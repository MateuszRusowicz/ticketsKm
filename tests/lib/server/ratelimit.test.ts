import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimits, pruneRateLimits, rateLimit } from '@/lib/server/ratelimit'

afterEach(() => {
  vi.useRealTimers()
})

describe('rateLimit', () => {
  it('allows up to the limit then refuses', () => {
    const key = `k${Math.random()}`
    for (let i = 0; i < 3; i++) expect(rateLimit(key, 3, 60_000)).toBe(true)
    expect(rateLimit(key, 3, 60_000)).toBe(false)
  })

  it('keeps separate counters per key', () => {
    const a = `a${Math.random()}`
    const b = `b${Math.random()}`
    expect(rateLimit(a, 1, 60_000)).toBe(true)
    expect(rateLimit(a, 1, 60_000)).toBe(false)
    expect(rateLimit(b, 1, 60_000)).toBe(true)
  })

  // Fake timers, not a short real window: with a 1ms window the second call
  // can legitimately land after it has already expired, so the test would
  // pass or fail depending on machine speed.
  it('resets after the window', () => {
    vi.useFakeTimers()
    const key = `k${Math.random()}`

    expect(rateLimit(key, 1, 60_000)).toBe(true)
    expect(rateLimit(key, 1, 60_000)).toBe(false)

    vi.advanceTimersByTime(60_001)
    expect(rateLimit(key, 1, 60_000)).toBe(true)
  })

  it('prunes expired windows', () => {
    vi.useFakeTimers()
    const key = `p${Math.random()}`
    rateLimit(key, 1, 60_000)

    vi.advanceTimersByTime(60_001)
    pruneRateLimits()

    // Pruned, so a fresh window starts and the call is allowed.
    expect(rateLimit(key, 1, 60_000)).toBe(true)
  })
})

describe('__resetRateLimits', () => {
  it('clears an exhausted budget so tests do not poison each other', () => {
    for (let i = 0; i < 3; i++) expect(rateLimit('reset-probe', 3, 60_000)).toBe(true)
    expect(rateLimit('reset-probe', 3, 60_000)).toBe(false)

    __resetRateLimits()

    expect(rateLimit('reset-probe', 3, 60_000)).toBe(true)
  })
})
