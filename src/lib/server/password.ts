import 'server-only'
import { hash, verify } from '@node-rs/argon2'
import { ARGON2_OPTIONS } from '@/lib/shared/password-options'

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS)
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, ARGON2_OPTIONS)
  } catch {
    // A malformed or truncated hash must fail closed, not throw. Otherwise a
    // corrupt row turns a failed login into a 500.
    return false
  }
}
