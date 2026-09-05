import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mock factories — TDZ-safe
// ---------------------------------------------------------------------------
const { mockRefundsCreate, mockRefundsList } = vi.hoisted(() => ({
  mockRefundsCreate: vi.fn(),
  mockRefundsList: vi.fn(),
}))

vi.mock('@/lib/server/stripe', () => ({
  stripe: {
    refunds: {
      create: mockRefundsCreate,
      list: mockRefundsList,
    },
  },
}))

import { db } from '@/lib/server/db'
import { createOrder } from '@/lib/server/orders'
import { reconcile } from '@/lib/server/reconcile'

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

let ticketTypeId: string

async function makeConcert(capacity = 100) {
  const venue =
    (await db.venue.findFirst({ where: { name: 'Reconcile test venue' } })) ??
    (await db.venue.create({
      data: { name: 'Reconcile test venue', city: 'C', address: 'A', defaultCapacity: 100 },
    }))

  const event = await db.event.create({
    data: {
      slug: `reconcile-test-${crypto.randomUUID()}`,
      venueId: venue.id,
      capacity,
      startsAt: new Date(Date.now() + 60 * 86_400_000),
      status: 'ON_SALE',
      translations: {
        create: (['pl', 'de', 'en'] as const).map((locale) => ({
          locale,
          title: 'T',
          description: 'D',
          performers: 'P',
        })),
      },
      ticketTypes: { create: [{ pricePln: 5000, priceEur: 1200 }] },
    },
    select: { id: true, ticketTypes: { select: { id: true } } },
  })

  return event.ticketTypes[0].id
}

async function anOrder(email: string) {
  return createOrder({
    ticketTypeId,
    quantity: 2,
    locale: 'pl',
    currency: 'PLN',
    email,
    firstName: 'Jan',
    lastName: 'Kowalski',
    attendeeNames: ['A', 'B'],
    needsInvoice: false,
    acceptedTerms: true,
  })
}

/** Mark an order as having a refund requested (phase 1 complete, phase 2 stuck). */
async function stuckRefund(orderId: string, piId: string) {
  await db.order.update({
    where: { id: orderId },
    data: {
      stripePaymentIntentId: piId,
      refundRequestedAt: new Date(Date.now() - 5 * 60 * 1000),
    },
  })
}

/** Insert a stuck webhook event older than 10 minutes, optionally > 1 hour. */
async function stuckWebhook(minutesOld: number) {
  const id = `evt_reconcile_${crypto.randomUUID()}`
  const receivedAt = new Date(Date.now() - minutesOld * 60 * 1000)
  await db.stripeWebhookEvent.create({
    data: { stripeEventId: id, type: 'payment_intent.succeeded', receivedAt, attemptCount: 3 },
  })
  return id
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "StripeWebhookEvent", "Ticket", "AuditLog" RESTART IDENTITY CASCADE',
  )
  // Truncate orders that carry refundRequestedAt/stripeRefundId.
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "OrderItem", "Order" RESTART IDENTITY CASCADE',
  )
  // Reset the order reference sequence so KM-YYYY-N references remain predictable.
  await db.$executeRawUnsafe('ALTER SEQUENCE "order_reference_seq" RESTART')

  ticketTypeId = await makeConcert()

  mockRefundsCreate.mockReset()
  mockRefundsList.mockReset()
})

describe('reconcile()', () => {
  // Case 1 — Stuck refund: happy path — Stripe refund succeeds
  it('case 1: recovers a stuck refund via stripe.refunds.create', async () => {
    const order = await anOrder('reconcile-1@example.test')
    const piId = `pi_reconcile_${crypto.randomUUID()}`
    await stuckRefund(order.orderId, piId)

    mockRefundsCreate.mockResolvedValueOnce({ id: 're_reconcile_001' })

    const result = await reconcile()

    expect(result.recoveredRefunds).toBe(1)
    expect(result.alerts).toBe(0)
    expect(mockRefundsCreate).toHaveBeenCalledWith(
      { payment_intent: piId, reason: 'requested_by_customer' },
      { idempotencyKey: `refund_${piId}` },
    )

    const updated = await db.order.findUniqueOrThrow({ where: { id: order.orderId } })
    expect(updated.status).toBe('REFUNDED')
    expect(updated.stripeRefundId).toBe('re_reconcile_001')
  })

  // Case 2 — Stuck refund: charge_already_refunded — retrieves existing refund id
  it('case 2: charge_already_refunded — retrieves existing refund from stripe.refunds.list', async () => {
    const order = await anOrder('reconcile-2@example.test')
    const piId = `pi_reconcile_${crypto.randomUUID()}`
    await stuckRefund(order.orderId, piId)

    const alreadyRefundedErr = Object.assign(new Error('charge_already_refunded'), {
      raw: { code: 'charge_already_refunded' },
    })
    mockRefundsCreate.mockRejectedValueOnce(alreadyRefundedErr)
    mockRefundsList.mockResolvedValueOnce({ data: [{ id: 're_reconcile_existing' }] })

    const result = await reconcile()

    expect(result.recoveredRefunds).toBe(1)
    const updated = await db.order.findUniqueOrThrow({ where: { id: order.orderId } })
    expect(updated.stripeRefundId).toBe('re_reconcile_existing')
    expect(updated.status).toBe('REFUNDED')
  })

  // Case 3 — Stuck webhook: 30 minutes old → counted but no ALERT
  it('case 3: webhook stuck 30 min and attemptCount < max — counted, no ALERT', async () => {
    await stuckWebhook(30)

    const result = await reconcile()

    expect(result.stuckWebhooks).toBe(1)
    expect(result.alerts).toBe(0)
  })

  // Case 4 — Stuck webhook: 2 hours old → ALERT audit
  it('case 4: webhook stuck 2 hours — ALERT audit written, alerts=1', async () => {
    await stuckWebhook(120)

    const result = await reconcile()

    expect(result.stuckWebhooks).toBe(1)
    expect(result.alerts).toBe(1)

    const alert = await db.auditLog.findFirst({
      where: { action: 'stripe.webhook_stuck' },
    })
    expect(alert).not.toBeNull()
    expect((alert!.meta as Record<string, unknown>).severity).toBe('ALERT')
  })

  // Case 5 — Paid order with missing tickets → ticketGaps=1, ALERT
  it('case 5: PAID order with 0 tickets but quantity=2 — ticketGap=1, ALERT', async () => {
    const order = await anOrder('reconcile-5@example.test')
    // Mark as PAID with paidAt — tickets are not created (gap condition)
    await db.order.update({
      where: { id: order.orderId },
      data: { status: 'PAID', paidAt: new Date() },
    })

    const result = await reconcile()

    expect(result.ticketGaps).toBe(1)
    expect(result.alerts).toBeGreaterThanOrEqual(1)

    const alert = await db.auditLog.findFirst({ where: { action: 'order.ticket_gap' } })
    expect(alert).not.toBeNull()
    expect((alert!.meta as Record<string, unknown>).severity).toBe('ALERT')
  })

  // Case 6 — Everything clean
  it('case 6: clean slate — all zeros, no ALERT', async () => {
    const result = await reconcile()

    expect(result).toEqual({ recoveredRefunds: 0, stuckWebhooks: 0, ticketGaps: 0, alerts: 0 })
  })

  // Case 7 — stderr format
  it('case 7: emits RECONCILE stderr line with correct format', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await reconcile()

    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/^RECONCILE recovered=\d+ stuckWebhooks=\d+ ticketGaps=\d+ alerts=\d+$/),
    )
    spy.mockRestore()
  })
})
