import { PrismaPg } from '@prisma/adapter-pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PrismaClient } from '@/generated/prisma/client'
import { db } from '@/lib/server/db'
import { InsufficientCapacityError } from '@/lib/server/holds'
import { cancelOrder, createOrderWith } from '@/lib/server/orders'

/**
 * The reason Plan 04 exists: proof that a 900-seat venue cannot be oversold.
 *
 * A dedicated client, because `db`'s 10-connection pool and 15s/30s
 * transaction settings are right for the application but wrong for this test.
 * 1000 simultaneous interactive transactions against 10 connections reject
 * with P2028 "unable to start a transaction in the given time" long before
 * the capacity race is exercised — measured at 166-431 successes, failing the
 * assertions for entirely the wrong reason and masking a real oversell.
 *
 *   max: 20        — enough physical parallelism that transactions genuinely
 *                    contend for the row lock. More changes nothing; Postgres
 *                    still serialises on the lock.
 *   maxWait: 60s   — tail transactions really do queue for tens of seconds.
 *   timeout: 60s   — each body is well under 100ms, but serialisation stacks.
 */
const oversellClient = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 20 }),
  transactionOptions: { maxWait: 60_000, timeout: 60_000 },
})

afterAll(async () => {
  await oversellClient.$disconnect()
})

let venueId: string

async function makeEvent(capacity: number) {
  return db.event.create({
    data: {
      slug: `oversell-${crypto.randomUUID()}`,
      venueId,
      startsAt: new Date(Date.now() + 30 * 86_400_000),
      capacity,
      status: 'ON_SALE',
      // All three locales: getPublicEvent returns null without a translation
      // for the requested one, and createOrder would then reject all 1000
      // attempts as EventNotPurchasableError('unknown') — green test, zero
      // coverage.
      translations: {
        create: (['pl', 'en', 'de'] as const).map((locale) => ({
          locale,
          title: 'T',
          description: 'D',
          performers: 'P',
        })),
      },
      // maxPerOrder deliberately huge: this test must prove capacity is the
      // binding constraint, not the per-order policy limit.
      ticketTypes: {
        create: [{ pricePln: 5000, priceEur: 1200, maxPerOrder: 5000, active: true }],
      },
    },
    include: { ticketTypes: true },
  })
}

function buyer(ticketTypeId: string, email: string, quantity: number) {
  return {
    ticketTypeId,
    quantity,
    locale: 'pl' as const,
    currency: 'PLN' as const,
    email,
    firstName: 'A',
    lastName: 'B',
    attendeeNames: Array.from({ length: quantity }, (_, i) => `Test ${i}`),
    needsInvoice: false,
    acceptedTerms: true as const,
  }
}

beforeEach(async () => {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "OrderItem", "Order", "TicketType",
                   "EventTranslation", "Event", "Venue"
    RESTART IDENTITY CASCADE
  `)
  // RESTART IDENTITY does not reset a standalone sequence.
  await db.$executeRawUnsafe(`ALTER SEQUENCE "order_reference_seq" RESTART`)

  const venue = await db.venue.create({
    data: { name: 'V', address: 'A', city: 'C', defaultCapacity: 900 },
  })
  venueId = venue.id
})

describe('oversell protection', () => {
  it('a 900-seat concert cannot be oversold under 1000 concurrent buyers', async () => {
    const event = await makeEvent(900)
    const ticketType = event.ticketTypes[0]

    const results = await Promise.allSettled(
      Array.from({ length: 1000 }, (_, i) =>
        createOrderWith(oversellClient, buyer(ticketType.id, `buyer${i}@example.test`, 1)),
      ),
    )

    const succeeded = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected')

    // Which 900 buyers win is nondeterministic. The count is not: the atomic
    // UPDATE guarantees soldCount + heldCount + quantity <= capacity on every
    // commit, so a 901st success is arithmetically impossible.
    expect(succeeded).toHaveLength(900)
    expect(failed).toHaveLength(100)

    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCapacityError)
    }

    const after = await db.ticketType.findUniqueOrThrow({ where: { id: ticketType.id } })
    expect(after.heldCount).toBe(900)
    expect(after.soldCount).toBe(0)

    const pending = await db.order.count({
      where: { status: 'PENDING', items: { some: { ticketTypeId: ticketType.id } } },
    })
    expect(pending).toBe(900)
  }, 180_000)

  it('mixed-quantity holds respect capacity exactly', async () => {
    const event = await makeEvent(900)
    const ticketType = event.ticketTypes[0]

    const results = await Promise.allSettled(
      Array.from({ length: 200 }, (_, i) =>
        createOrderWith(oversellClient, buyer(ticketType.id, `buyer${i}@example.test`, 5)),
      ),
    )

    // The interesting boundary: the last winner sees heldCount 895 and takes
    // the final five; the next sees 900 and correctly fails. Without the
    // row-level re-check the latter could pass a pre-lock evaluation and
    // oversell by five.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(180)

    const after = await db.ticketType.findUniqueOrThrow({ where: { id: ticketType.id } })
    expect(after.heldCount).toBe(900)
  }, 180_000)

  it('release and hold under contention preserve the counter invariant', async () => {
    const event = await makeEvent(100)
    const ticketType = event.ticketTypes[0]

    const first = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        createOrderWith(oversellClient, buyer(ticketType.id, `first${i}@example.test`, 1)),
      ),
    )

    const toCancel = first.filter((_, i) => i % 2 === 0).map((r) => r.orderId)

    // Cancellations race a second wave of holds for the freed seats.
    await Promise.all([
      Promise.allSettled(
        Array.from({ length: 100 }, (_, i) =>
          createOrderWith(oversellClient, buyer(ticketType.id, `second${i}@example.test`, 1)),
        ),
      ),
      Promise.all(toCancel.map((id) => cancelOrder(id, 'test'))),
    ])

    const after = await db.ticketType.findUniqueOrThrow({ where: { id: ticketType.id } })
    const pending = await db.order.count({
      where: { status: 'PENDING', items: { some: { ticketTypeId: ticketType.id } } },
    })

    // Invariant 2, in its strongest form: no slack either way. A lost
    // increment or a lost decrement makes these two diverge.
    expect(after.heldCount).toBe(pending)
    // Invariant 1.
    expect(after.heldCount).toBeLessThanOrEqual(100)
  }, 180_000)
})
