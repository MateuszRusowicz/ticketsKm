import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import { hashPassword, verifyPassword } from '@/lib/server/password'

/** Runs the script the way an operator would, returning its stdout. */
function reset(...args: string[]): string {
  return execFileSync('pnpm', ['exec', 'tsx', 'scripts/reset-admin-password.ts', ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env },
  })
}

/** The script prints `Password: <value>` exactly once. */
function passwordFrom(stdout: string): string {
  const line = stdout.split('\n').find((l) => l.startsWith('Password: '))
  if (!line) throw new Error(`no password in output:\n${stdout}`)
  return line.slice('Password: '.length)
}

const EMAIL = 'reset-target@example.test'

// Every test in this file spawns `pnpm exec tsx`, which costs a couple of
// seconds before the script even starts. Vitest's default testTimeout is 5s,
// and only hookTimeout was raised — so these were one slow run away from
// failing regardless of the code under test.
const SPAWN_TIMEOUT = 30_000

beforeEach(async () => {
  // Same reasoning as tests/prisma/seed.test.ts: one database, sequential
  // files, residue from earlier files breaks exact-count assertions.
  await db.adminSession.deleteMany({})
  await db.adminUser.deleteMany({ where: { email: EMAIL } })
  await db.adminUser.create({
    data: {
      email: EMAIL,
      name: 'Reset Target',
      role: 'ADMIN',
      passwordHash: await hashPassword('OriginalPassword123!'),
    },
  })
})

describe('reset-admin-password', () => {
  it('sets a password that actually authenticates', async () => {
    const password = passwordFrom(reset(EMAIL))

    const user = await db.adminUser.findUniqueOrThrow({ where: { email: EMAIL } })
    expect(await verifyPassword(user.passwordHash, password)).toBe(true)
  }, SPAWN_TIMEOUT)

  it('invalidates the previous password', async () => {
    reset(EMAIL)

    const user = await db.adminUser.findUniqueOrThrow({ where: { email: EMAIL } })
    expect(await verifyPassword(user.passwordHash, 'OriginalPassword123!')).toBe(false)
  }, SPAWN_TIMEOUT)

  it('generates a different password each run', () => {
    expect(passwordFrom(reset(EMAIL))).not.toBe(passwordFrom(reset(EMAIL)))
  }, SPAWN_TIMEOUT)

  it('clears a lockout, not just the failure counter', async () => {
    // Both fields matter. Clearing failedLoginCount alone leaves lockedUntil
    // in the future, so the account stays locked out with a password that
    // the operator has just been told is valid — the exact situation a reset
    // is meant to resolve.
    await db.adminUser.update({
      where: { email: EMAIL },
      data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() + 60 * 60_000) },
    })

    reset(EMAIL)

    const user = await db.adminUser.findUniqueOrThrow({ where: { email: EMAIL } })
    expect(user.failedLoginCount).toBe(0)
    expect(user.lockedUntil).toBeNull()
  }, SPAWN_TIMEOUT)

  it('revokes existing sessions', async () => {
    // A reset is what you do when a credential may be compromised. Leaving
    // live sessions alone would let whoever holds a stolen cookie keep the
    // access the reset was supposed to take away.
    const user = await db.adminUser.findUniqueOrThrow({ where: { email: EMAIL } })
    await db.adminSession.create({
      data: {
        adminUserId: user.id,
        tokenHash: 'test-token-hash-for-revocation',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    })

    reset(EMAIL)

    expect(await db.adminSession.count({ where: { adminUserId: user.id } })).toBe(0)
  }, SPAWN_TIMEOUT)

  it('matches on address case, as the login path does', async () => {
    // AdminUser.email is a case-sensitive unique index and create-admin.ts
    // lowercases on write. A reset typed in the wrong case must find the
    // same row, or it reports "no account" for an address that plainly exists.
    const password = passwordFrom(reset(EMAIL.toUpperCase()))

    const user = await db.adminUser.findUniqueOrThrow({ where: { email: EMAIL } })
    expect(await verifyPassword(user.passwordHash, password)).toBe(true)
  }, SPAWN_TIMEOUT)

  it('fails cleanly for an unknown address', () => {
    // One spawn, not two: each costs ~2.5s and two of them sat right on
    // Vitest's 5s default, which made this test fail only under load.
    // expect.assertions guards the other half — without it, a run that did
    // NOT throw would skip the catch block and pass silently.
    expect.assertions(2)
    try {
      reset('nobody@example.test')
    } catch (e) {
      const err = e as { stderr: string; status: number }
      expect(err.stderr).toContain('No admin account')
      expect(err.status).toBe(1)
    }
  }, SPAWN_TIMEOUT)

  it('requires an email argument', () => {
    expect.assertions(2)
    try {
      reset()
      throw new Error('expected a non-zero exit')
    } catch (e) {
      const err = e as { stderr: string; status: number }
      expect(err.stderr).toContain('Usage:')
      expect(err.status).toBe(1)
    }
  }, SPAWN_TIMEOUT)
})
