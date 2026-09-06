/**
 * Tests for extendHoldAction — PI error handling and additional non-PENDING
 * status codes not covered by extend-hold-action.test.ts.
 *
 * The action is the single entry-point for the Pay button: it extends the
 * hold AND creates the PaymentIntent in one round-trip. This file focuses
 * on what happens when createPaymentIntent throws and on PAID/FAILED/REFUNDED
 * order statuses (unreachable from the status guard but reachable via the
 * PaymentIntentReuseError path).
 */
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
// Hoisted mocks — TDZ-safe
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

let ticketTypeId: string

async function makeConcert() {
  const venue =
    (await db.venue.findFirst({ where: { name: 'StartPayment test venue' } })) ??
    (await db.venue.create({
      data: { name: 'StartPayment test venue', city: 'C', address: 'A', defaultCapacity: 100 },
    }))

  const event = await db.event.create({
    data: {
      slug: `start-payment-test-${crypto.randomUUID()}`,
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

async function anOrder(email = 'start-pay@example.test') {
  return createOrder({
    ticketTypeId,
    quantity: 2,
    locale: 'pl',
    currency: 'PLN',
    email,
    firstName: 'Anna',
    lastName: 'Nowak',
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
})

describe('extendHoldAction — PI error handling', () => {
  it('piReuseAlreadyPaid — createPaymentIntent throws alreadyPaid', async () => {
    const order = await anOrder()
    mockCreatePaymentIntent.mockRejectedValueOnce(new MockPaymentIntentReuseError('alreadyPaid'))

    const result = await extendHoldAction({}, form(order.reference, order.accessToken))

    expect(result).toEqual({ errors: { _form: ['piReuseAlreadyPaid'] } })
  })

  it('piReuseNotPending — createPaymentIntent throws notPending', async () => {
    const order = await anOrder()
    mockCreatePaymentIntent.mockRejectedValueOnce(new MockPaymentIntentReuseError('notPending'))

    const result = await extendHoldAction({}, form(order.reference, order.accessToken))

    expect(result).toEqual({ errors: { _form: ['piReuseNotPending'] } })
  })

  it('PAID order — returns notPendingPAID via status guard', async () => {
    const order = await anOrder()
    await db.order.update({ where: { id: order.orderId }, data: { status: 'PAID' } })

    const result = await extendHoldAction({}, form(order.reference, order.accessToken))

    expect(result).toEqual({ errors: { _form: ['notPendingPAID'] } })
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled()
  })

  it('FAILED order — returns notPendingFAILED via status guard', async () => {
    const order = await anOrder()
    await db.order.update({ where: { id: order.orderId }, data: { status: 'FAILED' } })

    const result = await extendHoldAction({}, form(order.reference, order.accessToken))

    expect(result).toEqual({ errors: { _form: ['notPendingFAILED'] } })
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled()
  })

  it('REFUNDED order — returns notPendingREFUNDED via status guard', async () => {
    const order = await anOrder()
    await db.order.update({ where: { id: order.orderId }, data: { status: 'REFUNDED' } })

    const result = await extendHoldAction({}, form(order.reference, order.accessToken))

    expect(result).toEqual({ errors: { _form: ['notPendingREFUNDED'] } })
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled()
  })

  it('malformed token (too short) — returns notFound without throwing', async () => {
    const order = await anOrder()

    const result = await extendHoldAction({}, form(order.reference, 'x'))

    expect(result).toEqual({ errors: { _form: ['notFound'] } })
  })
})
