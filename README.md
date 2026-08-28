# Krzyżowa Music — Ticketing

Ticket sales for the [Krzyżowa Music](https://krzyzowa-music.eu) festival. A
single Next.js application that sells general-admission tickets to roughly ten
concerts each August, in three languages (PL / EN / DE) and two currencies
(PLN / EUR), replacing the Wix ticketing the festival used previously.

It is deployed at `tickets-km.vercel.app` and will move to
`bilety.krzyzowa-music.eu`, linked from the main Wix marketing site.

---

## What works today

The project is being built in numbered plans. Two are finished, and it is worth
being precise about what that does and does not mean.

**Working:**

- Admin login with argon2id password hashing, account lockout and rate limiting
- Admin dashboard, plus full create / edit / list for concerts
- Three-language content per concert (title, description, performers)
- Two explicit prices per concert, PLN and EUR
- Capacity that cannot be lowered below tickets already sold
- Audit logging of every administrative change
- Localised public routing — `/pl`, `/en`, `/de` — with a locale switcher
- Deployed to Vercel (`fra1`) against Neon Postgres (`eu-central-1`)

**Not built yet:**

- **The public shop.** `/[locale]` currently renders a heading and nothing else.
  Browsing concerts and the checkout form are Plan 03. There is no cart —
  one concert per order, decided 27 Aug 2026.
- **Payments.** No Stripe integration. Plan 05.
- **Email and PDF tickets.** Plan 05.
- **The door scanner.** Plan 07.
- **Invitations, promo codes, refunds.** Plan 06.

So: the back-office is real and usable, and the storefront is a placeholder.

Current state, in detail: [`plan/STATUS.md`](plan/STATUS.md).

---

## Getting started

You need **Node 24**, **pnpm 10**, and **Docker** for Postgres.

```bash
pnpm install                       # also generates the Prisma client
docker compose up -d               # Postgres 16 on :5432, creates km_dev + km_test
cp .env.example .env
```

Then edit `.env` and set a real `SESSION_SECRET` — the placeholder will fail
validation at startup:

```bash
openssl rand -base64 32
```

Create the schema and some sample data:

```bash
pnpm db:migrate                    # applies migrations to km_dev
pnpm db:seed                       # 2 venues, 10 concerts, 2 accounts; upserts, safe to re-run
pnpm dev
```

Open <http://localhost:3000/admin/login> and sign in:

```
admin@krzyzowa-music.eu / DevPassword123!     (ADMIN — full access)
skaner@krzyzowa-music.eu / DevPassword123!    (SCANNER — door staff)
```

> **The seed password is public, and the seed must never run against
> production.** Production accounts are created with `pnpm admin:create`, which
> generates a random password and prints it once.

From there you can create a concert with Polish, English and German content and
watch the capacity guard refuse to drop below tickets sold.

`http://localhost:3000/` redirects to `/pl`. The other locales are `/en` and
`/de`.

---

## How it works

### Request paths

There are two distinct halves of the app, separated by route groups:

```
src/app/(shop)/[locale]/…    public, localised, PL/EN/DE
src/app/(admin)/admin/…      back-office, Polish only, authenticated
```

Route groups vanish from URLs but **remain in import paths**, so the admin
dashboard is `@/app/(admin)/admin/page.tsx` while its URL is `/admin`. This
catches people out.

`src/proxy.ts` handles locale negotiation and redirects `/` to `/pl`. In Next 16
this file is called `proxy.ts`; it was `middleware.ts` in earlier versions.

### Authentication

Login is a server action. On success, `startSession` issues an opaque random
token, stores only its SHA-256 hash in `AdminSession`, and sets it as the
`km_session` cookie — `HttpOnly`, `Secure` in production, `SameSite=Lax`, and
scoped to `Path=/admin` so it never rides along on public shop requests or
static assets.

Sessions last 12 hours for an ADMIN and 8 for a SCANNER, and slide forward when
used with under 2 hours left — otherwise an admin gets logged out at the busiest
moment of the day regardless of activity.

Failed logins are counted; five within the window locks the account for 15
minutes, and login is rate-limited to 10 attempts per minute per IP. An unknown
email is still verified against a dummy hash, so the response time does not
reveal which addresses have accounts.

Two guards express the whole authorisation model:

- `requireAdmin()` — ADMIN only, used by everything except the scanner
- `requireStaff()` — any active account, used by the scanner

### The server boundary

Every module under `src/lib/server/` begins with `import 'server-only'`, so the
build **fails** if server code is ever pulled into a client bundle. That makes
the client/server split a build error rather than a matter of discipline.

Two consequences worth knowing:

- **`server-only` throws under Vitest and `tsx`.** Tests alias it to a stub.
  CLI scripts must not import from `src/lib/server/` at all — anything shared
  between a script and the app lives in `src/lib/shared/` instead. That is why
  argon2 parameters sit in `src/lib/shared/password-options.ts`.
- Only `NEXT_PUBLIC_*` variables reach the browser. `NEXT_PUBLIC_SITE_URL` is
  the only one, and it is baked in at build time — changing it needs a redeploy,
  not just an env edit.

### Money

Prices are stored as **integer minor units** (grosze, cents) and never as
floats. `src/lib/shared/money.ts` converts and formats.

Each concert carries two explicit prices — one PLN, one EUR — rather than a
single price converted at runtime. Live FX would produce prices like 11.37 EUR;
the festival wants 12. Currency defaults from locale (PL → PLN, DE/EN → EUR) and
is frozen onto an order when it is created.

This matters more than it looks: **BLIK is PLN-only** and **Klarna in Germany
requires EUR**, so currency and available payment methods are coupled.

### Time

Everything is stored in UTC. Admins enter Warsaw local time, and
`src/lib/server/time.ts` converts both ways.

If you check stored times in `psql`, you need a double cast:

```sql
("startsAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw'
```

A single cast runs the conversion backwards and makes correct data look broken.

### Data model

Twelve application tables (thirteen counting `_prisma_migrations`). The ones
that carry the design:

| Table | Why it exists |
|---|---|
| `Event` + `EventTranslation` | One concert, three locales of content |
| `TicketType` | Exactly one row per event today, so a reduced price can be added later without a migration |
| `Order` + `OrderItem` | Guest checkout — buyer details live on the order; there is no user table |
| `Ticket` | One per admission, with an unguessable code for the QR |
| `PromoCode` | Discounts, including 100% for free tickets |
| `AuditLog` | Who changed what, when |
| `StripeWebhookEvent` | Webhook idempotency, so a replayed event cannot double-fulfil |

Full reasoning: [`plan/02-data-model.md`](plan/02-data-model.md).

---

## Layout

```
src/
  app/(shop)/[locale]/     public storefront (placeholder for now)
  app/(admin)/admin/       back-office — login, dashboard, events
  lib/server/              server-only: db, auth, sessions, events, audit, env
  lib/shared/              safe for both app and CLI scripts: money, schemas
  i18n/  messages/         next-intl config and pl/en/de catalogues
  generated/prisma/        Prisma client — git-ignored build output
  proxy.ts                 locale routing (was middleware.ts pre-Next 16)
prisma/                    schema, migrations, seed
scripts/                   operational CLI — admin creation, password reset
tests/                     Vitest, mirrors src/
plan/                      design documents and executable plans
```

---

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server on :3000 |
| `pnpm build` | Production build (also typechecks) |
| `pnpm typecheck` | `next typegen` then `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest against `km_test` |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm db:migrate` | Create and apply a migration in dev |
| `pnpm db:seed` | Sample data — **never against production** |
| `pnpm db:reset` | Drop, recreate, re-migrate, re-seed |
| `pnpm admin:create <email> <name> [ADMIN\|SCANNER]` | Create an account with a generated password |
| `pnpm admin:reset-password <email>` | New password, clears any lockout, revokes that account's sessions |

---

## Testing

114 tests across 19 files, run sequentially against a real Postgres database
(`km_test`, created by the Docker init script) rather than against mocks.

```bash
pnpm test
```

Two things to know:

- **Test files share one database and run in order.** A file that asserts exact
  row counts must truncate first — see `tests/prisma/seed.test.ts` for the
  pattern. When you add such a test, **run the suite twice**; ordering bugs only
  show up on the second pass.
- **Always verify from a clean tree** before believing a green result:

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Next 16 generates global route types into `.next/`, which is git-ignored. A warm
tree hides exactly the failures CI will hit.

CI runs `typecheck`, `lint` and `test` on Node 24 for every push.

---

## The stack, and where it surprises you

| | Version | |
|---|---|---|
| Next.js | 16.3.2 | App Router, Turbopack, `proxy.ts` |
| React | 19.2.8 | |
| Prisma | 7.9.1 | Driver adapter required |
| PostgreSQL | 16 | Neon in production |
| Tailwind | 4.3.3 | |
| Vitest | 4.1.11 | |
| Zod | 4.4.3 | |
| Node | 24.14.1 | |
| pnpm | 10.33.2 | |

Several of these are newer than most documentation and training data assume.
The differences that actually bite:

- **Prisma 7 requires a driver adapter.** `new PrismaClient()` with no options
  throws. `PrismaPg` is configured once, in `src/lib/server/db.ts`.
- **The Prisma client imports from `@/generated/prisma/client`**, not
  `@prisma/client`. It is git-ignored build output, regenerated by `postinstall`.
- **`directUrl` was removed from the Prisma schema.** The split lives in
  `prisma.config.ts` (migrations use `DIRECT_URL`) and `db.ts` (the app uses the
  pooled `DATABASE_URL`).
- **Tailwind 4 has no JS config.** Design tokens live in an `@theme` block in
  `src/app/globals.css`.
- **`next lint` was removed.** The lint script is plain `eslint`.
- **Zod 4 deprecated `z.string().url()`** in favour of `z.url()`.

`AGENTS.md` at the repo root is written by `next dev`, not by us. Committing it
alongside your work keeps the tree clean.

---

## Deployment

Vercel serves the app from `fra1`; Neon holds the database in `eu-central-1`.
Both are in the EU deliberately — the festival is a Polish entity handling buyer
data.

The application connects through Neon's **pooled** endpoint via the driver
adapter; the Prisma CLI runs migrations against the **direct** endpoint, because
a pooler cannot execute them. `pnpm vercel-build` runs
`prisma migrate deploy && prisma generate && next build`, so every deploy
migrates before it builds.

Four environment variables, set separately for Production and Preview:

| | |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string |
| `DIRECT_URL` | Neon **direct** connection string |
| `SESSION_SECRET` | 32+ chars, different per environment |
| `NEXT_PUBLIC_SITE_URL` | Public URL — baked in at build time |

Preview deployments point at Neon's `development` branch, so a migration on a
feature branch cannot touch live data.

Full procedure, including DNS and backups:
[`plan/steps/02-deployment.md`](plan/steps/02-deployment.md).

---

## Where to read next

The `plan/` directory is the real documentation, and it is unusually complete.

| Start here | |
|---|---|
| [`plan/STATUS.md`](plan/STATUS.md) | Where the project stands right now |
| [`HANDOFF.md`](HANDOFF.md) | Accounts, credentials, operations, and what breaks if nobody knows |
| [`CLAUDE.md`](CLAUDE.md) | Operating rules and the trap list, loaded automatically by Claude Code |
| [`plan/00-decisions.md`](plan/00-decisions.md) | Every settled decision and why — read before proposing changes |
| [`plan/README.md`](plan/README.md) | Index of all design documents and plans |

Design documents cover the [architecture](plan/01-architecture.md),
[data model](plan/02-data-model.md),
[purchase flow](plan/03-purchase-flow.md),
[invitations and refunds](plan/04-invitations-promo-refunds.md),
[admin and scanner](plan/05-admin-and-scanner.md),
[i18n, email and PDF](plan/06-i18n-email-pdf.md),
[security and testing](plan/07-security-and-testing.md), and the
[design system](plan/10-design-system.md).

[`plan/steps/`](plan/steps/) holds the executable plans. Each step has a command
and an expected result, so progress is verified rather than assumed. When a step
turns out to be wrong, the plan gets corrected along with the code — that has
happened about a dozen times, and the plans are only useful because they stay
true.

## Conventions

- **Commits are made by the repository owner.** Automated tooling stops at the
  commit boundary.
- Migrations should be **additive** — add columns rather than dropping them in
  the same release that stops using them. A Vercel rollback restores the old
  build but does not undo a migration.
- Secrets never enter the repository, a transcript, or a commit message. The
  `.env*` files are all git-ignored.
