import 'server-only'

type Window = { count: number; resetAt: number }

// In-memory and therefore per-instance: on Vercel, several function
// instances each keep their own counter, so the effective limit is looser
// than the number below. That is an accepted trade-off for Plan 01 — it
// raises the cost of an attack by orders of magnitude for ~20 lines and no
// new infrastructure. A shared store arrives in phase 8 alongside the
// checkout and scan limits.
const windows = new Map<string, Window>()

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const existing = windows.get(key)

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }

  if (existing.count >= limit) return false

  existing.count += 1
  return true
}

/** Prevents unbounded growth on a long-lived instance. */
export function pruneRateLimits(now = Date.now()): void {
  for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key)
}
