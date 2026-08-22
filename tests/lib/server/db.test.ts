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
