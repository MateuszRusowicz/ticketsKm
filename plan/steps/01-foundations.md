# Plan 01 — Foundations, Domain & Admin Skeleton

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed Next.js application where a festival administrator logs in and creates a concert with Polish, English and German content, prices in PLN and EUR, and a capacity — with every piece of it covered by tests that run in CI.

**Architecture:** One Next.js App Router application. All server-only code lives under `src/lib/server/` and begins with `import 'server-only'`, making the client/server boundary a build error rather than a convention. PostgreSQL through Prisma, run locally in Docker and on Neon in production. Admin sessions are database-backed opaque tokens in an httpOnly cookie — revocable, and simpler to test than a JWT scheme.

**Tech Stack:** Next.js (App Router) · TypeScript · pnpm · Prisma · PostgreSQL · next-intl · Tailwind CSS · Vitest · `@node-rs/argon2` · Zod

**Spec:** [`plan/README.md`](../README.md) and the documents it indexes. This plan implements phases 0 and 1 of [`plan/08-implementation-phases.md`](../08-implementation-phases.md).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Money is always an integer in minor units** (grosze, eurocents). No floating-point money anywhere, at any layer.
- **Every file under `src/lib/server/` begins with `import 'server-only'`** as its first line. Consequently **CLI scripts cannot import from `src/lib/server/`** — they run under `tsx`, outside Next's module graph, where that import throws. Anything a script and the app must share goes in `src/lib/shared/`.
- **Nothing under `src/lib/server/` may be imported from a `"use client"` file.** Shared types and Zod schemas go in `src/lib/shared/`.
- **Only `NEXT_PUBLIC_*` environment variables reach the browser.**
- **Package manager is `pnpm`.** Never `npm install` or `yarn`.
- **Prisma 7.** The client is generated as TypeScript into `src/generated/prisma` and imported from **`@/generated/prisma/client`** — *not* from `@prisma/client`. Prisma 7 also **requires a driver adapter**; `PrismaPg` is configured once in `src/lib/server/db.ts` and nowhere else.
- **Admin UI is Polish only** and deliberately untranslated. Only the public shop is localised.
- **Locales are exactly `pl`, `en`, `de`**, with `pl` as default.
- **Currencies are exactly `PLN` and `EUR`.**
- **Design tokens come from [`plan/10-design-system.md`](../10-design-system.md).** Form field borders use `--color-border-input` (`#757575`), never `--color-border` — see §2 of that document for why.
- **Timezone for all concert times is `Europe/Warsaw`**, always rendered explicitly.
- **Commits are made by the human operator.** An agent executing this plan stops at each commit step, reports what it changed, and waits. It does not run `git commit` itself.
- **Every task ends green.** `pnpm typecheck && pnpm lint && pnpm test` must pass before a commit step is reached.

---

## Prerequisites

Verify before Task 1. Each command should print a version, not an error.

```bash
node --version      # v20 or newer
pnpm --version      # v9 or newer
docker --version
docker compose version
```

If `pnpm` is missing: `corepack enable && corepack prepare pnpm@latest --activate`

---

## File Structure

Files created by this plan, and what each is responsible for.

**Configuration**
- `package.json`, `tsconfig.json`, `next.config.ts` — project setup
- `eslint.config.mjs` — lint rules, including the server/client import guard
- `vitest.config.mts`, `vitest.setup.ts` — test runner, Node environment
- `docker-compose.yml` — local Postgres with `km_dev` and `km_test` databases
- `.env.example`, `.env`, `.env.test` — environment
- `.github/workflows/ci.yml` — typecheck, lint, test on every push

**Database**
- `prisma.config.ts` — datasource URL for the CLI (Prisma 7 moved it out of the schema)
- `src/generated/prisma/**` — the generated client. **Git-ignored build output**, recreated by the `postinstall` hook; never edited, never committed
- `prisma/schema.prisma` — the full schema from [`02-data-model.md`](../02-data-model.md)
- `prisma/seed.ts` — two venues, three concerts, two admin accounts
- `src/lib/server/db.ts` — the Prisma client singleton

**Shared (safe on both sides)**
- `src/lib/shared/money.ts` — minor-unit arithmetic and formatting
- `src/lib/shared/locale.ts` — locale constants and BCP-47 mapping
- `src/lib/shared/schemas.ts` — Zod schemas for forms

**Server-only**
- `src/lib/server/env-schema.ts` — the environment Zod schema, side-effect free so it can be unit tested
- `src/lib/server/env.ts` — parses `process.env` once at boot
- `src/lib/server/password.ts` — argon2id hashing and verification
- `src/lib/server/sessions.ts` — session token creation and lookup, pure database functions
- `src/lib/server/auth.ts` — cookie handling and `requireAdmin` / `requireStaff`
- `src/lib/server/audit.ts` — audit log writer
- `src/lib/server/events.ts` — event creation and update, including the capacity guard

**Application**
- `src/app/globals.css` — design tokens
- `src/app/fonts.ts` — self-hosted Merriweather
- `src/app/[locale]/layout.tsx`, `page.tsx` — public shell
- `src/app/admin/layout.tsx`, `login/page.tsx`, `events/**` — admin
- `src/messages/{pl,en,de}.json` — UI strings
- `src/i18n/routing.ts`, `src/i18n/request.ts` — next-intl wiring

**Tests** mirror the source path under `tests/`.

---

## Task 1: Project scaffold, tooling and CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.mts`, `.gitignore`, `.github/workflows/ci.yml`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` scripts that every later task uses.

- [ ] **Step 1: Delete the empty placeholder directories and initialise git**

```bash
cd /home/mateusz/Documents/Kodowanie/KM
rmdir KMFront KMBack
git init
```

`rmdir` fails if either directory is non-empty — that is intentional. If it fails, inspect the contents before removing anything.

- [ ] **Step 2: Scaffold the application at the repository root**

`create-next-app` derives the npm package name from the directory, and npm
forbids capital letters — so running it in a directory called `KM` fails
outright with *"name can no longer contain capital letters"*. Scaffold under a
valid name and move the result in:

```bash
SCRATCH=$(mktemp -d)
cd "$SCRATCH"
pnpm create next-app@latest km --ts --app --src-dir --tailwind --eslint --import-alias "@/*" --yes
cd km && rm -rf .git .next node_modules
for f in $(ls -A); do mv "$f" /path/to/KM/; done
cd /path/to/KM && pnpm install
```

`node_modules` is deliberately not moved: pnpm symlinks into a
content-addressed store and those links do not survive a cross-filesystem
move. `--yes` keeps it non-interactive. The `plan/` directory is untouched.

- [ ] **Step 3: Verify the scaffold runs**

Run: `pnpm dev`
Then in another terminal: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000`
Expected: `200`
Stop the dev server afterwards.

- [ ] **Step 4: Install the test runner**

```bash
pnpm add -D vitest @vitest/coverage-v8 tsx dotenv-cli
```

- [ ] **Step 5: Create the Vitest configuration**

`vitest.config.mts` — note the **`.mts`** extension. The config uses
`import.meta.url`, and in a plain `.ts` file Vite loads it as CommonJS and
warns that this breaks under the native config loader.

```ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    hookTimeout: 30_000,

    // Test files share one Postgres database and TRUNCATE overlapping
    // tables. Vitest runs FILES in parallel by default, which would let
    // one file wipe AdminUser while another is mid-assertion. This is not
    // a risk to watch for — it is a certainty from the moment there are
    // two such files, so it is settled here rather than after the first
    // flake. (`poolOptions.threads.singleThread` does NOT do this: it
    // controls threading inside a worker, not the number of workers.)
    // Vitest 4 REMOVED `poolOptions` — these are top-level options now.
    // `minWorkers` does not exist in Vitest 4 either; tsc rejects it.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      // fileURLToPath rather than __dirname: this config is an ES module.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
```

`vitest.setup.ts`:

```ts
// Placeholder for now; Task 5 adds database lifecycle handling here.
export {}
```

**`server-only` must be stubbed for tests.** That package throws on import
unless resolved under React's `react-server` condition, which Vitest does not
use — so *every* server module fails to import, not merely under jsdom. Create
`tests/stubs/server-only.ts` containing `export {}` and alias it in
`resolve.alias`:

```ts
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
```

The guarantee still holds where it matters: the Next.js build resolves the real
package and fails if a server module ever reaches a client bundle.

- [ ] **Step 6: Add the scripts to `package.json`**

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "typecheck": "next typegen && tsc --noEmit",
    "test": "dotenv -e .env.test -- vitest run",
    "test:watch": "dotenv -e .env.test -- vitest"
  }
}
```

**Why `next typegen` precedes `tsc`.** Next 16 generates global route types —
`LayoutProps<"/">`, `PageProps<...>` — into `.next/dev/types/`, and the
scaffold's `src/app/layout.tsx` uses them. Both `.next/` and `next-env.d.ts`
are git-ignored, so a fresh clone has neither and `tsc` fails with
`Cannot find name 'LayoutProps'`. It passes on a developer's machine only
because `next dev` happened to run first — which makes this a bug that appears
exclusively in CI, the worst kind. `next typegen` generates the types without a
full build, in about a second.

To confirm it is genuinely fixed, reproduce CI's conditions:

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo && pnpm typecheck
```

- [ ] **Step 7: Write the smoke test**

`tests/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

describe('test runner', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 8: Create `.env.test` so the test script has a file to load**

`.env.test`:

```
NODE_ENV=test
DATABASE_URL=postgresql://km:km@localhost:5432/km_test
DIRECT_URL=postgresql://km:km@localhost:5432/km_test
SESSION_SECRET=test_secret_at_least_32_characters_long_ok
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

- [ ] **Step 9: Run the test suite**

Run: `pnpm test`
Expected: `1 passed`

- [ ] **Step 10: Add the server/client import guard to ESLint**

Append to `eslint.config.mjs`, inside the exported config array:

```js
{
  // Scoped to shared components rather than to app/ pages: Server
  // Components legitimately import server modules, and flagging them
  // would train everyone to disable the rule. `import 'server-only'` is
  // the real enforcement — this rule just shortens the feedback loop for
  // the case that actually goes wrong, a client component reaching into
  // lib/server.
  files: ['src/components/**/*.tsx'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['@/lib/server/*', '**/lib/server/*'],
        message:
          'Server-only modules must not be imported from components. ' +
          'Move shared types to src/lib/shared/, or import this in a Server Component only.',
      }],
    }],
  },
},
```

- [ ] **Step 10a: Allow deliberately-unused variables**

A leading underscore is the convention for something intentionally unused, and
this codebase hits it constantly: every server action has the signature
`(_prev, formData)`, and tests destructure a key out in order to omit it.
Without this the project accumulates warnings for code that is correct. Add to
`eslint.config.mjs`:

```js
{
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', {
      varsIgnorePattern: '^_',
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
      ignoreRestSiblings: true,
    }],
  },
},
```

Note that `eslint` exits 0 on warnings, so warnings never fail the gate. To
make them fail, add `--max-warnings 0` to the lint script.

- [ ] **Step 11: Verify lint and typecheck pass**

Run: `pnpm lint && pnpm typecheck`
Expected: both exit 0 with no errors.

- [ ] **Step 12: Create the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: km
          POSTGRES_PASSWORD: km
          POSTGRES_DB: km_test
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          # Match the local toolchain. A skew between CI and a developer's
          # machine is exactly the "passes on my laptop" problem the suite
          # exists to prevent.
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```

- [ ] **Step 13: Enable automated dependency updates**

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      all-minor-patch:
        update-types: ['minor', 'patch']
```

Next.js has shipped serious vulnerabilities — a middleware authorisation
bypass (CVE-2025-29927) among them. Grouping minor and patch updates into one
weekly pull request keeps the noise low enough that security releases are
actually noticed rather than closed unread.

- [ ] **Step 14: Verify the whole gate passes locally**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all three pass.

- [ ] **Step 15: Commit** *(human operator)*

```bash
git add -A
git commit -m "chore: scaffold Next.js app with TypeScript, Tailwind, Vitest and CI"
```

---

## Task 2: Environment validation

The application must refuse to start with a missing or malformed environment variable, rather than failing at the first database query.

**Files:**
- Create: `src/lib/server/env-schema.ts`, `src/lib/server/env.ts`, `.env.example`
- Test: `tests/lib/server/env-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `envSchema` (a Zod object schema) and `env: Env`, where
  `type Env = { DATABASE_URL: string; DIRECT_URL: string; NODE_ENV: 'development' | 'test' | 'production'; SESSION_SECRET: string; NEXT_PUBLIC_SITE_URL: string }`.

- [ ] **Step 1: Install Zod**

```bash
pnpm add zod server-only
```

`server-only` must be a runtime dependency, not a dev dependency — it is imported by modules that the build resolves.

- [ ] **Step 2: Write the failing test**

`tests/lib/server/env-schema.test.ts`:

```ts
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
    const { DATABASE_URL, ...rest } = valid
    expect(() => envSchema.parse(rest)).toThrow()
  })

  it('rejects a SESSION_SECRET shorter than 32 characters', () => {
    expect(() => envSchema.parse({ ...valid, SESSION_SECRET: 'short' })).toThrow()
  })

  it('rejects a non-URL site URL', () => {
    expect(() => envSchema.parse({ ...valid, NEXT_PUBLIC_SITE_URL: 'not-a-url' })).toThrow()
  })

  it('defaults NODE_ENV to development', () => {
    const { NODE_ENV, ...rest } = valid
    expect(envSchema.parse(rest).NODE_ENV).toBe('development')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test tests/lib/server/env-schema.test.ts`
Expected: FAIL — cannot resolve `@/lib/server/env-schema`.

- [ ] **Step 4: Write the schema**

`src/lib/server/env-schema.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test tests/lib/server/env-schema.test.ts`
Expected: `5 passed`

- [ ] **Step 6: Write the boot-time parser**

`src/lib/server/env.ts`:

```ts
import 'server-only'
import { envSchema } from './env-schema'

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n')
  throw new Error(`Invalid environment configuration:\n${issues}`)
}

export const env = parsed.data
```

- [ ] **Step 7: Create `.env.example` and `.env`**

`.env.example` — committed, no real values:

```
DATABASE_URL=postgresql://km:km@localhost:5432/km_dev
DIRECT_URL=postgresql://km:km@localhost:5432/km_dev
SESSION_SECRET=generate_with_openssl_rand_base64_32
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

Then create the real local file:

```bash
cp .env.example .env
sed -i "s|generate_with_openssl_rand_base64_32|$(openssl rand -base64 32)|" .env
```

- [ ] **Step 8: Confirm the right env files are ignored — and the right ones are not**

Next's default `.gitignore` contains a blanket `.env*`, which also swallows
`.env.example` and `.env.test`. Both must be committed: one documents the
required variables, the other is what CI loads to run the suite. Add
negations:

```
.env*
!.env.example
!.env.test
```

Then verify all three:

```bash
git check-ignore -v .env          # must print a .gitignore line
git check-ignore -q .env.example  # must exit non-zero (i.e. NOT ignored)
git check-ignore -q .env.test     # must exit non-zero
```

`.env` being ignored is the difference between a secret and a published
secret. `.env.example` being ignored is the difference between a working CI
run and a baffling one.

- [ ] **Step 9: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add validated environment configuration"
```

---

## Task 3: Money utilities

Every price in the system passes through this module. It is pure logic with no dependencies, which makes it the right place to establish the testing rhythm.

**Files:**
- Create: `src/lib/shared/money.ts`, `src/lib/shared/locale.ts`
- Test: `tests/lib/shared/money.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Currency = 'PLN' | 'EUR'`
  - `type Locale = 'pl' | 'en' | 'de'`
  - `formatMoney(minor: number, currency: Currency, locale: Locale): string`
  - `toMinor(major: number): number`
  - `toMajor(minor: number): number`
  - `applyPercentDiscount(subtotalMinor: number, percent: number): number` — returns the discount amount
  - `LOCALES: readonly Locale[]`, `DEFAULT_LOCALE: Locale`, `BCP47: Record<Locale, string>`

- [ ] **Step 1: Write the failing test**

