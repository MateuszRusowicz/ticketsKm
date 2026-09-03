import { beforeEach, describe, expect, it, vi } from 'vitest'

// Reassignable so the rate-limit test can present a distinct IP per case.
let currentIp = '127.0.0.1'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => void 0, delete: () => void 0 }),
  headers: async () => ({ get: () => currentIp }),
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`)
  },
}))

vi.mock('next/cache', () => ({ revalidatePath: () => void 0 }))

import { submitCheckout } from '@/app/(shop)/[locale]/koncert/[slug]/zamowienie/actions'
import { db } from '@/lib/server/db'
import { __resetRateLimits } from '@/lib/server/ratelimit'

let ticketTypeId: string

async function makeConcert(capacity = 100) {
  const venue =
    (await db.venue.findFirst({ where: { name: 'Checkout test venue' } })) ??
    (await db.venue.create({
      data: { name: 'Checkout test venue', city: 'C', address: 'A', defaultCapacity: 100 },
    }))

  const event = await db.event.create({
    data: {
      slug: `checkout-test-${crypto.randomUUID()}`,
      venueId: venue.id,
      capacity,
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

function form(over: Record<string, string | undefined> = {}, quantity = 2): FormData {
  const fd = new FormData()
  const base: Record<string, string> = {
    ticketTypeId,
    quantity: String(quantity),
    locale: 'pl',
    currency: 'PLN',
    email: 'buyer@example.test',
    firstName: 'Jan',
    lastName: 'Kowalski',
    acceptedTerms: 'on',
  }
  for (const [k, v] of Object.entries({ ...base, ...over })) {
    if (v !== undefined) fd.set(k, v)
  }
  if (!('__skipNames' in over)) {
    for (let i = 0; i < quantity; i++) fd.set(`attendeeNames.${i}`, `Gość ${i + 1}`)
  }
  return fd
}

async function heldCount(id: string) {
  const t = await db.ticketType.findUniqueOrThrow({ where: { id }, select: { heldCount: true } })
  return t.heldCount
}

beforeEach(async () => {
  __resetRateLimits()
  currentIp = '127.0.0.1'
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "OrderItem", "Order", "TicketType",
                   "EventTranslation", "Event", "Venue"
    RESTART IDENTITY CASCADE
  `)
  // RESTART IDENTITY does not reset a standalone sequence.
  await db.$executeRawUnsafe('ALTER SEQUENCE "order_reference_seq" RESTART')
  ticketTypeId = await makeConcert()
})

describe('submitCheckout', () => {
  it('creates the order and redirects to the guarded confirmation URL', async () => {
    await expect(submitCheckout({}, form())).rejects.toThrow(
      /^REDIRECT:\/pl\/order\/KM-\d{4}-\d{6}\?t=[0-9a-f-]{36}$/,
    )

    const order = await db.order.findFirstOrThrow({})
    expect(order.status).toBe('PENDING')
    expect(await heldCount(ticketTypeId)).toBe(2)
  })

  it('returns field errors and holds nothing when validation fails', async () => {
    const result = await submitCheckout({}, form({ email: 'not-an-email' }))

    expect(result).toMatchObject({ errors: { email: expect.any(Array) } })
    expect(await db.order.count()).toBe(0)
    expect(await heldCount(ticketTypeId)).toBe(0)
  })

  it('reports a sold-out concert as a form-level error, not a crash', async () => {
    const t = await makeConcert(1)

    const result = await submitCheckout({}, form({ ticketTypeId: t }, 2))

    expect(result).toEqual({ errors: { _form: ['soldOut'] } })
    expect(await db.order.count()).toBe(0)
  })

  it('rejects an attendee-name index gap rather than shifting names', async () => {
    const fd = form({ __skipNames: 'yes' }, 3)
    fd.set('attendeeNames.0', 'Anna')
    fd.set('attendeeNames.2', 'Piotr') // 1 deliberately missing

    const result = await submitCheckout({}, fd)

    expect(result).toEqual({ errors: { attendeeNames: ['incomplete'] } })
    expect(await db.order.count()).toBe(0)
  })

  it('rate-limits per IP and leaves other IPs alone', async () => {
    currentIp = '1.2.3.4'
    for (let i = 0; i < 10; i++) {
      await submitCheckout({}, form({ email: `b${i}@example.test` })).catch(() => {})
    }

    const blocked = await submitCheckout({}, form({ email: 'over@example.test' }))
    expect(blocked).toEqual({ errors: { _form: ['rateLimited'] } })

    currentIp = '5.6.7.8'
    await expect(submitCheckout({}, form({ email: 'other@example.test' }))).rejects.toThrow(
      /^REDIRECT:/,
    )
  })

  it('takes the currency from the submitted form, which is frozen at render', async () => {
    await expect(submitCheckout({}, form({ currency: 'EUR' }))).rejects.toThrow(/^REDIRECT:/)

    const order = await db.order.findFirstOrThrow({})
    expect(order.currency).toBe('EUR')
    expect(order.total).toBe(2400)
  })

  it('dedupes a double submit to the same reference and token', async () => {
    const first = await submitCheckout({}, form()).catch((e: Error) => e.message)
    const second = await submitCheckout({}, form()).catch((e: Error) => e.message)

    expect(second).toBe(first)
    expect(await db.order.count()).toBe(1)
    expect(await heldCount(ticketTypeId)).toBe(2)
  })
})
