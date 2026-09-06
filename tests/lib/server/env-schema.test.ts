import { describe, expect, it } from 'vitest'
import { envSchema } from '@/lib/server/env-schema'

const valid = {
  DATABASE_URL: 'postgresql://km:km@localhost:5432/km_dev',
  DIRECT_URL: 'postgresql://km:km@localhost:5432/km_dev',
  NODE_ENV: 'development',
  SESSION_SECRET: 'a'.repeat(32),
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_dummy_for_tests_only',
  STRIPE_SECRET_KEY: 'sk_test_dummy_for_tests_only',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy_for_tests_only_32chars_min',
  CRON_SECRET: 'cron_secret_dummy_for_tests_only_32chars',
}

describe('envSchema', () => {
  it('accepts a complete environment', () => {
    expect(envSchema.parse(valid)).toMatchObject({
      DATABASE_URL: valid.DATABASE_URL,
      NODE_ENV: valid.NODE_ENV,
      SESSION_SECRET: valid.SESSION_SECRET,
      NEXT_PUBLIC_SITE_URL: valid.NEXT_PUBLIC_SITE_URL,
    })
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

  // --- new Stripe + config cases ---

  it('accepts valid test-mode Stripe keys', () => {
    const result = envSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('rejects a missing STRIPE_PUBLISHABLE_KEY', () => {
    const { STRIPE_PUBLISHABLE_KEY: _omitted, ...rest } = valid
    const result = envSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejects a missing STRIPE_SECRET_KEY', () => {
    const { STRIPE_SECRET_KEY: _omitted, ...rest } = valid
    const result = envSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejects the whsec_placeholder literal', () => {
    const result = envSchema.safeParse({
      ...valid,
      STRIPE_WEBHOOK_SECRET: 'whsec_placeholder_replace_after_stripe_listen',
    })
    expect(result.success).toBe(false)
  })

  it('rejects live keys when NODE_ENV is development', () => {
    const result = envSchema.safeParse({
      ...valid,
      NODE_ENV: 'development',
      STRIPE_PUBLISHABLE_KEY: 'pk_live_something',
      STRIPE_SECRET_KEY: 'sk_live_something',
    })
    expect(result.success).toBe(false)
  })

  it('uses defaults for the six numeric config vars', () => {
    const result = envSchema.safeParse(valid)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.ASYNC_PAYMENT_TIMEOUT_MS).toBe(6 * 60 * 60 * 1000)
    expect(result.data.PAY_CLICK_HOLD_EXTENSION_MS).toBe(15 * 60 * 1000)
    expect(result.data.SEPA_HOLD_CAP_SHARE).toBe(0.10)
    expect(result.data.SELLOUT_HIDE_THRESHOLD).toBe(0.20)
    expect(result.data.SEPA_HARD_TIMEOUT_DAYS).toBe(5)
    expect(result.data.WEBHOOK_MAX_ATTEMPTS).toBe(8)
  })

  it('rejects SEPA_HOLD_CAP_SHARE outside [0, 1]', () => {
    const result = envSchema.safeParse({ ...valid, SEPA_HOLD_CAP_SHARE: '1.5' })
    expect(result.success).toBe(false)
  })

  it('rejects CRON_SECRET shorter than 32 characters', () => {
    const result = envSchema.safeParse({ ...valid, CRON_SECRET: 'tooshort' })
    expect(result.success).toBe(false)
  })
})
