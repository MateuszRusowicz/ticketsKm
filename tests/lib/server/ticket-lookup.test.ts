import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/server/db'
import { getPublicTicket, isValidTicketCode } from '@/lib/server/ticket-lookup'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeVenueAndEvent() {
  const venue = await db.venue.create({
    data: { name: 'Lookup test venue', city: 'Wrocław', address: 'ul. Testowa 1', defaultCapacity: 100 },
  })
  const event = await db.event.create({
    data: {
      slug: `lookup-test-${crypto.randomUUID()}`,
      venueId: venue.id,
      capacity: 100,
      startsAt: new Date('2027-08-15T19:00:00Z'),
      status: 'ON_SALE',
      translations: {
        create: (['pl', 'en', 'de'] as const).map((locale) => ({
          locale,
          title: `Lookup test ${locale}`,
          description: 'Lookup test',
          performers: 'Lookup test',
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
  overrides: { status?: string; locale?: string } = {},
) {
  return db.order.create({
    data: {
      reference: `KM-${Math.random().toString(36).slice(2).toUpperCase().slice(0, 8)}`,
      email: 'test@example.com',
      firstName: 'Jan',
      lastName: 'Kowalski',
      locale: (overrides.locale as 'pl' | 'en' | 'de') ?? 'pl',
      currency: 'PLN',
      subtotal: 5000,
      total: 5000,
      status: (overrides.status as 'PENDING' | 'PAID' | 'REFUNDED' | 'CANCELLED') ?? 'PAID',
      items: {
        create: [{
          ticketTypeId,
          quantity: 1,
          unitPrice: 5000,
          currency: 'PLN',
        }],
      },
    },
  })
}

async function makeTicket(
  orderId: string,
  eventId: string,
  ticketTypeId: string,
  overrides: { code?: string; status?: string; usedAt?: Date | null } = {},
) {
  return db.ticket.create({
    data: {
      code: overrides.code ?? `VALID1234567890ABCDEFGH${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`.slice(0, 26).toUpperCase(),
      orderId,
      eventId,
      ticketTypeId,
      holderName: 'Jan Kowalski',
      status: (overrides.status as 'VALID' | 'USED' | 'REVOKED') ?? 'VALID',
      usedAt: overrides.usedAt ?? null,
    },
  })
}

const VALID_CODE_1 = 'AAAA1111BBBB2222CCCC3333AA'
const VALID_CODE_2 = 'BBBB2222CCCC3333DDDD4444BB'
const VALID_CODE_3 = 'CCCC3333DDDD4444EEEE5555CC'
const VALID_CODE_4 = 'DDDD4444EEEE5555FFFF6666DD'

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
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isValidTicketCode', () => {
  it('accepts a valid 26-char Crockford code', () => {
    expect(isValidTicketCode('0123456789ABCDEFGHJKMNPQRS')).toBe(true)
  })

  it('rejects codes containing I, L, O, U', () => {
    expect(isValidTicketCode('IAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false)
    expect(isValidTicketCode('ALAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false)
    expect(isValidTicketCode('AOAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false)
    expect(isValidTicketCode('AUAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false)
  })

  it('rejects lowercase codes', () => {
    expect(isValidTicketCode('aaaa1111bbbb2222cccc3333aa')).toBe(false)
  })

  it('rejects codes of wrong length', () => {
    expect(isValidTicketCode('AAAA1111BBBB2222CCCC3333A')).toBe(false) // 25
    expect(isValidTicketCode('AAAA1111BBBB2222CCCC3333AAA')).toBe(false) // 27
  })
})

describe('getPublicTicket', () => {
  it('case 1: valid, unused ticket → kind: valid', async () => {
    const { eventId, ticketTypeId } = await makeVenueAndEvent()
    const order = await makeOrder(eventId, ticketTypeId)
    await makeTicket(order.id, eventId, ticketTypeId, { code: VALID_CODE_1 })

    const result = await getPublicTicket(VALID_CODE_1)
    expect(result?.kind).toBe('valid')
    expect(result?.ticket.code).toBe(VALID_CODE_1)
    expect(result?.ticket.holderName).toBe('Jan Kowalski')
  })

  it('case 2: used ticket → kind: used with usedAt', async () => {
    const { eventId, ticketTypeId } = await makeVenueAndEvent()
    const order = await makeOrder(eventId, ticketTypeId)
    const usedAt = new Date('2027-08-15T20:30:00Z')
    await makeTicket(order.id, eventId, ticketTypeId, {
      code: VALID_CODE_2,
      status: 'USED',
      usedAt,
    })

    const result = await getPublicTicket(VALID_CODE_2)
    expect(result?.kind).toBe('used')
    if (result?.kind === 'used') {
      expect(result.usedAt.getTime()).toBe(usedAt.getTime())
    }
  })

  it('case 3: revoked ticket → kind: revoked', async () => {
    const { eventId, ticketTypeId } = await makeVenueAndEvent()
    const order = await makeOrder(eventId, ticketTypeId)
    await makeTicket(order.id, eventId, ticketTypeId, {
      code: VALID_CODE_3,
      status: 'REVOKED',
    })

    const result = await getPublicTicket(VALID_CODE_3)
    expect(result?.kind).toBe('revoked')
  })

  it('case 4: refunded order with valid ticket → kind: revoked', async () => {
    const { eventId, ticketTypeId } = await makeVenueAndEvent()
    const order = await makeOrder(eventId, ticketTypeId, { status: 'REFUNDED' })
    await makeTicket(order.id, eventId, ticketTypeId, {
      code: VALID_CODE_4,
      status: 'VALID',
    })

    const result = await getPublicTicket(VALID_CODE_4)
    expect(result?.kind).toBe('revoked')
  })

  it('case 5: unknown but well-formed code → null', async () => {
    const result = await getPublicTicket('ZZZZ9999YYYY8888XXXX7777ZZ')
    expect(result).toBeNull()
  })

  it('case 6: malformed code → null and no DB query', async () => {
    const findUniqueSpy = vi.spyOn(db.ticket, 'findUnique')

    expect(await getPublicTicket('lowercase-invalid')).toBeNull()
    expect(await getPublicTicket('CONTAINS_U_CHAR_INVALID000')).toBeNull()
    expect(await getPublicTicket('TOOSHORT')).toBeNull()

    expect(findUniqueSpy).not.toHaveBeenCalled()
    findUniqueSpy.mockRestore()
  })
})
