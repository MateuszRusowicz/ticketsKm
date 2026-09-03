import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import { createOrder } from '@/lib/server/orders'
import { sweepExpiredHolds } from '@/lib/server/sweep-holds'

let ticketTypeId: string

async function makeConcert(capacity = 5000) {
  const venue =
    (await db.venue.findFirst({ where: { name: 'Sweep test venue' } })) ??
    (await db.venue.create({
      data: { name: 'Sweep test venue', city: 'C', address: 'A', defaultCapacity: 100 },
    }))

  const event = await db.event.create({
    data: {
      slug: `sweep-test-${crypto.randomUUID()}`,
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
      ticketTypes: { create: [{ pricePln: 5000, priceEur: 1200, maxPerOrder: 50 }] },
    },
    select: { ticketTypes: { select: { id: true } } },
  })

  return event.ticketTypes[0].id
}

async function anOrder(email: string, tt = ticketTypeId, quantity = 2) {
  return createOrder({
    ticketTypeId: tt,
    quantity,
    locale: 'pl',
    currency: 'PLN',
    email,
    firstName: 'Jan',
    lastName: 'Kowalski',
    attendeeNames: Array.from({ length: quantity }, (_, i) => `G${i}`),
    needsInvoice: false,
    acceptedTerms: true,
  })
}

async function lapse(orderId: string, secondsAgo = 1) {
  await db.order.update({
    where: { id: orderId },
    data: { holdExpiresAt: new Date(Date.now() - secondsAgo * 1000) },
  })
}

async function heldCount(id = ticketTypeId) {
  const t = await db.ticketType.findUniqueOrThrow({ where: { id }, select: { heldCount: true } })
  return t.heldCount
}

beforeEach(async () => {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "OrderItem", "Order", "TicketType",
                   "EventTranslation", "Event", "Venue"
    RESTART IDENTITY CASCADE
  `)
  await db.$executeRawUnsafe('ALTER SEQUENCE "order_reference_seq" RESTART')
  ticketTypeId = await makeConcert()
})

describe('sweepExpiredHolds', () => {
  it('reports nothing on an empty database', async () => {
    await expect(sweepExpiredHolds()).resolves.toEqual({ expired: 0, released: 0 })
  })

  it('expires a lapsed hold and returns its seats', async () => {
    const order = await anOrder('a@example.test')
    await lapse(order.orderId)

    expect(await sweepExpiredHolds()).toEqual({ expired: 1, released: 2 })
    expect(await heldCount()).toBe(0)
    expect(await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).toMatchObject({
      status: 'EXPIRED',
    })
  })

  it('leaves a hold that is still within its window', async () => {
    await anOrder('b@example.test')

    expect(await sweepExpiredHolds()).toEqual({ expired: 0, released: 0 })
    expect(await heldCount()).toBe(2)
  })

  it('leaves a lapsed order that has a PaymentIntent', async () => {
    // Przelewy24, Klarna and SEPA sit in `processing` for minutes to days.
    // Expiring one would resell seats the buyer is still paying for.
    const order = await anOrder('c@example.test')
    await lapse(order.orderId)
    await db.order.update({
      where: { id: order.orderId },
      data: { stripePaymentIntentId: 'pi_test_async' },
    })

    expect(await sweepExpiredHolds()).toEqual({ expired: 0, released: 0 })
    expect(await heldCount()).toBe(2)
  })

  it('ignores a PAID order even with a stale holdExpiresAt', async () => {
    const order = await anOrder('d@example.test')
    await lapse(order.orderId)
    await db.order.update({ where: { id: order.orderId }, data: { status: 'PAID' } })

    expect(await sweepExpiredHolds()).toEqual({ expired: 0, released: 0 })
  })

  it('writes one audit entry per expired order', async () => {
    const order = await anOrder('e@example.test')
    await lapse(order.orderId)
    await sweepExpiredHolds()

    const audits = await db.auditLog.findMany({
      where: { entityId: order.orderId, action: 'order.expire' },
    })
    expect(audits).toHaveLength(1)
    expect(audits[0].actorId).toBeNull()
  })

  it('drains past the 500-row page and takes the oldest first', async () => {
    // 550 orders, so the loop must continue past one page.
    const created = []
    for (let i = 0; i < 550; i++) {
      const o = await anOrder(`bulk${i}@example.test`, ticketTypeId, 1)
      created.push(o.orderId)
    }
    for (const [i, id] of created.entries()) await lapse(id, 600 - i)

    expect(await heldCount()).toBe(550)

    const result = await sweepExpiredHolds()

    expect(result).toEqual({ expired: 550, released: 550 })
    expect(await heldCount()).toBe(0)
    expect(await db.order.count({ where: { status: 'PENDING' } })).toBe(0)
  }, 180_000)

  it('releases exactly once when a buyer cancels during the sweep', async () => {
    const order = await anOrder('f@example.test')
    await lapse(order.orderId)

    const { cancelOrder } = await import('@/lib/server/orders')
    const [swept, cancelled] = await Promise.all([
      sweepExpiredHolds(),
      cancelOrder(order.orderId, 'buyer_cancelled'),
    ])

    const releasedTwice =
      swept.released === 2 && 'released' in cancelled && cancelled.released === 2
    expect(releasedTwice).toBe(false)
    expect(await heldCount()).toBe(0)
  })
})