`tests/lib/shared/money.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { applyPercentDiscount, formatMoney, toMajor, toMinor } from '@/lib/shared/money'

// Intl inserts a non-breaking space before the currency symbol in pl-PL and
// de-DE. Normalising it keeps the assertions readable.
const norm = (s: string) => s.replace(/ /g, ' ')

describe('toMinor / toMajor', () => {
  it('converts major units to minor units', () => {
    expect(toMinor(49)).toBe(4900)
    expect(toMinor(12.5)).toBe(1250)
  })

  it('rounds rather than truncating', () => {
    expect(toMinor(0.005)).toBe(1)
  })

  it('converts back', () => {
    expect(toMajor(4900)).toBe(49)
  })
})

describe('formatMoney', () => {
  it('formats PLN for a Polish reader', () => {
    expect(norm(formatMoney(4900, 'PLN', 'pl'))).toBe('49,00 zł')
  })

  it('formats EUR for a German reader', () => {
    expect(norm(formatMoney(1200, 'EUR', 'de'))).toBe('12,00 €')
  })

  it('formats EUR for an English reader', () => {
    expect(norm(formatMoney(1200, 'EUR', 'en'))).toBe('€12.00')
  })

  it('formats zero', () => {
    expect(norm(formatMoney(0, 'PLN', 'pl'))).toBe('0,00 zł')
  })
})

describe('applyPercentDiscount', () => {
  it('computes a percentage of the subtotal', () => {
    expect(applyPercentDiscount(10000, 10)).toBe(1000)
  })

  it('rounds down so the seller never loses a grosz', () => {
    expect(applyPercentDiscount(999, 10)).toBe(99)
  })

  it('never exceeds the subtotal', () => {
    expect(applyPercentDiscount(5000, 100)).toBe(5000)
    expect(applyPercentDiscount(5000, 150)).toBe(5000)
  })

  it('never returns a negative discount', () => {
    expect(applyPercentDiscount(5000, -10)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/lib/shared/money.test.ts`
Expected: FAIL — cannot resolve `@/lib/shared/money`.

- [ ] **Step 3: Write the locale constants**

`src/lib/shared/locale.ts`:

```ts
export const LOCALES = ['pl', 'en', 'de'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'pl'

// BCP-47 tags used for Intl formatting. 'en' maps to en-GB so that dates
// render day-first, matching Polish and German expectations.
export const BCP47: Record<Locale, string> = {
  pl: 'pl-PL',
  en: 'en-GB',
  de: 'de-DE',
}

export const TIMEZONE = 'Europe/Warsaw'

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value)
}
```

- [ ] **Step 4: Write the money module**

`src/lib/shared/money.ts`:

```ts
import { BCP47, type Locale } from './locale'

export const CURRENCIES = ['PLN', 'EUR'] as const
export type Currency = (typeof CURRENCIES)[number]

/** Major units (49.50) to minor units (4950). Rounds half away from zero. */
export function toMinor(major: number): number {
  return Math.round(major * 100)
}

/** Minor units (4950) to major units (49.5). For display and Intl only. */
export function toMajor(minor: number): number {
  return minor / 100
}

export function formatMoney(minor: number, currency: Currency, locale: Locale): string {
  return new Intl.NumberFormat(BCP47[locale], {
    style: 'currency',
    currency,
  }).format(toMajor(minor))
}

/**
 * Discount amount for a percentage off a subtotal, in minor units.
 * Floors, so rounding always favours the seller, and is clamped to
 * [0, subtotal] so a total can never go negative.
 */
export function applyPercentDiscount(subtotalMinor: number, percent: number): number {
  if (percent <= 0) return 0
  const raw = Math.floor((subtotalMinor * percent) / 100)
  return Math.min(Math.max(raw, 0), subtotalMinor)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test tests/lib/shared/money.test.ts`
Expected: `11 passed`

If the `formatMoney` assertions fail on the exact string, print the actual value first — Node's ICU data version can affect symbol placement. Adjust the expectation to what Node produces, but keep the non-breaking-space normalisation.

- [ ] **Step 6: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add money and locale utilities"
```

---

## Task 4: Local database and Prisma client

**Files:**
- Create: `docker-compose.yml`, `docker/init-test-db.sql`, `prisma/schema.prisma`, `src/lib/server/db.ts`
- Modify: `vitest.setup.ts`, `.env`, `.env.test`
- Test: `tests/lib/server/db.test.ts`

**Interfaces:**
- Consumes: `env` from Task 2.
- Produces: `db` — a `PrismaClient` singleton exported from `@/lib/server/db`.

- [ ] **Step 1: Create the Docker Compose file**

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: km
      POSTGRES_PASSWORD: km
      POSTGRES_DB: km_dev
    ports:
      - '5432:5432'
    volumes:
      - km_pgdata:/var/lib/postgresql/data
      - ./docker/init-test-db.sql:/docker-entrypoint-initdb.d/init-test-db.sql:ro
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U km -d km_dev']
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  km_pgdata:
```

`docker/init-test-db.sql`:

```sql
CREATE DATABASE km_test OWNER km;
```

The init script runs only when the volume is first created. If `km_test` is missing later, create it with:
`docker compose exec postgres psql -U km -d km_dev -c 'CREATE DATABASE km_test OWNER km;'`

- [ ] **Step 2: Start the database and verify both databases exist**

```bash
docker compose up -d
docker compose exec postgres psql -U km -d km_dev -c '\l' | grep -E 'km_dev|km_test'
```

Expected: both `km_dev` and `km_test` are listed.

- [ ] **Step 3: Install Prisma**

```bash
pnpm add -D prisma
pnpm add @prisma/client
pnpm exec prisma init --datasource-provider postgresql
```

`prisma exec` rather than `dlx` uses the version just installed instead of
re-resolving from the registry.

**`prisma init` also writes ~500KB of agent-skill files you did not ask for** —
`.agents/`, `.claude/skills/`, `.windsurf/skills/` and `skills-lock.json`. The
`.claude/` one is loaded into Claude Code sessions in this project. Delete
them:

```bash
rm -rf .agents .claude .windsurf skills-lock.json
```

- [ ] **Step 4: Configure the datasource for pooled and direct connections**

Prisma 7 removed `directUrl` from the schema, and the datasource URL moved out
of `schema.prisma` entirely into `prisma.config.ts`. The pooled/direct split
still exists — it just lives in two places now.

`prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}
```

`prisma.config.ts` (created by `prisma init`, needs `pnpm add -D dotenv`):

```ts
import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // The CLI (migrate, introspect) must use a DIRECT connection. The
    // application connects separately, through a driver adapter pointed at
    // the pooled DATABASE_URL. On Neon, migrations cannot run through the
    // connection pooler.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
})
```

Locally both variables point at the same Postgres. In production
`DATABASE_URL` is Neon's pooled endpoint and `DIRECT_URL` its direct one.
Getting this wrong surfaces as connection exhaustion under load — that is,
exactly when tickets go on sale.

- [ ] **Step 5: Write the Prisma client singleton**

`src/lib/server/db.ts`:

```ts
import 'server-only'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/generated/prisma/client'
import { env } from './env'

// Prisma 7 requires a driver adapter — the bundled query engine is gone.
// PrismaPg speaks plain TCP Postgres, which serves both the local Docker
// container and Neon's pooled endpoint, so local and production use the
// same code path. Migrations do NOT go through here: the CLI reads
// DIRECT_URL from prisma.config.ts, because Neon's pooler cannot run them.
function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })

  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

// Next.js hot-reloads modules in development, which would otherwise open a
// new pool on every edit until Postgres refuses connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const db = globalForPrisma.prisma ?? createClient()

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = db
```

Install the adapter: `pnpm add @prisma/adapter-pg`. Also add
`"postinstall": "prisma generate"` to `package.json` — the generated client is
git-ignored build output, so CI must regenerate it before typechecking.

- [ ] **Step 6: Add a placeholder model so the client can be generated**

Append to `prisma/schema.prisma`:

```prisma
model Venue {
  id              String   @id @default(uuid())
  name            String
  address         String
  city            String
  defaultCapacity Int
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

- [ ] **Step 7: Create the first migration**

```bash
pnpm dlx dotenv -e .env -- prisma migrate dev --name init
```

Expected: a directory appears under `prisma/migrations/` and the command reports the migration applied.

- [ ] **Step 8: Add database lifecycle to the test setup**

Replace `vitest.setup.ts`:

```ts
import { execSync } from 'node:child_process'
import { beforeAll } from 'vitest'

// Applies migrations to the test database once per run. `migrate deploy`
// is idempotent, so repeated runs are cheap. `pnpm exec` uses the Prisma
// already installed rather than re-resolving it from the registry on every
// run, and because vitest.config.ts sets fileParallelism: false this
// executes exactly once instead of once per worker.
beforeAll(() => {
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env },
  })
})
```

- [ ] **Step 9: Write the connectivity test**

`tests/lib/server/db.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'

describe('database connection', () => {
  it('reaches the test database', async () => {
    const rows = await db.$queryRaw<Array<{ ok: number }>>`SELECT 1 as ok`
    expect(rows[0].ok).toBe(1)
  })

  it('has the Venue table', async () => {
    await expect(db.venue.count()).resolves.toBeTypeOf('number')
  })
})
```

- [ ] **Step 10: Run the test**

Run: `pnpm test tests/lib/server/db.test.ts`
Expected: `2 passed`, with migration output above it.

- [ ] **Step 11: Add the Postgres service to CI**

The CI workflow from Task 1 already defines the `postgres` service. Add the environment to the test step so it reaches it — modify `.github/workflows/ci.yml`, replacing `- run: pnpm test` with:

```yaml
      - run: pnpm test
        env:
          DATABASE_URL: postgresql://km:km@localhost:5432/km_test
          DIRECT_URL: postgresql://km:km@localhost:5432/km_test
          SESSION_SECRET: ci_secret_at_least_32_characters_long_ok
          NEXT_PUBLIC_SITE_URL: http://localhost:3000
```

- [ ] **Step 12: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add local Postgres, Prisma client and test database lifecycle"
```

---

## Task 5: The full database schema

Implements [`02-data-model.md`](../02-data-model.md) in one migration. It is one task because a half-applied schema is not independently reviewable — the entities reference each other.

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `tests/prisma/schema.test.ts`

**Interfaces:**
- Consumes: `db` from Task 4.
- Produces: every Prisma model used by the rest of this plan and by plans 02–07. Note the addition of `AdminSession`, which is not in `02-data-model.md` — database-backed sessions need it, and it is recorded in the plan's closing notes.

- [ ] **Step 1: Write the failing test**

`tests/prisma/schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'

async function reset() {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog", "Ticket", "OrderItem", "Order", "PromoCode",
      "TicketType", "EventTranslation", "Event", "Venue",
      "AdminSession", "AdminUser", "StripeWebhookEvent"
    RESTART IDENTITY CASCADE
  `)
}

