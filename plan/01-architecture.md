# 01 — Architecture

One Next.js application (App Router, TypeScript), Prisma + PostgreSQL, deployed
to Vercel `fra1` with the database on Neon Frankfurt.

## Repository layout

The application lives at the **repository root**. The empty `KMFront/` and
`KMBack/` directories are removed — they contradict the monolith decision.

```
KM/
├─ src/
│  ├─ app/
│  │  ├─ [locale]/                    # pl | en | de
│  │  │  ├─ page.tsx                  # program — list of concerts
│  │  │  ├─ koncert/[slug]/page.tsx   # one concert + buy box
│  │  │  ├─ checkout/page.tsx         # Stripe Payment Element
│  │  │  ├─ order/[reference]/page.tsx# order status / confirmation
│  │  │  └─ regulamin/, prywatnosc/   # terms + privacy (legally required in PL)
│  │  ├─ t/[code]/page.tsx            # web ticket (the "link" half of delivery)
│  │  ├─ admin/                       # auth-gated, Polish only, own layout
│  │  │  ├─ login/
│  │  │  ├─ events/                   # CRUD + translations + prices
│  │  │  ├─ orders/                   # search, view, refund, resend
│  │  │  ├─ invitations/              # issue free tickets
│  │  │  ├─ promo-codes/
│  │  │  ├─ scan/                     # mobile QR check-in
│  │  │  └─ page.tsx                  # dashboard
│  │  └─ api/
│  │     ├─ checkout/route.ts
│  │     ├─ webhooks/stripe/route.ts  # nodejs runtime, raw body
│  │     ├─ cron/release-holds/route.ts
│  │     ├─ cron/retry-emails/route.ts
│  │     └─ admin/scan/route.ts
│  ├─ lib/
│  │  ├─ server/                      # EVERY file begins: import 'server-only'
│  │  │  ├─ db.ts                     # Prisma client singleton
│  │  │  ├─ env.ts                    # zod-validated environment
│  │  │  ├─ stripe.ts
│  │  │  ├─ inventory.ts              # capacity holds — the concurrency core
│  │  │  ├─ orders.ts                 # order creation + fulfilment
│  │  │  ├─ refunds.ts
│  │  │  ├─ promo.ts
│  │  │  ├─ tickets.ts                # code generation, revocation, scanning
│  │  │  ├─ pdf.ts                    # pdf-lib ticket rendering
│  │  │  ├─ qr.ts
│  │  │  ├─ mail.ts                   # Resend
│  │  │  ├─ auth.ts                   # admin sessions + requireAdmin/requireStaff
│  │  │  ├─ ratelimit.ts
│  │  │  └─ audit.ts
│  │  └─ shared/                      # zod schemas + types safe on both sides
│  │     ├─ money.ts                  # minor-unit formatting
│  │     └─ schemas.ts
│  ├─ components/
│  ├─ emails/                         # react-email templates × 3 locales
│  └─ messages/                       # pl.json / en.json / de.json
├─ prisma.config.ts               # datasource URL for the CLI (Prisma 7)
├─ src/generated/prisma/**        # generated client — git-ignored build output
├─ prisma/
│  ├─ schema.prisma
│  ├─ migrations/
│  └─ seed.ts
├─ e2e/                               # Playwright
├─ Dockerfile
├─ docker-compose.yml                 # local Postgres + app
├─ vercel.json                        # cron schedules
└─ .env.example
```

## The server/client boundary

Three rules, all mechanically enforced:

1. **`import 'server-only'`** is the first line of every file under
   `src/lib/server/`. If such a module is ever reachable from a client
   component, the build fails. This is the whole reason the monolith is safe.
2. **Nothing under `src/lib/server/` is imported from a `"use client"` file.**
   Shared types and zod schemas go in `src/lib/shared/`, which contains no
   secrets and no database access.
3. **Only `NEXT_PUBLIC_*` variables are exposed.** In practice that is the
   Stripe *publishable* key and the site URL — nothing else.

An ESLint rule (`no-restricted-imports`) blocks `lib/server/**` imports from
client component paths, so violations surface in the editor rather than at
build time.

## Data access and connection pooling

Neon sits behind a connection pooler, and serverless functions open many
short-lived connections. Prisma therefore needs two URLs:

Prisma 7 removed `directUrl` from the schema and moved the datasource URL into
`prisma.config.ts`, so the split now lives in two places:

```ts
// prisma.config.ts — used by the CLI only (migrate, introspect)
datasource: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL }
```

```ts
// src/lib/server/db.ts — used by the application
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })  // pooled
export const db = new PrismaClient({ adapter })
```

Prisma 7 also **requires a driver adapter** — the bundled query engine is gone,
and `new PrismaClient()` with no options throws. `PrismaPg` speaks plain TCP,
which serves both the local Docker container and Neon's pooled endpoint, so
local and production share one code path.

Getting this wrong shows up as connection exhaustion under load, i.e. precisely
when tickets go on sale. It is set up in phase 0 and load-tested in phase 8.

The client is generated as **TypeScript** into `src/generated/prisma` and
imported from `@/generated/prisma/client`, never from `@prisma/client`. It is
git-ignored build output, regenerated by a `postinstall` hook.

## Scheduled work

Two Vercel Cron jobs, both protected by a `CRON_SECRET` bearer token:

| Schedule | Endpoint | Purpose |
|---|---|---|
| every 5 min | `/api/cron/release-holds` | Expire abandoned checkouts and return capacity to sale |
| every 15 min | `/api/cron/retry-emails` | Re-send ticket emails for paid orders where delivery failed |

Both are idempotent and safe to run concurrently with themselves.

## Rendering strategy

- **Program and concert pages**: server components, dynamically rendered with a
  short cache. Availability changes minute-to-minute during a sale, so aggressive
  static caching would show "available" on a sold-out concert.
- **Checkout**: client component (Stripe Payment Element requires the browser).
- **Admin**: server components with server actions; every action authorises
  independently — see [07](07-security-and-testing.md).
- **Scanner**: client component (camera access), talking to a single API route.

## What is deliberately not here

No message queue, no Redis, no caching layer, no microservices. At ~10 concerts
and a few thousand tickets a year, Postgres and the Vercel function runtime are
comfortably sufficient, and every additional moving part is another thing that
can be broken at 20:00 on the evening sales open.
