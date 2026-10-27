import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/server/db'
import { __resetRateLimits } from '@/lib/server/ratelimit'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => '192.0.2.1' }),
}))

import { GET } from '@/app/t/[code]/pdf/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeVenueAndEvent() {
  const venue = await db.venue.create({
    data: { name: 'PDF Route test venue', city: 'Wrocław', address: 'ul. Testowa 1', defaultCapacity: 100 },
  })
  const event = await db.event.create({
    data: {
      slug: `pdf-route-test-${crypto.randomUUID()}`,
      venueId: venue.id,
      capacity: 100,
      startsAt: new Date('2027-08-15T19:00:00Z'),
      status: 'ON_SALE',
      translations: {
        create: (['pl', 'en', 'de'] as const).map((locale) => ({
          locale,
          title: `PDF route test ${locale}`,
          description: 'PDF route test',
          performers: 'PDF route test',
        })),
      },
      ticketTypes: {
        create: [{ pricePln: 5000, priceEur: 1200, maxPerOrder: 10, active: true }],
      },
    },
    include: { ticketTypes: true },
  })
  return { eventId: event.id, ticketTypeId: event.ticketTypes[0].id }
}

async function makeOrder(
  eventId: string,
  ticketTypeId: string,
  status: 'PAID' | 'REFUNDED' | 'CANCELLED' = 'PAID',
) {
  return db.order.create({
    data: {
      reference: `KM-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      email: 'test@example.com',
      firstName: 'Jan',
      lastName: 'Kowalski',
      locale: 'pl',
      currency: 'PLN',
      subtotal: 5000,
      total: 5000,
      status,
      items: {
        create: [{ ticketTypeId, quantity: 1, unitPrice: 5000, currency: 'PLN' }],
      },
    },
  })
}

async function makeTicket(
  orderId: string,
  eventId: string,
  ticketTypeId: string,
  overrides: { code?: string; status?: 'VALID' | 'USED' | 'REVOKED'; usedAt?: Date } = {},
) {
  return db.ticket.create({
    data: {
      code: overrides.code ?? 'AAAA1111BBBB2222CCCC3333AA',
      orderId,
      eventId,
      ticketTypeId,
      holderName: 'Jan Kowalski',
      status: overrides.status ?? 'VALID',
      usedAt: overrides.usedAt ?? null,
    },
  })
}

function makeRequest(code: string): Request {
  return new Request(`http://localhost/t/${code}/pdf`)
}

function makeParams(code: string) {
  return { params: Promise.resolve({ code }) }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "Ticket", "OrderItem", "Order", "TicketType",
                   "EventTranslation", "Event", "Venue"
    RESTART IDENTITY CASCADE
  `)
  await db.$executeRawUnsafe('ALTER SEQUENCE "order_reference_seq" RESTART')
  __resetRateLimits()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /t/[code]/pdf', () => {
  it('case 1: malformed code → 404 with no DB query', async () => {
    const findUniqueSpy = vi.spyOn(db.ticket, 'findUnique')

    const res = await GET(makeRequest('lowercase-invalid'), makeParams('lowercase-invalid'))
    expect(res.status).toBe(404)

    const res2 = await GET(makeRequest('TOOLONG12345678901234567890'), makeParams('TOOLONG12345678901234567890'))
    expect(res2.status).toBe(404)

    expect(findUniqueSpy).not.toHaveBeenCalled()
    findUniqueSpy.mockRestore()
  })

  it('case 2: unknown well-formed code → 404', async () => {
    const res = await GET(makeRequest('ZZZZ9999YYYY8888XXXX7777ZZ'), makeParams('ZZZZ9999YYYY8888XXXX7777ZZ'))
    expect(res.status).toBe(404)
  })

  it('case 3: ticket of a REVOKED order → 404', async () => {
    const { eventId, ticketTypeId } = await makeVenueAndEvent()
    const order = await makeOrder(eventId, ticketTypeId, 'REFUNDED')
    const code = 'AAAA1111BBBB2222CCCC3333AA'
    await makeTicket(order.id, eventId, ticketTypeId, { code, status: 'VALID' })

    const res = await GET(makeRequest(code), makeParams(code))
    expect(res.status).toBe(404)
  })

  it('case 4: VALID ticket → 200 with application/pdf and %PDF- start', async () => {
    const { eventId, ticketTypeId } = await makeVenueAndEvent()
    const order = await makeOrder(eventId, ticketTypeId)
    const code = 'BBBB2222CCCC3333DDDD4444BB'
    await makeTicket(order.id, eventId, ticketTypeId, { code })

    const res = await GET(makeRequest(code), makeParams(code))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')

    const body = await res.arrayBuffer()
    const start = Buffer.from(body).slice(0, 4).toString('ascii')
    expect(start).toBe('%PDF')
  })

  it('case 5: USED ticket → 200 (buyer can still re-print)', async () => {
    const { eventId, ticketTypeId } = await makeVenueAndEvent()
    const order = await makeOrder(eventId, ticketTypeId)
    const code = 'CCCC3333DDDD4444EEEE5555CC'
    await makeTicket(order.id, eventId, ticketTypeId, {
      code,
      status: 'USED',
      usedAt: new Date('2027-08-15T20:30:00Z'),
    })

    const res = await GET(makeRequest(code), makeParams(code))
    expect(res.status).toBe(200)
  })

  it('case 6: Content-Disposition filename uses first 6 chars of code', async () => {
    const { eventId, ticketTypeId } = await makeVenueAndEvent()
    const order = await makeOrder(eventId, ticketTypeId)
    const code = 'DDDD4444EEEE5555FFFF6666DD'
    await makeTicket(order.id, eventId, ticketTypeId, { code })

    const res = await GET(makeRequest(code), makeParams(code))
    expect(res.status).toBe(200)

    const disposition = res.headers.get('Content-Disposition') ?? ''
    expect(disposition).toContain(`ticket-${code.slice(0, 6).toLowerCase()}.pdf`)
  })

  it('case 7: rate limit fires on 21st request within 60s', { timeout: 60_000 }, async () => {
    const { eventId, ticketTypeId } = await makeVenueAndEvent()
    const order = await makeOrder(eventId, ticketTypeId)
    const code = 'EEEE5555FFFF6666GGGG7777EE'
    await makeTicket(order.id, eventId, ticketTypeId, { code })

    // Exhaust the 20-request budget
    for (let i = 0; i < 20; i++) {
      const res = await GET(makeRequest(code), makeParams(code))
      expect(res.status, `request ${i + 1} should succeed`).toBe(200)
    }

    // 21st request should be rate limited
    const res = await GET(makeRequest(code), makeParams(code))
    expect(res.status).toBe(429)

    __resetRateLimits()
  })
})
