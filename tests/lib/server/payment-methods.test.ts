import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import { computeAllowedPaymentMethods } from '@/lib/server/payment-methods'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeConcert(
  overrides: {
    capacity?: number
    currency?: 'PLN' | 'EUR'
    soldCount?: number
    heldCount?: number
  } = {},
) {
  const capacity = overrides.capacity ?? 100

  const venue =
    (await db.venue.findFirst({ where: { name: 'PayMethods test venue' } })) ??
    (await db.venue.create({
      data: { name: 'PayMethods test venue', city: 'Test', address: 'Test', defaultCapacity: 100 },
    }))

  const event = await db.event.create({
    data: {
      slug: `paymethods-test-${crypto.randomUUID()}`,
      venueId: venue.id,
      capacity,
      startsAt: new Date(Date.now() + 60 * 86_400_000),
      status: 'ON_SALE',
      translations: {
        create: (['pl', 'de', 'en'] as const).map((locale) => ({
          locale,
          title: 'PayMethods test',
          description: 'PayMethods test',
          performers: 'PayMethods test',
        })),
      },
      ticketTypes: {
        create: [
          {
            pricePln: 5000,
            priceEur: 1200,
            soldCount: overrides.soldCount ?? 0,
            heldCount: overrides.heldCount ?? 0,
            maxPerOrder: 10,
          },
        ],
      },
    },
    select: { id: true, ticketTypes: { select: { id: true } } },
  })

  return { eventId: event.id, ticketTypeId: event.ticketTypes[0].id, capacity }
}

async function makeOrder(
  ticketTypeId: string,
  overrides: {
    currency?: 'PLN' | 'EUR'
    email?: string
    paymentIntentStatus?: string | null
    paymentMethodType?: string | null
    status?: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'FAILED'
    quantity?: number
  } = {},
) {
  const currency = overrides.currency ?? 'PLN'
  const quantity = overrides.quantity ?? 1

  const order = await db.order.create({
    data: {
      reference: `TEST-${crypto.randomUUID()}`,
      kind: 'PURCHASE',
      email: overrides.email ?? `buyer-${crypto.randomUUID()}@example.test`,
      firstName: 'Test',
      lastName: 'Buyer',
      locale: 'pl',
      currency,
      subtotal: 5000,
      discount: 0,
      total: 5000,
      status: overrides.status ?? 'PENDING',
      attendeeNames: [{ index: 0, name: 'Test' }],
      holdExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      paymentIntentStatus: overrides.paymentIntentStatus ?? null,
      paymentMethodType: overrides.paymentMethodType ?? null,
      items: {
        create: [{ ticketTypeId, quantity, unitPrice: 5000, currency }],
      },
    },
    select: { id: true },
  })

  return order.id
}

