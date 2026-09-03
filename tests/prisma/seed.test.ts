import { execSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'

beforeAll(async () => {
  // Test files run sequentially against ONE database, and earlier files
  // leave rows behind after their final test. Without this truncate the
  // exact-count assertions below would pick up that residue and fail in a
  // way that depends on file ordering — the worst kind of flake.
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog", "Ticket", "OrderItem", "Order", "PromoCode",
      "TicketType", "EventTranslation", "Event", "Venue",
      "AdminSession", "AdminUser", "StripeWebhookEvent"
    RESTART IDENTITY CASCADE
  `)

  // Run twice: the second run is the idempotency assertion.
  execSync('pnpm exec tsx prisma/seed.ts', { stdio: 'pipe', env: { ...process.env } })
  execSync('pnpm exec tsx prisma/seed.ts', { stdio: 'pipe', env: { ...process.env } })
})

describe('seed', () => {
  it('is idempotent', async () => {
    expect(await db.venue.count()).toBe(2)
    expect(await db.event.count()).toBe(11)
    expect(await db.adminUser.count()).toBe(2)
    // Seeded twice above against a truncated database, so this is the real
    // idempotency assertion: the stale-hold order must be upserted, not
    // duplicated.
    expect(await db.order.count()).toBe(1)
    expect(await db.orderItem.count()).toBe(1)
  })

  it('seeds a stale PENDING hold for the sweep to find', async () => {
    const order = await db.order.findUniqueOrThrow({
      where: { reference: 'KM-0000-000001' },
      include: { items: true },
    })

    expect(order.status).toBe('PENDING')
    expect(order.holdExpiresAt).not.toBeNull()
    expect(order.holdExpiresAt!.getTime()).toBeLessThan(Date.now())
    expect(order.items).toHaveLength(1)
    expect(order.items[0].quantity).toBe(5)
  })

  it('keeps heldCount equal to the held order quantity across re-seeds', async () => {
    // Invariant 2. heldCount is set by an explicit updateMany because the
    // event upsert's update branch leaves nested creates alone — if that
    // regressed, the second seed would leave this at 0.
    const ticketType = await db.ticketType.findFirstOrThrow({
      where: { event: { slug: 'test-w-rezerwacji' } },
    })

    expect(ticketType.heldCount).toBe(5)
    expect(ticketType.soldCount).toBe(0)
  })

  it('stores Polish diacritics intact', async () => {
    const venue = await db.venue.findFirstOrThrow({ where: { city: 'Świdnica' } })
    expect(venue.name).toBe('Kościół Pokoju')

    const t = await db.eventTranslation.findFirstOrThrow({
      where: { locale: 'pl', title: { contains: 'Karłowicz' } },
    })
    expect(t.performers).toContain('Mieczysław')
  })

  it('gives every concert all three translations', async () => {
    const events = await db.event.findMany({ include: { translations: true } })
    for (const e of events) {
      expect(e.translations.map((t) => t.locale).sort()).toEqual(['de', 'en', 'pl'])
    }
  })

  it('stores admin emails in lowercase', async () => {
    const admins = await db.adminUser.findMany()
    for (const a of admins) expect(a.email).toBe(a.email.toLowerCase())
  })
})