describe('schema', () => {
  beforeEach(reset)

  it('creates an event with translations and a ticket type', async () => {
    const venue = await db.venue.create({
      data: { name: 'Kościół Pokoju', address: 'Plac Pokoju 6', city: 'Świdnica', defaultCapacity: 900 },
    })

    const event = await db.event.create({
      data: {
        slug: 'bach-wieczor',
        venueId: venue.id,
        startsAt: new Date('2026-08-14T19:00:00Z'),
        capacity: 900,
        status: 'DRAFT',
        translations: {
          create: [
            { locale: 'pl', title: 'Wieczór Bachowski', description: 'Opis', performers: 'Kwartet' },
            { locale: 'de', title: 'Bach-Abend', description: 'Beschreibung', performers: 'Quartett' },
            { locale: 'en', title: 'Bach Evening', description: 'Description', performers: 'Quartet' },
          ],
        },
        ticketTypes: {
          create: [{ pricePln: 4900, priceEur: 1200, maxPerOrder: 10 }],
        },
      },
      include: { translations: true, ticketTypes: true },
    })

    expect(event.translations).toHaveLength(3)
    expect(event.ticketTypes[0].pricePln).toBe(4900)
    expect(event.ticketTypes[0].soldCount).toBe(0)
    expect(event.ticketTypes[0].heldCount).toBe(0)
  })

  it('rejects two translations for the same event and locale', async () => {
    const venue = await db.venue.create({
      data: { name: 'V', address: 'A', city: 'C', defaultCapacity: 300 },
    })
    const event = await db.event.create({
      data: { slug: 'dup', venueId: venue.id, startsAt: new Date(), capacity: 300 },
    })
    await db.eventTranslation.create({
      data: { eventId: event.id, locale: 'pl', title: 'A', description: 'x', performers: 'y' },
    })

    await expect(
      db.eventTranslation.create({
        data: { eventId: event.id, locale: 'pl', title: 'B', description: 'x', performers: 'y' },
      }),
    ).rejects.toThrow()
  })

  it('rejects a duplicate event slug', async () => {
    const venue = await db.venue.create({
      data: { name: 'V', address: 'A', city: 'C', defaultCapacity: 300 },
    })
    await db.event.create({ data: { slug: 'same', venueId: venue.id, startsAt: new Date(), capacity: 300 } })
    await expect(
      db.event.create({ data: { slug: 'same', venueId: venue.id, startsAt: new Date(), capacity: 300 } }),
    ).rejects.toThrow()
  })

  it('rejects a duplicate ticket code', async () => {
    const venue = await db.venue.create({
      data: { name: 'V', address: 'A', city: 'C', defaultCapacity: 300 },
    })
    const event = await db.event.create({
      data: {
        slug: 'codes',
        venueId: venue.id,
        startsAt: new Date(),
        capacity: 300,
        ticketTypes: { create: [{ pricePln: 1000, priceEur: 300 }] },
      },
      include: { ticketTypes: true },
    })
    const order = await db.order.create({
      data: {
        reference: 'KM-2026-000001',
        email: 'a@b.pl',
        firstName: 'A',
        lastName: 'B',
        locale: 'pl',
        currency: 'PLN',
        subtotal: 1000,
        discount: 0,
        total: 1000,
        status: 'PAID',
      },
    })
    const base = {
      orderId: order.id,
      eventId: event.id,
      ticketTypeId: event.ticketTypes[0].id,
    }
    await db.ticket.create({ data: { ...base, code: 'DUPLICATE' } })
    await expect(db.ticket.create({ data: { ...base, code: 'DUPLICATE' } })).rejects.toThrow()
  })

  it('rejects a duplicate Stripe webhook event id', async () => {
    await db.stripeWebhookEvent.create({ data: { stripeEventId: 'evt_1', type: 'payment_intent.succeeded' } })
    await expect(
      db.stripeWebhookEvent.create({ data: { stripeEventId: 'evt_1', type: 'payment_intent.succeeded' } }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/prisma/schema.test.ts`
Expected: FAIL — `db.event` is not a function, or the TRUNCATE names unknown tables.

- [ ] **Step 3: Write the full schema**

Replace everything after the `datasource` block in `prisma/schema.prisma`:

```prisma
enum EventStatus {
  DRAFT
  ON_SALE
  SOLD_OUT
  CLOSED
  CANCELLED
}

enum OrderKind {
  PURCHASE
  INVITATION
}

enum OrderStatus {
  PENDING
  PAID
  FAILED
  EXPIRED
  CANCELLED
  REFUNDED
  PARTIALLY_REFUNDED
}

enum TicketStatus {
  VALID
  USED
  REVOKED
}

enum PromoKind {
  PERCENT
  FIXED
}

enum AdminRole {
  ADMIN
  SCANNER
}

// The design fixes these sets exactly ("Locales are exactly pl, en, de";
// "Currencies are exactly PLN and EUR"). Storing them as free-form strings
// would let a mis-cased "eur" or a stray "sk" reach the database and crash
// rendering later. Enums cost nothing now and avoid a data migration once
// orders exist.
enum Locale {
  pl
  en
  de
}

enum Currency {
  PLN
  EUR
}

model Venue {
  id              String   @id @default(uuid())
  name            String
  address         String
  city            String
  defaultCapacity Int
  mapUrl          String?
  events          Event[]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model Event {
  id             String             @id @default(uuid())
  slug           String             @unique
  venue          Venue              @relation(fields: [venueId], references: [id])
  venueId        String
  startsAt       DateTime
  doorsAt        DateTime?
  capacity       Int
  status         EventStatus        @default(DRAFT)
  salesOpenAt    DateTime?
  salesCloseAt   DateTime?
  imageUrl       String?
  translations   EventTranslation[]
  ticketTypes    TicketType[]
  tickets        Ticket[]
  promoCodes     PromoCode[]
  createdAt      DateTime           @default(now())
  updatedAt      DateTime           @updatedAt

  @@index([status, startsAt])
}

model EventTranslation {
  id          String @id @default(uuid())
  event       Event  @relation(fields: [eventId], references: [id], onDelete: Cascade)
  eventId     String
  locale      Locale
  title       String
  description String
  performers  String
  note        String?

  @@unique([eventId, locale])
}

model TicketType {
  id          String      @id @default(uuid())
  event       Event       @relation(fields: [eventId], references: [id], onDelete: Cascade)
  eventId     String
  pricePln    Int
  priceEur    Int
  maxPerOrder Int         @default(10)
  soldCount   Int         @default(0)
  heldCount   Int         @default(0)
  active      Boolean     @default(true)
  orderItems  OrderItem[]
  tickets     Ticket[]
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  @@index([eventId])
}

model Order {
  id                    String      @id @default(uuid())
  reference             String      @unique
  kind                  OrderKind   @default(PURCHASE)
  email                 String
  firstName             String
  lastName              String
  phone                 String?
  locale                Locale
  currency              Currency
  subtotal              Int
  discount              Int         @default(0)
  total                 Int
  status                OrderStatus @default(PENDING)
  stripePaymentIntentId String?     @unique
  promoCode             PromoCode?  @relation(fields: [promoCodeId], references: [id])
  promoCodeId           String?
  needsInvoice          Boolean     @default(false)
  companyName           String?
  nip                   String?
  invoiceAddress        String?
  issuedByAdmin         AdminUser?  @relation(fields: [issuedByAdminId], references: [id])
  issuedByAdminId       String?
  items                 OrderItem[]
  tickets               Ticket[]
  createdAt             DateTime    @default(now())
  holdExpiresAt         DateTime?
  paidAt                DateTime?
  emailSentAt           DateTime?
  cancelledAt           DateTime?

  @@index([email])
  @@index([status, holdExpiresAt])
}

model OrderItem {
  id           String     @id @default(uuid())
  order        Order      @relation(fields: [orderId], references: [id], onDelete: Cascade)
  orderId      String
  ticketType   TicketType @relation(fields: [ticketTypeId], references: [id])
  ticketTypeId String
  quantity     Int
  unitPrice    Int
  currency     Currency

  @@index([orderId])
}

model Ticket {
  id             String       @id @default(uuid())
  code           String       @unique
  order          Order        @relation(fields: [orderId], references: [id], onDelete: Cascade)
  orderId        String
  event          Event        @relation(fields: [eventId], references: [id])
  eventId        String
  ticketType     TicketType   @relation(fields: [ticketTypeId], references: [id])
  ticketTypeId   String
  holderName     String?
  status         TicketStatus @default(VALID)
  usedAt         DateTime?
  usedByAdmin    AdminUser?   @relation(fields: [usedByAdminId], references: [id])
  usedByAdminId  String?
  createdAt      DateTime     @default(now())

  @@index([eventId, status])
  @@index([orderId])
}

model PromoCode {
  id         String    @id @default(uuid())
  code       String    @unique
  kind       PromoKind
  value      Int
  currency   Currency?
  maxUses    Int?
  usedCount  Int       @default(0)
  validFrom  DateTime?
  validUntil DateTime?
  event      Event?    @relation(fields: [eventId], references: [id])
  eventId    String?
  active     Boolean   @default(true)
  orders     Order[]
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt
}

model AdminUser {
  id             String         @id @default(uuid())
  email          String         @unique
  passwordHash   String
  name           String
  role           AdminRole      @default(SCANNER)
  active         Boolean        @default(true)
  lastLoginAt    DateTime?
  sessions       AdminSession[]
  auditLogs      AuditLog[]
  issuedOrders   Order[]
  scannedTickets Ticket[]
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt
}

// Not in 02-data-model.md. Database-backed sessions are used instead of
// JWTs so that a session can be revoked immediately — a phone handed to a
// volunteer at the door must be revocable the moment it goes missing.
model AdminSession {
  id          String    @id @default(uuid())
  tokenHash   String    @unique
  admin       AdminUser @relation(fields: [adminUserId], references: [id], onDelete: Cascade)
  adminUserId String
  expiresAt   DateTime
  createdAt   DateTime  @default(now())

  @@index([adminUserId])
  @@index([expiresAt])
}

model StripeWebhookEvent {
  stripeEventId String    @id
  type          String
  receivedAt    DateTime  @default(now())
  processedAt   DateTime?
  error         String?
}

model AuditLog {
  id         String     @id @default(uuid())
  actor      AdminUser? @relation(fields: [actorId], references: [id])
  actorId    String?
  action     String
  entityType String
  entityId   String
  meta       Json?
  createdAt  DateTime   @default(now())

  @@index([entityType, entityId])
  @@index([createdAt])
}
```

- [ ] **Step 4: Create the migration**

```bash
pnpm dlx dotenv -e .env -- prisma migrate dev --name full_schema
```

Expected: the migration applies without prompting for data loss. If it warns about dropping the `Venue` table, that is fine — there is no data yet.

- [ ] **Step 5: Run the schema tests**

Run: `pnpm test tests/prisma/schema.test.ts`
Expected: `5 passed`

- [ ] **Step 6: Verify the enums reached the database**

```bash
docker compose exec postgres psql -U km -d km_test -c \
  "SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname IN ('Locale','Currency') ORDER BY t.typname, e.enumsortorder;"
```

Expected: `Currency` with `PLN`, `EUR`; `Locale` with `pl`, `en`, `de`.

Note for later tasks: the Prisma client exports a `Locale` enum whose name
collides with the `Locale` type in `@/lib/shared/locale`. Where both are
needed in one file, import the Prisma one as `import type { $Enums } from
'@/generated/prisma/client'` and refer to `$Enums.Locale`.

- [ ] **Step 7: Verify the unique constraints exist in the database itself**

```bash
docker compose exec postgres psql -U km -d km_test -c \
  "SELECT indexname FROM pg_indexes WHERE tablename IN ('Ticket','Order','Event','EventTranslation') ORDER BY indexname;"
```

Expected: indexes including `Ticket_code_key`, `Order_reference_key`, `Event_slug_key`, `EventTranslation_eventId_locale_key`.

Passing tests confirm Prisma's view; this confirms the database's. They are not the same claim.

- [ ] **Step 8: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add full database schema"
```

---

## Task 6: Password hashing

**Files:**
- Create: `src/lib/server/password.ts`, `scripts/create-admin.ts`
- Test: `tests/lib/server/password.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `hashPassword(plain: string): Promise<string>`
  - `verifyPassword(hash: string, plain: string): Promise<boolean>`

- [ ] **Step 1: Install argon2**

```bash
pnpm add @node-rs/argon2
```

`@node-rs/argon2` ships prebuilt binaries for `linux-x64-gnu`, which is what both Docker and Vercel run. There is no bcrypt fallback: argon2id is the OWASP recommendation and bcrypt is not its peer. If the install fails here, that is a local toolchain problem to solve, not a reason to change algorithm.

- [ ] **Step 2: Write the failing test**

`tests/lib/server/password.test.ts`:

```ts
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
```

The last case matters: a malformed hash in the database must produce a failed login, not a 500 that reveals the login route is reachable.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test tests/lib/server/password.test.ts`
Expected: FAIL — cannot resolve `@/lib/server/password`.

- [ ] **Step 4: Write the implementation**

The parameters live in `shared/`, not `server/`. The `create-admin` script and
the seed both run under `tsx`, where `import 'server-only'` throws — but an
admin created by a script and one created through the app must hash
identically, or the tuning is decorative. Sharing the numbers is what makes
that true; they are parameters, not secrets.

`src/lib/shared/password-options.ts`:

```ts
/**
 * argon2id parameters, per OWASP's recommendation for interactive logins.
 * Lives in shared/ so CLI scripts can reach them — see the note above.
 */
export const ARGON2_OPTIONS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const
```

`src/lib/server/password.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test tests/lib/server/password.test.ts`
Expected: `5 passed`

- [ ] **Step 6: Write the admin creation script**

`scripts/create-admin.ts`:

```ts
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { randomBytes } from 'node:crypto'
// argon2 is called directly rather than through lib/server/password.ts:
// that module starts with `import 'server-only'`, which throws under tsx.
// The PARAMETERS are shared, which is what actually matters.
import { hash } from '@node-rs/argon2'
import { ARGON2_OPTIONS } from '../src/lib/shared/password-options'

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! }),
})

async function main() {
  const [email, name, role = 'SCANNER'] = process.argv.slice(2)

  if (!email || !name) {
    console.error('Usage: pnpm admin:create <email> <name> [ADMIN|SCANNER]')
    process.exit(1)
  }
  if (role !== 'ADMIN' && role !== 'SCANNER') {
    console.error(`Invalid role "${role}". Use ADMIN or SCANNER.`)
    process.exit(1)
  }

  // Generated rather than prompted, so a weak password is never chosen and
  // never appears in shell history.
  const password = randomBytes(12).toString('base64url')

  await db.adminUser.create({
    data: {
      // Lowercased on write because the unique index is case-sensitive:
      // Admin@… and admin@… would otherwise both be creatable, and only
      // one of them reachable through the login path.
      email: email.trim().toLowerCase(),
      name,
      role,
      passwordHash: await hash(password, ARGON2_OPTIONS),
    },
  })

  console.log(`Created ${role} ${email}`)
  console.log(`Password: ${password}`)
  console.log('Record this now — it is not stored anywhere in recoverable form.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
```

Add to `package.json` scripts:

```json
"admin:create": "dotenv -e .env -- tsx scripts/create-admin.ts"
```

- [ ] **Step 7: Verify the script**

Run: `pnpm admin:create test@EXAMPLE.com "Test Person" SCANNER`
Expected: a generated password is printed, and the confirmation line shows the
address **lowercased**. Then confirm the stored hash carries the tuned
parameters — not argon2's defaults:

```bash
docker compose exec -T postgres psql -U km -d km_dev -t -c \
  "SELECT email, role, split_part(\"passwordHash\", '\$', 4) FROM \"AdminUser\";"
```

Expected: `m=19456,t=2,p=1`. Anything else means the shared options were not
applied. Also confirm the row exists:

```bash
docker compose exec postgres psql -U km -d km_dev -c \
  "SELECT email, role FROM \"AdminUser\" ORDER BY email;"
```

Then remove the test row:

```bash
docker compose exec postgres psql -U km -d km_dev -c \
  "DELETE FROM \"AdminUser\" WHERE email = 'test@example.com';"
```

- [ ] **Step 8: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add argon2id password hashing and admin creation script"
```

---

## Task 7: Seed data

**Files:**
- Create: `prisma/seed.ts`, `tests/prisma/seed.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the schema from Task 5, `ARGON2_OPTIONS` from Task 6.
- Produces: `pnpm db:seed`.

- [ ] **Step 1: Write the seed script**

`prisma/seed.ts`:

```ts
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
// Direct argon2 call with shared parameters — the seed runs under tsx,
// where lib/server/password.ts's `import 'server-only'` would throw.
import { hash } from '@node-rs/argon2'
import { ARGON2_OPTIONS } from '../src/lib/shared/password-options'

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! }),
})

async function main() {
  const swidnica = await db.venue.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Kościół Pokoju',
      address: 'Plac Pokoju 6',
      city: 'Świdnica',
      defaultCapacity: 900,
    },
  })

  const krzyzowa = await db.venue.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      name: 'Pałac w Krzyżowej',
      address: 'Krzyżowa 7',
      city: 'Krzyżowa',
      defaultCapacity: 300,
    },
  })

  const concerts = [
    {
      slug: 'wieczor-bachowski',
      venueId: swidnica.id,
      capacity: 900,
      startsAt: new Date('2026-08-14T17:00:00Z'), // 19:00 Europe/Warsaw
      pricePln: 8000,
      priceEur: 1900,
      pl: { title: 'Wieczór Bachowski', description: 'Koncert inauguracyjny festiwalu.', performers: 'J.S. Bach' },
      de: { title: 'Bach-Abend', description: 'Eröffnungskonzert des Festivals.', performers: 'J.S. Bach' },
      en: { title: 'Bach Evening', description: 'Festival opening concert.', performers: 'J.S. Bach' },
    },
    {
      slug: 'karlowicz-kwartet',
      venueId: krzyzowa.id,
      capacity: 300,
      startsAt: new Date('2026-08-16T18:00:00Z'), // 20:00 Europe/Warsaw
      pricePln: 6000,
      priceEur: 1400,
      pl: { title: 'Karłowicz i przyjaciele', description: 'Muzyka kameralna.', performers: 'Mieczysław Karłowicz' },
      de: { title: 'Karłowicz und Freunde', description: 'Kammermusik.', performers: 'Mieczysław Karłowicz' },
      en: { title: 'Karłowicz and Friends', description: 'Chamber music.', performers: 'Mieczysław Karłowicz' },
    },
    {
      slug: 'koncert-finalowy',
      venueId: swidnica.id,
      capacity: 900,
      startsAt: new Date('2026-08-22T17:00:00Z'),
      pricePln: 9000,
      priceEur: 2100,
      pl: { title: 'Koncert finałowy', description: 'Zakończenie festiwalu.', performers: 'Wszyscy artyści' },
      de: { title: 'Abschlusskonzert', description: 'Festivalabschluss.', performers: 'Alle Künstler' },
      en: { title: 'Closing Concert', description: 'End of the festival.', performers: 'All artists' },
    },
  ]

  for (const c of concerts) {
    await db.event.upsert({
      where: { slug: c.slug },
      update: {},
      create: {
        slug: c.slug,
        venueId: c.venueId,
        startsAt: c.startsAt,
        capacity: c.capacity,
        status: 'ON_SALE',
        translations: {
          create: [
            { locale: 'pl', ...c.pl },
            { locale: 'de', ...c.de },
            { locale: 'en', ...c.en },
          ],
        },
        ticketTypes: { create: [{ pricePln: c.pricePln, priceEur: c.priceEur }] },
      },
    })
  }

  const password = await hash('DevPassword123!', ARGON2_OPTIONS)

  await db.adminUser.upsert({
    where: { email: 'admin@krzyzowa-music.eu' },
    update: {},
    create: { email: 'admin@krzyzowa-music.eu', passwordHash: password, name: 'Administrator', role: 'ADMIN' },
  })

  await db.adminUser.upsert({
    where: { email: 'skaner@krzyzowa-music.eu' },
    update: {},
    create: { email: 'skaner@krzyzowa-music.eu', passwordHash: password, name: 'Obsługa wejścia', role: 'SCANNER' },
  })

  console.log('Seeded 2 venues, 3 concerts, 2 admin accounts.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
```

The seed password is a development credential only. Production accounts are created by the script in Task 7 step 9.

- [ ] **Step 2: Register the seed command**

Add to `package.json`:

```json
{
  "prisma": { "seed": "tsx prisma/seed.ts" },
  "scripts": {
    "db:seed": "dotenv -e .env -- tsx prisma/seed.ts",
    "db:reset": "dotenv -e .env -- prisma migrate reset --force"
  }
}
```

- [ ] **Step 3: Run the seed**

Run: `pnpm db:seed`
Expected: `Seeded 2 venues, 3 concerts, 2 admin accounts.`

- [ ] **Step 4: Verify the data landed, including Polish characters**

```bash
docker compose exec postgres psql -U km -d km_dev -c \
  "SELECT e.slug, t.locale, t.title FROM \"Event\" e JOIN \"EventTranslation\" t ON t.\"eventId\" = e.id ORDER BY e.slug, t.locale;"
```

Expected: nine rows. Confirm `Karłowicz` and `Świdnica` display with correct diacritics — mojibake here means a client encoding problem worth fixing now rather than after it reaches a PDF ticket.

- [ ] **Step 5: Verify idempotency**

Run: `pnpm db:seed` a second time.
Expected: succeeds with no unique-constraint error, and the row counts are unchanged.

- [ ] **Step 6: Write the seed test**

`tests/prisma/seed.test.ts`:

```ts
import { execSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'

beforeAll(async () => {
  // Test files run sequentially against ONE database, and earlier files
  // leave rows behind after their final test. Without this truncate the
  // exact-count assertions below pick up that residue and fail in a way
  // that depends on file ordering — the worst kind of flake.
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog", "Ticket", "OrderItem", "Order", "PromoCode",
      "TicketType", "EventTranslation", "Event", "Venue",
      "AdminSession", "AdminUser", "StripeWebhookEvent"
    RESTART IDENTITY CASCADE
  `)

  // Run twice: the second run is the idempotency assertion.
  execSync('pnpm exec tsx prisma/seed.ts', { stdio: 'pipe', env: { ...process.env } })
  execSync('pnpm exec tsx prisma/seed.ts', { stdio: 'pipe', env: { ...process.env } })
})

describe('seed', () => {
  it('is idempotent', async () => {
    expect(await db.venue.count()).toBe(2)
    expect(await db.event.count()).toBe(3)
    expect(await db.adminUser.count()).toBe(2)
  })

  it('stores Polish diacritics intact', async () => {
    const venue = await db.venue.findFirstOrThrow({ where: { city: 'Świdnica' } })
    expect(venue.name).toBe('Kościół Pokoju')

    const t = await db.eventTranslation.findFirstOrThrow({
      where: { locale: 'pl', title: { contains: 'Karłowicz' } },
    })
    expect(t.performers).toContain('Mieczysław')
  })

  it('gives every concert all three translations', async () => {
    const events = await db.event.findMany({ include: { translations: true } })
    for (const e of events) {
      expect(e.translations.map((t) => t.locale).sort()).toEqual(['de', 'en', 'pl'])
    }
  })

  it('stores admin emails in lowercase', async () => {
    const admins = await db.adminUser.findMany()
    for (const a of admins) expect(a.email).toBe(a.email.toLowerCase())
  })
})
```

- [ ] **Step 7: Run the seed test — then the whole suite, twice**

Run: `pnpm test tests/prisma/seed.test.ts`
Expected: `4 passed`

Passing in isolation proves little here: this file asserts exact row counts,
so it is the one most exposed to cross-file residue. Run the full suite twice
and confirm the totals are identical both times.

Run: `pnpm test` (twice)
Expected: the same counts each run.

- [ ] **Step 8: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add database seed with venues, concerts and admin accounts"
```

---

## Task 8: Session storage

Sessions are opaque random tokens stored as SHA-256 hashes. A database leak therefore does not hand the attacker working sessions, and a session can be revoked instantly — which matters when a phone handed to a door volunteer goes missing.

**Files:**
- Create: `src/lib/server/sessions.ts`
- Test: `tests/lib/server/sessions.test.ts`

**Interfaces:**
- Consumes: `db` (Task 4), the `AdminSession` model (Task 5).
- Produces:
  - `SESSION_TTL_HOURS: number`
  - `createSession(adminUserId: string): Promise<{ token: string; expiresAt: Date }>`
  - `findSessionUser(token: string): Promise<AdminUser | null>`
  - `deleteSession(token: string): Promise<void>`
  - `deleteExpiredSessions(): Promise<number>`

- [ ] **Step 1: Write the failing test**

`tests/lib/server/sessions.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/lib/server/sessions.test.ts`
Expected: FAIL — cannot resolve `@/lib/server/sessions`.

- [ ] **Step 3: Write the implementation**

`src/lib/server/sessions.ts`:

```ts
import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import type { AdminRole, AdminUser } from '@/generated/prisma/client'
import { db } from './db'

// Two TTLs, because the two roles have opposite risks. A scanner phone is
// borrowed, carried around a venue and easily mislaid, so its session should
// not outlive the evening. An administrator doing back-office work all day
// must not be logged out mid-refund.
export const SESSION_TTL_HOURS: Record<AdminRole, number> = {
  SCANNER: 8,
  ADMIN: 12,
}

// When a session is used with less than this left, its expiry is pushed out.
// Without it, a 12-hour cap logs an admin out at the busiest moment of the
// day regardless of how active they were.
const REFRESH_WHEN_UNDER_HOURS = 2

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(
  adminUserId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const admin = await db.adminUser.findUniqueOrThrow({ where: { id: adminUserId } })
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS[admin.role] * 60 * 60 * 1000)

  await db.adminSession.create({
    data: { tokenHash: hashToken(token), adminUserId, expiresAt },
  })

  return { token, expiresAt }
}

export async function findSessionUser(token: string): Promise<AdminUser | null> {
  const session = await db.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { admin: true },
  })

  if (!session) return null
  if (session.expiresAt <= new Date()) return null
  if (!session.admin.active) return null

  // Rolling expiry: extend only when the session is close to lapsing, so
  // an active user is never logged out mid-task and an idle one still is.
  const remainingMs = session.expiresAt.getTime() - Date.now()
  if (remainingMs < REFRESH_WHEN_UNDER_HOURS * 60 * 60 * 1000) {
    await db.adminSession.update({
      where: { tokenHash: session.tokenHash },
      data: {
        expiresAt: new Date(Date.now() + SESSION_TTL_HOURS[session.admin.role] * 60 * 60 * 1000),
      },
    })
  }

  return session.admin
}

export async function deleteSession(token: string): Promise<void> {
  await db.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } })
}

export async function deleteExpiredSessions(): Promise<number> {
  const { count } = await db.adminSession.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  })
  return count
}
```

`deleteMany` rather than `delete` in `deleteSession` — `delete` throws when no row matches, and logging out with an already-invalid cookie must not produce an error page.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/lib/server/sessions.test.ts`
Expected: `12 passed`

- [ ] **Step 5: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add database-backed admin sessions"
```

---

## Task 9: Authentication with account lockout

**Files:**
- Create: `src/lib/server/login.ts`
- Modify: `prisma/schema.prisma` (two columns on `AdminUser`)
- Test: `tests/lib/server/login.test.ts`

**Interfaces:**
- Consumes: `verifyPassword` (Task 7), `db` (Task 4).
- Produces:
  - `type AuthResult = { ok: true; user: AdminUser } | { ok: false; reason: 'INVALID' | 'LOCKED' | 'INACTIVE' }`
  - `authenticate(email: string, password: string): Promise<AuthResult>`
  - `MAX_FAILED_ATTEMPTS: number`, `LOCKOUT_MINUTES: number`

- [ ] **Step 1: Add lockout columns to the schema**

In `prisma/schema.prisma`, add to `model AdminUser`:

```prisma
  failedLoginCount Int       @default(0)
  lockedUntil      DateTime?
```

Then:

```bash
pnpm dlx dotenv -e .env -- prisma migrate dev --name admin_lockout
```

- [ ] **Step 2: Write the failing test**

`tests/lib/server/login.test.ts`:

```ts
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
```

The fourth case is the one worth reading twice. An unknown email and a wrong password must be indistinguishable to the caller, or the login form becomes a way to discover which addresses have accounts.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test tests/lib/server/login.test.ts`
Expected: FAIL — cannot resolve `@/lib/server/login`.

- [ ] **Step 4: Write the implementation**

`src/lib/server/login.ts`:

```ts
import 'server-only'
import type { AdminUser } from '@/generated/prisma/client'
import { db } from './db'
import { hashPassword, verifyPassword } from './password'

export const MAX_FAILED_ATTEMPTS = 5
export const LOCKOUT_MINUTES = 15

export type AuthResult =
  | { ok: true; user: AdminUser }
  | { ok: false; reason: 'INVALID' | 'LOCKED' | 'INACTIVE' }

// Verified against when no account matches, so that a request for an unknown
// address costs the same time as one for a known address. Without this, the
// response latency itself reveals which emails have accounts.
let dummyHashPromise: Promise<string> | null = null
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('dummy-password-for-timing-equalisation')
  return dummyHashPromise
}

export async function authenticate(email: string, password: string): Promise<AuthResult> {
  const normalised = email.trim().toLowerCase()
  const user = await db.adminUser.findUnique({ where: { email: normalised } })

  if (!user) {
    await verifyPassword(await dummyHash(), password)
    return { ok: false, reason: 'INVALID' }
  }

  if (!user.active) return { ok: false, reason: 'INACTIVE' }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { ok: false, reason: 'LOCKED' }
  }

  // The lockout has lapsed — clear the counter before evaluating this
  // attempt. Without this, the first wrong password after a lockout expires
  // takes the count from 5 to 6 and re-locks instantly, so the account is
  // effectively locked forever after one bad afternoon.
  const priorFailures = user.lockedUntil ? 0 : user.failedLoginCount

  const valid = await verifyPassword(user.passwordHash, password)

  if (!valid) {
    const failedLoginCount = priorFailures + 1
    const lockedUntil =
      failedLoginCount >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
        : null

    await db.adminUser.update({
      where: { id: user.id },
      data: { failedLoginCount, lockedUntil },
    })

    return { ok: false, reason: 'INVALID' }
  }

  const updated = await db.adminUser.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })

  return { ok: true, user: updated }
}
```

- [ ] **Step 5: Ensure emails are stored lowercase**

The seed and `create-admin` script must normalise too, or a login will fail against an address stored with capitals. In `scripts/create-admin.ts`, change the create call to use `email: email.trim().toLowerCase()`. In `prisma/seed.ts` the addresses are already lowercase — verify by reading them.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test tests/lib/server/login.test.ts`
Expected: `9 passed`

