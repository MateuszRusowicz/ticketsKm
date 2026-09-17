import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/server/db'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any import that pulls stripe,
// because vi.hoisted lifts the factory to the top of the compiled file,
// before all ES imports.
// ---------------------------------------------------------------------------

const { paymentIntentsRetrieve } = vi.hoisted(() => ({
  paymentIntentsRetrieve: vi.fn(),
}))

vi.mock('@/lib/server/stripe', () => ({
  stripe: {
    paymentIntents: {
      retrieve: paymentIntentsRetrieve,
    },
  },
}))

// Import under-test AFTER vi.mock calls
import { getOrderForConfirmation } from '@/lib/server/order-lookup'
import { createOrder } from '@/lib/server/orders'

// ---------------------------------------------------------------------------
// DB helpers — replicated from order-lookup.test.ts; each file needs its
// own setup because vi.mock scoping makes sharing a concert fixture unsafe.
// ---------------------------------------------------------------------------

let ticketTypeId: string

async function makeConcert() {
  const venue =
    (await db.venue.findFirst({ where: { name: 'Stripe lookup test venue' } })) ??
    (await db.venue.create({
      data: { name: 'Stripe lookup test venue', city: 'C', address: 'A', defaultCapacity: 100 },
    }))

  const event = await db.event.create({
    data: {
      slug: `stripe-lookup-${crypto.randomUUID()}`,
      venueId: venue.id,
      capacity: 100,
      startsAt: new Date(Date.now() + 60 * 86_400_000),
      status: 'ON_SALE',
      translations: {
        create: (['pl', 'de', 'en'] as const).map((locale) => ({
          locale,
          title: `Koncert ${locale}`,
          description: 'D',
          performers: 'P',
        })),
      },
      ticketTypes: { create: [{ pricePln: 5000, priceEur: 1200 }] },
    },
    select: { ticketTypes: { select: { id: true } } },
  })

  return event.ticketTypes[0].id
}

async function anOrder() {
  return createOrder({
    ticketTypeId,
    quantity: 1,
    locale: 'pl',
    currency: 'PLN',
    email: `buyer-${crypto.randomUUID()}@stripe-lookup.test`,
    firstName: 'Jan',
    lastName: 'Kowalski',
    attendeeNames: ['Jan Kowalski'],
    needsInvoice: false,
    acceptedTerms: true,
  })
}

beforeEach(async () => {
  // Same TRUNCATE pattern as payment-intent.test.ts to guarantee a clean
  // slate regardless of what other test files leave behind. The sequence
  // reset ensures generated references never collide with stale rows.
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "OrderItem", "Order", "TicketType",
                   "EventTranslation", "Event", "Venue"
    RESTART IDENTITY CASCADE
  `)
  await db.$executeRawUnsafe('ALTER SEQUENCE "order_reference_seq" RESTART')

  ticketTypeId = await makeConcert()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getOrderForConfirmation — live Stripe status lookup', () => {
  it('PENDING + PI succeeded → processing band (the post-redirect race)', async () => {
    // Simulates the race: buyer pays by card, Stripe redirect returns before
    // the webhook. Stored paymentIntentStatus is still 'requires_confirmation'
    // but the real PI status is 'succeeded'.
    const created = await anOrder()
    const piId = `pi_test_${crypto.randomUUID().replace(/-/g, '')}`
    await db.order.update({
      where: { id: created.orderId },
      data: { stripePaymentIntentId: piId, paymentIntentStatus: 'requires_confirmation' },
    })
    paymentIntentsRetrieve.mockResolvedValueOnce({ id: piId, status: 'succeeded' })

    const found = await getOrderForConfirmation(created.reference, created.accessToken, 'pl')

    expect(found!.band).toBe('processing')
    expect(paymentIntentsRetrieve).toHaveBeenCalledOnce()
    expect(paymentIntentsRetrieve).toHaveBeenCalledWith(piId)
  })

  it('PENDING + PI requires_confirmation → holding band (abandoned buyer can retry)', async () => {
    // Proves the trap is avoided: a buyer who clicked Pay but never entered
    // card details has stripePaymentIntentId set and paymentIntentStatus =
    // 'requires_confirmation'. Stripe's real status is also 'requires_confirmation'.
    // They must see 'holding' so they can retry, NOT 'processing' (which would
    // show the spinner forever with no way out).
    const created = await anOrder()
    const piId = `pi_test_${crypto.randomUUID().replace(/-/g, '')}`
    await db.order.update({
      where: { id: created.orderId },
      data: { stripePaymentIntentId: piId, paymentIntentStatus: 'requires_confirmation' },
    })
    paymentIntentsRetrieve.mockResolvedValueOnce({ id: piId, status: 'requires_confirmation' })

    const found = await getOrderForConfirmation(created.reference, created.accessToken, 'pl')

    expect(found!.band).toBe('holding')
  })

  it('PENDING + no PI → holding band, Stripe not called', async () => {
    // When there is no stripePaymentIntentId, the buyer has not yet clicked
    // Pay at all. No Stripe API call must be made.
    const created = await anOrder()
    // stripePaymentIntentId is null by default on a freshly created order

    const found = await getOrderForConfirmation(created.reference, created.accessToken, 'pl')

    expect(found!.band).toBe('holding')
    expect(paymentIntentsRetrieve).not.toHaveBeenCalled()
  })

  it('PAID → paid band, Stripe not called', async () => {
    // Non-PENDING orders must never trigger a Stripe call — the stored band
    // is authoritative and there is no PI status to reconcile.
    const created = await anOrder()
    const piId = `pi_test_${crypto.randomUUID().replace(/-/g, '')}`
    await db.order.update({
      where: { id: created.orderId },
      data: { status: 'PAID', stripePaymentIntentId: piId },
    })

    const found = await getOrderForConfirmation(created.reference, created.accessToken, 'pl')

    expect(found!.band).toBe('paid')
    expect(paymentIntentsRetrieve).not.toHaveBeenCalled()
  })

  it('Stripe throws → falls back to stored-mirror band, page still renders', async () => {
    // If Stripe is unreachable (network, rate limit), the page must not error
    // out. Fall back to the stored mirror: PENDING + requires_confirmation
    // with a valid hold renders as 'holding'.
    const created = await anOrder()
    const piId = `pi_test_${crypto.randomUUID().replace(/-/g, '')}`
    await db.order.update({
      where: { id: created.orderId },
      data: { stripePaymentIntentId: piId, paymentIntentStatus: 'requires_confirmation' },
    })
    paymentIntentsRetrieve.mockRejectedValueOnce(new Error('Stripe network error'))

    const found = await getOrderForConfirmation(created.reference, created.accessToken, 'pl')

    // Page must still render with the stored-mirror band
    expect(found).not.toBeNull()
    // PENDING + stored paymentIntentStatus 'requires_confirmation' with valid hold → holding
    expect(found!.band).toBe('holding')
  })
})
