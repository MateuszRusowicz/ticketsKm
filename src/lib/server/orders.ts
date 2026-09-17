import 'server-only'
import { randomBytes } from 'node:crypto'
import { Prisma, type PrismaClient } from '@/generated/prisma/client'
import type Stripe from 'stripe'
import { checkoutSchema, type CheckoutInput } from '@/lib/shared/checkout'
import { recordAudit } from './audit'
import { db } from './db'
import { holdCapacity, InsufficientCapacityError, releaseCapacity } from './holds'
import { expireOrderWith } from '@/lib/shared/holds-sweep'
import { generateOrderReference } from './order-reference'
import { getPublicEvent } from './public-events'

/** 30 minutes, flat across venues — plan/00-decisions.md, settled 30 Aug 2026. */
export const HOLD_DURATION_MS = 30 * 60 * 1000

export class EventNotPurchasableError extends Error {
  constructor(readonly reason: string) {
    super(`Concert not purchasable: ${reason}`)
    this.name = 'EventNotPurchasableError'
  }
}

export class QuantityAboveMaxPerOrderError extends Error {
  constructor(
    readonly requested: number,
    readonly max: number,
  ) {
    super(`Requested ${requested} tickets, maximum per order is ${max}`)
    this.name = 'QuantityAboveMaxPerOrderError'
  }
}

/**
 * Thrown by `reclaimCapacityForOrder` when the event is no longer in a
 * purchasable state (CANCELLED, CLOSED, or DRAFT). A `succeeded` PI against
 * such an order must be refunded — issuing tickets for a cancelled concert
 * is worse than a refund being one step late.
 */
export class EventNoLongerPurchasableError extends Error {
  constructor(readonly reason: 'cancelled' | 'closed' | 'draft') {
    super(`Event no longer purchasable: ${reason}`)
    this.name = 'EventNoLongerPurchasableError'
  }
}

export type FulfilResult =
  | { fulfilled: true; ticketIds: string[] }
  | { skipped: 'alreadyFulfilled' }
  | {
      refunded: true
      reason:
        | 'oversoldOnLateSuccess'
        | 'eventCancelledOnLateSuccess'
        | 'terminalStateOnLateSuccess'
    }

/**
 * Performs a real refund on the Stripe charge for this PaymentIntent.
 *
 * Implemented in the webhook dispatcher (Task 9). Accepts both a PI id and a
 * charge id so the refund lookup can use whichever is available when
 * charge_already_refunded or idempotency_key_in_use is returned.
 */
export type RefundHook = (
  paymentIntentId: string,
  chargeId: string | null,
) => Promise<{ refundId: string }>

export type CreateOrderResult = {
  orderId: string
  reference: string
  accessToken: string
  holdExpiresAt: Date
}

export async function createOrder(raw: CheckoutInput): Promise<CreateOrderResult> {
  return createOrderWith(db, raw)
}

/**
 * The implementation, parameterised by client.
 *
 * `createOrder` binds the application singleton. The concurrency test binds
 * its own client with a larger pool and longer transaction timeouts: 1000
 * simultaneous transactions against a 10-connection pool reject with P2028
 * before the capacity race is ever exercised, which would make a green test
 * meaningless.
 */
