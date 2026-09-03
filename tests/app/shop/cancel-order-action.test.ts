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

import { cancelOrderAction } from '@/app/(shop)/[locale]/order/[reference]/actions'
import { db } from '@/lib/server/db'
import { createOrder } from '@/lib/server/orders'

let ticketTypeId: string

async function makeConcert() {
  const venue =
    (await db.venue.findFirst({ where: { name: 'Cancel test venue' } })) ??
    (await db.venue.create({
      data: { name: 'Cancel test venue', city: 'C', address: 'A', defaultCapacity: 100 },
    }))

  const event = await db.event.create({
    data: {
      slug: `cancel-test-${crypto.randomUUID()}`,
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

async function anOrder(email = 'buyer@example.test') {
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

async function heldCount() {
  const t = await db.ticketType.findUniqueOrThrow({
    where: { id: ticketTypeId },
    select: { heldCount: true },
  })
  return t.heldCount
}

beforeEach(async () => {
  ticketTypeId = await makeConcert()
})

describe('cancelOrderAction', () => {
  it('cancels and releases the hold when the token is correct', async () => {
    const order = await anOrder()
    expect(await heldCount()).toBe(2)

    await expect(cancelOrderAction({}, form(order.reference, order.accessToken))).rejects.toThrow(
      /^REDIRECT:\/pl\/order\/KM-/,
    )

    expect(await heldCount()).toBe(0)
    expect(await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).toMatchObject({
      status: 'CANCELLED',
    })
  })

  it('refuses a wrong token and changes nothing', async () => {
    // The reference is enumerable by design, so the token is the only thing
    // stopping a stranger releasing every hold in the festival.
    const order = await anOrder()

    const result = await cancelOrderAction({}, form(order.reference, crypto.randomUUID()))

    expect(result).toEqual({ errors: { _form: ['notFound'] } })
    expect(await heldCount()).toBe(2)
    expect(await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).toMatchObject({
      status: 'PENDING',
    })
  })

  it('refuses a malformed token without throwing', async () => {
    const order = await anOrder()

    await expect(cancelOrderAction({}, form(order.reference, 'x'))).resolves.toEqual({
      errors: { _form: ['notFound'] },
    })
    expect(await heldCount()).toBe(2)
  })

  it('gives an unknown reference the same answer as a wrong token', async () => {
    const result = await cancelOrderAction({}, form('KM-2026-999999', crypto.randomUUID()))

    expect(result).toEqual({ errors: { _form: ['notFound'] } })
  })

  it('releases exactly once when cancelled twice', async () => {
    const order = await anOrder()

    await cancelOrderAction({}, form(order.reference, order.accessToken)).catch(() => {})
    await cancelOrderAction({}, form(order.reference, order.accessToken)).catch(() => {})

    expect(await heldCount()).toBe(0)
  })
})
