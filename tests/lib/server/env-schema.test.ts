import { describe, expect, it } from 'vitest'
import { envSchema } from '@/lib/server/env-schema'

const valid = {
  DATABASE_URL: 'postgresql://km:km@localhost:5432/km_dev',
  DIRECT_URL: 'postgresql://km:km@localhost:5432/km_dev',
  NODE_ENV: 'development',
  SESSION_SECRET: 'a'.repeat(32),
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
}

describe('envSchema', () => {
  it('accepts a complete environment', () => {
    expect(envSchema.parse(valid)).toMatchObject(valid)
  })

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _omitted, ...rest } = valid
    expect(() => envSchema.parse(rest)).toThrow()
  })

  it('rejects a SESSION_SECRET shorter than 32 characters', () => {
    expect(() => envSchema.parse({ ...valid, SESSION_SECRET: 'short' })).toThrow()
  })

  it('rejects a non-URL site URL', () => {
    expect(() => envSchema.parse({ ...valid, NEXT_PUBLIC_SITE_URL: 'not-a-url' })).toThrow()
  })

  it('defaults NODE_ENV to development', () => {
    const { NODE_ENV: _omitted, ...rest } = valid
    expect(envSchema.parse(rest).NODE_ENV).toBe('development')
  })
})