- [ ] **Step 7: Run the whole suite**

Run: `pnpm test`
Expected: all tests pass. Several files now truncate `AdminUser`; they do not interfere because `vitest.config.mts` set `fileParallelism: false` in Task 1. If you see rows vanishing mid-test, that setting has been lost — restore it rather than adding retries.

- [ ] **Step 8: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add admin authentication with account lockout"
```

---

## Task 10: Cookies, guards and the login page

**Files:**
- Create: `src/lib/server/auth.ts`, `src/app/admin/layout.tsx`, `src/app/admin/login/page.tsx`, `src/app/admin/login/actions.ts`, `src/app/admin/page.tsx`
- Test: `tests/lib/server/auth.test.ts`

**Interfaces:**
- Consumes: `createSession`, `findSessionUser`, `deleteSession` (Task 8); `authenticate` (Task 9).
- Produces:
  - `SESSION_COOKIE: 'km_session'`
  - `startSession(adminUserId: string): Promise<void>`
  - `endSession(): Promise<void>`
  - `getCurrentAdmin(): Promise<AdminUser | null>`
  - `requireStaff(): Promise<AdminUser>` — any active admin; redirects to `/admin/login` otherwise
  - `requireAdmin(): Promise<AdminUser>` — role `ADMIN` only; redirects otherwise

- [ ] **Step 1: Write the cookie and guard module**

`src/lib/server/auth.ts`:

```ts
import 'server-only'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { AdminUser } from '@/generated/prisma/client'
import { createSession, deleteSession, findSessionUser } from './sessions'

export const SESSION_COOKIE = 'km_session'

// Scoped to /admin, not /. Nothing outside the admin area reads the session,
// and this keeps it off every public shop request, every static asset and
// every /t/<code> ticket page.
const COOKIE_PATH = '/admin'

export async function startSession(adminUserId: string): Promise<void> {
  const { token, expiresAt } = await createSession(adminUserId)
  const store = await cookies()

  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: COOKIE_PATH,
    expires: expiresAt,
  })
}

export async function endSession(): Promise<void> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (token) await deleteSession(token)
  // The path must match the one used to set it, or the delete silently
  // does nothing and the user stays logged in.
  store.delete({ name: SESSION_COOKIE, path: COOKIE_PATH })
}

export async function getCurrentAdmin(): Promise<AdminUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  return findSessionUser(token)
}

/** Any active admin account. Used by the scanner. */
export async function requireStaff(): Promise<AdminUser> {
  const user = await getCurrentAdmin()
  if (!user) redirect('/admin/login')
  return user
}

/** ADMIN role only. Used by everything except the scanner. */
export async function requireAdmin(): Promise<AdminUser> {
  const user = await requireStaff()
  if (user.role !== 'ADMIN') redirect('/admin/scan')
  return user
}
```

Both guards are called **inside** each page and server action. Middleware is not used for authorisation — Next.js has shipped a middleware authorisation bypass (CVE-2025-29927), and Server Actions are publicly callable HTTP endpoints regardless of where they are defined. See [`07-security-and-testing.md`](../07-security-and-testing.md).

- [ ] **Step 2: Write the guard test**

`tests/lib/server/auth.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test**

Run: `pnpm test tests/lib/server/auth.test.ts`
Expected: `5 passed`

The fourth case is the one that matters operationally: a phone at the door must not reach the buyer list.

- [ ] **Step 4: Add per-IP rate limiting**

Per-account lockout is not rate limiting. An attacker spreading attempts
across many addresses is never slowed by it — and worse, lockout is itself a
weapon: hammering `admin@krzyzowa-music.eu` with wrong passwords locks the
festival out of its own admin on the evening sales open. The two controls
solve different problems and both are needed.

`src/lib/server/ratelimit.ts`:

```ts
import 'server-only'

type Window = { count: number; resetAt: number }

// In-memory and therefore per-instance: on Vercel, several function
// instances each keep their own counter, so the effective limit is looser
// than the number below. That is an accepted trade-off for Plan 01 — it
// raises the cost of an attack by orders of magnitude for ~20 lines and no
// new infrastructure. A shared store arrives in phase 8 alongside the
// checkout and scan limits.
const windows = new Map<string, Window>()

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const existing = windows.get(key)

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }

  if (existing.count >= limit) return false

  existing.count += 1
  return true
}

/** Prevents unbounded growth on a long-lived instance. */
export function pruneRateLimits(now = Date.now()): void {
  for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key)
}
```

`tests/lib/server/ratelimit.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pruneRateLimits, rateLimit } from '@/lib/server/ratelimit'

afterEach(() => {
  vi.useRealTimers()
})

describe('rateLimit', () => {
  it('allows up to the limit then refuses', () => {
    const key = `k${Math.random()}`
    for (let i = 0; i < 3; i++) expect(rateLimit(key, 3, 60_000)).toBe(true)
    expect(rateLimit(key, 3, 60_000)).toBe(false)
  })

  it('keeps separate counters per key', () => {
    const a = `a${Math.random()}`
    const b = `b${Math.random()}`
    expect(rateLimit(a, 1, 60_000)).toBe(true)
    expect(rateLimit(a, 1, 60_000)).toBe(false)
    expect(rateLimit(b, 1, 60_000)).toBe(true)
  })

  // Fake timers, not a short real window: with a 1ms window the second
  // call can legitimately land after it has already expired, so the test
  // would pass or fail depending on machine speed.
  it('resets after the window', () => {
    vi.useFakeTimers()
    const key = `k${Math.random()}`

    expect(rateLimit(key, 1, 60_000)).toBe(true)
    expect(rateLimit(key, 1, 60_000)).toBe(false)

    vi.advanceTimersByTime(60_001)
    expect(rateLimit(key, 1, 60_000)).toBe(true)
  })

  it('prunes expired windows', () => {
    vi.useFakeTimers()
    const key = `p${Math.random()}`
    rateLimit(key, 1, 60_000)

    vi.advanceTimersByTime(60_001)
    pruneRateLimits()

    // Pruned, so a fresh window starts and the call is allowed.
    expect(rateLimit(key, 1, 60_000)).toBe(true)
  })
})
```

Run: `pnpm test tests/lib/server/ratelimit.test.ts`
Expected: `4 passed`

- [ ] **Step 5: Write the login server action**

`src/app/admin/login/actions.ts`:

```ts
'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { authenticate } from '@/lib/server/login'
import { endSession, startSession } from '@/lib/server/auth'
import { rateLimit } from '@/lib/server/ratelimit'

export type LoginState = { error?: string }

const MESSAGES: Record<string, string> = {
  INVALID: 'Nieprawidłowy e-mail lub hasło.',
  LOCKED: 'Konto tymczasowo zablokowane po zbyt wielu próbach. Spróbuj za 15 minut.',
  INACTIVE: 'To konto jest nieaktywne.',
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  if (!rateLimit(`login:${ip}`, 10, 60_000)) {
    return { error: 'Zbyt wiele prób. Odczekaj minutę.' }
  }

  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')

  if (!email || !password) return { error: 'Podaj e-mail i hasło.' }

  const result = await authenticate(email, password)
  if (!result.ok) return { error: MESSAGES[result.reason] }

  await startSession(result.user.id)
  redirect(result.user.role === 'ADMIN' ? '/admin' : '/admin/scan')
}

export async function logoutAction(): Promise<void> {
  await endSession()
  redirect('/admin/login')
}
```

- [ ] **Step 6: Write the login page**

`src/app/admin/login/page.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { loginAction, type LoginState } from './actions'

const initial: LoginState = {}

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, initial)

  return (
    <main className="mx-auto max-w-[400px] px-4 py-16">
      <h1 className="font-serif text-2xl font-bold text-[var(--color-text-primary)]">
        Panel administracyjny
      </h1>

      <form action={action} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold">E-mail</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
            className="min-h-[48px] rounded-[2px] border border-[var(--color-border-input)] px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold">Hasło</span>
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="min-h-[48px] rounded-[2px] border border-[var(--color-border-input)] px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          />
        </label>

        {state.error && (
          <p role="alert" className="text-sm text-[var(--color-accent)]">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="min-h-[48px] rounded-[2px] bg-[var(--color-accent)] px-4 font-semibold text-white disabled:opacity-60"
        >
          {pending ? 'Logowanie…' : 'Zaloguj się'}
        </button>
      </form>
    </main>
  )
}
```

- [ ] **Step 7: Write the admin shell and dashboard placeholder**

`src/app/admin/layout.tsx`:

