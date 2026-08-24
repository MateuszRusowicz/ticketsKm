import 'server-only'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { AdminUser } from '@/generated/prisma/client'
import { createSession, deleteSession, findSessionUser } from './sessions'

export const SESSION_COOKIE = 'km_session'

// Scoped to /admin, not /. Nothing outside the admin area reads the session,
// and this keeps it off every public shop request, every static asset and
// every /t/<code> ticket page.
const COOKIE_PATH = '/admin'

export async function startSession(adminUserId: string): Promise<void> {
  const { token, expiresAt } = await createSession(adminUserId)
  const store = await cookies()

  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: COOKIE_PATH,
    expires: expiresAt,
  })
}

export async function endSession(): Promise<void> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (token) await deleteSession(token)
  // The path must match the one used to set it, or the delete silently
  // does nothing and the user stays logged in.
  store.delete({ name: SESSION_COOKIE, path: COOKIE_PATH })
}

export async function getCurrentAdmin(): Promise<AdminUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  return findSessionUser(token)
}

/** Any active admin account. Used by the scanner. */
export async function requireStaff(): Promise<AdminUser> {
  const user = await getCurrentAdmin()
  if (!user) redirect('/admin/login')
  return user
}

/** ADMIN role only. Used by everything except the scanner. */
export async function requireAdmin(): Promise<AdminUser> {
  const user = await requireStaff()
  if (user.role !== 'ADMIN') redirect('/admin/scan')
  return user
}
