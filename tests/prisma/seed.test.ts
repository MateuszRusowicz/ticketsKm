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
    expect(await db.event.count()).toBe(10)
    expect(await db.adminUser.count()).toBe(2)
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