```tsx
import type { ReactNode } from 'react'

// Admin pages are Polish only and must never be indexed.
export const metadata = { robots: { index: false, follow: false } }

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <div lang="pl">{children}</div>
}
```

`src/app/admin/page.tsx`:

```tsx
import { requireAdmin } from '@/lib/server/auth'
import { logoutAction } from './login/actions'

export default async function AdminHome() {
  const admin = await requireAdmin()

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-16">
      <h1 className="font-serif text-3xl font-bold">Panel administracyjny</h1>
      <p className="mt-2 text-[var(--color-text-secondary)]">
        Zalogowano jako {admin.name} ({admin.email})
      </p>

      <nav className="mt-8">
        <a href="/admin/events" className="text-[var(--color-accent)] underline">
          Koncerty
        </a>
      </nav>

      <form action={logoutAction} className="mt-8">
        <button type="submit" className="text-sm underline">
          Wyloguj się
        </button>
      </form>
    </main>
  )
}
```

- [ ] **Step 8: Verify the redirect for an anonymous visitor**

```bash
pnpm dev &
sleep 5
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:3000/admin
```

Expected: a `307` (or `302`) to `/admin/login`.

- [ ] **Step 8a: Write the login-action integration test**

The browser checks below are worth doing once, but they are manual and cannot
run in CI. Cover the same ground automatically first, in
`tests/app/admin/login-action.test.ts`: mock `next/headers` (cookies **and**
headers) and `next/navigation`, then assert that

1. a correct ADMIN login throws `REDIRECT:/admin` and sets the session cookie;
2. a SCANNER is sent to `/admin/scan`, not the dashboard;
3. a wrong password returns the error and sets **no** cookie;
4. a sixth attempt reports the lockout;
5. eleven attempts from one IP trip the rate limiter **even when no such
   account exists** — an attacker spraying addresses must be throttled too.

Give each test a distinct fake IP: the limiter is a module-level in-memory
`Map`, so counters leak between tests otherwise.

Run: `pnpm test tests/app/admin/login-action.test.ts`
Expected: `5 passed`

- [ ] **Step 9: Verify a real login in the browser**

Open `http://localhost:3000/admin/login`, sign in as `admin@krzyzowa-music.eu` / `DevPassword123!`.
Expected: the dashboard renders with the account name.

Then check the cookie in DevTools → Application → Cookies. Expected: `km_session` present, `HttpOnly` ticked, `SameSite=Lax`, `Path=/admin`. If `HttpOnly` is not set, stop and fix it — the session is readable by any script on the page otherwise.

- [ ] **Step 10: Verify the lockout is real**

Submit a wrong password six times.
Expected: the sixth attempt reports the lockout message rather than "nieprawidłowy e-mail lub hasło".

Then clear it:

```bash
docker compose exec postgres psql -U km -d km_dev -c \
  "UPDATE \"AdminUser\" SET \"failedLoginCount\" = 0, \"lockedUntil\" = NULL;"
```

- [ ] **Step 11a: Verify the IP rate limit**

Submit the login form eleven times in quick succession with any credentials.
Expected: the eleventh reports "Zbyt wiele prób. Odczekaj minutę." rather than
an authentication message. Wait a minute and confirm it recovers.

- [ ] **Step 11: Verify the SCANNER restriction in the browser**

Log in as `skaner@krzyzowa-music.eu` / `DevPassword123!` and navigate to `/admin`.
Expected: redirected away to `/admin/scan` (which 404s at this stage — that is correct, it arrives in Plan 07).

- [ ] **Step 12: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add admin login, session cookies, rate limiting and role guards"
```

---

## Task 11: Design tokens and fonts

**Files:**
- Create: `src/app/fonts.ts`
- Modify: `src/app/globals.css`
- Test: `tests/design/tokens.test.ts`

> **Tailwind v4.** `create-next-app` scaffolds Tailwind v4, which has no
> `tailwind.config.ts`: tokens are declared in CSS inside an `@theme` block
> and Tailwind generates the matching utilities from them. The v3-style JS
> config shown in `10-design-system.md` §9 does not apply — that section has
> been corrected to match.

**Interfaces:**
- Consumes: nothing.
- Produces: the CSS custom properties from [`10-design-system.md`](../10-design-system.md), and `merriweather` (a `next/font` object exposing `.variable`).

- [ ] **Step 1: Write the failing test**

This test does two things: it confirms every required token exists, and it recomputes the WCAG contrast ratios so the palette cannot silently drift below threshold.

`tests/design/tokens.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/app/globals.css', 'utf8')

