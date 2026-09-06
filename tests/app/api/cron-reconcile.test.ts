import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReconcileResult } from '@/lib/server/reconcile'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockReconcile } = vi.hoisted(() => ({
  mockReconcile: vi.fn<() => Promise<ReconcileResult>>(),
}))

vi.mock('@/lib/server/reconcile', () => ({
  reconcile: mockReconcile,
}))

import { GET } from '@/app/api/cron/reconcile/route'

const CRON_SECRET = process.env.CRON_SECRET ?? ''

function makeRequest(secret?: string): Request {
  const headers: Record<string, string> = {}
  if (secret !== undefined) headers['authorization'] = `Bearer ${secret}`
  return new Request('http://localhost/api/cron/reconcile', { method: 'GET', headers })
}

const ALL_CLEAN: ReconcileResult = {
  recoveredRefunds: 0,
  stuckWebhooks: 0,
  ticketGaps: 0,
  alerts: 0,
}

beforeEach(() => {
  mockReconcile.mockReset()
  mockReconcile.mockResolvedValue(ALL_CLEAN)
})

describe('GET /api/cron/reconcile', () => {
  it('valid secret — calls reconcile and returns 200 when alerts=0', async () => {
    const res = await GET(makeRequest(CRON_SECRET))

    expect(res.status).toBe(200)
    expect(mockReconcile).toHaveBeenCalledOnce()
    const body = await res.json() as ReconcileResult
    expect(body).toEqual(ALL_CLEAN)
  })

  it('missing Authorization header — returns 401 without calling reconcile', async () => {
    const res = await GET(makeRequest(undefined))

    expect(res.status).toBe(401)
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('wrong secret — returns 401 without calling reconcile', async () => {
    const res = await GET(makeRequest('bad_secret'))

    expect(res.status).toBe(401)
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('alerts > 0 — returns 207', async () => {
    mockReconcile.mockResolvedValueOnce({ recoveredRefunds: 1, stuckWebhooks: 0, ticketGaps: 1, alerts: 2 })

    const res = await GET(makeRequest(CRON_SECRET))

    expect(res.status).toBe(207)
    const body = await res.json() as ReconcileResult
    expect(body.alerts).toBe(2)
  })
})
