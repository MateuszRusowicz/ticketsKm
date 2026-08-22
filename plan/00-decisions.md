# Settled decisions

Each row records what was decided and why, so nobody re-litigates it in month two.

## Product scope

| Decision | Choice | Reasoning |
|---|---|---|
| Seating | **General admission, no seats** | No seat-map UI, no per-seat locking. Capacity is a single number per concert. |
| Catalogue | **Full program — many concerts** | ~10 concerts, each with its own date, venue, capacity and price. |
| Ticket types | **One price per concert** | Modelled as a `TicketType` table with exactly one row per event, so a reduced price can be added later without a migration. |
| Buyer accounts | **Guest checkout only** | Sales happen once a year. Accounts would add registration, login, password reset, session security and a GDPR liability for zero benefit. |
| Multi-concert cart | **Open question** — see [09](09-open-questions.md) | The schema supports it; the UI cost is real. |
| Free tickets | **Staff invitations + 100% promo codes** | Two distinct flows, both bypassing Stripe. |
| Refunds | **In-app, full and partial** | Staff must not have to use the Stripe dashboard for routine work. |
| Invoices | **Invoice on request — details captured only** | The app stores company name / NIP / address and exports them. It does not generate faktury; that stays with accounting. |
| Check-in | **Browser-based QR scanner on staff phones** | No app install, no dedicated hardware, replaces the current Wix scanner with something we control. |
| Event admin | **Full CRUD in the app** | Programs and times shift. Every change must not become a developer task. |

## Technical

| Decision | Choice | Reasoning |
|---|---|---|
| Architecture | **Next.js monolith** (front + back in one app) | See "On the monolith" below. |
| Language/runtime | TypeScript, Next.js App Router, Node runtime for API routes | |
| Database | **PostgreSQL via Prisma**, hosted on **Neon (Frankfurt)** | Neon's cheap tier suspends compute when idle but keeps the data — exactly right for a 9-month break. Supabase's free tier *pauses projects*, which is the wrong behaviour here. |
| Hosting | **Vercel Pro, `fra1`** | Seasonal load makes a VPS a poor fit: paid and patched 12 months to be used for 2, and left stale over the break. Cost delta vs. a Hetzner box is ~€180/yr — negligible against ticket revenue, and it removes ops risk on the one evening that matters. **Vercel's Hobby tier forbids commercial use**, so Pro is required. |
| Portability | Docker + docker-compose committed | Used for local dev, and keeps a VPS migration open without a rewrite. Implies **no headless Chrome** — PDFs are generated with a pure-JS library. |
| Payments | **Stripe Payment Element** with automatic payment methods | Methods are enabled in the Stripe dashboard, not hardcoded, so adding PayPal later needs no deploy. Card data never touches our server (PCI SAQ-A). |
| Currencies | **PLN and EUR, two explicit prices per concert** | Never live FX conversion — prices must be stable and roundable (49 PLN / 12 EUR, not 11.37 EUR). Currency is locked into the order at creation. |
| Languages | **PL / EN / DE** via `next-intl`, locale in the URL path | Lets the Wix site link straight into the right language, and is good for SEO. |
| Admin language | **Polish only, untranslated** | Staff are Polish. Translating the back-office triples i18n work for no benefit. |
| Email | **Resend** + `react-email` templates | Simplest integration for a Next.js project, free tier covers festival volume. |
| Ticket delivery | **PDF attachment *and* a web link** | Attachments are the single most common delivery failure — spam filters, corporate mail servers, phones that won't open them. The link is the safety net and works on a phone in a queue. |
| Legal seller | **Polish entity** (fundacja / sp. z o.o.) | Stripe account country PL, settlement in PLN. BLIK and Przelewy24 are native. |

## Versions as built

Recorded because several plan steps were written against older majors and had
to be corrected while executing Tasks 1–4. Where a plan step disagrees with
this table, trust the table.

