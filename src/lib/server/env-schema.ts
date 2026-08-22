import { z } from 'zod'

// Deliberately free of side effects so it can be unit tested without a
// real environment. env.ts is what actually reads process.env.
export const envSchema = z.object({
  // z.url() rather than z.string().url(): the latter is deprecated in Zod 4.
  DATABASE_URL: z.url(),
  DIRECT_URL: z.url(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  NEXT_PUBLIC_SITE_URL: z.url(),
})

export type Env = z.infer<typeof envSchema>
