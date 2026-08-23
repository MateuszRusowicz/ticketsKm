import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '@/lib/server/password'

describe('password hashing', () => {
  it('produces a hash that is not the plaintext', async () => {
    const hash = await hashPassword('CorrectHorseBattery1!')
    expect(hash).not.toContain('CorrectHorseBattery1!')
    expect(hash.startsWith('$argon2')).toBe(true)
  })

  it('verifies a correct password', async () => {
    const hash = await hashPassword('CorrectHorseBattery1!')
    await expect(verifyPassword(hash, 'CorrectHorseBattery1!')).resolves.toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('CorrectHorseBattery1!')
    await expect(verifyPassword(hash, 'wrong')).resolves.toBe(false)
  })

  it('produces a different hash for the same password each time', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
  })

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false)
  })
})