// Tokens are declared inside @theme (Tailwind v4), not :root. The regexes
// below match either, so this test survives a move between the two.

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))
  if (!match) throw new Error(`Token --${name} not found in globals.css`)
  return match[1]
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('design tokens', () => {
  const required = [
    'color-background', 'color-surface', 'color-text-primary', 'color-text-secondary',
    'color-accent', 'color-border', 'color-border-input', 'color-border-strong',
    'color-accent-hover',
  ]

  it.each(required)('defines --%s', (name) => {
    expect(token(name)).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })

  it('uses the agreed palette values', () => {
    expect(token('color-background')).toBe('#FFFFFF')
    expect(token('color-text-primary')).toBe('#1A1A1A')
    expect(token('color-text-secondary')).toBe('#4A4A4A')
    expect(token('color-accent')).toBe('#C4122D')
    expect(token('color-border')).toBe('#E0E0E0')
  })

  it('body text meets WCAG AA (4.5:1)', () => {
    expect(contrast(token('color-text-primary'), token('color-background'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('color-text-secondary'), token('color-background'))).toBeGreaterThanOrEqual(4.5)
  })

  it('white text on the accent meets WCAG AA', () => {
    expect(contrast('#FFFFFF', token('color-accent'))).toBeGreaterThanOrEqual(4.5)
  })

  // WCAG 2.1 SC 1.4.11: the visual boundary of a UI component needs 3:1.
  // --color-border (#E0E0E0) is ~1.3:1 and is therefore decorative only.
  it('form field borders meet WCAG non-text contrast (3:1)', () => {
    expect(contrast(token('color-border-input'), token('color-background'))).toBeGreaterThanOrEqual(3)
    expect(contrast(token('color-border-strong'), token('color-background'))).toBeGreaterThanOrEqual(3)
  })

  it('defines the 8px spacing scale', () => {
    for (const s of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8']) {
      expect(css).toContain(s)
    }
  })

  it('enables hyphenation, which German compound nouns depend on', () => {
    expect(css).toMatch(/hyphens:\s*auto/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/design/tokens.test.ts`
Expected: FAIL — tokens not found.

- [ ] **Step 3: Write the tokens**

Replace `src/app/globals.css` with the following. The palette lives inside
`@theme` so that Tailwind emits both the CSS custom properties (usable as
`var(--color-accent)`) **and** matching utilities (`bg-accent`,
`border-border-input`, `text-text-secondary`). Copy the hex values verbatim
from [`10-design-system.md`](../10-design-system.md) §1 — do not retype them.

```css
@import 'tailwindcss';

@theme {
  --color-background: #FFFFFF;
  --color-surface: #F8F9FA;
  --color-text-primary: #1A1A1A;
  --color-text-secondary: #4A4A4A;
  --color-accent: #C4122D;
  --color-accent-hover: #A00F25;
  --color-border: #E0E0E0;
  --color-border-strong: #949494;
  --color-border-input: #757575;
  --color-success: #1E6B3A;
  --color-warning: #8A5A00;

  --font-primary: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --font-secondary: Georgia, 'Times New Roman', serif;

  --space-1: 0.5rem;
  --space-2: 1rem;
  --space-3: 1.5rem;
  --space-4: 2rem;
  --space-6: 3rem;
  --space-8: 4rem;
  --space-12: 6rem;

  --radius: 2px;
}

html {
  color-scheme: light;
}

body {
  background: var(--color-background);
  color: var(--color-text-primary);
  font-family: var(--font-primary);
  font-weight: 400;
}

h1, h2, h3 {
  font-family: var(--font-secondary);
  font-weight: 700;
  letter-spacing: -0.01em;
}

/* Hyphenation is what stops "Kammermusikfestival" overflowing a narrow
   column. It only works when <html lang> is set — Task 12 wires that up. */
h1, h2, h3, p {
  hyphens: auto;
  overflow-wrap: break-word;
}

h1 { font-size: clamp(1.75rem, 1.2rem + 2.2vw, 3rem); line-height: 1.15; }
h2 { font-size: clamp(1.375rem, 1.1rem + 1.2vw, 2rem); line-height: 1.25; }
p  { font-size: clamp(1rem, 0.96rem + 0.2vw, 1.125rem); line-height: 1.65; }

.price, .order-reference { font-variant-numeric: tabular-nums; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/design/tokens.test.ts`
Expected: all pass, including the two contrast assertions.

- [ ] **Step 5: Set up self-hosted fonts**

`src/app/fonts.ts`:

```ts
import { Merriweather } from 'next/font/google'

// Self-hosted at build time, not linked from Google's CDN. Two reasons:
// latin-ext is required for Polish diacritics (ą ć ę ł ń ó ś ż ź), and a
// German court (LG München I, 2022) held that loading fonts from Google's
// servers transmits the visitor's IP without consent.
export const merriweather = Merriweather({
  weight: ['300', '400', '700'],
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-merriweather',
})
```

Then in the `@theme` block of `src/app/globals.css`, change the serif stack to
prefer the loaded face:

```css
  --font-secondary: var(--font-merriweather), Georgia, 'Times New Roman', serif;
```

- [ ] **Step 6: Apply the font variable**

The `<html>` elements are created in Task 12, which adds
`className={merriweather.variable}` to each root layout. Nothing to do here
beyond confirming `src/app/fonts.ts` type-checks:

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 6a: Verify the generated utilities exist**

Tailwind only emits a utility if something uses it, so put the token classes on
a page first — `src/app/page.tsx` is fine, Task 12 replaces it anyway:

```tsx
<main className="bg-surface text-text-primary border border-border-input p-4">
  <h1 className="text-accent">Kościół Pokoju — Świdnica</h1>
  <p className="text-text-secondary">Wieczór Bachowski · Karłowicz</p>
</main>
```

Then build and check the emitted CSS. **Find the chunk rather than assuming a
path** — Turbopack writes to `.next/static/chunks/*.css`, not the
`.next/static/css/` webpack used:

```bash
pnpm build
CSS=$(find .next -name "*.css" -not -path "*/cache/*" | head -1)
for u in bg-surface text-accent text-text-secondary border-border-input; do
  printf '%-24s ' ".$u"; grep -q "\.$u" "$CSS" && echo emitted || echo MISSING
done
```

Expected: all four `emitted`. If they are `MISSING`, the tokens are not inside
`@theme` and only `var(--color-*)` usage will work.

Note the doubled words in `text-text-secondary` and `border-border-input`: that
is the cost of keeping the token names exactly as the design document specifies.
Renaming them to read better in markup would break the single source of truth
the contrast test relies on.

- [ ] **Step 7: Verify the font is served from our own origin**

`next/font` declares `@font-face` inside a CSS chunk using **relative** URLs, so
grepping the HTML for `href=".woff2"` finds nothing even when everything is
correct. Check the CSS chunk instead:

```bash
CSS=$(find .next -name "*.css" -not -path "*/cache/*" | head -1)
grep -oE "src:url\([^)]*\)" "$CSS" | head -4
grep -c 'gstatic\|googleapis' "$CSS"
```

Expected: `src:url(../media/….woff2)` paths, and a count of **0** for external
hosts. Any `fonts.gstatic.com` reference means the font is not self-hosted and
the GDPR problem described above is live.

- [ ] **Step 8: Verify the latin-ext subset is actually loaded**

Polish diacritics live outside Latin-1: `ł` is U+0142, `ś` U+015B, `ż` U+017C,
`ć` U+0107, `ę` U+0119, `ą` U+0105, `ń` U+0144. Without the `latin-ext` subset
they fall back to a different face mid-word. Confirm the range is present:

```bash
CSS=$(find .next -name "*.css" -not -path "*/cache/*" | head -1)
grep -ohE 'unicode-range:U\+100[^;]*' "$CSS" | head -1
```

Expected: a range starting `U+100-2BA`, which covers all seven characters
above. Then open the login page and confirm "Hasło" renders with a proper `ł`
rather than a substituted glyph.

- [ ] **Step 9: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add design tokens, self-hosted fonts and contrast tests"
```

---

## Task 12: Localised routing

**Files:**
- Create: `src/i18n/routing.ts`, `src/i18n/request.ts`, `src/proxy.ts`, `src/messages/{pl,en,de}.json`
- Create: `src/app/(shop)/[locale]/layout.tsx`, `src/app/(shop)/[locale]/page.tsx`
- Create: `src/components/LocaleSwitcher.tsx`
- Move: `src/app/admin/**` → `src/app/(admin)/admin/**`
- Create: `src/app/(admin)/admin/layout.tsx` (replacing the one from Task 10)
- Delete: `src/app/layout.tsx`, `src/app/page.tsx`
- Modify: `next.config.ts`
- Test: `tests/i18n/messages.test.ts`

> **The root layout structure.** Next.js allows exactly one layout containing
> `<html>` and `<body>` on any given path. The shop needs `<html lang={locale}>`
> — that attribute is what selects the browser's hyphenation dictionary, without
> which the German compound-noun handling from Task 11 does nothing — while the
> admin needs `<html lang="pl">`. Two different `<html>` elements means **two
> root layouts**, which Next.js supports only through top-level route groups,
> and only when `src/app/layout.tsx` does not exist (the moment it does, it
> becomes *the* root and a nested `<html>` is an error).
>
> Hence:
>
> ```
> src/app/
> ├─ (shop)/[locale]/layout.tsx    ← <html lang={locale}>
> │                  page.tsx
> ├─ (admin)/admin/layout.tsx      ← <html lang="pl">
> │                login/  events/  page.tsx
> └─ (no layout.tsx or page.tsx at this level)
> ```
>
> Route groups do not appear in URLs: `(shop)/[locale]/page.tsx` still serves
> `/pl`, and `(admin)/admin/login/page.tsx` still serves `/admin/login`. Plan 04
> adds `(ticket)/t/[code]/` the same way. Each root layout imports
> `globals.css` independently — they are separate document roots.

**Interfaces:**
- Consumes: `LOCALES`, `DEFAULT_LOCALE` (Task 3).
- Produces: `routing`, and the `Link` / `redirect` / `usePathname` / `useRouter` navigation helpers from `next-intl`.

- [ ] **Step 1: Install next-intl**

```bash
pnpm add next-intl
```

- [ ] **Step 2: Write the failing test**

`tests/i18n/messages.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import pl from '@/messages/pl.json'
import en from '@/messages/en.json'
import de from '@/messages/de.json'

function keys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? keys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  )
}

describe('message catalogues', () => {
  it('English has every key Polish has', () => {
    expect(keys(en).sort()).toEqual(keys(pl).sort())
  })

  it('German has every key Polish has', () => {
    expect(keys(de).sort()).toEqual(keys(pl).sort())
  })

  it('has no empty strings', () => {
    for (const [name, cat] of [['pl', pl], ['en', en], ['de', de]] as const) {
      for (const key of keys(cat)) {
        const value = key.split('.').reduce<any>((acc, k) => acc[k], cat)
        expect(value, `${name}.${key} is empty`).not.toBe('')
      }
    }
  })
})
```

This catches the most common i18n failure — a key added to Polish and forgotten in German — at commit time rather than when a German buyer sees a raw key on the checkout page.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test tests/i18n/messages.test.ts`
Expected: FAIL — message files do not exist.

- [ ] **Step 4: Create the message catalogues**

`src/messages/pl.json`:

```json
{
  "site": { "title": "Krzyżowa-Music — bilety", "programme": "Program" },
  "common": { "loading": "Ładowanie…", "soldOut": "Wyprzedane" }
}
```

`src/messages/en.json`:

```json
{
  "site": { "title": "Krzyżowa-Music — tickets", "programme": "Programme" },
  "common": { "loading": "Loading…", "soldOut": "Sold out" }
}
```

`src/messages/de.json`:

```json
{
  "site": { "title": "Krzyżowa-Music — Karten", "programme": "Programm" },
  "common": { "loading": "Wird geladen…", "soldOut": "Ausverkauft" }
}
```

- [ ] **Step 5: Enable JSON module resolution**

In `tsconfig.json`, ensure `"resolveJsonModule": true` is set under `compilerOptions`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test tests/i18n/messages.test.ts`
Expected: `3 passed`

- [ ] **Step 7: Wire up next-intl**

`src/i18n/routing.ts`:

```ts
import { defineRouting } from 'next-intl/routing'
import { createNavigation } from 'next-intl/navigation'
import { DEFAULT_LOCALE, LOCALES } from '@/lib/shared/locale'

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'always',
})

export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing)
```

`localePrefix: 'always'` means Polish lives at `/pl`, not `/`. That is deliberate: the Wix site links into three explicit language URLs, and an unprefixed default makes those links ambiguous.

`src/i18n/request.ts`:

```ts
import { getRequestConfig } from 'next-intl/server'
import { hasLocale } from 'next-intl'
import { routing } from './routing'

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  }
})
```

`src/proxy.ts` — **not `middleware.ts`**. Next 16 renamed the file convention
and warns on the old name at build time. next-intl still exports
`createMiddleware`; only the filename changed.

```ts
import createMiddleware from 'next-intl/middleware'
import { routing } from './i18n/routing'

export default createMiddleware(routing)

export const config = {
  // /admin is excluded: it is Polish-only and must not be locale-prefixed.
  // /api and /t are excluded so their URLs stay stable — a QR code printed
  // on a ticket cannot be re-issued if the path later gains a prefix.
  matcher: ['/((?!api|admin|t|_next|_vercel|.*\\..*).*)'],
}
```

`next.config.ts`:

```ts
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin()

export default withNextIntl({})
```

- [ ] **Step 8: Create the localised layout with the `lang` attribute**

`src/app/(shop)/[locale]/layout.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { hasLocale, NextIntlClientProvider } from 'next-intl'
import { getMessages, setRequestLocale } from 'next-intl/server'
import { merriweather } from '@/app/fonts'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import { routing } from '@/i18n/routing'
import type { ReactNode } from 'react'
import '@/app/globals.css'

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()

  setRequestLocale(locale)

  // Messages are passed explicitly. Any client component calling
  // useTranslations() throws MISSING_MESSAGES without them — and because the
  // only client component in Plan 01 hardcodes Polish, that failure would not
  // surface until Plan 02's buy box, a long way from its cause.
  const messages = await getMessages()

  // The lang attribute is what selects the browser's hyphenation dictionary.
  // Without it, `hyphens: auto` does nothing and German compounds overflow.
  return (
    <html lang={locale} className={merriweather.variable}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <header className="mx-auto flex max-w-[1200px] justify-end px-8 py-4">
            <LocaleSwitcher />
          </header>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
```

`src/components/LocaleSwitcher.tsx`:

```tsx
'use client'

import { useLocale } from 'next-intl'
import { Link, usePathname } from '@/i18n/routing'
import { LOCALES, type Locale } from '@/lib/shared/locale'

const LABEL: Record<Locale, string> = { pl: 'PL', en: 'EN', de: 'DE' }

export function LocaleSwitcher() {
  // usePathname() from next-intl returns the path WITHOUT the locale prefix,
  // so the same path can be handed to <Link> for a different locale.
  const pathname = usePathname()
  const active = useLocale()

  return (
    <nav aria-label="Język" className="flex gap-1">
      {LOCALES.map((l) => (
        <Link
          key={l}
          href={pathname}
          locale={l}
          aria-current={l === active ? 'true' : undefined}
          className={`min-h-[44px] px-3 py-2 text-sm ${
            l === active ? 'font-semibold text-accent underline' : 'text-text-secondary'
          }`}
        >
          {LABEL[l]}
        </Link>
      ))}
    </nav>
  )
}
```

`src/app/(shop)/[locale]/page.tsx`:

```tsx
import { getTranslations, setRequestLocale } from 'next-intl/server'

export default async function ProgrammePage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)
  const t = await getTranslations('site')

  return (
    <main className="mx-auto max-w-[1200px] px-8 py-16">
      <h1>{t('programme')}</h1>
    </main>
  )
}
```

- [ ] **Step 9: Restructure into two route groups**

```bash
mkdir -p 'src/app/(admin)'
git mv src/app/admin 'src/app/(admin)/admin'
rm src/app/layout.tsx src/app/page.tsx
```

**Route groups disappear from URLs but not from import paths.** Anything
importing the admin server actions must be updated:

```diff
- import { loginAction } from '@/app/admin/login/actions'
+ import { loginAction } from '@/app/(admin)/admin/login/actions'
```

`tests/app/admin/login-action.test.ts` from Task 10 is the one that breaks.

Then replace `src/app/(admin)/admin/layout.tsx` — it is now a root layout and
must render the document itself:

```tsx
import type { ReactNode } from 'react'
import { merriweather } from '@/app/fonts'
import '@/app/globals.css'

// Admin pages are Polish only and must never be indexed.
export const metadata = { robots: { index: false, follow: false } }

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pl" className={merriweather.variable}>
      <body>{children}</body>
    </html>
  )
}
```

- [ ] **Step 9a: Verify the build accepts two root layouts**

Run: `pnpm build`
Expected: succeeds. A "You should not have a nested `<html>` element" or
"Duplicate root layout" error means `src/app/layout.tsx` still exists — delete
it. This check is the point of the whole restructure; do not continue past a
failing build.

- [ ] **Step 10: Verify all three locales serve**

```bash
pnpm dev &
sleep 5
for l in pl en de; do
  echo -n "$l: "
  curl -s "http://localhost:3000/$l" | grep -o '<html lang="[a-z]*"' | head -1
done
```

Expected:

```
pl: <html lang="pl"
en: <html lang="en"
de: <html lang="de"
```

The `lang` attribute is the whole point of this check — without it the hyphenation from Task 11 is inert.

- [ ] **Step 11: Verify the root redirect and that admin is untouched**

```bash
curl -s -o /dev/null -w "/ → %{http_code} %{redirect_url}\n" http://localhost:3000/
curl -s -o /dev/null -w "/admin → %{http_code} %{redirect_url}\n" http://localhost:3000/admin
```

Expected: `/` redirects to `/pl`; `/admin` redirects to `/admin/login` — **not** to `/pl/admin`. If it does the latter, the middleware matcher is wrong.

Route groups must not appear in any URL. Confirm:

```bash
curl -s -o /dev/null -w "final: %{http_code}  url: %{url_effective}\n" -L 'http://localhost:3000/(shop)/pl'
```

Expected: a final **404**. Follow the redirects (`-L`) rather than reading the
first status: next-intl's proxy adds a locale prefix first, so the immediate
response is a 307 to `/pl/(shop)/pl`, which then 404s. Checking only the first
status would look like the group *is* routable when it is not.

- [ ] **Step 12: Verify the locale switcher works**

Open `http://localhost:3000/pl` and click **DE**.
Expected: the URL becomes `/de`, the heading reads "Programm", and `<html lang>`
is now `de`. Click **EN**: `/en`, "Programme". The switcher must preserve the
path, not always return to the home page — confirm again from a sub-path once
Plan 02 adds one.

- [ ] **Step 12a: Verify the client provider has messages**

The switcher is a client component calling `useLocale()`. If the page renders
without a `MISSING_MESSAGES` error in the console, the provider is wired
correctly. Open DevTools → Console on `/de`.
Expected: no `IntlError`.

- [ ] **Step 12b: Verify German hyphenation**

On `http://localhost:3000/de`, set the viewport to 320px in DevTools and
temporarily add a heading containing `Kammermusikfestival`.
Expected: the word breaks with a hyphen rather than overflowing the column.
Remove the temporary heading afterwards.

- [ ] **Step 12c: Re-run lint — the restructure surfaces new errors**

Two rules only start firing once the pages sit at a resolvable route:

- `@next/next/no-html-link-for-pages` — the dashboard's `<a href="/admin/events">`
  must become `<Link>` from `next/link`. (The admin is not localised, so this is
  `next/link`, **not** next-intl's `Link`.)
- `@typescript-eslint/no-explicit-any` — the message-catalogue walker in
  `tests/i18n/messages.test.ts` needs `reduce<unknown>` with a cast rather than
  `reduce<any>`.

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 13: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add pl/en/de routing, route-group layouts and locale switcher"
```

---

## Task 13: Audit logging

**Files:**
- Create: `src/lib/server/audit.ts`
- Test: `tests/lib/server/audit.test.ts`

**Interfaces:**
- Consumes: `db` (Task 4).
- Produces: `recordAudit(entry: AuditEntry): Promise<void>` where
  `type AuditEntry = { actorId?: string | null; action: string; entityType: string; entityId: string; meta?: Record<string, unknown> }`

- [ ] **Step 1: Write the failing test**

`tests/lib/server/audit.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import { recordAudit } from '@/lib/server/audit'

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "AuditLog", "AdminUser" RESTART IDENTITY CASCADE')
})

describe('recordAudit', () => {
  it('writes an entry with its actor', async () => {
    const admin = await db.adminUser.create({
      data: { email: 'a@example.com', name: 'A', role: 'ADMIN', passwordHash: 'x' },
    })

    await recordAudit({
      actorId: admin.id,
      action: 'event.create',
      entityType: 'Event',
      entityId: 'evt-1',
      meta: { slug: 'test' },
    })

    const [entry] = await db.auditLog.findMany()
    expect(entry.action).toBe('event.create')
    expect(entry.actorId).toBe(admin.id)
    expect(entry.meta).toEqual({ slug: 'test' })
  })

  it('accepts a system entry with no actor', async () => {
    await recordAudit({ action: 'cron.release_holds', entityType: 'System', entityId: 'cron' })
    const [entry] = await db.auditLog.findMany()
    expect(entry.actorId).toBeNull()
  })

  it('never throws — a failed audit write must not break the operation', async () => {
    await expect(
      recordAudit({
        actorId: '00000000-0000-0000-0000-000000000000', // no such admin
        action: 'x',
        entityType: 'Y',
        entityId: 'z',
      }),
    ).resolves.toBeUndefined()
  })
})
```

The third case encodes a policy: audit logging is important, but a refund must not fail because the audit table rejected a row. The write is best-effort and its failures are logged to stderr.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/lib/server/audit.test.ts`
Expected: FAIL — cannot resolve `@/lib/server/audit`.

- [ ] **Step 3: Write the implementation**

`src/lib/server/audit.ts`:

```ts
import 'server-only'
import type { Prisma } from '@/generated/prisma/client'
import { db } from './db'

export type AuditEntry = {
  actorId?: string | null
  action: string
  entityType: string
  entityId: string
  meta?: Record<string, unknown>
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        meta: (entry.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
  } catch (error) {
    // Best effort by design: never let an audit failure abort a refund,
    // an invitation, or an event change.
    console.error('[audit] failed to record entry', entry.action, error)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/lib/server/audit.test.ts`
Expected: `3 passed`

- [ ] **Step 5: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add audit logging"
```

---

## Task 14: Event service with the capacity guard

**Files:**
- Create: `src/lib/server/events.ts`, `src/lib/shared/schemas.ts`
- Test: `tests/lib/server/events.test.ts`

**Interfaces:**
- Consumes: `db` (Task 4), `recordAudit` (Task 13).
- Produces:
  - `eventInputSchema` — a Zod schema exported from `@/lib/shared/schemas`
  - `type EventInput = z.infer<typeof eventInputSchema>`
  - `createEvent(input: EventInput, actorId: string): Promise<Event>`
  - `updateEvent(id: string, input: EventInput, actorId: string): Promise<Event>`
  - `class CapacityBelowSoldError extends Error` with `{ sold: number; held: number }`
  - `class SlugTakenError extends Error`

- [ ] **Step 1: Write the failing test**

`tests/lib/server/events.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import {
  CapacityBelowSoldError,
  createEvent,
  PriceChangeWhileHeldError,
  SlugTakenError,
  updateEvent,
} from '@/lib/server/events'

let actorId: string
let venueId: string

beforeEach(async () => {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "TicketType", "EventTranslation", "Event",
                   "Venue", "AdminUser" RESTART IDENTITY CASCADE
  `)
  const admin = await db.adminUser.create({
    data: { email: 'a@example.com', name: 'A', role: 'ADMIN', passwordHash: 'x' },
  })
  actorId = admin.id
  const venue = await db.venue.create({
    data: { name: 'V', address: 'A', city: 'C', defaultCapacity: 900 },
  })
  venueId = venue.id
})

function input(overrides: Partial<Parameters<typeof createEvent>[0]> = {}) {
  return {
    slug: 'wieczor-bachowski',
    venueId,
    startsAt: new Date('2026-08-14T17:00:00Z'),
    capacity: 900,
    status: 'DRAFT' as const,
    pricePln: 8000,
    priceEur: 1900,
    maxPerOrder: 10,
    translations: {
      pl: { title: 'Wieczór Bachowski', description: 'Opis', performers: 'J.S. Bach' },
      en: { title: 'Bach Evening', description: 'Description', performers: 'J.S. Bach' },
      de: { title: 'Bach-Abend', description: 'Beschreibung', performers: 'J.S. Bach' },
    },
    ...overrides,
  }
}

describe('createEvent', () => {
  it('creates the event with three translations and one ticket type', async () => {
    const event = await createEvent(input(), actorId)

    const stored = await db.event.findUniqueOrThrow({
      where: { id: event.id },
      include: { translations: true, ticketTypes: true },
    })

    expect(stored.translations).toHaveLength(3)
    expect(stored.ticketTypes).toHaveLength(1)
    expect(stored.ticketTypes[0].pricePln).toBe(8000)
    expect(stored.ticketTypes[0].priceEur).toBe(1900)
  })

  it('writes an audit entry', async () => {
    const event = await createEvent(input(), actorId)
    const entries = await db.auditLog.findMany({ where: { entityId: event.id } })
    expect(entries[0].action).toBe('event.create')
  })

  it('rejects a duplicate slug with a typed error', async () => {
    await createEvent(input(), actorId)
    await expect(createEvent(input(), actorId)).rejects.toBeInstanceOf(SlugTakenError)
  })
})

describe('updateEvent', () => {
  it('updates translations in place rather than duplicating them', async () => {
    const event = await createEvent(input(), actorId)

    await updateEvent(
      event.id,
      input({
        translations: {
          pl: { title: 'Zmieniony', description: 'Opis', performers: 'J.S. Bach' },
          en: { title: 'Bach Evening', description: 'Description', performers: 'J.S. Bach' },
          de: { title: 'Bach-Abend', description: 'Beschreibung', performers: 'J.S. Bach' },
        },
      }),
      actorId,
    )

    const stored = await db.event.findUniqueOrThrow({
      where: { id: event.id },
      include: { translations: true },
    })

    expect(stored.translations).toHaveLength(3)
    expect(stored.translations.find((t) => t.locale === 'pl')?.title).toBe('Zmieniony')
  })

  it('allows raising the capacity', async () => {
    const event = await createEvent(input({ capacity: 300 }), actorId)
    const updated = await updateEvent(event.id, input({ capacity: 500 }), actorId)
    expect(updated.capacity).toBe(500)
  })

  it('refuses to lower capacity below tickets already sold and held', async () => {
    const event = await createEvent(input({ capacity: 900 }), actorId)
    await db.ticketType.updateMany({
      where: { eventId: event.id },
      data: { soldCount: 400, heldCount: 20 },
    })

    await expect(updateEvent(event.id, input({ capacity: 300 }), actorId)).rejects.toBeInstanceOf(
      CapacityBelowSoldError,
    )
  })

  it('refuses a price change while tickets are held', async () => {
    const event = await createEvent(input(), actorId)
    await db.ticketType.updateMany({ where: { eventId: event.id }, data: { heldCount: 3 } })

    await expect(
      updateEvent(event.id, input({ pricePln: 9000 }), actorId),
    ).rejects.toBeInstanceOf(PriceChangeWhileHeldError)
  })

  it('allows a non-price change while tickets are held', async () => {
    const event = await createEvent(input(), actorId)
    await db.ticketType.updateMany({ where: { eventId: event.id }, data: { heldCount: 3 } })

    const updated = await updateEvent(event.id, input({ status: 'ON_SALE' }), actorId)
    expect(updated.status).toBe('ON_SALE')
  })

  it('allows lowering capacity to exactly the number sold and held', async () => {
    const event = await createEvent(input({ capacity: 900 }), actorId)
    await db.ticketType.updateMany({
      where: { eventId: event.id },
      data: { soldCount: 400, heldCount: 20 },
    })

    const updated = await updateEvent(event.id, input({ capacity: 420 }), actorId)
    expect(updated.capacity).toBe(420)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/lib/server/events.test.ts`
Expected: FAIL — cannot resolve `@/lib/server/events`.

- [ ] **Step 3: Write the input schema**

`src/lib/shared/schemas.ts`:

```ts
import { z } from 'zod'
import { LOCALES } from './locale'

const translationSchema = z.object({
  title: z.string().min(1, 'Tytuł jest wymagany'),
  description: z.string().min(1, 'Opis jest wymagany'),
  performers: z.string().min(1, 'Wykonawcy są wymagani'),
  note: z.string().optional(),
})

export const eventInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'Slug może zawierać tylko małe litery, cyfry i myślniki'),
  venueId: z.string().uuid(),
  startsAt: z.coerce.date(),
  doorsAt: z.coerce.date().optional().nullable(),
  capacity: z.number().int().positive(),
  status: z.enum(['DRAFT', 'ON_SALE', 'SOLD_OUT', 'CLOSED', 'CANCELLED']),
  salesOpenAt: z.coerce.date().optional().nullable(),
  salesCloseAt: z.coerce.date().optional().nullable(),
  // Minor units. Integers only — see the Global Constraints.
  pricePln: z.number().int().nonnegative(),
  priceEur: z.number().int().nonnegative(),
  maxPerOrder: z.number().int().positive().max(50).default(10),
  translations: z.object(
    Object.fromEntries(LOCALES.map((l) => [l, translationSchema])) as Record<
      (typeof LOCALES)[number],
      typeof translationSchema
    >,
  ),
})

export type EventInput = z.infer<typeof eventInputSchema>
```

- [ ] **Step 4: Write the service**

`src/lib/server/events.ts`:

```ts
import 'server-only'
import type { Event } from '@/generated/prisma/client'
import { Prisma } from '@/generated/prisma/client'
import { db } from './db'
import { recordAudit } from './audit'
import { eventInputSchema, type EventInput } from '@/lib/shared/schemas'
import { LOCALES } from '@/lib/shared/locale'

export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`Koncert o adresie "${slug}" już istnieje.`)
    this.name = 'SlugTakenError'
  }
}

export class PriceChangeWhileHeldError extends Error {
  constructor(readonly held: number) {
    super(
      `Nie można zmienić ceny — ${held} bilet(ów) jest w trakcie zakupu. Spróbuj ponownie za kilka minut.`,
    )
    this.name = 'PriceChangeWhileHeldError'
  }
}

export class CapacityBelowSoldError extends Error {
  constructor(
    readonly sold: number,
    readonly held: number,
  ) {
    super(
      `Nie można zmniejszyć pojemności poniżej liczby sprzedanych i zarezerwowanych biletów (${sold} + ${held}).`,
    )
    this.name = 'CapacityBelowSoldError'
  }
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

export async function createEvent(raw: EventInput, actorId: string): Promise<Event> {
  const input = eventInputSchema.parse(raw)

  try {
    const event = await db.event.create({
      data: {
        slug: input.slug,
        venueId: input.venueId,
        startsAt: input.startsAt,
        doorsAt: input.doorsAt ?? null,
        capacity: input.capacity,
        status: input.status,
        salesOpenAt: input.salesOpenAt ?? null,
        salesCloseAt: input.salesCloseAt ?? null,
        translations: {
          create: LOCALES.map((locale) => ({ locale, ...input.translations[locale] })),
        },
        ticketTypes: {
          create: [
            {
              pricePln: input.pricePln,
              priceEur: input.priceEur,
              maxPerOrder: input.maxPerOrder,
            },
          ],
        },
      },
    })

    await recordAudit({
      actorId,
      action: 'event.create',
      entityType: 'Event',
      entityId: event.id,
      meta: { slug: event.slug, capacity: event.capacity },
    })

    return event
  } catch (e) {
    if (isUniqueViolation(e)) throw new SlugTakenError(input.slug)
    throw e
  }
}

export async function updateEvent(
  id: string,
  raw: EventInput,
  actorId: string,
): Promise<Event> {
  const input = eventInputSchema.parse(raw)

  const existing = await db.event.findUniqueOrThrow({
    where: { id },
    include: { ticketTypes: true },
  })

  // Capacity may never fall below what is already committed to buyers.
  const sold = existing.ticketTypes.reduce((n, t) => n + t.soldCount, 0)
  const held = existing.ticketTypes.reduce((n, t) => n + t.heldCount, 0)
  if (input.capacity < sold + held) throw new CapacityBelowSoldError(sold, held)

  // Refuse price edits while someone is mid-checkout. Their order snapshotted
  // the old price and Stripe already holds a PaymentIntent for that amount;
  // changing it underneath them makes the confirmation page disagree with the
  // charge. Holds expire in 30 minutes, so this resolves itself.
  const priceChanged = existing.ticketTypes.some(
    (t) => t.pricePln !== input.pricePln || t.priceEur !== input.priceEur,
  )
  if (priceChanged && held > 0) throw new PriceChangeWhileHeldError(held)

  try {
    const event = await db.$transaction(async (tx) => {
      const updated = await tx.event.update({
        where: { id },
        data: {
          slug: input.slug,
          venueId: input.venueId,
          startsAt: input.startsAt,
          doorsAt: input.doorsAt ?? null,
          capacity: input.capacity,
          status: input.status,
          salesOpenAt: input.salesOpenAt ?? null,
          salesCloseAt: input.salesCloseAt ?? null,
        },
      })

      for (const locale of LOCALES) {
        await tx.eventTranslation.upsert({
          where: { eventId_locale: { eventId: id, locale } },
          create: { eventId: id, locale, ...input.translations[locale] },
          update: input.translations[locale],
        })
      }

      // Prices are edited on the single ticket type. Existing orders keep
      // their snapshotted unitPrice, so this never rewrites history.
      await tx.ticketType.updateMany({
        where: { eventId: id },
        data: {
          pricePln: input.pricePln,
          priceEur: input.priceEur,
          maxPerOrder: input.maxPerOrder,
        },
      })

      return updated
    })

    await recordAudit({
      actorId,
      action: 'event.update',
      entityType: 'Event',
      entityId: event.id,
      meta: { slug: event.slug, capacity: event.capacity, previousCapacity: existing.capacity },
    })

    return event
  } catch (e) {
    if (isUniqueViolation(e)) throw new SlugTakenError(input.slug)
    throw e
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test tests/lib/server/events.test.ts`
Expected: `9 passed`

- [ ] **Step 6: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add event service with capacity guard and audit trail"
```

---

## Task 15: Admin event screens

**Files:**
- Create: `src/app/(admin)/admin/events/page.tsx`, `.../new/page.tsx`, `.../[id]/page.tsx`, `.../actions.ts`, `.../EventForm.tsx`
- Create: `src/lib/server/time.ts`
- Test: `tests/lib/server/time.test.ts`, `tests/app/admin/events-action.test.ts`

**Interfaces:**
- Consumes: `requireAdmin` (Task 10), `createEvent` / `updateEvent` / the typed errors (Task 14), `formatMoney` (Task 3).
- Produces: the admin screens. Nothing later in this plan depends on their internals.

- [ ] **Step 1: Fix the timezone conversion first**

A `datetime-local` input submits `2026-08-14T19:00` with **no timezone**.
`new Date()` on that string interprets it in the *runtime's* zone — UTC on
Vercel and in Docker. The form says "czas polski". So an admin typing 19:00
would store 19:00Z, which is 21:00 in Warsaw: every concert two hours late in
summer, one in winter, and invisible until someone reads the time back.

```bash
pnpm add date-fns date-fns-tz
```

`src/lib/server/time.ts`:

```ts
import 'server-only'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import { format } from 'date-fns'
import { TIMEZONE } from '@/lib/shared/locale'

/** "2026-08-14T19:00" typed as Warsaw wall-clock → the correct UTC instant. */
export function warsawLocalToUtc(value: string): Date {
  return fromZonedTime(value, TIMEZONE)
}

/** A stored instant → the "YYYY-MM-DDTHH:mm" a datetime-local input expects. */
export function utcToWarsawLocalInput(date: Date): string {
  return format(toZonedTime(date, TIMEZONE), "yyyy-MM-dd'T'HH:mm")
}
```

`tests/lib/server/time.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { utcToWarsawLocalInput, warsawLocalToUtc } from '@/lib/server/time'

describe('warsawLocalToUtc', () => {
  it('treats summer input as CEST (UTC+2)', () => {
    expect(warsawLocalToUtc('2026-08-14T19:00').toISOString()).toBe('2026-08-14T17:00:00.000Z')
  })

  it('treats winter input as CET (UTC+1)', () => {
    expect(warsawLocalToUtc('2026-01-14T19:00').toISOString()).toBe('2026-01-14T18:00:00.000Z')
  })
})

describe('round trip', () => {
  it('returns the same wall-clock time it was given', () => {
    for (const wall of ['2026-08-14T19:00', '2026-01-14T19:00', '2026-03-29T04:00']) {
      expect(utcToWarsawLocalInput(warsawLocalToUtc(wall))).toBe(wall)
    }
  })
})
```

Run: `pnpm test tests/lib/server/time.test.ts`
Expected: `3 passed`. If the first case yields `19:00:00.000Z`, the conversion
is being skipped — do not proceed, every concert time downstream depends on it.

- [ ] **Step 2: Write the server actions**

`src/app/(admin)/admin/events/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/server/auth'
import {
  CapacityBelowSoldError,
  createEvent,
  PriceChangeWhileHeldError,
  SlugTakenError,
  updateEvent,
} from '@/lib/server/events'
import { warsawLocalToUtc } from '@/lib/server/time'
import { toMinor } from '@/lib/shared/money'

export type EventFormState = { error?: string }

function readForm(formData: FormData) {
  return {
    slug: String(formData.get('slug') ?? ''),
    venueId: String(formData.get('venueId') ?? ''),
    // NOT new Date(...): the input carries no timezone — see Step 1.
    startsAt: warsawLocalToUtc(String(formData.get('startsAt') ?? '')),
    capacity: Number(formData.get('capacity')),
    status: String(formData.get('status') ?? 'DRAFT') as 'DRAFT',
    // Staff type "80.00"; the database stores 8000.
    pricePln: toMinor(Number(formData.get('pricePln'))),
    priceEur: toMinor(Number(formData.get('priceEur'))),
    maxPerOrder: Number(formData.get('maxPerOrder') ?? 10),
    translations: {
      pl: {
        title: String(formData.get('pl.title') ?? ''),
        description: String(formData.get('pl.description') ?? ''),
        performers: String(formData.get('pl.performers') ?? ''),
      },
      en: {
        title: String(formData.get('en.title') ?? ''),
        description: String(formData.get('en.description') ?? ''),
        performers: String(formData.get('en.performers') ?? ''),
      },
      de: {
        title: String(formData.get('de.title') ?? ''),
        description: String(formData.get('de.description') ?? ''),
        performers: String(formData.get('de.performers') ?? ''),
      },
    },
  }
}

function toMessage(e: unknown): string {
  if (
    e instanceof SlugTakenError ||
    e instanceof CapacityBelowSoldError ||
    e instanceof PriceChangeWhileHeldError
  ) {
    return e.message
  }
  console.error('[admin/events]', e)
  return 'Nie udało się zapisać koncertu. Sprawdź poprawność pól.'
}

export async function createEventAction(
  _prev: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  // Authorisation inside the action, not in middleware. Server Actions are
  // publicly callable HTTP endpoints.
  const admin = await requireAdmin()

  try {
    await createEvent(readForm(formData), admin.id)
  } catch (e) {
    return { error: toMessage(e) }
  }

  revalidatePath('/admin/events')
  redirect('/admin/events')
}

export async function updateEventAction(
  id: string,
  _prev: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const admin = await requireAdmin()

  try {
    await updateEvent(id, readForm(formData), admin.id)
  } catch (e) {
    return { error: toMessage(e) }
  }

  revalidatePath('/admin/events')
  redirect('/admin/events')
}
```

- [ ] **Step 3: Write the shared form component**

`src/app/(admin)/admin/events/EventForm.tsx`:

```tsx
'use client'

import { useActionState, useState } from 'react'
import { LOCALES, type Locale } from '@/lib/shared/locale'
import type { EventFormState } from './actions'

const LOCALE_LABEL: Record<Locale, string> = { pl: 'Polski', en: 'English', de: 'Deutsch' }

const field =
  'min-h-[48px] w-full rounded-[2px] border border-[var(--color-border-input)] px-3 text-base ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-[var(--color-accent)]'

export type EventFormValues = {
  slug: string
  venueId: string
  startsAtLocal: string
  capacity: number
  status: string
  pricePlnMajor: string
  priceEurMajor: string
  maxPerOrder: number
  translations: Record<Locale, { title: string; description: string; performers: string }>
}

export function EventForm({
  action,
  initial,
  venues,
  submitLabel,
}: {
  action: (prev: EventFormState, formData: FormData) => Promise<EventFormState>
  initial: EventFormValues
  venues: Array<{ id: string; name: string; city: string }>
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {} as EventFormState)
  const [tab, setTab] = useState<Locale>('pl')

  return (
    <form action={formAction} className="flex max-w-[800px] flex-col gap-6">
      <label className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Adres URL (slug)</span>
        <input name="slug" defaultValue={initial.slug} required className={field} />
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Miejsce</span>
        <select name="venueId" defaultValue={initial.venueId} required className={field}>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} — {v.city}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Data i godzina (czas polski)</span>
        <input
          name="startsAt"
          type="datetime-local"
          defaultValue={initial.startsAtLocal}
          required
          className={field}
        />
      </label>

      <div className="flex flex-col gap-4 sm:flex-row">
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-sm font-semibold">Pojemność</span>
          <input name="capacity" type="number" min={1} defaultValue={initial.capacity} required className={field} />
        </label>
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-sm font-semibold">Maks. biletów na zamówienie</span>
          <input name="maxPerOrder" type="number" min={1} defaultValue={initial.maxPerOrder} className={field} />
        </label>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-sm font-semibold">Cena PLN</span>
          <input name="pricePln" type="number" step="0.01" min="0" defaultValue={initial.pricePlnMajor} required className={field} />
        </label>
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-sm font-semibold">Cena EUR</span>
          <input name="priceEur" type="number" step="0.01" min="0" defaultValue={initial.priceEurMajor} required className={field} />
        </label>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        Obie ceny ustawiane są ręcznie — system nie przelicza kursu. Cena w PLN
        umożliwia BLIK, cena w EUR umożliwia Klarna.
      </p>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Status</span>
        <select name="status" defaultValue={initial.status} className={field}>
          <option value="DRAFT">Szkic (niewidoczny)</option>
          <option value="ON_SALE">W sprzedaży</option>
          <option value="CLOSED">Sprzedaż zamknięta</option>
          <option value="CANCELLED">Odwołany</option>
        </select>
      </label>

      <fieldset className="border border-[var(--color-border)] p-4">
        <legend className="px-2 text-sm font-semibold">Treść koncertu</legend>

        <div role="tablist" className="mb-4 flex gap-2">
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              role="tab"
              aria-selected={tab === l}
              onClick={() => setTab(l)}
              className={`min-h-[40px] rounded-[2px] border px-3 text-sm ${
                tab === l
                  ? 'border-[var(--color-accent)] font-semibold text-[var(--color-accent)]'
                  : 'border-[var(--color-border-strong)]'
              }`}
            >
              {LOCALE_LABEL[l]}
            </button>
          ))}
        </div>

        {/* All three panels stay mounted so every field is submitted,
            regardless of which tab is visible. */}
        {LOCALES.map((l) => (
          <div key={l} hidden={tab !== l} className="flex flex-col gap-4">
            <label className="flex flex-col gap-2">
              <span className="text-sm font-semibold">Tytuł</span>
              <input name={`${l}.title`} defaultValue={initial.translations[l].title} required className={field} />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-sm font-semibold">Wykonawcy</span>
              <input name={`${l}.performers`} defaultValue={initial.translations[l].performers} required className={field} />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-sm font-semibold">Opis</span>
              <textarea
                name={`${l}.description`}
                defaultValue={initial.translations[l].description}
                required
                rows={5}
                className={`${field} py-2`}
              />
            </label>
          </div>
        ))}
      </fieldset>

      {state.error && (
        <p role="alert" className="border border-[var(--color-accent)] p-3 text-sm text-[var(--color-accent)]">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="min-h-[48px] rounded-[2px] bg-[var(--color-accent)] px-6 font-semibold text-white disabled:opacity-60"
      >
        {pending ? 'Zapisywanie…' : submitLabel}
      </button>
    </form>
  )
}
```

The comment on the tab panels is load-bearing: rendering only the active locale would silently drop the other two languages on submit, and the loss would not be visible until a German buyer opened the page.

- [ ] **Step 4: Write the list page**

`src/app/(admin)/admin/events/page.tsx`:

Internal navigation uses `next/link`, not `<a>` — `@next/next/no-html-link-for-pages`
is an **error**, not a warning, and it fires for both the "Dodaj koncert" button
and the per-concert detail link.

```tsx
import Link from 'next/link'
import { requireAdmin } from '@/lib/server/auth'
import { db } from '@/lib/server/db'
import { formatMoney } from '@/lib/shared/money'
import { TIMEZONE } from '@/lib/shared/locale'

export default async function EventsPage() {
  await requireAdmin()

  const events = await db.event.findMany({
    orderBy: { startsAt: 'asc' },
    include: {
      venue: true,
      ticketTypes: true,
      translations: { where: { locale: 'pl' } },
    },
  })

  const when = new Intl.DateTimeFormat('pl-PL', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: TIMEZONE,
  })

  return (
    <main className="mx-auto max-w-[1200px] px-8 py-16">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-3xl font-bold">Koncerty</h1>
        <Link
          href="/admin/events/new"
          className="min-h-[48px] rounded-[2px] bg-accent px-6 py-3 font-semibold text-white"
        >
          Dodaj koncert
        </Link>
      </div>

      <table className="mt-8 w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-[var(--color-border)]">
            <th className="py-3">Tytuł</th>
            <th>Data</th>
            <th>Miejsce</th>
            <th>Pojemność</th>
            <th>Sprzedane</th>
            <th>Cena</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const type = e.ticketTypes[0]
            const sold = e.ticketTypes.reduce((n, t) => n + t.soldCount, 0)
            return (
              <tr key={e.id} className="border-b border-[var(--color-border)]">
                <td className="py-3">
                  <Link href={`/admin/events/${e.id}`} className="text-accent underline">
                    {e.translations[0]?.title ?? e.slug}
                  </Link>
                </td>
                <td>{when.format(e.startsAt)}</td>
                <td className="text-[var(--color-text-secondary)]">{e.venue.name}</td>
                <td className="price">{e.capacity}</td>
                <td className="price">{sold}</td>
                <td className="price">
                  {type ? `${formatMoney(type.pricePln, 'PLN', 'pl')} / ${formatMoney(type.priceEur, 'EUR', 'pl')}` : '—'}
                </td>
                <td>{e.status}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {events.length === 0 && (
        <p className="mt-8 text-[var(--color-text-secondary)]">Brak koncertów. Dodaj pierwszy.</p>
      )}
    </main>
  )
}
```

- [ ] **Step 5: Write the create page**

`src/app/(admin)/admin/events/new/page.tsx`:

```tsx
import { requireAdmin } from '@/lib/server/auth'
import { db } from '@/lib/server/db'
import { EventForm } from '../EventForm'
import { createEventAction } from '../actions'

export default async function NewEventPage() {
  await requireAdmin()
  const venues = await db.venue.findMany({ orderBy: { name: 'asc' } })

  return (
    <main className="mx-auto max-w-[800px] px-8 py-16">
      <h1 className="font-serif text-3xl font-bold">Nowy koncert</h1>
      <div className="mt-8">
        <EventForm
          action={createEventAction}
          venues={venues}
          submitLabel="Utwórz koncert"
          initial={{
            slug: '',
            venueId: venues[0]?.id ?? '',
            startsAtLocal: '',
            capacity: venues[0]?.defaultCapacity ?? 300,
            status: 'DRAFT',
            pricePlnMajor: '',
            priceEurMajor: '',
            maxPerOrder: 10,
            translations: {
              pl: { title: '', description: '', performers: '' },
              en: { title: '', description: '', performers: '' },
              de: { title: '', description: '', performers: '' },
            },
          }}
        />
      </div>
    </main>
  )
}
```

- [ ] **Step 6: Write the edit page**

`src/app/(admin)/admin/events/[id]/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/server/auth'
import { db } from '@/lib/server/db'
import { toMajor } from '@/lib/shared/money'
import { utcToWarsawLocalInput } from '@/lib/server/time'
import { LOCALES, type Locale } from '@/lib/shared/locale'
import { EventForm } from '../EventForm'
import { updateEventAction } from '../actions'

export default async function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin()
  const { id } = await params

  const [event, venues] = await Promise.all([
    db.event.findUnique({
      where: { id },
      include: { translations: true, ticketTypes: true },
    }),
    db.venue.findMany({ orderBy: { name: 'asc' } }),
  ])

  if (!event) notFound()

  const type = event.ticketTypes[0]

  const translations = Object.fromEntries(
    LOCALES.map((l) => {
      const t = event.translations.find((x) => x.locale === l)
      return [l, { title: t?.title ?? '', description: t?.description ?? '', performers: t?.performers ?? '' }]
    }),
  ) as Record<Locale, { title: string; description: string; performers: string }>

  const boundAction = updateEventAction.bind(null, event.id)

  return (
    <main className="mx-auto max-w-[800px] px-8 py-16">
      <h1 className="font-serif text-3xl font-bold">Edycja koncertu</h1>
      <div className="mt-8">
        <EventForm
          action={boundAction}
          venues={venues}
          submitLabel="Zapisz zmiany"
          initial={{
            slug: event.slug,
            venueId: event.venueId,
            startsAtLocal: utcToWarsawLocalInput(event.startsAt),
            capacity: event.capacity,
            status: event.status,
            pricePlnMajor: type ? String(toMajor(type.pricePln)) : '',
            priceEurMajor: type ? String(toMajor(type.priceEur)) : '',
            maxPerOrder: type?.maxPerOrder ?? 10,
            translations,
          }}
        />
      </div>
    </main>
  )
}
```

Both directions of the conversion go through `src/lib/server/time.ts`, so the
value shown in the form is always the same wall-clock time that was typed into
it.

- [ ] **Step 7: Verify the list renders the seeded concerts**

Start one dev server for the whole verification block and keep its PID — the
earlier tasks each backgrounded their own, and five servers competing for port
3000 is its own debugging session:

```bash
pnpm dev & DEV_PID=$!
sleep 5
```

Log in as `admin@krzyzowa-music.eu` and open `/admin/events`.
Expected: three concerts, dates shown in Polish time, prices as `80,00 zł / 19,00 €`.

- [ ] **Step 8: Verify creating a concert end to end**

Create a concert with slug `test-koncert`, capacity 100, prices 50 PLN / 12 EUR, and all three languages filled.
Expected: redirect to the list, the new concert visible.

Confirm the database agrees:

```bash
docker compose exec postgres psql -U km -d km_dev -c \
  "SELECT t.locale, t.title FROM \"EventTranslation\" t JOIN \"Event\" e ON e.id = t.\"eventId\" WHERE e.slug = 'test-koncert';"
```

Expected: three rows. **If only one row appears, the tab panels are being unmounted** — re-read Task 15 step 2.

Then confirm the stored instant is the right one. **`AT TIME ZONE` on a
`timestamp without time zone` interprets rather than converts**, so the obvious
single-cast query runs the conversion backwards and makes a correct 19:00 look
like 15:00. Prisma maps `DateTime` to `timestamp(3)` without a zone, so the
double cast is required:

```bash
docker compose exec -T postgres psql -U km -d km_dev -t -c \
  "SELECT slug, \"startsAt\" AS stored_utc,
          (\"startsAt\" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' AS warsaw
     FROM \"Event\" ORDER BY \"startsAt\";"
```

Expected for a concert entered as 19:00 in August: `stored_utc` = `17:00:00`,
`warsaw` = `19:00:00`. If both columns read the same, the double cast was
dropped.

Also confirm the price stored as minor units:

```bash
docker compose exec postgres psql -U km -d km_dev -c \
  "SELECT \"pricePln\", \"priceEur\" FROM \"TicketType\" tt JOIN \"Event\" e ON e.id = tt.\"eventId\" WHERE e.slug = 'test-koncert';"
```

Expected: `5000 | 1200`. Anything with a decimal point means `toMinor` was not applied.

- [ ] **Step 9: Verify the duplicate-slug error**

Create another concert with slug `test-koncert`.
Expected: the form reports "Koncert o adresie "test-koncert" już istnieje." and stays on the page — not a 500.

- [ ] **Step 10: Verify the capacity guard through the UI**

```bash
docker compose exec postgres psql -U km -d km_dev -c \
  "UPDATE \"TicketType\" SET \"soldCount\" = 60 WHERE \"eventId\" = (SELECT id FROM \"Event\" WHERE slug = 'test-koncert');"
```

Edit `test-koncert` and set capacity to 50.
Expected: refused with the message naming 60 sold. Set it to 60 — expected: accepted.

- [ ] **Step 11: Verify a SCANNER cannot reach these pages**

Log out, log in as `skaner@krzyzowa-music.eu`, and open `/admin/events`.
Expected: redirected to `/admin/scan`.

A guard on the page but not on the action is the exact shape of a real
vulnerability, so the action must be tested directly. A raw `curl` POST cannot
do this: Next.js dispatches server actions through an internal RPC that carries
a `Next-Action` header, so a plain form POST never reaches `createEventAction`
at all and would "pass" whether or not the guard existed.

`tests/app/admin/events-action.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cookieStore = new Map<string, string>()

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieStore.has(n) ? { value: cookieStore.get(n) } : undefined),
    set: (n: string, v: string) => void cookieStore.set(n, v),
    delete: () => void 0,
  }),
  headers: async () => ({ get: () => '127.0.0.1' }),
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`)
  },
}))

vi.mock('next/cache', () => ({ revalidatePath: () => void 0 }))

import { db } from '@/lib/server/db'
import { startSession } from '@/lib/server/auth'
import { createEventAction } from '@/app/(admin)/admin/events/actions'

function form(slug: string, venueId: string): FormData {
  const fd = new FormData()
  fd.set('slug', slug)
  fd.set('venueId', venueId)
  fd.set('startsAt', '2026-08-14T19:00')
  fd.set('capacity', '100')
  fd.set('status', 'DRAFT')
  fd.set('pricePln', '50')
  fd.set('priceEur', '12')
  fd.set('maxPerOrder', '10')
  for (const l of ['pl', 'en', 'de']) {
    fd.set(`${l}.title`, 'T')
    fd.set(`${l}.description`, 'D')
    fd.set(`${l}.performers`, 'P')
  }
  return fd
}

let venueId: string

beforeEach(async () => {
  cookieStore.clear()
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "TicketType", "EventTranslation", "Event",
                   "Venue", "AdminSession", "AdminUser" RESTART IDENTITY CASCADE
  `)
  const venue = await db.venue.create({
    data: { name: 'V', address: 'A', city: 'C', defaultCapacity: 900 },
  })
  venueId = venue.id
})