export async function createOrderWith(
  client: PrismaClient,
  raw: CheckoutInput,
): Promise<CreateOrderResult> {
  const input = checkoutSchema.parse(raw)
  const now = new Date()

  // A. Resolve the concert from the ticket type. findFirstOrThrow raises
  // P2025 for a well-formed but unknown id — a stale tab, not a server fault,
  // so it becomes a typed error rather than a 500.
  let event: { id: string; slug: string }
  try {
    event = await client.event.findFirstOrThrow({
      where: { ticketTypes: { some: { id: input.ticketTypeId } } },
      select: { id: true, slug: true },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new EventNotPurchasableError('unknown')
    }
    throw e
  }

  // B. Purchasability comes from the same query the shop renders from —
  // deriving it a second time here would drift. Note that DRAFT, CANCELLED
  // and past concerts are filtered at the query level, so all three arrive
  // as null and collapse to 'unknown'; only soldOut / notYetOpen / closed /
  // inactive produce a distinguishable reason.
  const view = await getPublicEvent(event.slug, input.locale)
  if (!view) throw new EventNotPurchasableError('unknown')
  if (!view.purchasable) throw new EventNotPurchasableError(view.notPurchasableReason ?? 'unknown')
  if (view.ticketTypeId !== input.ticketTypeId) {
    throw new EventNotPurchasableError('ticketTypeChanged')
  }

  // C. Policy limit, server-side. The quantity selector clamps at render
  // time, which a crafted POST simply ignores.
  if (input.quantity > view.maxPerOrder) {
    throw new QuantityAboveMaxPerOrderError(input.quantity, view.maxPerOrder)
  }

  // D. Same-buyer dedupe. Without it, a double-submit, a second tab or a
  // back-button resubmit each strand a 30-minute hold the buyer cannot even
  // reach, because they only ever see the newest reference. Returning the
  // existing order makes checkout idempotent and turns abandonment into a
  // resumable session, which is what the hold-duration decision assumes.
  //
  // Deliberately outside the transaction: losing this race costs one extra
  // hold released at expiry, which is not a correctness problem, and holding
  // a lock across it would serialise every checkout for the same concert.
  const existing = await client.order.findFirst({
    where: {
      email: input.email,
      status: 'PENDING',
      holdExpiresAt: { gt: now },
      items: { some: { ticketTypeId: input.ticketTypeId } },
    },
    select: { id: true, reference: true, accessToken: true, holdExpiresAt: true },
    orderBy: { createdAt: 'desc' },
  })

  if (existing) {
    return {
      orderId: existing.id,
      reference: existing.reference,
      accessToken: existing.accessToken,
      holdExpiresAt: existing.holdExpiresAt!,
    }
  }

  // Price is snapshotted from the database, never taken from the payload.
  const unitPrice = input.currency === 'PLN' ? view.pricePln : view.priceEur
  const subtotal = unitPrice * input.quantity
  const holdExpiresAt = new Date(now.getTime() + HOLD_DURATION_MS)

  // E. Hold, order and audit are one transaction: all of them or none.
  // Everything inside uses `tx` — touching the `db` singleton here pins a
  // second pool connection while already holding one, which deadlocks under
  // concurrency.
  return client.$transaction(async (tx) => {
    await holdCapacity({
      ticketTypeId: input.ticketTypeId,
      eventId: event.id,
      quantity: input.quantity,
      client: tx,
    })

    const reference = await generateOrderReference(now, tx)

    const order = await tx.order.create({
      data: {
        reference,
        kind: 'PURCHASE',
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone ?? null,
        locale: input.locale,
        currency: input.currency,
        subtotal,
        discount: 0,
        total: subtotal,
        status: 'PENDING',
        needsInvoice: input.needsInvoice,
        companyName: input.needsInvoice ? (input.companyName ?? null) : null,
        nip: input.needsInvoice ? (input.nip ?? null) : null,
        invoiceAddress: input.needsInvoice ? (input.invoiceAddress ?? null) : null,
        // Index-keyed rather than a bare array: fulfilment maps these onto
        // Ticket.holderName, and a positional array shifts every later name
        // onto the wrong ticket if one entry is ever dropped, with the count
        // still matching.
        attendeeNames: input.attendeeNames.map((name, index) => ({
          index,
          name,
        })) as Prisma.InputJsonValue,
        holdExpiresAt,
        items: {
          create: [
            {
              ticketTypeId: input.ticketTypeId,
              quantity: input.quantity,
              unitPrice,
              currency: input.currency,
            },
          ],
        },
      },
      select: { id: true, reference: true, accessToken: true, holdExpiresAt: true },
    })

    // Passed `tx`, so this participates in the transaction and propagates
    // failures rather than swallowing them. For an order create the audit row
    // is the paper trail; it should exist if and only if the order does.
    await recordAudit(
      {
        action: 'order.create',
        entityType: 'Order',
        entityId: order.id,
        meta: { reference, ticketTypeId: input.ticketTypeId, quantity: input.quantity },
      },
      tx,
    )

    return {
      orderId: order.id,
      reference: order.reference,
      accessToken: order.accessToken,
      holdExpiresAt: order.holdExpiresAt!,
    }
  })
}

/**
 * Every path out of `PENDING`.
 *
 * The conditional `UPDATE ... WHERE status = 'PENDING'` is the sole arbiter.
 * There is deliberately no pre-transaction guard reading the current status:
 * that would make the sequential second call throw while the concurrent case
 * succeeded, which is backwards from where the surprise belongs.
 *
 * `skipped` distinguishes *why* nothing happened. Collapsing 'notYetExpired'
 * into 'alreadyTerminal' would tell the Plan 05 sweep that a live order had
 * been dealt with.
 */
export type { ReleaseResult, SkipReason } from '@/lib/shared/holds-sweep'
import type { ReleaseResult } from '@/lib/shared/holds-sweep'

async function releaseHoldForOrder(
  orderId: string,
  nextStatus: 'CANCELLED' | 'EXPIRED' | 'FAILED',
  requireExpired: boolean,
  tx: Prisma.TransactionClient,
): Promise<{ claimed: boolean }> {
  // $1 is cast to OrderStatus for the assignment and to text for the CASE
  // comparison, with separate parameters. Reusing one parameter for both
  // makes Postgres refuse with 42P08, "inconsistent types deduced".
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "Order"
        SET status = $1::"OrderStatus",
            "cancelledAt" = CASE WHEN $2::text = 'CANCELLED' THEN now() ELSE "cancelledAt" END
      WHERE id = $3
        AND status = 'PENDING'
        ${requireExpired ? 'AND "holdExpiresAt" < now()' : ''}
    RETURNING id`,
    nextStatus,
    nextStatus,
    orderId,
  )

  return { claimed: rows.length > 0 }
}

async function releaseItems(orderId: string, tx: Prisma.TransactionClient): Promise<number> {
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { ticketTypeId: true, quantity: true },
  })

  let released = 0
  for (const item of items) {
    await releaseCapacity({ ticketTypeId: item.ticketTypeId, quantity: item.quantity, client: tx })
    released += item.quantity
  }

  return released
}

export async function cancelOrder(orderId: string, reason: string): Promise<ReleaseResult> {
  return db.$transaction(async (tx) => {
    const { claimed } = await releaseHoldForOrder(orderId, 'CANCELLED', false, tx)
    if (!claimed) return { skipped: 'alreadyTerminal' }

    const released = await releaseItems(orderId, tx)
    await recordAudit(
      { action: 'order.cancel', entityType: 'Order', entityId: orderId, meta: { reason } },
      tx,
    )

    return { released }
  })
}

export async function expireOrder(
  orderId: string,
  opts?: { beforeRelease?: (client: Prisma.TransactionClient) => Promise<void> | void },
): Promise<ReleaseResult> {
  // One implementation of the transition, in shared/, so the sweep CLI runs
  // exactly the same code path as the app.
  return db.$transaction((tx) => expireOrderWith(tx, orderId, opts))
}

export async function failOrder(orderId: string, reason: string): Promise<ReleaseResult> {
  // No caller in Plan 04. Plan 05's webhook handler for
  // payment_intent.payment_failed and .canceled calls this.
  return db.$transaction(async (tx) => {
    const { claimed } = await releaseHoldForOrder(orderId, 'FAILED', false, tx)
    if (!claimed) return { skipped: 'alreadyTerminal' }

    const released = await releaseItems(orderId, tx)
    await recordAudit(
      { action: 'order.fail', entityType: 'Order', entityId: orderId, meta: { reason } },
      tx,
    )

    return { released }
  })
}

/**
 * Plan 05's late-succeed path: a Przelewy24 or SEPA transfer that confirms
 * after the sweep already expired the order. Re-takes the capacity, so it can
 * fail with InsufficientCapacityError if the concert sold out meanwhile —
 * which is exactly when Plan 05 must refund instead of fulfilling.
 */
export async function reclaimCapacityForOrder(
  orderId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      status: true,
      items: {
        select: {
          ticketTypeId: true,
          quantity: true,
          ticketType: { select: { event: { select: { id: true, status: true } } } },
        },
      },
    },
  })

  if (order.status !== 'EXPIRED') {
    throw new Error(`reclaimCapacityForOrder: order ${orderId} is ${order.status}, expected EXPIRED`)
  }

  // Guard: refuse to re-hold seats on an event that is no longer purchasable.
  // Without this, a late `succeeded` PI on an EXPIRED order for a CANCELLED
  // event would issue tickets for a concert that will never happen.
  const eventStatus = order.items[0].ticketType.event.status
  if (!['ON_SALE', 'SOLD_OUT'].includes(eventStatus)) {
    throw new EventNoLongerPurchasableError(
      eventStatus === 'CANCELLED' ? 'cancelled' : eventStatus === 'CLOSED' ? 'closed' : 'draft',
    )
  }

  for (const item of order.items) {
    await holdCapacity({
      ticketTypeId: item.ticketTypeId,
      eventId: item.ticketType.event.id,
      quantity: item.quantity,
      client: tx,
    })
  }

  await tx.order.update({
    where: { id: orderId },
    data: { status: 'PENDING', holdExpiresAt: new Date(Date.now() + HOLD_DURATION_MS) },
  })
}

// ---------------------------------------------------------------------------
// fulfilOrder helpers (internal)
// ---------------------------------------------------------------------------

/**
 * Generates a 26-character Crockford base32 ticket code from 16 random bytes.
 *
 * Crockford alphabet: 0–9 A–Z excluding I L O U (32 symbols).
 * 16 bytes × 8 bits = 128 bits; ⌈128/5⌉ = 26 characters.
 */
function ticketCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const bytes = randomBytes(16)
  let out = ''
  let value = 0
  let bits = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31]
  return out
}

/**
 * Two-transaction refund for orders that cannot be fulfilled.
 *
 * Phase 1 (tx1): mark `refundRequestedAt` and write an ALERT audit. Commits
 *   before the Stripe call so a crash mid-call is recoverable by reconciliation.
 * Phase 2 (outside any tx): call the injected refundHook — a single Stripe
 *   network round-trip. Never inside a Postgres transaction: measured to
 *   serialise 500 orders against a 30s timeout.
 * Phase 3 (tx2): persist `stripeRefundId` and transition to REFUNDED.
 */
async function processLateSuccessRefund(
  orderId: string,
  reason: 'oversoldOnLateSuccess' | 'eventCancelledOnLateSuccess' | 'terminalStateOnLateSuccess',
  refundHook: RefundHook,
  pi: Stripe.PaymentIntent,
): Promise<FulfilResult> {
  // Phase 1 — commit the intent to refund before we call Stripe.
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { refundRequestedAt: new Date() } })
    await recordAudit(
      {
        action: 'order.refund_requested',
        entityType: 'Order',
        entityId: orderId,
        meta: { reason, paymentIntentId: pi.id, severity: 'ALERT' },
      },
      tx,
    )
  })

  // Phase 2 — Stripe refund outside any DB transaction.
  const chargeId =
    typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge?.id ?? null)
  const { refundId } = await refundHook(pi.id, chargeId)

  // Phase 3 — persist the result.
  await db.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { status: 'REFUNDED', stripeRefundId: refundId },
    })
    await recordAudit(
      {
        action: 'order.refunded',
        entityType: 'Order',
        entityId: orderId,
        meta: { reason, paymentIntentId: pi.id, refundId },
      },
      tx,
    )
  })

  return { refunded: true, reason }
}

// ---------------------------------------------------------------------------
// fulfilOrder — the primary safety net for Plan 05
// ---------------------------------------------------------------------------

/**
 * Fulfils a `succeeded` PaymentIntent: moves `heldCount → soldCount` in one
 * atomic UPDATE, transitions the order to PAID, and creates Ticket rows.
 *
 * Also handles the reclaim-or-refund path — the primary defence against
 * oversell. A PaymentIntent can succeed after its seats were released by the
 * hold-expiry sweep (which never calls Stripe). If the seats are still
 * available they are reclaimed and the order is fulfilled; otherwise the
 * buyer is refunded. FAILED/CANCELLED orders that somehow received a
 * `succeeded` event are also refunded.
 *
 * **Lock order matches `holdCapacity` (Event first, TicketType second)** so
 * concurrent hold + fulfil on the same event cannot ABBA-deadlock.
 */
export async function fulfilOrder(
  orderId: string,
  refundHook: RefundHook,
  pi: Stripe.PaymentIntent,
): Promise<FulfilResult> {
  // -------------------------------------------------------------------------
  // PI cross-check: happens FIRST, before any DB write.
  //
  // A mismatched PI reaching this function is a severe programming error —
  // we could be charging a different order or a different amount. Abort with
  // no side effects rather than issuing wrong tickets or a wrong refund.
  // -------------------------------------------------------------------------
  const order0 = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true,
      total: true,
      currency: true,
      stripePaymentIntentId: true,
      stripeRefundId: true,
    },
  })

  if (pi.id !== order0.stripePaymentIntentId) {
    throw new Error(
      `fulfilOrder: PI id mismatch: pi=${pi.id}, order=${order0.stripePaymentIntentId}`,
    )
  }
  if (pi.amount_received !== order0.total) {
    throw new Error(
      `fulfilOrder: amount mismatch: pi=${pi.amount_received}, order=${order0.total}`,
    )
  }
  if (pi.currency !== order0.currency.toLowerCase()) {
    throw new Error(
      `fulfilOrder: currency mismatch: pi=${pi.currency}, order=${order0.currency}`,
    )
  }

  // If a refund already completed for this order, do nothing.
  // Checked before the transaction: idempotency on our own field, not Stripe's.
  if (order0.stripeRefundId) return { skipped: 'alreadyFulfilled' }

  const result = await db.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        stripePaymentIntentId: true,
        attendeeNames: true,
        items: {
          select: {
            ticketTypeId: true,
            quantity: true,
            ticketType: { select: { eventId: true } },
          },
        },
      },
    })

    // PAID / REFUNDED / PARTIALLY_REFUNDED: already handled, do nothing.
    if (['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.status)) {
      return { skipped: 'alreadyFulfilled' as const }
    }

    if (order.status === 'EXPIRED') {
      // Late success after hold-expiry sweep: attempt to reclaim the seats.
      // InsufficientCapacityError → oversold.  EventNoLongerPurchasableError →
      // event was cancelled while the order was in flight.
      try {
        await reclaimCapacityForOrder(order.id, tx)
      } catch (e) {
        if (e instanceof InsufficientCapacityError) {
          return { needsRefund: 'oversoldOnLateSuccess' as const }
        }
        if (e instanceof EventNoLongerPurchasableError) {
          return { needsRefund: 'eventCancelledOnLateSuccess' as const }
        }
        throw e
      }
    } else if (order.status === 'FAILED' || order.status === 'CANCELLED') {
      // A `succeeded` PI against a terminal order is money held with nothing
      // delivered. Refund immediately — skipping would leave the buyer charged.
      return { needsRefund: 'terminalStateOnLateSuccess' as const }
    } else if (order.status !== 'PENDING') {
      return { skipped: 'alreadyFulfilled' as const }
    }

    // -----------------------------------------------------------------------
    // Fulfilment path. Order is PENDING (either originally, or just reclaimed
    // from EXPIRED by reclaimCapacityForOrder above).
    // -----------------------------------------------------------------------

    // ABBA-safe Event lock first, matching holdCapacity's lock order.
    // holdCapacity: Event FOR UPDATE → TicketType UPDATE
    // fulfilOrder: Event FOR UPDATE → TicketType UPDATE
    // Both sides take the same lock first, so no deadlock is possible.
    const eventId = order.items[0].ticketType.eventId
    await tx.$executeRawUnsafe(`SELECT id FROM "Event" WHERE id = $1 FOR UPDATE`, eventId)

    // ONE UPDATE moves held → sold. Two separate UPDATEs create a window in
    // which a concurrent sweep can decrement heldCount below zero — the drift
    // bug Plan 04 flagged explicitly.
    for (const item of order.items) {
      const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE "TicketType"
            SET "heldCount" = "heldCount" - $1,
                "soldCount" = "soldCount" + $1,
                "updatedAt"  = now()
          WHERE id = $2 AND "heldCount" >= $1
        RETURNING id`,
        item.quantity,
        item.ticketTypeId,
      )
      if (rows.length === 0) {
        throw new Error(`fulfilOrder: heldCount too low for ticketType ${item.ticketTypeId}`)
      }
    }

    // Transition Order PENDING → PAID atomically. If a concurrent transaction
    // raced us to a terminal status, this returns 0 rows and we throw, rolling
    // the entire transaction back.
    // status IN ('PENDING') is sufficient: if we came through the EXPIRED
    // branch, reclaimCapacityForOrder already set status = PENDING within
    // this same transaction, so the UPDATE sees PENDING.
    const paid = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "Order" SET status = 'PAID', "paidAt" = now()
        WHERE id = $1 AND status IN ('PENDING')
        RETURNING id`,
      orderId,
    )
    if (paid.length === 0) {
      throw new Error(`fulfilOrder: order ${orderId} was not PENDING at PAID transition`)
    }

    // Create Ticket rows: one per admission, holder name from the index-keyed
    // attendeeNames JSON stored at checkout time.
    const attendees =
      (order.attendeeNames as Array<{ index: number; name: string }> | null) ?? []
    const byIndex = new Map(attendees.map((a) => [a.index, a.name]))
    const ticketIds: string[] = []
    let idx = 0
    for (const item of order.items) {
      for (let i = 0; i < item.quantity; i++) {
        const ticket = await tx.ticket.create({
          data: {
            code: ticketCode(),
            orderId,
            eventId: item.ticketType.eventId,
            ticketTypeId: item.ticketTypeId,
            holderName: byIndex.get(idx) ?? null,
            status: 'VALID',
          },
          select: { id: true },
        })
        ticketIds.push(ticket.id)
        idx += 1
      }
    }

    // Flip event to SOLD_OUT if capacity is now fully sold.
    // Guard: ON_SALE only — a concurrent fulfil may already have flipped it,
    // and CANCELLED/CLOSED events must never be revived.
    await tx.$executeRawUnsafe(
      `UPDATE "Event" SET status = 'SOLD_OUT'
        WHERE id = $1
          AND status = 'ON_SALE'
          AND capacity <= (
            SELECT COALESCE(SUM("soldCount"), 0)
              FROM "TicketType"
             WHERE "eventId" = $1
          )`,
      eventId,
    )

    await recordAudit(
      {
        action: 'order.fulfil',
        entityType: 'Order',
        entityId: orderId,
        meta: { ticketCount: ticketIds.length, paymentIntentId: order.stripePaymentIntentId },
      },
      tx,
    )

    return { fulfilled: true as const, ticketIds }
  })

  if ('needsRefund' in result) {
    // TypeScript can't narrow the Prisma-inferred union to exclude undefined here;
    // the `in` guard guarantees it is present.
    return processLateSuccessRefund(orderId, result.needsRefund!, refundHook, pi)
  }
  return result
}

// ---------------------------------------------------------------------------
// recordPaymentAttempt — Task 8
// ---------------------------------------------------------------------------

/**
 * Extracts the payment method type from a PaymentIntent.
 *
 * stripe@19.3.1 has no `pi.charges` field (verified types/PaymentIntents.d.ts:129).
 * Uses pi.latest_charge (string | Stripe.Charge | null); when expanded via retrieve,
 * reads charge.payment_method_details.type. Falls back to pi.payment_method_types
 * if it collapses to exactly one method (i.e. the allow-list has unambiguously one entry).
 */
export function extractPaymentMethodType(pi: Stripe.PaymentIntent): string | null {
  const lc = pi.latest_charge
  if (lc && typeof lc !== 'string') {
    const t = lc.payment_method_details?.type
    if (t) return t
  }
  // Fall back to the allow-list — reliable only when collapsed to one method.
  if (pi.payment_method_types.length === 1) return pi.payment_method_types[0]
  return null
}

/**
 * Records a declined, processing, or requires_action payment attempt without
 * touching Order.status. A declined card is retryable — calling failOrder here
 * would release the seats and make any retry charge against a FAILED order
 * (where fulfilOrder skips fulfilment and triggers the refund path instead).
 *
 * Writes paymentIntentStatus and paymentMethodType (if determinable), then an
 * audit row. The audit is standalone (best-effort); a failure there must not
 * roll back the status update.
 */
export async function recordPaymentAttempt(
  orderId: string,
  pi: Stripe.PaymentIntent,
  meta: { reason: 'processing' | 'requires_action' | 'declined' | 'succeeded' },
): Promise<void> {
  const paymentMethodType = extractPaymentMethodType(pi)
  await db.order.update({
    where: { id: orderId },
    data: {
      paymentIntentStatus: pi.status,
      ...(paymentMethodType !== null && { paymentMethodType }),
    },
  })
  await recordAudit({
    action: `stripe.${meta.reason}`,
    entityType: 'Order',
    entityId: orderId,
    meta: {
      paymentIntentId: pi.id,
      status: pi.status,
      lastPaymentError: pi.last_payment_error?.code ?? null,
    },
  })
}
