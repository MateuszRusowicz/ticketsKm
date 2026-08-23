import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'

async function reset() {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog", "Ticket", "OrderItem", "Order", "PromoCode",
      "TicketType", "EventTranslation", "Event", "Venue",
      "AdminSession", "AdminUser", "StripeWebhookEvent"
    RESTART IDENTITY CASCADE
  `)
}

describe('schema', () => {
  beforeEach(reset)

  it('creates an event with translations and a ticket type', async () => {
    const venue = await db.venue.create({
      data: { name: 'Kościół Pokoju', address: 'Plac Pokoju 6', city: 'Świdnica', defaultCapacity: 900 },
    })

    const event = await db.event.create({
      data: {
        slug: 'bach-wieczor',
        venueId: venue.id,
        startsAt: new Date('2026-08-14T19:00:00Z'),
        capacity: 900,
        status: 'DRAFT',
        translations: {
          create: [
            { locale: 'pl', title: 'Wieczór Bachowski', description: 'Opis', performers: 'Kwartet' },
            { locale: 'de', title: 'Bach-Abend', description: 'Beschreibung', performers: 'Quartett' },
            { locale: 'en', title: 'Bach Evening', description: 'Description', performers: 'Quartet' },
          ],
        },
        ticketTypes: {
          create: [{ pricePln: 4900, priceEur: 1200, maxPerOrder: 10 }],
        },
      },
      include: { translations: true, ticketTypes: true },
    })

    expect(event.translations).toHaveLength(3)
    expect(event.ticketTypes[0].pricePln).toBe(4900)
    expect(event.ticketTypes[0].soldCount).toBe(0)
    expect(event.ticketTypes[0].heldCount).toBe(0)
  })

  it('rejects two translations for the same event and locale', async () => {
    const venue = await db.venue.create({
      data: { name: 'V', address: 'A', city: 'C', defaultCapacity: 300 },
    })
    const event = await db.event.create({
      data: { slug: 'dup', venueId: venue.id, startsAt: new Date(), capacity: 300 },
    })
    await db.eventTranslation.create({
      data: { eventId: event.id, locale: 'pl', title: 'A', description: 'x', performers: 'y' },
    })

    await expect(
      db.eventTranslation.create({
        data: { eventId: event.id, locale: 'pl', title: 'B', description: 'x', performers: 'y' },
      }),
    ).rejects.toThrow()
  })

  it('rejects a duplicate event slug', async () => {
    const venue = await db.venue.create({
      data: { name: 'V', address: 'A', city: 'C', defaultCapacity: 300 },
    })
    await db.event.create({ data: { slug: 'same', venueId: venue.id, startsAt: new Date(), capacity: 300 } })
    await expect(
      db.event.create({ data: { slug: 'same', venueId: venue.id, startsAt: new Date(), capacity: 300 } }),
    ).rejects.toThrow()
  })

  it('rejects a duplicate ticket code', async () => {
    const venue = await db.venue.create({
      data: { name: 'V', address: 'A', city: 'C', defaultCapacity: 300 },
    })
    const event = await db.event.create({
      data: {
        slug: 'codes',
        venueId: venue.id,
        startsAt: new Date(),
        capacity: 300,
        ticketTypes: { create: [{ pricePln: 1000, priceEur: 300 }] },
      },
      include: { ticketTypes: true },
    })
    const order = await db.order.create({
      data: {
        reference: 'KM-2026-000001',
        email: 'a@b.pl',
        firstName: 'A',
        lastName: 'B',
        locale: 'pl',
        currency: 'PLN',
        subtotal: 1000,
        discount: 0,
        total: 1000,
        status: 'PAID',
      },
    })
    const base = {
      orderId: order.id,
      eventId: event.id,
      ticketTypeId: event.ticketTypes[0].id,
    }
    await db.ticket.create({ data: { ...base, code: 'DUPLICATE' } })
    await expect(db.ticket.create({ data: { ...base, code: 'DUPLICATE' } })).rejects.toThrow()
  })

  it('rejects a duplicate Stripe webhook event id', async () => {
    await db.stripeWebhookEvent.create({ data: { stripeEventId: 'evt_1', type: 'payment_intent.succeeded' } })
    await expect(
      db.stripeWebhookEvent.create({ data: { stripeEventId: 'evt_1', type: 'payment_intent.succeeded' } }),
    ).rejects.toThrow()
  })
})
