import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'

/**
 * The reconciliation script is a CLI, so it is exercised as one — that is
 * also the only way to assert on its exit code, which is what a cron or a
 * human actually reads.
 */
function runVerify(args: string[] = []): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('pnpm', ['exec', 'tsx', 'scripts/verify-holds.ts', ...args], {
      encoding: 'utf8',
      env: { ...process.env, DIRECT_URL: process.env.DATABASE_URL },
    })
    return { stdout, status: 0 }
  } catch (e) {
    const err = e as { stdout?: string; status?: number }
    return { stdout: err.stdout ?? '', status: err.status ?? 1 }
  }
}

// Same defect as tests/scripts/reset-admin-password.test.ts, which documented
// it and fixed only itself: every `runVerify` spawns `pnpm exec tsx`, measured
// at ~2.6s before the script begins. Vitest's default testTimeout is 5s and
// vitest.config.mts raises only hookTimeout, so the `--fix` test — the one
// that spawns twice — sat ~0.2s under the limit and failed the first time the
// machine ran slow. It passes in isolation and fails in the full suite, which
// is what a marginal timeout looks like, not a logic bug.
const SPAWN_TIMEOUT = 30_000

let ticketTypeId: string

beforeEach(async () => {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "OrderItem", "Order", "TicketType",
                   "EventTranslation", "Event", "Venue"
    RESTART IDENTITY CASCADE
  `)

  const venue = await db.venue.create({
    data: { name: 'Verify venue', city: 'C', address: 'A', defaultCapacity: 100 },
  })
  const event = await db.event.create({
    data: {
      slug: 'verify-drift',
      venueId: venue.id,
      capacity: 100,
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
  ticketTypeId = event.ticketTypes[0].id
})

describe('holds:verify', () => {
  it('reports no drift and exits 0 on a consistent database', () => {
    const { stdout, status } = runVerify()

    expect(stdout).toContain('no drift')
    expect(status).toBe(0)
  }, SPAWN_TIMEOUT)

  it('detects an inflated heldCount and exits 1', async () => {
    // Drift of exactly the kind nothing else would ever notice: capacity
    // silently removed from sale with no order justifying it.
    await db.ticketType.update({ where: { id: ticketTypeId }, data: { heldCount: 3 } })

    const { stdout, status } = runVerify()

    expect(stdout).toContain('verify-drift')
    expect(stdout).toContain('drift=+3')
    expect(status).toBe(1)
  }, SPAWN_TIMEOUT)

  it('corrects drift with --fix and records why', async () => {
    await db.ticketType.update({ where: { id: ticketTypeId }, data: { heldCount: 3 } })

    const fixed = runVerify(['--fix'])
    expect(fixed.status).toBe(0)

    const after = await db.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } })
    expect(after.heldCount).toBe(0)

    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'holds.reconcile' } })
    expect(audit.meta).toMatchObject({ before: 3, after: 0, drift: 3 })

    expect(runVerify().status).toBe(0)
  }, SPAWN_TIMEOUT)
})
