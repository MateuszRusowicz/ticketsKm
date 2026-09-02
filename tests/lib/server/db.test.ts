import { describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'

describe('database connection', () => {
  it('reaches the test database', async () => {
    const rows = await db.$queryRaw<Array<{ ok: number }>>`SELECT 1 as ok`
    expect(rows[0].ok).toBe(1)
  })

  it('has the Venue table', async () => {
    await expect(db.venue.count()).resolves.toBeTypeOf('number')
  })
})

// A load smoke test, NOT a guard on the tuning in src/lib/server/db.ts.
//
// Verified by negative control on 2 Sep 2026: with `transactionOptions` and
// `max` removed and Prisma's stock defaults restored (maxWait 2s), these tests
// still pass. Local Docker Postgres accepts connections far too quickly to
// reproduce the condition the tuning exists for — a Neon scale-to-zero cold
// start, and hundreds of holds across Vercel instances serialising on one
// TicketType row. Do not read a green run here as evidence the tuning is
// correct or even present; it is evidence the pool is not broken.
describe('connection pool under load', () => {
  it('serves 500 concurrent queries without a rejection', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 500 }, () => db.$queryRaw`SELECT 1 as ok`),
    )

    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0)
  }, 60_000)

  it('runs 50 concurrent interactive transactions without starving the pool', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1`
          await tx.$queryRaw`SELECT 2`
          return true
        }),
      ),
    )

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(50)
  }, 60_000)
})
