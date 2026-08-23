import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import { hashPassword } from '@/lib/server/password'
import { authenticate, MAX_FAILED_ATTEMPTS } from '@/lib/server/login'

const PASSWORD = 'CorrectHorseBattery1!'

async function makeAdmin(email = 'admin@example.com', active = true) {
  return db.adminUser.create({
    data: {
      email,
      name: 'Test',
      role: 'ADMIN',
      active,
      passwordHash: await hashPassword(PASSWORD),
    },
  })
}

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "AdminSession", "AdminUser" RESTART IDENTITY CASCADE')
})

describe('authenticate', () => {
  it('accepts correct credentials', async () => {
    const admin = await makeAdmin()
    const result = await authenticate('admin@example.com', PASSWORD)
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.user.id).toBe(admin.id)
  })

  it('is case-insensitive about the email', async () => {
    await makeAdmin('admin@example.com')
    const result = await authenticate('ADMIN@Example.com', PASSWORD)
    expect(result.ok).toBe(true)
  })

  it('rejects a wrong password', async () => {
    await makeAdmin()
    expect(await authenticate('admin@example.com', 'wrong')).toEqual({ ok: false, reason: 'INVALID' })
  })

  it('rejects an unknown email with the same reason as a wrong password', async () => {
    expect(await authenticate('nobody@example.com', PASSWORD)).toEqual({ ok: false, reason: 'INVALID' })
  })

  it('rejects a deactivated account', async () => {
    await makeAdmin('gone@example.com', false)
    expect(await authenticate('gone@example.com', PASSWORD)).toEqual({ ok: false, reason: 'INACTIVE' })
  })

  it('locks the account after too many failures', async () => {
    await makeAdmin()
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await authenticate('admin@example.com', 'wrong')
    }
    expect(await authenticate('admin@example.com', PASSWORD)).toEqual({ ok: false, reason: 'LOCKED' })
  })

  it('resets the failure count after a successful login', async () => {
    await makeAdmin()
    await authenticate('admin@example.com', 'wrong')
    await authenticate('admin@example.com', PASSWORD)

    const admin = await db.adminUser.findUniqueOrThrow({ where: { email: 'admin@example.com' } })
    expect(admin.failedLoginCount).toBe(0)
    expect(admin.lockedUntil).toBeNull()
    expect(admin.lastLoginAt).not.toBeNull()
  })

  it('gives a full set of attempts again after the lockout lapses', async () => {
    await makeAdmin()
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await authenticate('admin@example.com', 'wrong')
    }
    await db.adminUser.update({
      where: { email: 'admin@example.com' },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    })

    // One more wrong password must NOT re-lock immediately.
    expect(await authenticate('admin@example.com', 'wrong')).toEqual({ ok: false, reason: 'INVALID' })
    expect((await authenticate('admin@example.com', PASSWORD)).ok).toBe(true)
  })

  it('unlocks once the lockout window has passed', async () => {
    await makeAdmin()
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await authenticate('admin@example.com', 'wrong')
    }
    await db.adminUser.update({
      where: { email: 'admin@example.com' },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    })
    expect((await authenticate('admin@example.com', PASSWORD)).ok).toBe(true)
  })
})
