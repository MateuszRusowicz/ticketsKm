import { beforeEach, describe, expect, it, vi } from 'vitest'

const cookieStore = new Map<string, string>()

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieStore.has(n) ? { value: cookieStore.get(n) } : undefined),
    set: (n: string, v: string) => void cookieStore.set(n, v),
    delete: () => void 0,
  }),
  headers: async () => ({ get: () => '127.0.0.1' }),
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`)
  },
}))

vi.mock('next/cache', () => ({ revalidatePath: () => void 0 }))

import { db } from '@/lib/server/db'
import { startSession } from '@/lib/server/auth'
import { createEventAction } from '@/app/(admin)/admin/events/actions'

function form(slug: string, venueId: string): FormData {
  const fd = new FormData()
  fd.set('slug', slug)
  fd.set('venueId', venueId)
  fd.set('startsAt', '2026-08-14T19:00')
  fd.set('capacity', '100')
  fd.set('status', 'DRAFT')
  fd.set('pricePln', '50')
  fd.set('priceEur', '12')
  fd.set('maxPerOrder', '10')
  for (const l of ['pl', 'en', 'de']) {
    fd.set(`${l}.title`, 'T')
    fd.set(`${l}.description`, 'D')
    fd.set(`${l}.performers`, 'P')
  }
  return fd
}

let venueId: string

beforeEach(async () => {
  cookieStore.clear()
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "TicketType", "EventTranslation", "Event",
                   "Venue", "AdminSession", "AdminUser" RESTART IDENTITY CASCADE
  `)
  const venue = await db.venue.create({
    data: { name: 'V', address: 'A', city: 'C', defaultCapacity: 900 },
  })
  venueId = venue.id
})

describe('createEventAction authorisation', () => {
  it('refuses an anonymous caller', async () => {
    await expect(createEventAction({}, form('anon', venueId))).rejects.toThrow(
      'REDIRECT:/admin/login',
    )
    expect(await db.event.count()).toBe(0)
  })

  it('refuses a SCANNER even with a valid session', async () => {
    const scanner = await db.adminUser.create({
      data: { email: 's@example.com', name: 'S', role: 'SCANNER', passwordHash: 'x' },
    })
    await startSession(scanner.id)

    await expect(createEventAction({}, form('scanner', venueId))).rejects.toThrow(
      'REDIRECT:/admin/scan',
    )
    expect(await db.event.count()).toBe(0)
  })

  it('allows an ADMIN', async () => {
    const admin = await db.adminUser.create({
      data: { email: 'a@example.com', name: 'A', role: 'ADMIN', passwordHash: 'x' },
    })
    await startSession(admin.id)

    // A successful action redirects, which the mock turns into a throw.
    await expect(createEventAction({}, form('allowed', venueId))).rejects.toThrow(
      'REDIRECT:/admin/events',
    )
    expect(await db.event.count()).toBe(1)
  })

  it('stores the typed wall-clock time as Warsaw local, not UTC', async () => {
    const admin = await db.adminUser.create({
      data: { email: 'b@example.com', name: 'B', role: 'ADMIN', passwordHash: 'x' },
    })
    await startSession(admin.id)

    await expect(createEventAction({}, form('tz', venueId))).rejects.toThrow('REDIRECT:')

    const event = await db.event.findUniqueOrThrow({ where: { slug: 'tz' } })
    expect(event.startsAt.toISOString()).toBe('2026-08-14T17:00:00.000Z')
  })

  it('stores prices as integer minor units', async () => {
    const admin = await db.adminUser.create({
      data: { email: 'c@example.com', name: 'C', role: 'ADMIN', passwordHash: 'x' },
    })
    await startSession(admin.id)

    await expect(createEventAction({}, form('money', venueId))).rejects.toThrow('REDIRECT:')

    const type = await db.ticketType.findFirstOrThrow({
      where: { event: { slug: 'money' } },
    })
    expect(type.pricePln).toBe(5000)
    expect(type.priceEur).toBe(1200)
  })
})
