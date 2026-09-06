import { z } from 'zod'

// Deliberately free of side effects so it can be unit tested without a
// real environment. env.ts is what actually reads process.env.
export const envSchema = z
  .object({
    // z.url() rather than z.string().url(): the latter is deprecated in Zod 4.
    DATABASE_URL: z.url(),
    DIRECT_URL: z.url(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    NEXT_PUBLIC_SITE_URL: z.url(),

    STRIPE_PUBLISHABLE_KEY: z.string().startsWith('pk_'),
    STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .startsWith('whsec_')
      .min(20)
      .refine((v) => v !== 'whsec_placeholder_replace_after_stripe_listen', {
        message: 'STRIPE_WEBHOOK_SECRET is the Task 1 placeholder — run `stripe listen` first',
      }),

    CRON_SECRET: z.string().min(32),

    ASYNC_PAYMENT_TIMEOUT_MS: z
      .string()
      .default(String(6 * 60 * 60 * 1000))
      .transform((v) => Number.parseInt(v, 10))
      .refine((n) => Number.isFinite(n) && n >= 30 * 60 * 1000),

    PAY_CLICK_HOLD_EXTENSION_MS: z
      .string()
      .default(String(15 * 60 * 1000))
      .transform((v) => Number.parseInt(v, 10))
      .refine((n) => Number.isFinite(n) && n >= 60_000),

    SEPA_HOLD_CAP_SHARE: z
      .string()
      .default('0.10')
      .transform((v) => Number.parseFloat(v))
      .refine((n) => Number.isFinite(n) && n >= 0 && n <= 1),

    SELLOUT_HIDE_THRESHOLD: z
      .string()
      .default('0.20')
      .transform((v) => Number.parseFloat(v))
      .refine((n) => Number.isFinite(n) && n >= 0 && n <= 1),

    SEPA_HARD_TIMEOUT_DAYS: z
      .string()
      .default('5')
      .transform((v) => Number.parseInt(v, 10))
      .refine((n) => Number.isFinite(n) && n >= 1),

    WEBHOOK_MAX_ATTEMPTS: z
      .string()
      .default('8')
      .transform((v) => Number.parseInt(v, 10))
      .refine((n) => Number.isFinite(n) && n >= 1 && n <= 100),
  })
  .superRefine((v, ctx) => {
    if (
      v.NODE_ENV === 'development' &&
      (v.STRIPE_PUBLISHABLE_KEY.startsWith('pk_live_') || v.STRIPE_SECRET_KEY.startsWith('sk_live_'))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_SECRET_KEY'],
        message: 'live Stripe keys in NODE_ENV=development',
      })
    }
  })

export type Env = z.infer<typeof envSchema>
