import { PrismaPg } from '@prisma/adapter-pg'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { PrismaClient } from '@/generated/prisma/client'
import { db } from '@/lib/server/db'
import {
  cancelOrder,
  expireOrder,
  createOrder,
  failOrder,
  fulfilOrder,
  type FulfilResult,
  type RefundHook,
} from '@/lib/server/orders'
import type { CheckoutInput } from '@/lib/shared/checkout'

// Case 11 uses a dedicated client because 100 concurrent transactions against
// the 10-connection singleton would serialise heavily; a larger pool lets
// them queue at the Postgres row-lock level, not at the application level.
// Pattern mirrors oversell.test.ts.
const fulfilClient = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 20 }),
  transactionOptions: { maxWait: 60_000, timeout: 60_000 },
})

afterAll(async () => {
  await fulfilClient.$disconnect()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeEvent(
  overrides: {
    capacity?: number
    status?: 'DRAFT' | 'ON_SALE' | 'SOLD_OUT' | 'CANCELLED' | 'CLOSED'
  } = {},
) {
  const venue = await db.venue.create({
    data: { name: 'Fulfil test venue', city: 'Test', address: 'Test', defaultCapacity: 100 },
  })
  const event = await db.event.create({
    data: {
      slug: `fulfil-test-${crypto.randomUUID()}`,
      venueId: venue.id,
      capacity: overrides.capacity ?? 100,
      startsAt: new Date(Date.now() + 60 * 86_400_000),
      status: overrides.status ?? 'ON_SALE',
      translations: {
        create: (['pl', 'en', 'de'] as const).map((locale) => ({
          locale,
          title: 'Fulfil test',
          description: 'Fulfil test',
          performers: 'Fulfil test',
        })),
      },
      ticketTypes: {
        create: [{ pricePln: 5000, priceEur: 1200, maxPerOrder: 500, active: true }],
      },
    },
    include: { ticketTypes: true },
  })
  return {
    eventId: event.id,
    ticketTypeId: event.ticketTypes[0].id,
  }
}

function orderInput(ticketTypeId: string, overrides: Partial<CheckoutInput> = {}): CheckoutInput {
  const quantity = overrides.quantity ?? 1
  return {
    ticketTypeId,
    quantity,
    locale: 'pl',
    currency: 'PLN',
    email: overrides.email ?? 'fulfil-buyer@example.test',
    firstName: 'Jan',
    lastName: 'Kowalski',
    attendeeNames: Array.from({ length: quantity }, (_, i) => `Attendee ${i + 1}`),
    needsInvoice: false,
    acceptedTerms: true,
    ...overrides,
  } as CheckoutInput
}

/** A Stripe PaymentIntent stub that satisfies the cross-check in fulfilOrder. */
function makePi(overrides: {
  id?: string
  amount_received?: number
  currency?: string
  latest_charge?: string | null
} = {}) {
  return {
    id: overrides.id ?? 'pi_test_default',
    amount_received: overrides.amount_received ?? 5000,
    currency: overrides.currency ?? 'pln',
    latest_charge: overrides.latest_charge ?? null,
  } as unknown as Stripe.PaymentIntent
}

beforeEach(async () => {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "Ticket", "OrderItem", "Order", "TicketType",
                   "EventTranslation", "Event", "Venue"
    RESTART IDENTITY CASCADE
  `)
  await db.$executeRawUnsafe('ALTER SEQUENCE "order_reference_seq" RESTART')
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fulfilOrder', () => {
  // Case 1 — Happy path: PENDING → PAID
  it('case 1: PENDING → PAID, heldCount→soldCount, tickets created, SOLD_OUT flip', async () => {
    // capacity = 3 so the fulfil fills the event (tests the SOLD_OUT flip too)
    const { ticketTypeId, eventId } = await makeEvent({ capacity: 3 })
    const piId = 'pi_case1'
    const { orderId } = await createOrder(
      orderInput(ticketTypeId, { quantity: 3, email: 'case1@example.test' }),
    )
    // total = 3 × 5000 = 15 000 PLN
    await db.order.update({
      where: { id: orderId },
      data: { stripePaymentIntentId: piId },
    })

    const refundHook = vi.fn<RefundHook>(async () => ({ refundId: 're_case1' }))
    const pi = makePi({ id: piId, amount_received: 15_000, currency: 'pln' })

    const result = await fulfilOrder(orderId, refundHook, pi)

    expect(result).toMatchObject({
      fulfilled: true,
      ticketIds: expect.arrayContaining([expect.any(String)]),
    })
    expect((result as Extract<FulfilResult, { fulfilled: true }>).ticketIds).toHaveLength(3)
    expect(refundHook).not.toHaveBeenCalled()

    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('PAID')
    expect(order.paidAt).not.toBeNull()

    const tt = await db.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } })
    expect(tt.heldCount).toBe(0)
    expect(tt.soldCount).toBe(3)

    const tickets = await db.ticket.findMany({ where: { orderId } })
    expect(tickets).toHaveLength(3)

    // Codes must be distinct Crockford base32 strings (26 chars per ticketCode())
    const codes = tickets.map((t) => t.code)
    expect(new Set(codes).size).toBe(3)
    codes.forEach((c) => {
      expect(c).toHaveLength(26)
      expect(c).toMatch(/^[0-9A-HJKMNPQRSTVWXYZ]+$/)
    })

    // Attendee names are mapped by index
    const holderNames = tickets
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((t) => t.holderName)
    expect(holderNames).toEqual(['Attendee 1', 'Attendee 2', 'Attendee 3'])

    // Event flipped to SOLD_OUT (soldCount 3 = capacity 3)
    const event = await db.event.findUniqueOrThrow({ where: { id: eventId } })
    expect(event.status).toBe('SOLD_OUT')

    const audits = await db.auditLog.findMany({
      where: { entityId: orderId, action: 'order.fulfil' },
    })
    expect(audits).toHaveLength(1)
    expect(audits[0].meta).toMatchObject({ ticketCount: 3, paymentIntentId: piId })
  })

  // Case 2 — Already PAID (tx-level idempotency guard)
  it('case 2: already PAID → skipped:alreadyFulfilled, no second ticket batch', async () => {
    const { ticketTypeId } = await makeEvent()
    const piId = 'pi_case2'
    const { orderId } = await createOrder(orderInput(ticketTypeId, { email: 'case2@example.test' }))
    await db.order.update({
      where: { id: orderId },
      data: { status: 'PAID', stripePaymentIntentId: piId, paidAt: new Date() },
    })

    const refundHook = vi.fn<RefundHook>(async () => ({ refundId: 're_case2' }))
    const pi = makePi({ id: piId, amount_received: 5000, currency: 'pln' })

    const result = await fulfilOrder(orderId, refundHook, pi)

    expect(result).toEqual({ skipped: 'alreadyFulfilled' })
    expect(refundHook).not.toHaveBeenCalled()
    expect(await db.ticket.count({ where: { orderId } })).toBe(0)
  })

  // Case 3 — Already REFUNDED (tx-level idempotency guard)
  it('case 3: already REFUNDED → skipped:alreadyFulfilled', async () => {
    const { ticketTypeId } = await makeEvent()
    const piId = 'pi_case3'
    const { orderId } = await createOrder(orderInput(ticketTypeId, { email: 'case3@example.test' }))
    // stripeRefundId is null → pre-tx guard does NOT fire; tx-level guard fires on status
    await db.order.update({
      where: { id: orderId },
      data: { status: 'REFUNDED', stripePaymentIntentId: piId },
    })

    const refundHook = vi.fn<RefundHook>(async () => ({ refundId: 're_case3' }))
    const pi = makePi({ id: piId, amount_received: 5000, currency: 'pln' })

    const result = await fulfilOrder(orderId, refundHook, pi)

    expect(result).toEqual({ skipped: 'alreadyFulfilled' })
    expect(refundHook).not.toHaveBeenCalled()
  })

  // Case 4 — stripeRefundId set: pre-tx short-circuit fires before opening a transaction
  it('case 4: stripeRefundId already set → skipped:alreadyFulfilled before tx opens', async () => {
    const { ticketTypeId } = await makeEvent()
    const piId = 'pi_case4'
    const { orderId } = await createOrder(orderInput(ticketTypeId, { email: 'case4@example.test' }))
    // Order is still PENDING — only stripeRefundId is set artificially
    await db.order.update({
      where: { id: orderId },
      data: { stripePaymentIntentId: piId, stripeRefundId: 're_already_done' },
    })

    const refundHook = vi.fn<RefundHook>(async () => ({ refundId: 're_case4' }))
    const pi = makePi({ id: piId, amount_received: 5000, currency: 'pln' })

    const result = await fulfilOrder(orderId, refundHook, pi)

    expect(result).toEqual({ skipped: 'alreadyFulfilled' })
    expect(refundHook).not.toHaveBeenCalled()
    // Status unchanged — the pre-tx guard short-circuited before any write
    const row = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    })
    expect(row.status).toBe('PENDING')
  })

  // Case 5 — EXPIRED + capacity available → reclaim → fulfilled
  it('case 5: EXPIRED + capacity → reclaimCapacityForOrder → fulfilled', async () => {
    const { ticketTypeId } = await makeEvent({ capacity: 100 })
    const piId = 'pi_case5'
    const { orderId } = await createOrder(
      orderInput(ticketTypeId, { quantity: 2, email: 'case5@example.test' }),
    )
    await db.order.update({
      where: { id: orderId },
      data: { holdExpiresAt: new Date(Date.now() - 1000), stripePaymentIntentId: piId },
    })
    await expireOrder(orderId)
    // After expiry: heldCount = 0, status = EXPIRED

    const refundHook = vi.fn<RefundHook>(async () => ({ refundId: 're_case5' }))
    // total = 2 × 5000 = 10 000
    const pi = makePi({ id: piId, amount_received: 10_000, currency: 'pln' })

    const result = await fulfilOrder(orderId, refundHook, pi)

    expect(result).toMatchObject({ fulfilled: true })
    expect(refundHook).not.toHaveBeenCalled()

    const tt = await db.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } })
    expect(tt.heldCount).toBe(0)
    expect(tt.soldCount).toBe(2)

    expect(await db.ticket.count({ where: { orderId } })).toBe(2)

    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('PAID')
  })

  // Case 6 — EXPIRED + concert sold out → oversold
  it('case 6: EXPIRED + concert sold out → refunded(oversoldOnLateSuccess)', async () => {
    const { ticketTypeId } = await makeEvent({ capacity: 100 })
    const piId = 'pi_case6'
    const { orderId } = await createOrder(
      orderInput(ticketTypeId, { quantity: 2, email: 'case6@example.test' }),
    )
    await db.order.update({
      where: { id: orderId },
      data: { holdExpiresAt: new Date(Date.now() - 1000), stripePaymentIntentId: piId },
    })
    await expireOrder(orderId)
    // Sell all capacity so reclaim fails
    await db.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: 100 } })

    const refundHook = vi.fn<RefundHook>(async () => ({ refundId: 're_case6' }))
    const pi = makePi({ id: piId, amount_received: 10_000, currency: 'pln' })

    const result = await fulfilOrder(orderId, refundHook, pi)

    expect(result).toMatchObject({ refunded: true, reason: 'oversoldOnLateSuccess' })
    expect(refundHook).toHaveBeenCalledOnce()

    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('REFUNDED')
    expect(order.stripeRefundId).toBe('re_case6')
    expect(order.refundRequestedAt).not.toBeNull()
  })

  // Case 7 — CANCELLED order: terminal state triggers refund
  it('case 7: CANCELLED order → refunded(terminalStateOnLateSuccess)', async () => {
    const { ticketTypeId } = await makeEvent()
    const piId = 'pi_case7'
    const { orderId } = await createOrder(
      orderInput(ticketTypeId, { email: 'case7@example.test' }),
    )
    await cancelOrder(orderId, 'test')
    await db.order.update({ where: { id: orderId }, data: { stripePaymentIntentId: piId } })

    const refundHook = vi.fn<RefundHook>(async () => ({ refundId: 're_case7' }))
    const pi = makePi({ id: piId, amount_received: 5000, currency: 'pln' })

    const result = await fulfilOrder(orderId, refundHook, pi)

    expect(result).toMatchObject({ refunded: true, reason: 'terminalStateOnLateSuccess' })
    expect(refundHook).toHaveBeenCalledOnce()

    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('REFUNDED')
    expect(order.stripeRefundId).toBe('re_case7')
  })

  // Case 8 — EXPIRED + event CANCELLED: Event.status reclaim guard (negative control anchor)
  // Negative control: remove the EventNoLongerPurchasableError guard in reclaimCapacityForOrder
  // → reclaim succeeds, tickets issued for a CANCELLED event → test fails
  it('case 8: EXPIRED + event CANCELLED → refunded(eventCancelledOnLateSuccess)', async () => {
    const { ticketTypeId, eventId } = await makeEvent({ capacity: 100 })
    const piId = 'pi_case8'
    const { orderId } = await createOrder(
      orderInput(ticketTypeId, { quantity: 2, email: 'case8@example.test' }),
    )
    await db.order.update({
      where: { id: orderId },
      data: { holdExpiresAt: new Date(Date.now() - 1000), stripePaymentIntentId: piId },
    })
    await expireOrder(orderId)
    // Cancel the event after the order expired
    await db.event.update({ where: { id: eventId }, data: { status: 'CANCELLED' } })

    const refundHook = vi.fn<RefundHook>(async () => ({ refundId: 're_case8' }))
    const pi = makePi({ id: piId, amount_received: 10_000, currency: 'pln' })

    const result = await fulfilOrder(orderId, refundHook, pi)

    expect(result).toMatchObject({ refunded: true, reason: 'eventCancelledOnLateSuccess' })
    expect(refundHook).toHaveBeenCalledOnce()

    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('REFUNDED')
    // No tickets ever issued for a cancelled event
    expect(await db.ticket.count({ where: { orderId } })).toBe(0)
  })

  // Case 9 — FAILED order: terminal state triggers refund (negative control anchor)
  // Negative control: change FAILED/CANCELLED branch to return skipped:alreadyFulfilled
  // → refundHook not called → test fails
  it('case 9: FAILED order → refunded(terminalStateOnLateSuccess)', async () => {
    const { ticketTypeId } = await makeEvent()
    const piId = 'pi_case9'
    const { orderId } = await createOrder(
      orderInput(ticketTypeId, { email: 'case9@example.test' }),
    )
    await failOrder(orderId, 'payment_failed')
    await db.order.update({ where: { id: orderId }, data: { stripePaymentIntentId: piId } })

    const refundHook = vi.fn<RefundHook>(async () => ({ refundId: 're_case9' }))
    const pi = makePi({ id: piId, amount_received: 5000, currency: 'pln' })

    const result = await fulfilOrder(orderId, refundHook, pi)

    expect(result).toMatchObject({ refunded: true, reason: 'terminalStateOnLateSuccess' })
    expect(refundHook).toHaveBeenCalledOnce()
    // chargeId = null because pi.latest_charge = null in our mock
    expect(refundHook).toHaveBeenCalledWith(piId, null)

    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('REFUNDED')
    expect(order.stripeRefundId).toBe('re_case9')
    expect(order.refundRequestedAt).not.toBeNull()

    // Two audit entries: refund_requested and refunded
    const auditActions = (
      await db.auditLog.findMany({ where: { entityId: orderId }, orderBy: { createdAt: 'asc' } })
    ).map((a) => a.action)
    expect(auditActions).toContain('order.refund_requested')
    expect(auditActions).toContain('order.refunded')
  })

  // Case 10 — PI cross-check: throws before any DB write (negative control anchor)
  // Negative control: remove the three PI assertions before the tx
  // → fulfilOrder proceeds with mismatched PI, DB is mutated → test fails (no throw)
  it('case 10: PI amount mismatch → throws, DB is unchanged', async () => {
    const { ticketTypeId } = await makeEvent()
    const piId = 'pi_case10'
    const { orderId } = await createOrder(
      orderInput(ticketTypeId, { email: 'case10@example.test' }),
    )
    // total = 5000
    await db.order.update({ where: { id: orderId }, data: { stripePaymentIntentId: piId } })

    const refundHook = vi.fn<RefundHook>(async () => ({ refundId: 're_case10' }))
    // Wrong amount: 9999 ≠ 5000
    const pi = makePi({ id: piId, amount_received: 9999, currency: 'pln' })

    await expect(fulfilOrder(orderId, refundHook, pi)).rejects.toThrow(/amount mismatch/)

    // DB must be completely unchanged — no write happened before the throw
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('PENDING')
    expect(order.paidAt).toBeNull()
    expect(refundHook).not.toHaveBeenCalled()
    expect(await db.ticket.count({ where: { orderId } })).toBe(0)
    expect(
      await db.auditLog.count({ where: { entityId: orderId, action: 'order.fulfil' } }),
    ).toBe(0)
  })

  // Case 11 — Concurrency: 100 orders / 1000 tickets, distinct emails, capacity 10 000
  // Models oversell.test.ts. Verifies the one-UPDATE atomicity under 100 concurrent
  // fulfilOrder calls that all update the same TicketType row.
  it(
    'case 11: 100 concurrent fulfils / 1000 tickets, no drift in heldCount or soldCount',
    async () => {
      const n = 100
      const qty = 10 // tickets per order

      const { ticketTypeId, eventId } = await makeEvent({ capacity: 10_000 })

      // Create n orders with distinct emails (same-buyer dedupe collapses identical ones)
      const orders: Array<{ orderId: string; piId: string }> = []
      for (let i = 0; i < n; i++) {
        const { orderId } = await createOrder(
          orderInput(ticketTypeId, {
            email: `case11-${i}@example.test`,
            quantity: qty,
          }),
        )
        const piId = `pi_case11_${i}`
        await db.order.update({ where: { id: orderId }, data: { stripePaymentIntentId: piId } })
        orders.push({ orderId, piId })
      }

      // Sanity: all holds set before concurrent phase
      const tt0 = await db.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } })
      expect(tt0.heldCount).toBe(n * qty)
      expect(tt0.soldCount).toBe(0)

      const refundHook = vi.fn<RefundHook>(async () => ({ refundId: 're_never_called' }))

      // total = qty × 5000 = 50 000 for every order
      const results = await Promise.allSettled(
        orders.map(({ orderId, piId }) =>
          fulfilOrder(orderId, refundHook, makePi({ id: piId, amount_received: 50_000, currency: 'pln' })),
        ),
      )

      const rejected = results.filter((r) => r.status === 'rejected')
      expect(rejected).toHaveLength(0)

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      expect(fulfilled).toHaveLength(n)

      for (const r of fulfilled) {
        expect((r as PromiseFulfilledResult<FulfilResult>).value).toMatchObject({ fulfilled: true })
      }

      // One-UPDATE invariant: heldCount exactly 0, soldCount exactly n × qty
      const tt = await db.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } })
      expect(tt.heldCount).toBe(0)
      expect(tt.soldCount).toBe(n * qty)

      // Exactly n × qty Ticket rows, all codes unique
      const tickets = await db.ticket.findMany({ where: { eventId } })
      expect(tickets).toHaveLength(n * qty)
      expect(new Set(tickets.map((t) => t.code)).size).toBe(n * qty)

      expect(refundHook).not.toHaveBeenCalled()
    },
    60_000,
  )
})

