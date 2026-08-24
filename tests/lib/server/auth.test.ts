import { describe, expect, it, vi } from 'vitest'

const cookieStore = new Map<string, string>()

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieStore.has(name) ? { value: cookieStore.get(name) } : undefined),
    set: (name: string, value: string) => void cookieStore.set(name, value),
    delete: (name: string) => void cookieStore.delete(name),
  }),
}))

const redirected: string[] = []
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    redirected.push(to)
    throw new Error(`REDIRECT:${to}`)
  },
}))

import { db } from '@/lib/server/db'
import { getCurrentAdmin, requireAdmin, requireStaff, startSession } from '@/lib/server/auth'

async function makeAdmin(role: 'ADMIN' | 'SCANNER') {
  return db.adminUser.create({
    data: {
      email: `u${Math.random().toString(36).slice(2)}@example.com`,
      name: 'T',
      role,
      passwordHash: 'x',
    },
  })
}

describe('auth guards', () => {
  it('returns null when there is no cookie', async () => {
    cookieStore.clear()
    expect(await getCurrentAdmin()).toBeNull()
  })

  it('redirects an anonymous visitor to the login page', async () => {
    cookieStore.clear()
    await expect(requireStaff()).rejects.toThrow('REDIRECT:/admin/login')
  })

  it('admits a SCANNER to requireStaff', async () => {
    cookieStore.clear()
    const user = await makeAdmin('SCANNER')
    await startSession(user.id)
    expect((await requireStaff()).id).toBe(user.id)
  })

  it('refuses a SCANNER from requireAdmin', async () => {
    cookieStore.clear()
    const user = await makeAdmin('SCANNER')
    await startSession(user.id)
    await expect(requireAdmin()).rejects.toThrow('REDIRECT:/admin/scan')
  })

  it('admits an ADMIN to requireAdmin', async () => {
    cookieStore.clear()
    const user = await makeAdmin('ADMIN')
    await startSession(user.id)
    expect((await requireAdmin()).id).toBe(user.id)
  })
})