// Create N in-flight SEPA orders for an event
async function makeSepaInFlightOrders(
  ticketTypeId: string,
  count: number,
  status = 'processing',
) {
  for (let i = 0; i < count; i++) {
    await makeOrder(ticketTypeId, {
      currency: 'EUR',
      email: `sepa-${crypto.randomUUID()}@example.test`,
      paymentIntentStatus: status,
      paymentMethodType: 'sepa_debit',
    })
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "OrderItem", "Order", "TicketType",
                   "EventTranslation", "Event", "Venue"
    RESTART IDENTITY CASCADE
  `)
  await db.$executeRawUnsafe('ALTER SEQUENCE "order_reference_seq" RESTART')
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeAllowedPaymentMethods', () => {
  // Case 1 — PLN order, plenty of capacity, no in-flight
  it('returns card + blik + p24 for a PLN order with plenty of capacity', async () => {
    const { ticketTypeId } = await makeConcert({ capacity: 100 })
    const orderId = await makeOrder(ticketTypeId, { currency: 'PLN' })

    const methods = await computeAllowedPaymentMethods(orderId)

    expect(methods).toContain('card')
    expect(methods).toContain('blik')
    expect(methods).toContain('p24')
    expect(methods).not.toContain('sepa_debit')
    expect(methods).not.toContain('klarna')
  })

  // Case 2 — EUR, plenty of capacity, no in-flight SEPA → SEPA included
  it('returns card + klarna + sepa_debit for a EUR order with plenty of capacity', async () => {
    const { ticketTypeId } = await makeConcert({ capacity: 100 })
    const orderId = await makeOrder(ticketTypeId, { currency: 'EUR' })

    const methods = await computeAllowedPaymentMethods(orderId)

    expect(methods).toContain('card')
    expect(methods).toContain('klarna')
    expect(methods).toContain('sepa_debit')
    expect(methods).not.toContain('blik')
    expect(methods).not.toContain('p24')
  })

  // Case 3 — EUR, SEPA cap reached (10% of capacity in-flight SEPA)
  it('drops sepa_debit when SEPA cap is reached', async () => {
    // capacity=100, SEPA_HOLD_CAP_SHARE=0.10, cap=10
    // Create 10 in-flight SEPA orders — cap exactly hit
    const { ticketTypeId } = await makeConcert({ capacity: 100 })
    await makeSepaInFlightOrders(ticketTypeId, 10, 'processing')
    const orderId = await makeOrder(ticketTypeId, { currency: 'EUR' })

    const methods = await computeAllowedPaymentMethods(orderId)

    expect(methods).toContain('card')
    expect(methods).toContain('klarna')
    expect(methods).not.toContain('sepa_debit')
  })

  // Case 4 — EUR, near-sellout (available <= floor(capacity * 0.20))
  it('drops sepa_debit when near sellout', async () => {
    // capacity=100, threshold=0.20, floor=20
    // available = capacity - soldCount - heldCount = 100 - 85 - 0 = 15 <= 20 → hide SEPA
    const { ticketTypeId } = await makeConcert({ capacity: 100, soldCount: 85 })
    const orderId = await makeOrder(ticketTypeId, { currency: 'EUR' })

    const methods = await computeAllowedPaymentMethods(orderId)

    expect(methods).toContain('card')
    expect(methods).toContain('klarna')
    expect(methods).not.toContain('sepa_debit')
  })

  // Case 5 — PLN, near-sellout → SEPA not applicable anyway, PLN methods unchanged
  it('still returns card + blik + p24 for PLN near-sellout', async () => {
    const { ticketTypeId } = await makeConcert({ capacity: 100, soldCount: 85 })
    const orderId = await makeOrder(ticketTypeId, { currency: 'PLN' })

    const methods = await computeAllowedPaymentMethods(orderId)

    expect(methods).toContain('card')
    expect(methods).toContain('blik')
    expect(methods).toContain('p24')
    expect(methods).not.toContain('sepa_debit')
  })

  // Case 6 — EUR, tiny concert (capacity 5, cap floor = 0) → SEPA allowed unconditionally
  it('allows sepa_debit for a tiny concert even with in-flight SEPA', async () => {
    // capacity=5, SEPA_HOLD_CAP_SHARE=0.10, sepaCap = floor(5*0.10) = floor(0.5) = 0
    // The floor guard: sepaCap >= 1 is false → skip the count → SEPA allowed
    const { ticketTypeId } = await makeConcert({ capacity: 5 })
    // Add 1 in-flight SEPA — would block if floor guard weren't there
    await makeSepaInFlightOrders(ticketTypeId, 1, 'processing')
    const orderId = await makeOrder(ticketTypeId, { currency: 'EUR' })

    const methods = await computeAllowedPaymentMethods(orderId)

    expect(methods).toContain('sepa_debit')
  })

  // Case 7 — EUR, cap counts requires_confirmation, not just processing
  it('counts requires_confirmation status when computing SEPA cap', async () => {
    // capacity=100, cap=10; create 10 in requires_confirmation state
    const { ticketTypeId } = await makeConcert({ capacity: 100 })
    await makeSepaInFlightOrders(ticketTypeId, 10, 'requires_confirmation')
    const orderId = await makeOrder(ticketTypeId, { currency: 'EUR' })

    const methods = await computeAllowedPaymentMethods(orderId)

    // Cap hit by requires_confirmation orders → SEPA blocked
    expect(methods).not.toContain('sepa_debit')
  })

  // Case 8 — Order does not exist → throws Prisma P2025
  it('throws when the order does not exist', async () => {
    await expect(
      computeAllowedPaymentMethods('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow()
  })
})
