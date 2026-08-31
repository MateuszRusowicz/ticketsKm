import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import { getPublicEvent, listPublicEvents } from '@/lib/server/public-events'
import type { EventStatus } from '@/generated/prisma/client'

let venueId: string

const DAY = 86_400_000
const inDays = (n: number) => new Date(Date.now() + n * DAY)

beforeEach(async () => {
  // One database, sequential files, residue breaks exact-count assertions.
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "Ticket", "OrderItem", "Order", "PromoCode",
                   "TicketType", "EventTranslation", "Event", "Venue"
    RESTART IDENTITY CASCADE
  `)
  const venue = await db.venue.create({
    data: { name: 'Kościół Pokoju', address: 'Plac Pokoju 6', city: 'Świdnica', defaultCapacity: 900 },
  })
  venueId = venue.id
})

async function makeEvent(opts: {
  slug: string
  status?: EventStatus
  startsAt?: Date
  capacity?: number
  salesOpenAt?: Date | null
  salesCloseAt?: Date | null
  soldCount?: number
  heldCount?: number
  active?: boolean
}) {
  return db.event.create({
    data: {
      slug: opts.slug,
      venueId,
      startsAt: opts.startsAt ?? inDays(30),
      capacity: opts.capacity ?? 900,
      status: opts.status ?? 'ON_SALE',
      salesOpenAt: opts.salesOpenAt ?? null,
      salesCloseAt: opts.salesCloseAt ?? null,
      translations: {
        create: [
          { locale: 'pl', title: `PL ${opts.slug}`, description: 'Opis', performers: 'Wykonawcy' },
          { locale: 'en', title: `EN ${opts.slug}`, description: 'Desc', performers: 'Performers' },
          { locale: 'de', title: `DE ${opts.slug}`, description: 'Beschr', performers: 'Künstler' },
        ],
      },
      ticketTypes: {
        create: [
          {
            pricePln: 8000,
            priceEur: 1900,
            maxPerOrder: 10,
            soldCount: opts.soldCount ?? 0,
            heldCount: opts.heldCount ?? 0,
            active: opts.active ?? true,
          },
        ],
      },
    },
  })
}

describe('listPublicEvents — what is visible at all', () => {
  it('omits DRAFT concerts', async () => {
    await makeEvent({ slug: 'draft', status: 'DRAFT' })
    expect(await listPublicEvents('pl')).toHaveLength(0)
  })

  it('omits CANCELLED concerts', async () => {
    await makeEvent({ slug: 'cancelled', status: 'CANCELLED' })
    expect(await listPublicEvents('pl')).toHaveLength(0)
  })

  it('omits concerts that have already happened', async () => {
    // Without this the programme keeps advertising last year's festival.
    await makeEvent({ slug: 'past', startsAt: inDays(-1) })
    expect(await listPublicEvents('pl')).toHaveLength(0)
  })

  it('lists SOLD_OUT concerts — people still want to see the programme', async () => {
    await makeEvent({ slug: 'sold-out', status: 'SOLD_OUT', soldCount: 900 })
    expect(await listPublicEvents('pl')).toHaveLength(1)
  })

  it('lists CLOSED concerts — sales ended but the concert still happens', async () => {
    await makeEvent({ slug: 'closed', status: 'CLOSED' })
    expect(await listPublicEvents('pl')).toHaveLength(1)
  })

  it('orders by start time ascending', async () => {
    await makeEvent({ slug: 'third', startsAt: inDays(30) })
    await makeEvent({ slug: 'first', startsAt: inDays(10) })
    await makeEvent({ slug: 'second', startsAt: inDays(20) })

    const events = await listPublicEvents('pl')
    expect(events.map((e) => e.slug)).toEqual(['first', 'second', 'third'])
  })
})

describe('listPublicEvents — translations', () => {
  it('returns only the requested locale', async () => {
    await makeEvent({ slug: 'concert' })

    for (const locale of ['pl', 'en', 'de'] as const) {
      const [event] = await listPublicEvents(locale)
      expect(event.translation.locale).toBe(locale)
      expect(event.translation.title).toBe(`${locale.toUpperCase()} concert`)
    }
  })
})

describe('purchasability', () => {
  it('is purchasable when on sale, future, with capacity and no window', async () => {
    await makeEvent({ slug: 'normal' })
    const [event] = await listPublicEvents('pl')
    expect(event.purchasable).toBe(true)
    expect(event.notPurchasableReason).toBeNull()
  })

  it('is not purchasable before salesOpenAt', async () => {
    await makeEvent({ slug: 'early', salesOpenAt: inDays(5) })
    const [event] = await listPublicEvents('pl')
    expect(event.purchasable).toBe(false)
    expect(event.notPurchasableReason).toBe('notYetOpen')
  })

  it('carries salesOpenAt through, so the UI can say when sales open', async () => {
    // A notYetOpen reason without the date is not actionable for a visitor.
    const opens = inDays(5)
    await makeEvent({ slug: 'early', salesOpenAt: opens })
    const [event] = await listPublicEvents('pl')
    expect(event.salesOpenAt?.toISOString()).toBe(opens.toISOString())
  })

  it('is purchasable once salesOpenAt has passed', async () => {
    await makeEvent({ slug: 'open', salesOpenAt: inDays(-1) })
    const [event] = await listPublicEvents('pl')
    expect(event.purchasable).toBe(true)
  })

  it('is not purchasable after salesCloseAt', async () => {
    await makeEvent({ slug: 'late', salesCloseAt: inDays(-1) })
    const [event] = await listPublicEvents('pl')
    expect(event.purchasable).toBe(false)
    expect(event.notPurchasableReason).toBe('closed')
  })

  it('is not purchasable when status is CLOSED', async () => {
    await makeEvent({ slug: 'closed', status: 'CLOSED' })
    const [event] = await listPublicEvents('pl')
    expect(event.purchasable).toBe(false)
    expect(event.notPurchasableReason).toBe('closed')
  })

  it('is not purchasable when sold out', async () => {
    await makeEvent({ slug: 'full', status: 'SOLD_OUT', capacity: 900, soldCount: 900 })
    const [event] = await listPublicEvents('pl')
    expect(event.purchasable).toBe(false)
    expect(event.notPurchasableReason).toBe('soldOut')
  })

  it('is not purchasable when the ticket type is inactive', async () => {
    // Otherwise the buy box renders and every checkout attempt fails.
    await makeEvent({ slug: 'inactive', active: false })
    const [event] = await listPublicEvents('pl')
    expect(event.purchasable).toBe(false)
  })
})

describe('availability', () => {
  it('subtracts both sold and held from capacity', async () => {
    await makeEvent({ slug: 'partly', capacity: 900, soldCount: 100, heldCount: 50 })
    const [event] = await listPublicEvents('pl')
    expect(event.available).toBe(750)
  })

  it('never goes negative, even if capacity was lowered below sold', async () => {
    await makeEvent({ slug: 'oversold', capacity: 100, soldCount: 150 })
    const [event] = await listPublicEvents('pl')
    expect(event.available).toBe(0)
    expect(event.band).toBe('soldOut')
  })

  it('carries the ticket type id and maxPerOrder through', async () => {
    // Plan 04's hold targets ticketTypeId; the buy box bounds on maxPerOrder.
    await makeEvent({ slug: 'concert' })
    const [event] = await listPublicEvents('pl')
    expect(event.ticketTypeId).toEqual(expect.any(String))
    expect(event.maxPerOrder).toBe(10)
  })
})

describe('getPublicEvent', () => {
  it('returns a concert by slug', async () => {
    await makeEvent({ slug: 'wieczor-bachowski' })
    const event = await getPublicEvent('wieczor-bachowski', 'pl')
    expect(event?.slug).toBe('wieczor-bachowski')
  })

  it('returns null for an unknown slug', async () => {
    expect(await getPublicEvent('nope', 'pl')).toBeNull()
  })

  it('returns null for a DRAFT concert — an embargoed programme must not leak', async () => {
    await makeEvent({ slug: 'draft', status: 'DRAFT' })
    expect(await getPublicEvent('draft', 'pl')).toBeNull()
  })

  it('returns null for a CANCELLED concert', async () => {
    await makeEvent({ slug: 'cancelled', status: 'CANCELLED' })
    expect(await getPublicEvent('cancelled', 'pl')).toBeNull()
  })

  it('returns null for a past concert', async () => {
    await makeEvent({ slug: 'past', startsAt: inDays(-1) })
    expect(await getPublicEvent('past', 'pl')).toBeNull()
  })

  it('returns a CLOSED concert, not purchasable', async () => {
    await makeEvent({ slug: 'closed', status: 'CLOSED' })
    const event = await getPublicEvent('closed', 'pl')
    expect(event).not.toBeNull()
    expect(event!.purchasable).toBe(false)
  })
})