| Package | Assumed when planning | Actually installed | What changed |
|---|---|---|---|
| Next.js | 15 | **16.3.2** | `next lint` removed — the lint script is plain `eslint`. Turbopack is the dev default. |
| React | 19 | 19.2.8 | — |
| Prisma | 6 | **7.9.1** | `directUrl` removed from the schema; datasource URL moved to `prisma.config.ts`; a **driver adapter is mandatory**; the client generates as TypeScript into `src/generated/prisma`. |
| Tailwind | 3 (a JS config was assumed) | **4.3.3** | No `tailwind.config.ts`; tokens live in an `@theme` block in CSS. |
| Vitest | 3 | **4.1.11** | `poolOptions` removed (top-level now); `minWorkers` no longer exists. Config renamed to `.mts`. |
| Zod | 3 | **4.4.3** | `z.string().url()` deprecated in favour of `z.url()`. |
| Node | 20 | **24.14.1** | CI pinned to 24 to match. |
| pnpm | 9+ | 10.33.2 | — |

Three further environment facts worth recording:

- **`create-next-app` cannot scaffold into a directory named `KM`.** npm forbids
  capitals in package names and the tool derives the name from the directory.
  The app was scaffolded under a temporary `km/` and moved in.
- **`server-only` throws under Vitest.** It resolves to a no-op only under
  React's `react-server` condition, which Vitest does not use, so every server
  module fails to import. It is aliased to a stub in `vitest.config.mts`; the
  real package still guards the Next.js build, which is where the guarantee
  actually matters.
- **`prisma init` writes ~500KB of agent-skill files** into `.agents/`,
  `.claude/skills/`, `.windsurf/skills/` and `skills-lock.json`. These were
  deleted; re-running `prisma init` will recreate them.

## On the monolith (and why it is not a security problem)

The concern with putting front and back in one Next.js app is that the
client/server boundary is *implicit*: one careless import chain can pull server
code into the browser bundle.

What that does and does not mean:

- Environment variables are **not** leaked by default. Only `NEXT_PUBLIC_*`
  prefixed variables are inlined into the client bundle. `STRIPE_SECRET_KEY`
  stays server-side even if a module is bundled.
- **Code** can leak — pricing logic, table names, internal endpoints. That is
  information disclosure, not credential disclosure.

This is made a build-time error rather than a matter of discipline:

1. Every server module begins with `import 'server-only'`. The build **fails**
   if such a module ever reaches a client bundle.
2. All server code lives under `src/lib/server/`, never imported from a
   `"use client"` file.
3. Postgres is never publicly reachable.

The split alternative is not free: it adds a second HTTP surface that must be
authenticated, CORS configuration, a second secret store and a second deploy
pipeline. On a single host the network isolation it appears to buy is largely
illusory, since both containers share a network anyway.

None of the genuinely high-severity risks in a ticketing system are affected by
this choice. They are: webhook signature verification, server-side price
calculation, webhook idempotency, unguessable ticket codes, and keeping Next.js
patched. See [07-security-and-testing.md](07-security-and-testing.md).

## Payment methods and currency are coupled

This is the reason "both PLN and EUR" is a real feature and not a display toggle:

- **BLIK is PLN-only.** Charging a Polish buyer in EUR removes the dominant
  Polish payment method.
- **Klarna in Germany requires EUR.**
- **Przelewy24** supports PLN and EUR.
- **giropay** — listed in the original `plan.md` — was wound down by the German
  banking association and Stripe has been retiring it. **Do not build around
  it.** Verify what is actually available on the account and substitute Klarna /
  PayPal / SEPA / cards.
- **Klarna availability for Polish Stripe accounts must be verified on the real
  account** before it is promised to anyone.

Consequence: currency defaults from locale (PL → PLN, DE/EN → EUR) with a
visible manual switcher, and is frozen onto the order at creation. Refunds are
issued in the original currency.

## Divergences from the original `plan.md`

| `plan.md` said | This plan says | Why |
|---|---|---|
| VPS (Hetzner) or serverless | Vercel + Neon | Seasonal load; ops risk on sale day |
| A `User` entity | No user table; buyer data lives on `Order` | Guest checkout only |
| giropay as a payment method | Klarna / PayPal / SEPA instead | giropay was discontinued |
| PDF ticket by email | PDF **and** a web link | Attachment deliverability |
| "Transaction" entity | `Order` (+ `OrderItem`) | Also covers zero-value invitations, so there is one fulfilment path |
| Nothing about concurrency | Transactional capacity enforcement from phase 3 | 900-seat venues sell out with real contention |
