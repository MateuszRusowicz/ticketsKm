import 'server-only'
import { Prisma, type PrismaClient } from '@/generated/prisma/client'
import { checkoutSchema, type CheckoutInput } from '@/lib/shared/checkout'
import { recordAudit } from './audit'
import { db } from './db'
import { holdCapacity, releaseCapacity } from './holds'
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
      items: { select: { ticketTypeId: true, quantity: true } },
    },
  })

  if (order.status !== 'EXPIRED') {
    throw new Error(`reclaimCapacityForOrder: order ${orderId} is ${order.status}, expected EXPIRED`)
  }

  for (const item of order.items) {
    const ticketType = await tx.ticketType.findUniqueOrThrow({
      where: { id: item.ticketTypeId },
      select: { eventId: true },
    })

    await holdCapacity({
      ticketTypeId: item.ticketTypeId,
      eventId: ticketType.eventId,
      quantity: item.quantity,
      client: tx,
    })
  }

  await tx.order.update({
    where: { id: orderId },
    data: { status: 'PENDING', holdExpiresAt: new Date(Date.now() + HOLD_DURATION_MS) },
  })
}
