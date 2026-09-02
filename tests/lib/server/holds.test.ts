import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import {
  HeldCountUnderflow,
  holdCapacity,
  InsufficientCapacityError,
  InvalidQuantityError,
  releaseCapacity,
} from '@/lib/server/holds'

let eventId: string
let ticketTypeId: string

async function makeEvent(capacity: number, soldCount = 0) {
  // Venue has no unique key other than id, so this is find-or-create rather
  // than an upsert.
  const venue =
    (await db.venue.findFirst({ where: { name: 'Holds test venue' } })) ??
    (await db.venue.create({
      data: {
        name: 'Holds test venue',
        city: 'Test',
        address: 'Test',
        defaultCapacity: 100,
      },
    }))

  const event = await db.event.create({
    data: {
      slug: `holds-test-${crypto.randomUUID()}`,
      venueId: venue.id,
      capacity,
      startsAt: new Date(Date.now() + 60 * 86_400_000),
      status: 'ON_SALE',
      translations: {
        create: (['pl', 'de', 'en'] as const).map((locale) => ({
          locale,
          title: 'Holds test',
          description: 'Holds test',
          performers: 'Holds test',
        })),
      },
      ticketTypes: { create: [{ pricePln: 5000, priceEur: 1200, soldCount }] },
    },
    select: { id: true, ticketTypes: { select: { id: true } } },
  })

  return { eventId: event.id, ticketTypeId: event.ticketTypes[0].id }
}

async function heldCount(id: string) {
  const t = await db.ticketType.findUniqueOrThrow({ where: { id }, select: { heldCount: true } })
  return t.heldCount
}

beforeEach(async () => {
  const made = await makeEvent(100)
  eventId = made.eventId
  ticketTypeId = made.ticketTypeId
})

describe('holdCapacity', () => {
  it('increases heldCount by exactly the quantity', async () => {
    await db.$transaction((tx) => holdCapacity({ ticketTypeId, eventId, quantity: 5, client: tx }))

    expect(await heldCount(ticketTypeId)).toBe(5)
  })

  it('refuses to push past capacity minus soldCount', async () => {
    const { eventId: e, ticketTypeId: t } = await makeEvent(10, 8)

    await expect(
      db.$transaction((tx) => holdCapacity({ ticketTypeId: t, eventId: e, quantity: 3, client: tx })),
    ).rejects.toThrow(InsufficientCapacityError)

    expect(await heldCount(t)).toBe(0)
  })

  it('reports what is actually available on the error', async () => {
    const { eventId: e, ticketTypeId: t } = await makeEvent(10, 8)
    expect.assertions(2)

    try {
      await db.$transaction((tx) =>
        holdCapacity({ ticketTypeId: t, eventId: e, quantity: 3, client: tx }),
      )
    } catch (err) {
      expect((err as InsufficientCapacityError).requested).toBe(3)
      expect((err as InsufficientCapacityError).available).toBe(2)
    }
  })

  it('fills the last remaining seat but not one more', async () => {
    const { eventId: e, ticketTypeId: t } = await makeEvent(10, 8)

    await db.$transaction((tx) => holdCapacity({ ticketTypeId: t, eventId: e, quantity: 2, client: tx }))
    expect(await heldCount(t)).toBe(2)

    await expect(
      db.$transaction((tx) => holdCapacity({ ticketTypeId: t, eventId: e, quantity: 1, client: tx })),
    ).rejects.toThrow(InsufficientCapacityError)
  })

  it('refuses when the ticket type is inactive', async () => {
    await db.ticketType.update({ where: { id: ticketTypeId }, data: { active: false } })

    await expect(
      db.$transaction((tx) => holdCapacity({ ticketTypeId, eventId, quantity: 1, client: tx })),
    ).rejects.toThrow(InsufficientCapacityError)

    expect(await heldCount(ticketTypeId)).toBe(0)
  })

  it('rejects a non-positive quantity as a caller bug, distinctly', async () => {
    await expect(
      db.$transaction((tx) => holdCapacity({ ticketTypeId, eventId, quantity: 0, client: tx })),
    ).rejects.toThrow(InvalidQuantityError)

    await expect(
      db.$transaction((tx) => holdCapacity({ ticketTypeId, eventId, quantity: -3, client: tx })),
    ).rejects.toThrow(InvalidQuantityError)
  })

  it('reverts when the surrounding transaction rolls back', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await holdCapacity({ ticketTypeId, eventId, quantity: 5, client: tx })
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')

    expect(await heldCount(ticketTypeId)).toBe(0)
  })

  it('reads capacity from Event inside the SQL, not from a stale caller value', async () => {
    // The race the JOIN exists to close: capacity is lowered after a caller
    // would have read it. If capacity were passed in as a JS argument, this
    // hold would succeed against the old value and oversell.
    await db.$transaction((tx) => holdCapacity({ ticketTypeId, eventId, quantity: 90, client: tx }))
    await db.event.update({ where: { id: eventId }, data: { capacity: 92 } })

    await expect(
      db.$transaction((tx) => holdCapacity({ ticketTypeId, eventId, quantity: 5, client: tx })),
    ).rejects.toThrow(InsufficientCapacityError)

    expect(await heldCount(ticketTypeId)).toBe(90)
  })
})

describe('releaseCapacity', () => {
  it('decrements by exactly the quantity', async () => {
    await db.$transaction((tx) => holdCapacity({ ticketTypeId, eventId, quantity: 5, client: tx }))
    await db.$transaction((tx) => releaseCapacity({ ticketTypeId, quantity: 2, client: tx }))

    expect(await heldCount(ticketTypeId)).toBe(3)
  })

  it('surfaces drift as HeldCountUnderflow rather than clamping it away', async () => {
    // No GREATEST(x - n, 0): a double-decrement is a real bug, and the CHECK
    // constraint is how we hear about it. Clamping would silently manufacture
    // capacity that nobody paid for.
    await db.$transaction((tx) => holdCapacity({ ticketTypeId, eventId, quantity: 2, client: tx }))

    await expect(
      db.$transaction((tx) => releaseCapacity({ ticketTypeId, quantity: 5, client: tx })),
    ).rejects.toThrow(HeldCountUnderflow)

    expect(await heldCount(ticketTypeId)).toBe(2)
  })

  it('is a no-op for an unknown ticket type and creates nothing', async () => {
    const before = await db.ticketType.count()

    await db.$transaction((tx) =>
      releaseCapacity({ ticketTypeId: crypto.randomUUID(), quantity: 1, client: tx }),
    )

    expect(await db.ticketType.count()).toBe(before)
  })
})
