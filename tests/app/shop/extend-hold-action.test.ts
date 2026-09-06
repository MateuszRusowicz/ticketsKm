import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => void 0, delete: () => void 0 }),
  headers: async () => ({ get: () => '127.0.0.1' }),
}))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`)
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: () => void 0 }))

// ---------------------------------------------------------------------------
// Hoisted mocks — TDZ-safe (vi.hoisted runs before module evaluation)
// ---------------------------------------------------------------------------
const { mockCreatePaymentIntent, MockPaymentIntentReuseError } = vi.hoisted(() => {
  class MockPaymentIntentReuseError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'PaymentIntentReuseError'
    }
  }
  return {
    mockCreatePaymentIntent: vi.fn(),
    MockPaymentIntentReuseError,
  }
})

vi.mock('@/lib/server/payment-intent', () => ({
  createPaymentIntent: mockCreatePaymentIntent,
  PaymentIntentReuseError: MockPaymentIntentReuseError,
}))

import { extendHoldAction } from '@/app/(shop)/[locale]/order/[reference]/actions'
import { db } from '@/lib/server/db'
import { createOrder } from '@/lib/server/orders'

const PI_RESPONSE = {
  clientSecret: 'pi_test_cs_001',
  paymentIntentId: 'pi_test_001',
  publishableKey: 'pk_test_dummy',
}

let ticketTypeId: string

async function makeConcert() {
  const venue =
    (await db.venue.findFirst({ where: { name: 'ExtendHold test venue' } })) ??
    (await db.venue.create({
      data: { name: 'ExtendHold test venue', city: 'C', address: 'A', defaultCapacity: 100 },
    }))

  const event = await db.event.create({
    data: {
      slug: `extend-hold-test-${crypto.randomUUID()}`,
      venueId: venue.id,
      capacity: 100,
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
    select: { ticketTypes: { select: { id: true } } },
  })

  return event.ticketTypes[0].id
}

async function anOrder(email = 'extend-hold@example.test') {
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

function form(reference: string, token: string) {
  const fd = new FormData()
  fd.set('reference', reference)
  fd.set('accessToken', token)
  return fd
}

beforeEach(async () => {
  ticketTypeId = await makeConcert()
  mockCreatePaymentIntent.mockReset()
  mockCreatePaymentIntent.mockResolvedValue(PI_RESPONSE)
})

describe('extendHoldAction — hold extension and status checks', () => {
  it('happy path — returns clientSecret, publishableKey and paymentIntentId', async () => {
    const order = await anOrder()

    const result = await extendHoldAction({}, form(order.reference, order.accessToken))

    expect(result).toEqual(PI_RESPONSE)
    expect(mockCreatePaymentIntent).toHaveBeenCalledOnce()
    expect(mockCreatePaymentIntent).toHaveBeenCalledWith(order.orderId)
  })

  it('wrong token — returns notFound without calling createPaymentIntent', async () => {
    const order = await anOrder()

    const result = await extendHoldAction({}, form(order.reference, crypto.randomUUID()))

    expect(result).toEqual({ errors: { _form: ['notFound'] } })
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled()
  })

  it('unknown reference — returns notFound', async () => {
    const result = await extendHoldAction({}, form('KM-2026-999999', crypto.randomUUID()))

    expect(result).toEqual({ errors: { _form: ['notFound'] } })
  })

  it('EXPIRED order — returns notPendingEXPIRED without calling createPaymentIntent', async () => {
    const order = await anOrder()
    await db.order.update({ where: { id: order.orderId }, data: { status: 'EXPIRED' } })

    const result = await extendHoldAction({}, form(order.reference, order.accessToken))

    expect(result).toEqual({ errors: { _form: ['notPendingEXPIRED'] } })
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled()
  })

  it('CANCELLED order — returns notPendingCANCELLED without calling createPaymentIntent', async () => {
    const order = await anOrder()
    await db.order.update({ where: { id: order.orderId }, data: { status: 'CANCELLED' } })

    const result = await extendHoldAction({}, form(order.reference, order.accessToken))

    expect(result).toEqual({ errors: { _form: ['notPendingCANCELLED'] } })
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled()
  })

  it('holdExpiresAt is extended in DB when the hold would otherwise expire soon', async () => {
    const order = await anOrder()

    // Set holdExpiresAt to 1 minute from now so PAY_CLICK_HOLD_EXTENSION_MS (15 min) extends it.
    const nearExpiry = new Date(Date.now() + 60 * 1000)
    await db.order.update({ where: { id: order.orderId }, data: { holdExpiresAt: nearExpiry } })

    await extendHoldAction({}, form(order.reference, order.accessToken))

    const after = await db.order.findUniqueOrThrow({
      where: { id: order.orderId },
      select: { holdExpiresAt: true },
    })
    // After extension, holdExpiresAt must be beyond the 1-minute near-expiry we set.
    expect(after.holdExpiresAt?.getTime()).toBeGreaterThan(nearExpiry.getTime())
  })
})