describe('createEventAction authorisation', () => {
  it('refuses an anonymous caller', async () => {
    await expect(createEventAction({}, form('anon', venueId))).rejects.toThrow(
      'REDIRECT:/admin/login',
    )
    expect(await db.event.count()).toBe(0)
  })

  it('refuses a SCANNER even with a valid session', async () => {
    const scanner = await db.adminUser.create({
      data: { email: 's@example.com', name: 'S', role: 'SCANNER', passwordHash: 'x' },
    })
    await startSession(scanner.id)

    await expect(createEventAction({}, form('scanner', venueId))).rejects.toThrow(
      'REDIRECT:/admin/scan',
    )
    expect(await db.event.count()).toBe(0)
  })

  it('allows an ADMIN', async () => {
    const admin = await db.adminUser.create({
      data: { email: 'a@example.com', name: 'A', role: 'ADMIN', passwordHash: 'x' },
    })
    await startSession(admin.id)

    // A successful action redirects, which the mock turns into a throw.
    await expect(createEventAction({}, form('allowed', venueId))).rejects.toThrow(
      'REDIRECT:/admin/events',
    )
    expect(await db.event.count()).toBe(1)
  })

  it('stores the typed wall-clock time as Warsaw local, not UTC', async () => {
    const admin = await db.adminUser.create({
      data: { email: 'b@example.com', name: 'B', role: 'ADMIN', passwordHash: 'x' },
    })
    await startSession(admin.id)

    await expect(createEventAction({}, form('tz', venueId))).rejects.toThrow('REDIRECT:')

    const event = await db.event.findUniqueOrThrow({ where: { slug: 'tz' } })
    expect(event.startsAt.toISOString()).toBe('2026-08-14T17:00:00.000Z')
  })

  it('stores prices as integer minor units', async () => {
    const admin = await db.adminUser.create({
      data: { email: 'c@example.com', name: 'C', role: 'ADMIN', passwordHash: 'x' },
    })
    await startSession(admin.id)

    await expect(createEventAction({}, form('money', venueId))).rejects.toThrow('REDIRECT:')

    const type = await db.ticketType.findFirstOrThrow({
      where: { event: { slug: 'money' } },
    })
    expect(type.pricePln).toBe(5000)
    expect(type.priceEur).toBe(1200)
  })
})
```

Run: `pnpm test tests/app/admin/events-action.test.ts`
Expected: `5 passed`

- [ ] **Step 12: Clean up the test data and stop the dev server**

```bash
docker compose exec postgres psql -U km -d km_dev -c \
  "DELETE FROM \"Event\" WHERE slug = 'test-koncert';"
