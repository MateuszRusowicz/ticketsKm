import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import { generateOrderReference } from '@/lib/server/order-reference'
import { REFERENCE_RE } from '@/lib/shared/order-reference'

beforeEach(async () => {
  // RESTART IDENTITY does not touch a standalone sequence, so reset it here or
  // references drift between files and between runs.
  await db.$executeRawUnsafe('ALTER SEQUENCE "order_reference_seq" RESTART')
})

describe('generateOrderReference', () => {
  it('takes the year from the supplied clock, not the wall clock', async () => {
    const reference = await generateOrderReference(new Date('2027-06-15T00:00:00Z'), db)
    expect(reference).toMatch(/^KM-2027-\d{6}$/)
  })

  it('never issues the same reference twice under concurrency', async () => {
    const references = await Promise.all(
      Array.from({ length: 100 }, () => generateOrderReference(new Date('2026-01-01T00:00:00Z'), db)),
    )

    expect(new Set(references).size).toBe(100)
    for (const reference of references) expect(REFERENCE_RE.test(reference)).toBe(true)
  })

  it('accepts a transaction client and advances even when that transaction rolls back', async () => {
    // Sequences are non-transactional in Postgres: nextval is not rolled back.
    // That is the property which makes a retry loop unnecessary, so pin it.
    const before = await generateOrderReference(new Date('2026-01-01T00:00:00Z'), db)

    await expect(
      db.$transaction(async (tx) => {
        await generateOrderReference(new Date('2026-01-01T00:00:00Z'), tx)
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')

    const after = await generateOrderReference(new Date('2026-01-01T00:00:00Z'), db)

    const seq = (r: string) => Number(r.slice(-6))
    expect(seq(after)).toBe(seq(before) + 2)
  })
})
