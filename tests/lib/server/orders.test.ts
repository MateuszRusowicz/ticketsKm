import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/server/db'
import { InsufficientCapacityError } from '@/lib/server/holds'
import {
  createOrder,
  EventNotPurchasableError,
  HOLD_DURATION_MS,
  QuantityAboveMaxPerOrderError,
} from '@/lib/server/orders'
import type { CheckoutInput } from '@/lib/shared/checkout'

async function makeConcert(
  overrides: {
    capacity?: number
    soldCount?: number
    status?: 'DRAFT' | 'ON_SALE' | 'SOLD_OUT' | 'CLOSED' | 'CANCELLED'
    startsAt?: Date
    salesOpenAt?: Date | null
    salesCloseAt?: Date | null
    maxPerOrder?: number
    active?: boolean
  } = {},
) {
  const venue =
    (await db.venue.findFirst({ where: { name: 'Orders test venue' } })) ??
    (await db.venue.create({
      data: { name: 'Orders test venue', city: 'Test', address: 'Test', defaultCapacity: 100 },
    }))

  const event = await db.event.create({
    data: {
      slug: `orders-test-${crypto.randomUUID()}`,
      venueId: venue.id,
      capacity: overrides.capacity ?? 100,
      startsAt: overrides.startsAt ?? new Date(Date.now() + 60 * 86_400_000),
      status: overrides.status ?? 'ON_SALE',
      salesOpenAt: overrides.salesOpenAt ?? null,
      salesCloseAt: overrides.salesCloseAt ?? null,
      // Every locale, or toPublicEvent returns null and every reason
      // collapses to 'unknown'.
      translations: {
        create: (['pl', 'de', 'en'] as const).map((locale) => ({
          locale,
          title: 'Orders test',
          description: 'Orders test',
          performers: 'Orders test',
        })),
      },
      ticketTypes: {
        create: [
          {
            pricePln: 5000,
            priceEur: 1200,
            soldCount: overrides.soldCount ?? 0,
            maxPerOrder: overrides.maxPerOrder ?? 10,
            active: overrides.active ?? true,
          },
        ],
      },
    },
    select: { id: true, slug: true, ticketTypes: { select: { id: true } } },
  })

  return { eventId: event.id, slug: event.slug, ticketTypeId: event.ticketTypes[0].id }
}

function input(ticketTypeId: string, over: Partial<CheckoutInput> = {}): CheckoutInput {
  const quantity = over.quantity ?? 2
  return {
    ticketTypeId,
    quantity,
    locale: 'pl',
    currency: 'PLN',
    email: 'buyer@example.test',
    firstName: 'Jan',
    lastName: 'Kowalski',
    attendeeNames: Array.from({ length: quantity }, (_, i) => `Gość ${i + 1}`),
    needsInvoice: false,
    acceptedTerms: true,
    ...over,
  } as CheckoutInput
}

async function heldCount(id: string) {
  const t = await db.ticketType.findUniqueOrThrow({ where: { id }, select: { heldCount: true } })
  return t.heldCount
}

let ticketTypeId: string

beforeEach(async () => {
  ticketTypeId = (await makeConcert()).ticketTypeId
})