kill $DEV_PID
```

- [ ] **Step 13: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all four pass.

- [ ] **Step 14: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: add admin event list, creation and editing with three-language content"
```

---

## Task 16: Deploy

**Superseded by [`02-deployment.md`](02-deployment.md).**

This task was written before Prisma 7 removed `directUrl`, and it was too thin
for work that involves three external accounts, DNS propagation and a backup
you have to verify by actually restoring it. Deployment is now its own plan.

Nothing else in Plan 01 depends on it: the application runs locally in full
without it.

---

## Definition of done for Plan 01

Every box below must be checked before Plan 02 begins.

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass locally
- [ ] CI is green on the default branch
- [ ] `pnpm build` succeeds with two root layouts and no nested-`<html>` error
- [ ] `/pl`, `/en` and `/de` all render with the correct `lang` attribute
- [ ] The locale switcher moves between languages without losing the path
- [ ] A concert created at 19:00 stores `17:00:00Z` in summer — not `19:00:00Z`
- [ ] Fonts are served from our own origin, with Polish diacritics rendering correctly
- [ ] An ADMIN can log in, create a concert in three languages, and edit it
- [ ] A SCANNER is redirected away from every admin page **and** cannot invoke the event server action (proven by `tests/app/admin/events-action.test.ts`, not by curl)
- [ ] Capacity cannot be lowered below sold + held
- [ ] Prices are stored as integer minor units
- [ ] Account lockout triggers after five failed logins, and lapses cleanly
- [ ] Per-IP login rate limiting refuses the eleventh attempt in a minute
- [ ] The session cookie is `HttpOnly` and `Secure` in production
- [ ] No secret appears in the client bundle

---

## Notes for the specification

Two schema additions were made in this plan that are not yet in [`02-data-model.md`](../02-data-model.md). Back-port them:

1. **`AdminSession`** — database-backed sessions, chosen over JWTs so a session can be revoked the moment a door volunteer's phone goes missing.
2. **`AdminUser.failedLoginCount` and `AdminUser.lockedUntil`** — per-account lockout. Note this is *not* the same as rate limiting: lockout alone lets an attacker spread attempts across addresses freely, and worse, lets them lock the festival out of `admin@krzyzowa-music.eu` on the evening sales open. Plan 01 therefore also ships a per-IP limiter; the distributed version remains in phase 8.
3. **`Locale` and `Currency` are Prisma enums**, not strings, on `EventTranslation`, `Order`, `OrderItem` and `PromoCode`.
4. **Two root layouts via route groups** — `(shop)` and `(admin)` — because the shop needs `<html lang={locale}>` and the admin needs `<html lang="pl">`. Plan 04's `/t/[code]` page needs a third, `(ticket)`.
5. **`updateEvent` refuses price changes while `heldCount > 0`.** Plan 03 should confirm this interacts correctly with the atomic hold path.

Also worth deciding before Plan 03, raised during review:

- **Hold duration by venue size.** 30 minutes across the board means 300 people can be mid-checkout on a 300-seat concert while everyone else sees "sold out". Consider a shorter window for the smaller venues.
- **`Order.reference` has no format constraint** — only `@unique`. Add a regex check when Plan 03 writes the generator, and never accept a reference from a form.
- **Ticket codes should use Crockford base32** (no O/0/I/L), since the scanner also offers manual entry.
- **`experimental.serverActions.allowedOrigins`** must be set once the production domain is known.

## What Plan 02 picks up

The public programme listing, concert detail pages, the currency and locale switchers, availability display, and the buyer details form — everything up to but not including the creation of an order. Inventory holds are Plan 03.
