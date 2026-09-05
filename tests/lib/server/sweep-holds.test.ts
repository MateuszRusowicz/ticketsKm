import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/server/db'
import { createOrder } from '@/lib/server/orders'
import { sweepExpiredHolds, sweepAsyncExpiredHolds } from '@/lib/server/sweep-holds'
import { sweepExpiredHoldsWith, sweepAsyncExpiredHoldsWith, expireOrderWith } from '@/lib/shared/holds-sweep'

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

async function lapseByMs(orderId: string, ms: number) {
  await db.order.update({
    where: { id: orderId },
    data: { holdExpiresAt: new Date(Date.now() - ms) },
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

// ---------------------------------------------------------------------------
// Primary sweep (PI-status-aware, keyset-paginated)
// ---------------------------------------------------------------------------

describe('sweepExpiredHolds', () => {
  it('reports nothing on an empty database', async () => {
    await expect(sweepExpiredHolds()).resolves.toEqual({ expired: 0, released: 0, failed: 0 })
  })

  // Case 1: no PI, expired → swept
  it('expires a lapsed hold with no PaymentIntent and returns its seats', async () => {
    const order = await anOrder('a@example.test')
    await lapse(order.orderId)

    expect(await sweepExpiredHolds()).toEqual({ expired: 1, released: 2, failed: 0 })
    expect(await heldCount()).toBe(0)
    expect(await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).toMatchObject({
      status: 'EXPIRED',
    })
  })

  it('leaves a hold that is still within its window', async () => {
    await anOrder('b@example.test')

    expect(await sweepExpiredHolds()).toEqual({ expired: 0, released: 0, failed: 0 })
    expect(await heldCount()).toBe(2)
  })

  // Case 3: processing → NOT swept (in-flight)
  it('leaves a lapsed order whose PI is in-flight (processing)', async () => {
    // A Przelewy24 / SEPA order that is actively processing must never be
    // swept — the buyer is still paying. The guard is paymentIntentStatus, not
    // stripePaymentIntentId alone.
    const order = await anOrder('c@example.test')
    await lapse(order.orderId)
    await db.order.update({
      where: { id: order.orderId },
      data: { stripePaymentIntentId: 'pi_test_async', paymentIntentStatus: 'processing' },
    })

    expect(await sweepExpiredHolds()).toEqual({ expired: 0, released: 0, failed: 0 })
    expect(await heldCount()).toBe(2)
  })

  it('ignores a PAID order even with a stale holdExpiresAt', async () => {
    const order = await anOrder('d@example.test')
    await lapse(order.orderId)
    await db.order.update({ where: { id: order.orderId }, data: { status: 'PAID' } })

    expect(await sweepExpiredHolds()).toEqual({ expired: 0, released: 0, failed: 0 })
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

    expect(result).toEqual({ expired: 550, released: 550, failed: 0 })
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

  // Case 2: requires_confirmation → NOT swept (mid-checkout in-flight)
  it('leaves a lapsed order with paymentIntentStatus = requires_confirmation', async () => {
    const order = await anOrder('req-conf@example.test')
    await lapse(order.orderId)
    await db.order.update({
      where: { id: order.orderId },
      data: {
        stripePaymentIntentId: 'pi_test_conf',
        paymentIntentStatus: 'requires_confirmation',
      },
    })

    const result = await sweepExpiredHolds()
    expect(result).toEqual({ expired: 0, released: 0, failed: 0 })
    expect(await heldCount()).toBe(2)
  })

  // Case 4: requires_payment_method (declined) → IS swept (buyer bailed)
  it('sweeps a lapsed order with paymentIntentStatus = requires_payment_method', async () => {
    const order = await anOrder('declined@example.test')
    await lapse(order.orderId)
    await db.order.update({
      where: { id: order.orderId },
      data: {
        stripePaymentIntentId: 'pi_test_declined',
        paymentIntentStatus: 'requires_payment_method',
      },
    })

    const result = await sweepExpiredHolds()
    expect(result).toEqual({ expired: 1, released: 2, failed: 0 })
    expect(await heldCount()).toBe(0)
  })

  // Case 5: head-of-line — middle order throws, keyset advances past it on same tick
  it('counts failed orders separately and advances keyset past them', async () => {
    // Three orders with distinct expiry times so ordering is deterministic.
    const early = await anOrder('hol-early@example.test')
    const mid = await anOrder('hol-mid@example.test')
    const late = await anOrder('hol-late@example.test')
    await lapseByMs(early.orderId, 300_000)
    await lapseByMs(mid.orderId, 200_000)
    await lapseByMs(late.orderId, 100_000)

    const failId = mid.orderId

    const result = await sweepExpiredHoldsWith(db, async (id) => {
      if (id === failId) throw new Error('deliberate test failure — head-of-line')
      return db.$transaction((tx) => expireOrderWith(tx, id))
    })

    // Two succeed, one fails. The keyset advanced past the failed order so the
    // late order was reached on the same tick — it did not spin.
    expect(result).toEqual({ expired: 2, failed: 1, released: 4 })
    // Failed order stays PENDING; the others are EXPIRED.
    const statuses = await db.order.findMany({
      where: { id: { in: [early.orderId, mid.orderId, late.orderId] } },
      orderBy: { holdExpiresAt: 'asc' },
      select: { id: true, status: true },
    })
    // ASC: earliest-expiry (early, 300s ago) first, latest-expiry (late, 100s ago) last.
    expect(statuses[0]).toMatchObject({ id: early.orderId, status: 'EXPIRED' })
    expect(statuses[1]).toMatchObject({ id: mid.orderId, status: 'PENDING' })
    expect(statuses[2]).toMatchObject({ id: late.orderId, status: 'EXPIRED' })
  })

  // Case 9: stderr line format
  it('emits a SWEEP-PRIMARY line on stderr', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const order = await anOrder('stderr@example.test')
      await lapse(order.orderId)
      await sweepExpiredHolds()
      const match = spy.mock.calls.some(
        (args) => typeof args[0] === 'string' && /^SWEEP-PRIMARY /.test(args[0]),
      )
      expect(match).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Secondary sweep (SEPA-aware, hard-timeout)
// ---------------------------------------------------------------------------

const SEPA_TIMEOUT_DAYS = 5
const ASYNC_TIMEOUT_SECS = 6 * 60 * 60 // 6 hours

function makeExpireOne(isSepaExpected?: boolean) {
  return async (orderId: string, isSepa: boolean) => {
    if (isSepaExpected !== undefined) expect(isSepa).toBe(isSepaExpected)
    return db.$transaction((tx) =>
      expireOrderWith(tx, orderId, isSepa ? { trigger: 'sepa_hard_timeout' } : undefined),
    )
  }
}

// Case 6: SEPA order 6 days old → swept, trigger = sepa_hard_timeout
it('secondary sweep: expires SEPA order past the hard timeout', async () => {
  const order = await anOrder('sepa-old@example.test')
  await lapseByMs(order.orderId, 6 * 24 * 60 * 60 * 1000) // 6 days in the past
  await db.order.update({
    where: { id: order.orderId },
    data: {
      stripePaymentIntentId: 'pi_sepa_old',
      paymentIntentStatus: 'processing',
      paymentMethodType: 'sepa_debit',
    },
  })

  const result = await sweepAsyncExpiredHoldsWith(
    db,
    { sepaHardTimeoutDays: SEPA_TIMEOUT_DAYS, asyncPaymentTimeoutSecs: ASYNC_TIMEOUT_SECS },
    makeExpireOne(true),
  )

  expect(result).toEqual({ expired: 1, released: 2, failed: 0 })
  expect(await heldCount()).toBe(0)

  const audit = await db.auditLog.findFirst({
    where: { entityId: order.orderId, action: 'order.expire' },
  })
  expect(audit?.meta).toMatchObject({ trigger: 'sepa_hard_timeout' })
})

// Case 7: non-SEPA processing order 7h old → swept
it('secondary sweep: expires non-SEPA order past the async timeout', async () => {
  const order = await anOrder('p24-old@example.test')
  await lapseByMs(order.orderId, 7 * 60 * 60 * 1000) // 7 hours in the past
  await db.order.update({
    where: { id: order.orderId },
    data: {
      stripePaymentIntentId: 'pi_p24_old',
      paymentIntentStatus: 'processing',
      paymentMethodType: 'p24',
    },
  })

  const result = await sweepAsyncExpiredHoldsWith(
    db,
    { sepaHardTimeoutDays: SEPA_TIMEOUT_DAYS, asyncPaymentTimeoutSecs: ASYNC_TIMEOUT_SECS },
    makeExpireOne(false),
  )

  expect(result).toEqual({ expired: 1, released: 2, failed: 0 })
  expect(await heldCount()).toBe(0)
})

// Case 8: SEPA order 4 days old → NOT swept (within hard cap)
it('secondary sweep: does not expire SEPA order within the hard timeout', async () => {
  const order = await anOrder('sepa-new@example.test')
  await lapseByMs(order.orderId, 4 * 24 * 60 * 60 * 1000) // only 4 days
  await db.order.update({
    where: { id: order.orderId },
    data: {
      stripePaymentIntentId: 'pi_sepa_new',
      paymentIntentStatus: 'processing',
      paymentMethodType: 'sepa_debit',
    },
  })

  const result = await sweepAsyncExpiredHoldsWith(
    db,
    { sepaHardTimeoutDays: SEPA_TIMEOUT_DAYS, asyncPaymentTimeoutSecs: ASYNC_TIMEOUT_SECS },
    makeExpireOne(),
  )

  expect(result).toEqual({ expired: 0, released: 0, failed: 0 })
  expect(await heldCount()).toBe(2)
})

// sweepAsyncExpiredHolds binding uses env values
it('sweepAsyncExpiredHolds binding: sweeps nothing on an empty db', async () => {
  await expect(sweepAsyncExpiredHolds()).resolves.toEqual({ expired: 0, released: 0, failed: 0 })
})