describe('createOrder — happy path', () => {
  it('creates a PENDING order, holds capacity, and snapshots the price', async () => {
    const result = await createOrder(input(ticketTypeId, { quantity: 3 }))

    expect(result.reference).toMatch(/^KM-\d{4}-\d{6}$/)
    expect(result.accessToken).toMatch(/^[0-9a-f-]{36}$/)

    const order = await db.order.findUniqueOrThrow({
      where: { id: result.orderId },
      include: { items: true },
    })

    expect(order.status).toBe('PENDING')
    expect(order.currency).toBe('PLN')
    expect(order.items).toHaveLength(1)
    expect(order.items[0].quantity).toBe(3)
    expect(order.items[0].unitPrice).toBe(5000)
    expect(await heldCount(ticketTypeId)).toBe(3)
  })

  it('computes totals from the database, not from the payload', async () => {
    const result = await createOrder(input(ticketTypeId, { quantity: 3 }))
    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId } })

    expect(order.subtotal).toBe(15_000)
    expect(order.discount).toBe(0)
    expect(order.total).toBe(15_000)
  })

  it('charges the EUR price when the order is in EUR', async () => {
    const result = await createOrder(input(ticketTypeId, { currency: 'EUR', quantity: 2 }))
    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId } })

    expect(order.currency).toBe('EUR')
    expect(order.total).toBe(2400)
  })

  it('stores attendee names index-keyed, not as a bare positional array', async () => {
    const result = await createOrder(
      input(ticketTypeId, { quantity: 2, attendeeNames: ['Anna Nowak', 'Piotr Zieliński'] }),
    )
    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId } })

    expect(order.attendeeNames).toEqual([
      { index: 0, name: 'Anna Nowak' },
      { index: 1, name: 'Piotr Zieliński' },
    ])
  })

  it('sets holdExpiresAt to exactly 30 minutes out', async () => {
    expect(HOLD_DURATION_MS).toBe(1_800_000)

    const before = Date.now()
    const result = await createOrder(input(ticketTypeId))
    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId } })

    const delta = order.holdExpiresAt!.getTime() - before
    expect(delta).toBeGreaterThanOrEqual(HOLD_DURATION_MS - 5_000)
    expect(delta).toBeLessThanOrEqual(HOLD_DURATION_MS + 5_000)
  })

  it('writes an audit entry inside the same transaction', async () => {
    const result = await createOrder(input(ticketTypeId))
    const entries = await db.auditLog.findMany({ where: { entityId: result.orderId } })

    expect(entries).toHaveLength(1)
    expect(entries[0].action).toBe('order.create')
  })
})

describe('createOrder — not purchasable', () => {
  it.each([
    ['DRAFT', { status: 'DRAFT' as const }],
    ['CANCELLED', { status: 'CANCELLED' as const }],
    ['past', { startsAt: new Date(Date.now() - 86_400_000) }],
  ])('reports %s as unknown, because getPublicEvent filters it at the query level', async (_l, o) => {
    const { ticketTypeId: t } = await makeConcert(o)

    await expect(createOrder(input(t))).rejects.toMatchObject({
      name: 'EventNotPurchasableError',
      reason: 'unknown',
    })
  })

  it('rejects an unknown but well-formed ticketTypeId as unknown, not a 500', async () => {
    await expect(createOrder(input(crypto.randomUUID()))).rejects.toThrow(EventNotPurchasableError)
  })

  it('reports a distinguishable reason when sales have not opened', async () => {
    const { ticketTypeId: t } = await makeConcert({
      salesOpenAt: new Date(Date.now() + 86_400_000),
    })

    await expect(createOrder(input(t))).rejects.toMatchObject({ reason: 'notYetOpen' })
  })

  it('reports a distinguishable reason when sales have closed', async () => {
    const { ticketTypeId: t } = await makeConcert({
      salesCloseAt: new Date(Date.now() - 86_400_000),
    })

    await expect(createOrder(input(t))).rejects.toMatchObject({ reason: 'closed' })
  })

  it('creates nothing when the concert is not purchasable', async () => {
    const { ticketTypeId: t } = await makeConcert({ status: 'DRAFT' })
    const before = await db.order.count()

    await expect(createOrder(input(t))).rejects.toThrow()

    expect(await db.order.count()).toBe(before)
    expect(await heldCount(t)).toBe(0)
  })
})

