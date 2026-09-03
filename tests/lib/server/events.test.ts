import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import {
  CapacityBelowSoldError,
  createEvent,
  PriceChangeWhileHeldError,
  SlugTakenError,
  updateEvent,
} from '@/lib/server/events'
import { createOrder } from '@/lib/server/orders'

let actorId: string
let venueId: string

beforeEach(async () => {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "OrderItem", "Order", "TicketType",
                   "EventTranslation", "Event", "Venue", "AdminUser"
    RESTART IDENTITY CASCADE
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

const FUTURE = new Date(Date.now() + 60 * 86_400_000)

describe('updateEvent — cancelling a concert releases its holds', () => {
  async function onSaleEventWithHolds(orderCount: number) {
    // startsAt must be overridden: the shared input() helper pins it to
    // 2026-08-14, which is in the past, and getPublicEvent filters past
    // concerts out — so createOrder would see 'unknown'.
    const event = await createEvent(
      input({ slug: 'do-odwolania', status: 'ON_SALE', capacity: 100, startsAt: FUTURE }),
      actorId,
    )
    const ticketType = await db.ticketType.findFirstOrThrow({ where: { eventId: event.id } })

    for (let i = 0; i < orderCount; i++) {
      await createOrder({
        ticketTypeId: ticketType.id,
        quantity: 2,
        locale: 'pl',
        currency: 'PLN',
        // Distinct buyers: same-email orders would dedupe into one.
        email: `buyer${i}@example.test`,
        firstName: 'Jan',
        lastName: 'Kowalski',
        attendeeNames: ['A', 'B'],
        needsInvoice: false,
        acceptedTerms: true,
      })
    }

    return { event, ticketTypeId: ticketType.id }
  }

  it('cancels every PENDING order and returns the seats', async () => {
    const { event, ticketTypeId } = await onSaleEventWithHolds(3)

    expect(
      (await db.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } })).heldCount,
    ).toBe(6)

    await updateEvent(
      event.id,
      input({ slug: 'do-odwolania', status: 'CANCELLED', capacity: 100, startsAt: FUTURE }),
      actorId,
    )

    const orders = await db.order.findMany({ where: { items: { some: { ticketTypeId } } } })
    expect(orders).toHaveLength(3)
    for (const order of orders) expect(order.status).toBe('CANCELLED')

    expect(
      (await db.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } })).heldCount,
    ).toBe(0)

    const cancels = await db.auditLog.findMany({ where: { action: 'order.cancel' } })
    expect(cancels).toHaveLength(3)
    expect(cancels[0].meta).toMatchObject({ reason: 'event_cancelled' })
  })

  it('cancels cleanly when the concert has no outstanding holds', async () => {
    const event = await createEvent(
      input({ slug: 'puste-odwolanie', status: 'ON_SALE', capacity: 100, startsAt: FUTURE }),
      actorId,
    )

    await expect(
      updateEvent(
        event.id,
        input({ slug: 'puste-odwolanie', status: 'CANCELLED', capacity: 100, startsAt: FUTURE }),
        actorId,
      ),
    ).resolves.toBeDefined()

    expect(await db.auditLog.count({ where: { action: 'order.cancel' } })).toBe(0)
  })

  it('does not touch orders when the status change is not a cancellation', async () => {
    const { event, ticketTypeId } = await onSaleEventWithHolds(2)

    await updateEvent(
      event.id,
      input({ slug: 'do-odwolania', status: 'CLOSED', capacity: 100, startsAt: FUTURE }),
      actorId,
    )

    expect(
      (await db.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } })).heldCount,
    ).toBe(4)
    expect(await db.auditLog.count({ where: { action: 'order.cancel' } })).toBe(0)
  })
})
