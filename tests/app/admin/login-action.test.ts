import { beforeEach, describe, expect, it, vi } from 'vitest'

const cookieStore = new Map<string, string>()
let clientIp = '10.0.0.1'

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieStore.has(n) ? { value: cookieStore.get(n) } : undefined),
    set: (n: string, v: string) => void cookieStore.set(n, v),
    delete: (arg: string | { name: string }) =>
      void cookieStore.delete(typeof arg === 'string' ? arg : arg.name),
  }),
  headers: async () => ({ get: () => clientIp }),
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`)
  },
}))

import { db } from '@/lib/server/db'
import { hashPassword } from '@/lib/server/password'
import { SESSION_COOKIE } from '@/lib/server/auth'
import { loginAction } from '@/app/(admin)/admin/login/actions'

const PASSWORD = 'CorrectHorseBattery1!'

function form(email: string, password: string): FormData {
  const fd = new FormData()
  fd.set('email', email)
  fd.set('password', password)
  return fd
}

async function makeAdmin(email: string, role: 'ADMIN' | 'SCANNER') {
  return db.adminUser.create({
    data: { email, name: 'T', role, passwordHash: await hashPassword(PASSWORD) },
  })
}

beforeEach(async () => {
  cookieStore.clear()
  // A fresh IP per test: the rate limiter is a module-level in-memory Map,
  // so counters would otherwise leak between tests in this file.
  clientIp = `10.0.0.${Math.floor(Math.random() * 250) + 1}-${Math.random()}`
  await db.$executeRawUnsafe('TRUNCATE TABLE "AdminSession", "AdminUser" RESTART IDENTITY CASCADE')
})

describe('loginAction', () => {
  it('signs an ADMIN in and sets a session cookie', async () => {
    await makeAdmin('admin@example.com', 'ADMIN')

    await expect(loginAction({}, form('admin@example.com', PASSWORD))).rejects.toThrow(
      'REDIRECT:/admin',
    )
    expect(cookieStore.has(SESSION_COOKIE)).toBe(true)
  })

  it('sends a SCANNER to the scan page, not the dashboard', async () => {
    await makeAdmin('scanner@example.com', 'SCANNER')

    await expect(loginAction({}, form('scanner@example.com', PASSWORD))).rejects.toThrow(
      'REDIRECT:/admin/scan',
    )
  })

  it('rejects a wrong password without setting a cookie', async () => {
    await makeAdmin('admin@example.com', 'ADMIN')

    const result = await loginAction({}, form('admin@example.com', 'wrong'))
    expect(result.error).toMatch(/Nieprawidłowy/)
    expect(cookieStore.has(SESSION_COOKIE)).toBe(false)
  })

  it('reports a lockout after five failures', async () => {
    await makeAdmin('admin@example.com', 'ADMIN')
    for (let i = 0; i < 5; i++) await loginAction({}, form('admin@example.com', 'wrong'))

    const result = await loginAction({}, form('admin@example.com', PASSWORD))
    expect(result.error).toMatch(/zablokowane/)
  })

  it('rate-limits by IP before the account is even looked up', async () => {
    // No account exists at all — the limiter must still trip, which is the
    // point: an attacker spraying addresses is throttled regardless.
    let last: { error?: string } = {}
    for (let i = 0; i < 11; i++) last = await loginAction({}, form('nobody@example.com', 'x'))

    expect(last.error).toMatch(/Zbyt wiele prób/)
  })
})
