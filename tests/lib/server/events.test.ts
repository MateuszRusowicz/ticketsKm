import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import {
  CapacityBelowSoldError,
  createEvent,
  PriceChangeWhileHeldError,
  SlugTakenError,
  updateEvent,
} from '@/lib/server/events'

let actorId: string
let venueId: string

beforeEach(async () => {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "TicketType", "EventTranslation", "Event",
                   "Venue", "AdminUser" RESTART IDENTITY CASCADE
  `)
  const admin = await db.adminUser.create({
    data: { email: 'a@example.com', name: 'A', role: 'ADMIN', passwordHash: 'x' },
  })
  actorId = admin.id
  const venue = await db.venue.create({
    data: { name: 'V', address: 'A', city: 'C', defaultCapacity: 900 },
  })
  venueId = venue.id
})

function input(overrides: Partial<Parameters<typeof createEvent>[0]> = {}) {
  return {
    slug: 'wieczor-bachowski',
    venueId,
    startsAt: new Date('2026-08-14T17:00:00Z'),
    capacity: 900,
    status: 'DRAFT' as const,
    pricePln: 8000,
    priceEur: 1900,
    maxPerOrder: 10,
    translations: {
      pl: { title: 'Wieczór Bachowski', description: 'Opis', performers: 'J.S. Bach' },
      en: { title: 'Bach Evening', description: 'Description', performers: 'J.S. Bach' },
      de: { title: 'Bach-Abend', description: 'Beschreibung', performers: 'J.S. Bach' },
    },
    ...overrides,
  }
}

describe('createEvent', () => {
  it('creates the event with three translations and one ticket type', async () => {
    const event = await createEvent(input(), actorId)

    const stored = await db.event.findUniqueOrThrow({
      where: { id: event.id },
      include: { translations: true, ticketTypes: true },
    })

    expect(stored.translations).toHaveLength(3)
    expect(stored.ticketTypes).toHaveLength(1)
    expect(stored.ticketTypes[0].pricePln).toBe(8000)
    expect(stored.ticketTypes[0].priceEur).toBe(1900)
  })

  it('writes an audit entry', async () => {
    const event = await createEvent(input(), actorId)
    const entries = await db.auditLog.findMany({ where: { entityId: event.id } })
    expect(entries[0].action).toBe('event.create')
  })

  it('rejects a duplicate slug with a typed error', async () => {
    await createEvent(input(), actorId)
    await expect(createEvent(input(), actorId)).rejects.toBeInstanceOf(SlugTakenError)
  })
})

describe('updateEvent', () => {
  it('updates translations in place rather than duplicating them', async () => {
    const event = await createEvent(input(), actorId)

    await updateEvent(
      event.id,
      input({
        translations: {
          pl: { title: 'Zmieniony', description: 'Opis', performers: 'J.S. Bach' },
          en: { title: 'Bach Evening', description: 'Description', performers: 'J.S. Bach' },
          de: { title: 'Bach-Abend', description: 'Beschreibung', performers: 'J.S. Bach' },
        },
      }),
      actorId,
    )

    const stored = await db.event.findUniqueOrThrow({
      where: { id: event.id },
      include: { translations: true },
    })

    expect(stored.translations).toHaveLength(3)
    expect(stored.translations.find((t) => t.locale === 'pl')?.title).toBe('Zmieniony')
  })

  it('allows raising the capacity', async () => {
    const event = await createEvent(input({ capacity: 300 }), actorId)
    const updated = await updateEvent(event.id, input({ capacity: 500 }), actorId)
    expect(updated.capacity).toBe(500)
  })

  it('refuses to lower capacity below tickets already sold and held', async () => {
    const event = await createEvent(input({ capacity: 900 }), actorId)
    await db.ticketType.updateMany({
      where: { eventId: event.id },
      data: { soldCount: 400, heldCount: 20 },
    })

    await expect(updateEvent(event.id, input({ capacity: 300 }), actorId)).rejects.toBeInstanceOf(
      CapacityBelowSoldError,
    )
  })

  it('refuses a price change while tickets are held', async () => {
    const event = await createEvent(input(), actorId)
    await db.ticketType.updateMany({ where: { eventId: event.id }, data: { heldCount: 3 } })

    await expect(
      updateEvent(event.id, input({ pricePln: 9000 }), actorId),
    ).rejects.toBeInstanceOf(PriceChangeWhileHeldError)
  })

  it('allows a non-price change while tickets are held', async () => {
    const event = await createEvent(input(), actorId)
    await db.ticketType.updateMany({ where: { eventId: event.id }, data: { heldCount: 3 } })

    const updated = await updateEvent(event.id, input({ status: 'ON_SALE' }), actorId)
    expect(updated.status).toBe('ON_SALE')
  })

  it('allows lowering capacity to exactly the number sold and held', async () => {
    const event = await createEvent(input({ capacity: 900 }), actorId)
    await db.ticketType.updateMany({
      where: { eventId: event.id },
      data: { soldCount: 400, heldCount: 20 },
    })

    const updated = await updateEvent(event.id, input({ capacity: 420 }), actorId)
    expect(updated.capacity).toBe(420)
  })
})