describe('createOrder — quantity limits', () => {
  it('refuses a quantity above the concert maxPerOrder and holds nothing', async () => {
    const { ticketTypeId: t } = await makeConcert({ maxPerOrder: 4 })

    await expect(createOrder(input(t, { quantity: 5 }))).rejects.toThrow(
      QuantityAboveMaxPerOrderError,
    )

    expect(await heldCount(t)).toBe(0)
    expect(await db.order.count({ where: { items: { some: { ticketTypeId: t } } } })).toBe(0)
  })

  it('allows exactly maxPerOrder', async () => {
    const { ticketTypeId: t } = await makeConcert({ maxPerOrder: 4 })

    await expect(createOrder(input(t, { quantity: 4 }))).resolves.toBeDefined()
    expect(await heldCount(t)).toBe(4)
  })

  it('surfaces InsufficientCapacityError and creates no order', async () => {
    const { ticketTypeId: t } = await makeConcert({ capacity: 10, soldCount: 9 })

    await expect(createOrder(input(t, { quantity: 2 }))).rejects.toThrow(InsufficientCapacityError)

    expect(await heldCount(t)).toBe(0)
    expect(await db.order.count({ where: { items: { some: { ticketTypeId: t } } } })).toBe(0)
  })
})

describe('createOrder — same-buyer dedupe', () => {
  it('returns the existing reference instead of holding a second time', async () => {
    const first = await createOrder(input(ticketTypeId, { quantity: 2 }))
    const second = await createOrder(input(ticketTypeId, { quantity: 2 }))

    expect(second.reference).toBe(first.reference)
    expect(second.accessToken).toBe(first.accessToken)
    expect(await heldCount(ticketTypeId)).toBe(2)
    expect(await db.order.count({ where: { items: { some: { ticketTypeId } } } })).toBe(1)
  })

  it.each(['EXPIRED', 'CANCELLED', 'FAILED', 'PAID'] as const)(
    'does not dedupe against a %s order',
    async (status) => {
      const first = await createOrder(input(ticketTypeId))
      await db.order.update({ where: { id: first.orderId }, data: { status } })

      const second = await createOrder(input(ticketTypeId))

      expect(second.reference).not.toBe(first.reference)
    },
  )

  it('does not dedupe against a PENDING order whose hold has already expired', async () => {
    // The sweep may not have run yet. Leave the stale order to it rather than
    // expiring synchronously from the checkout path.
    const first = await createOrder(input(ticketTypeId))
    await db.order.update({
      where: { id: first.orderId },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    })

    const second = await createOrder(input(ticketTypeId))

    expect(second.reference).not.toBe(first.reference)
    expect(await db.order.findUniqueOrThrow({ where: { id: first.orderId } })).toMatchObject({
      status: 'PENDING',
    })
  })

  it('does not dedupe across different buyers', async () => {
    const a = await createOrder(input(ticketTypeId, { email: 'a@example.test' }))
    const b = await createOrder(input(ticketTypeId, { email: 'b@example.test' }))

    expect(b.reference).not.toBe(a.reference)
    expect(await heldCount(ticketTypeId)).toBe(4)
  })
})

describe('createOrder — atomicity', () => {
  it('rolls back the order and the hold when the audit write fails', async () => {
    const audit = await import('@/lib/server/audit')
    const spy = vi.spyOn(audit, 'recordAudit').mockRejectedValueOnce(new Error('audit exploded'))

    await expect(createOrder(input(ticketTypeId))).rejects.toThrow('audit exploded')

    expect(await heldCount(ticketTypeId)).toBe(0)
    expect(await db.order.count({ where: { items: { some: { ticketTypeId } } } })).toBe(0)

    spy.mockRestore()
  })

  it('passes the transaction client to recordAudit', async () => {
    // Pins the argument, not just the rollback. Verified by negative control:
    // without this assertion the suite still passed when `tx` was dropped from
    // the recordAudit call, because the mock rejects regardless of arguments.
    const audit = await import('@/lib/server/audit')
    const spy = vi.spyOn(audit, 'recordAudit')

    await createOrder(input(ticketTypeId))

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][1]).toBeDefined()

    spy.mockRestore()
  })
})
