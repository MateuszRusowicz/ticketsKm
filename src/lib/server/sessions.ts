import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import type { AdminRole, AdminUser } from '@/generated/prisma/client'
import { db } from './db'

// Two TTLs, because the two roles have opposite risks. A scanner phone is
// borrowed, carried around a venue and easily mislaid, so its session should
// not outlive the evening. An administrator doing back-office work all day
// must not be logged out mid-refund.
export const SESSION_TTL_HOURS: Record<AdminRole, number> = {
  SCANNER: 8,
  ADMIN: 12,
}

// When a session is used with less than this left, its expiry is pushed out.
// Without it, a 12-hour cap logs an admin out at the busiest moment of the
// day regardless of how active they were.
const REFRESH_WHEN_UNDER_HOURS = 2

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(
  adminUserId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const admin = await db.adminUser.findUniqueOrThrow({ where: { id: adminUserId } })
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS[admin.role] * 60 * 60 * 1000)

  await db.adminSession.create({
    data: { tokenHash: hashToken(token), adminUserId, expiresAt },
  })

  return { token, expiresAt }
}

export async function findSessionUser(token: string): Promise<AdminUser | null> {
  const session = await db.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { admin: true },
  })

  if (!session) return null
  if (session.expiresAt <= new Date()) return null
  if (!session.admin.active) return null

  // Rolling expiry: extend only when the session is close to lapsing, so
  // an active user is never logged out mid-task and an idle one still is.
  const remainingMs = session.expiresAt.getTime() - Date.now()
  if (remainingMs < REFRESH_WHEN_UNDER_HOURS * 60 * 60 * 1000) {
    await db.adminSession.update({
      where: { tokenHash: session.tokenHash },
      data: {
        expiresAt: new Date(Date.now() + SESSION_TTL_HOURS[session.admin.role] * 60 * 60 * 1000),
      },
    })
  }

  return session.admin
}

export async function deleteSession(token: string): Promise<void> {
  await db.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } })
}

export async function deleteExpiredSessions(): Promise<number> {
  const { count } = await db.adminSession.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  })
  return count
}
