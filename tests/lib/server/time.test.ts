import { describe, expect, it } from 'vitest'
import { utcToWarsawLocalInput, warsawLocalToUtc } from '@/lib/server/time'

describe('warsawLocalToUtc', () => {
  it('treats summer input as CEST (UTC+2)', () => {
    expect(warsawLocalToUtc('2026-08-14T19:00').toISOString()).toBe('2026-08-14T17:00:00.000Z')
  })

  it('treats winter input as CET (UTC+1)', () => {
    expect(warsawLocalToUtc('2026-01-14T19:00').toISOString()).toBe('2026-01-14T18:00:00.000Z')
  })
})

describe('round trip', () => {
  it('returns the same wall-clock time it was given', () => {
    for (const wall of ['2026-08-14T19:00', '2026-01-14T19:00', '2026-03-29T04:00']) {
      expect(utcToWarsawLocalInput(warsawLocalToUtc(wall))).toBe(wall)
    }
  })
})
