import { beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { db } from '@/lib/server/db'
import {
  createSession,
  deleteExpiredSessions,
  deleteSession,
  findSessionUser,
} from '@/lib/server/sessions'

async function makeAdmin(overrides: { active?: boolean } = {}) {
  return db.adminUser.create({
    data: {
      email: `a${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Test',
      role: 'ADMIN',
      passwordHash: 'x',
      active: overrides.active ?? true,
    },
  })
}

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "AdminSession", "AdminUser" RESTART IDENTITY CASCADE')
})

describe('createSession', () => {
  it('returns a token and stores only its hash', async () => {
    const admin = await makeAdmin()
    const { token } = await createSession(admin.id)

    expect(token.length).toBeGreaterThanOrEqual(32)

    const rows = await db.adminSession.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0].tokenHash).not.toBe(token)
    expect(rows[0].tokenHash).toBe(createHash('sha256').update(token).digest('hex'))
  })

  it('returns a different token every time', async () => {
    const admin = await makeAdmin()
    const a = await createSession(admin.id)
    const b = await createSession(admin.id)
    expect(a.token).not.toBe(b.token)
  })
})

describe('findSessionUser', () => {
  it('returns the admin for a valid token', async () => {
    const admin = await makeAdmin()
    const { token } = await createSession(admin.id)
    const found = await findSessionUser(token)
    expect(found?.id).toBe(admin.id)
  })

  it('returns null for an unknown token', async () => {
    expect(await findSessionUser('nonsense')).toBeNull()
  })

  it('returns null for an expired session', async () => {
    const admin = await makeAdmin()
    const { token } = await createSession(admin.id)
    await db.adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await findSessionUser(token)).toBeNull()
  })

  it('returns null when the admin has been deactivated', async () => {
    const admin = await makeAdmin()
    const { token } = await createSession(admin.id)
    await db.adminUser.update({ where: { id: admin.id }, data: { active: false } })
    expect(await findSessionUser(token)).toBeNull()
  })
})

describe('deleteSession', () => {
  it('invalidates the token immediately', async () => {
    const admin = await makeAdmin()
    const { token } = await createSession(admin.id)
    await deleteSession(token)
    expect(await findSessionUser(token)).toBeNull()
  })

  it('does not throw for an unknown token', async () => {
    await expect(deleteSession('nonsense')).resolves.toBeUndefined()
  })
})

describe('rolling expiry', () => {
  it('extends a session that is close to lapsing', async () => {
    const admin = await makeAdmin()
    const { token } = await createSession(admin.id)
    const soon = new Date(Date.now() + 30 * 60 * 1000) // 30 minutes left
    await db.adminSession.updateMany({ data: { expiresAt: soon } })

    await findSessionUser(token)

    const [row] = await db.adminSession.findMany()
    expect(row.expiresAt.getTime()).toBeGreaterThan(soon.getTime() + 60 * 60 * 1000)
  })

  it('leaves a fresh session alone', async () => {
    const admin = await makeAdmin()
    const { token } = await createSession(admin.id)
    const before = (await db.adminSession.findMany())[0].expiresAt

    await findSessionUser(token)

    const after = (await db.adminSession.findMany())[0].expiresAt
    expect(after.getTime()).toBe(before.getTime())
  })

  it('gives a SCANNER a shorter session than an ADMIN', async () => {
    const scanner = await db.adminUser.create({
      data: { email: `s${Math.random().toString(36).slice(2)}@example.com`, name: 'S', role: 'SCANNER', passwordHash: 'x' },
    })
    const admin = await makeAdmin()

    const s = await createSession(scanner.id)
    const a = await createSession(admin.id)

    expect(s.expiresAt.getTime()).toBeLessThan(a.expiresAt.getTime())
  })
})

describe('deleteExpiredSessions', () => {
  it('removes only expired rows', async () => {
    const admin = await makeAdmin()
    await createSession(admin.id)
    const stale = await createSession(admin.id)
    await db.adminSession.updateMany({
      where: { tokenHash: createHash('sha256').update(stale.token).digest('hex') },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    expect(await deleteExpiredSessions()).toBe(1)
    expect(await db.adminSession.count()).toBe(1)
  })
})
