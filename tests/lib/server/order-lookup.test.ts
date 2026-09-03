import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import { getOrderForConfirmation } from '@/lib/server/order-lookup'
import { createOrder } from '@/lib/server/orders'

let ticketTypeId: string

async function makeConcert() {
  const venue =
    (await db.venue.findFirst({ where: { name: 'Lookup test venue' } })) ??
    (await db.venue.create({
      data: { name: 'Lookup test venue', city: 'C', address: 'A', defaultCapacity: 100 },
    }))

  const event = await db.event.create({
    data: {
      slug: `lookup-test-${crypto.randomUUID()}`,
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

beforeEach(async () => {
  ticketTypeId = await makeConcert()
})

describe('getOrderForConfirmation', () => {
  it('returns the order for a correct reference and token', async () => {
    const created = await anOrder()

    const found = await getOrderForConfirmation(created.reference, created.accessToken, 'pl')

    expect(found).not.toBeNull()
    expect(found!.order.reference).toBe(created.reference)
    expect(found!.band).toBe('holding')
    expect(found!.event.title).toBe('Koncert pl')
  })

  it('returns null when the token is wrong but the reference is right', async () => {
    const created = await anOrder()

    const found = await getOrderForConfirmation(created.reference, crypto.randomUUID(), 'pl')

    expect(found).toBeNull()
  })

  it('returns null for a token of a different length rather than throwing', async () => {
    // timingSafeEqual throws on unequal buffer lengths, and the token comes
    // straight from a user-controlled query string.
    const created = await anOrder()

    await expect(getOrderForConfirmation(created.reference, 'short', 'pl')).resolves.toBeNull()
    await expect(getOrderForConfirmation(created.reference, '', 'pl')).resolves.toBeNull()
  })

  it('returns null for an unknown reference', async () => {
    await expect(
      getOrderForConfirmation('KM-2026-999999', crypto.randomUUID(), 'pl'),
    ).resolves.toBeNull()
  })

  it('reports a lapsed hold as expired', async () => {
    const created = await anOrder()
    await db.order.update({
      where: { id: created.orderId },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    })

    const found = await getOrderForConfirmation(created.reference, created.accessToken, 'pl')

    expect(found!.band).toBe('expired')
  })

  it.each([
    ['CANCELLED', 'cancelled'],
    ['EXPIRED', 'cancelled'],
    ['FAILED', 'cancelled'],
    ['PAID', 'paid'],
  ] as const)('maps %s to the %s band', async (status, band) => {
    const created = await anOrder()
    await db.order.update({ where: { id: created.orderId }, data: { status } })

    const found = await getOrderForConfirmation(created.reference, created.accessToken, 'pl')

    expect(found!.band).toBe(band)
  })

  it('does not expose attendee names', async () => {
    const created = await anOrder()

    const found = await getOrderForConfirmation(created.reference, created.accessToken, 'pl')

    expect(JSON.stringify(found)).not.toContain('attendeeNames')
  })
})
