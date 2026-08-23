import 'server-only'
import type { AdminUser } from '@/generated/prisma/client'
import { db } from './db'
import { hashPassword, verifyPassword } from './password'

export const MAX_FAILED_ATTEMPTS = 5
export const LOCKOUT_MINUTES = 15

export type AuthResult =
  | { ok: true; user: AdminUser }
  | { ok: false; reason: 'INVALID' | 'LOCKED' | 'INACTIVE' }

// Verified against when no account matches, so that a request for an unknown
// address costs the same time as one for a known address. Without this, the
// response latency itself reveals which emails have accounts.
let dummyHashPromise: Promise<string> | null = null
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('dummy-password-for-timing-equalisation')
  return dummyHashPromise
}

export async function authenticate(email: string, password: string): Promise<AuthResult> {
  const normalised = email.trim().toLowerCase()
  const user = await db.adminUser.findUnique({ where: { email: normalised } })

  if (!user) {
    await verifyPassword(await dummyHash(), password)
    return { ok: false, reason: 'INVALID' }
  }

  if (!user.active) return { ok: false, reason: 'INACTIVE' }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { ok: false, reason: 'LOCKED' }
  }

  // The lockout has lapsed — clear the counter before evaluating this
  // attempt. Without this, the first wrong password after a lockout expires
  // takes the count from 5 to 6 and re-locks instantly, so the account is
  // effectively locked forever after one bad afternoon.
  const priorFailures = user.lockedUntil ? 0 : user.failedLoginCount

  const valid = await verifyPassword(user.passwordHash, password)

  if (!valid) {
    const failedLoginCount = priorFailures + 1
    const lockedUntil =
      failedLoginCount >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
        : null

    await db.adminUser.update({
      where: { id: user.id },
      data: { failedLoginCount, lockedUntil },
    })

    return { ok: false, reason: 'INVALID' }
  }

  const updated = await db.adminUser.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })

  return { ok: true, user: updated }
}
