import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SweepResult } from '@/lib/shared/holds-sweep'

// ---------------------------------------------------------------------------
// Hoisted mocks — TDZ-safe
// ---------------------------------------------------------------------------
const { mockSweepPrimary, mockSweepAsync } = vi.hoisted(() => ({
  mockSweepPrimary: vi.fn<() => Promise<SweepResult>>(),
  mockSweepAsync: vi.fn<() => Promise<SweepResult>>(),
}))

vi.mock('@/lib/server/sweep-holds', () => ({
  sweepExpiredHolds: mockSweepPrimary,
  sweepAsyncExpiredHolds: mockSweepAsync,
}))

import { GET as getPrimary } from '@/app/api/cron/release-holds/route'
import { GET as getAsync } from '@/app/api/cron/async-release-holds/route'

const CRON_SECRET = process.env.CRON_SECRET ?? ''

function makeRequest(secret?: string, path = '/api/cron/release-holds'): Request {
  const headers: Record<string, string> = {}
  if (secret !== undefined) headers['authorization'] = `Bearer ${secret}`
  return new Request(`http://localhost${path}`, { method: 'GET', headers })
}

const ALL_CLEAN: SweepResult = { expired: 0, released: 0, failed: 0 }
const WITH_FAILURES: SweepResult = { expired: 2, released: 4, failed: 1 }

beforeEach(() => {
  mockSweepPrimary.mockReset()
  mockSweepAsync.mockReset()
  mockSweepPrimary.mockResolvedValue(ALL_CLEAN)
  mockSweepAsync.mockResolvedValue(ALL_CLEAN)
})

describe('GET /api/cron/release-holds', () => {
  it('case 1: valid secret — calls sweep and returns 200 when no failures', async () => {
    const res = await getPrimary(makeRequest(CRON_SECRET))

    expect(res.status).toBe(200)
    expect(mockSweepPrimary).toHaveBeenCalledOnce()
    const body = await res.json() as SweepResult
    expect(body).toEqual(ALL_CLEAN)
  })

  it('case 2: missing Authorization header — returns 401 without calling sweep', async () => {
    const res = await getPrimary(makeRequest(undefined))

    expect(res.status).toBe(401)
    expect(mockSweepPrimary).not.toHaveBeenCalled()
  })

  it('case 3: wrong secret — returns 401 without calling sweep', async () => {
    const res = await getPrimary(makeRequest('wrong_secret'))

    expect(res.status).toBe(401)
    expect(mockSweepPrimary).not.toHaveBeenCalled()
  })

  it('case 4: sweep has failures — returns 207', async () => {
    mockSweepPrimary.mockResolvedValueOnce(WITH_FAILURES)

    const res = await getPrimary(makeRequest(CRON_SECRET))

    expect(res.status).toBe(207)
    const body = await res.json() as SweepResult
    expect(body.failed).toBe(1)
  })

  it('case 5: stderr line format matches SWEEP-PRIMARY', async () => {
    mockSweepPrimary.mockResolvedValueOnce({ expired: 3, released: 6, failed: 0 })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await getPrimary(makeRequest(CRON_SECRET))

    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/^SWEEP-PRIMARY expired=3 released=6 failed=0$/),
    )
    spy.mockRestore()
  })
})

describe('GET /api/cron/async-release-holds', () => {
  it('case 6: valid secret — calls async sweep and returns 200', async () => {
    const res = await getAsync(makeRequest(CRON_SECRET, '/api/cron/async-release-holds'))

    expect(res.status).toBe(200)
    expect(mockSweepAsync).toHaveBeenCalledOnce()
  })

  it('case 7: wrong secret — returns 401', async () => {
    const res = await getAsync(makeRequest('bad', '/api/cron/async-release-holds'))

    expect(res.status).toBe(401)
    expect(mockSweepAsync).not.toHaveBeenCalled()
  })

  it('case 8: async sweep with failures — returns 207', async () => {
    mockSweepAsync.mockResolvedValueOnce(WITH_FAILURES)

    const res = await getAsync(makeRequest(CRON_SECRET, '/api/cron/async-release-holds'))

    expect(res.status).toBe(207)
  })

  it('case 9: async stderr line matches SWEEP-ASYNC', async () => {
    mockSweepAsync.mockResolvedValueOnce({ expired: 1, released: 2, failed: 0 })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await getAsync(makeRequest(CRON_SECRET, '/api/cron/async-release-holds'))

    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/^SWEEP-ASYNC expired=1 released=2 failed=0$/),
    )
    spy.mockRestore()
  })
})
