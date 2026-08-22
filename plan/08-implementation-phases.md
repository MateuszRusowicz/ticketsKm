# 08 — Implementation phases

Nine phases over roughly ten weeks, sized to the 2–3 month deadline. Each phase
ends in a state that can be demonstrated, and each has an acceptance criterion
that is *checked*, not assumed.

The ordering has one deliberate feature: **inventory concurrency (phase 3) is
built and proven before Stripe is introduced (phase 4).** Overselling is the
hardest problem here and the least forgiving to retrofit. It gets solved while
the system is still simple enough to test properly.

---

## Phase 0 — Foundations (week 1)

| # | Step |
|---|---|
| 0.1 | `create-next-app` at the repository root — TypeScript, App Router, ESLint. Delete the empty `KMFront/` and `KMBack/` directories. `git init`. |
| 0.2 | Prettier, ESLint config, and the `no-restricted-imports` rule blocking `lib/server/**` from client components. |
| 0.3 | Tailwind CSS + the base component conventions (button, input, card). |
| 0.4 | `src/lib/server/env.ts` — zod-validated environment. The app refuses to boot on a missing variable. Commit `.env.example`. |
| 0.5 | `docker-compose.yml` with Postgres for local development; `Dockerfile` for the app. |
| 0.6 | Prisma 7 installed with the `@prisma/adapter-pg` driver adapter (Prisma 7 requires one), connected to a Neon **development branch**. The CLI reads `DIRECT_URL` via `prisma.config.ts`; the application connects to the pooled `DATABASE_URL` through the adapter. A `postinstall: prisma generate` hook regenerates the git-ignored client. |
| 0.7 | `next-intl` skeleton: `/pl`, `/en`, `/de` routing, message files, a locale switcher, and the two-root-layout route-group structure (`(shop)` and `(admin)`) that lets the shop carry `lang={locale}` while the admin carries `lang="pl"`. |
| 0.8 | GitHub Actions CI: typecheck, lint, unit tests on every push. |
| 0.9 | Vercel project connected, preview deploys on branches, production on `main`. |
| 0.10 | Renovate or Dependabot enabled. |

**Acceptance:** `pnpm dev` serves a page at `/pl`, `/en` and `/de`; CI is green;
a preview deployment is reachable; a missing environment variable fails the boot
with a readable message.

---

## Phase 1 — Domain and admin skeleton (week 2)

| # | Step |
|---|---|
| 1.1 | Full Prisma schema from [02](02-data-model.md); first migration; all indexes. |
| 1.2 | `prisma/seed.ts` — two venues, three concerts with PL/EN/DE translations, prices in both currencies, one admin, one scanner account. |
| 1.3 | Session handling with argon2id hashing and `ADMIN` / `SCANNER` roles. Auth.js was evaluated and dropped: for two roles and one login page its adapter layer costs more than it saves, and database-backed opaque sessions are both simpler to test and revocable — which a stateless token is not, and which matters when a door volunteer's phone goes missing. |
| 1.4 | `requireAdmin()` / `requireStaff()` helpers; admin layout; login page; **per-account lockout and per-IP rate limiting** — these are different controls solving different problems, and lockout alone is itself a denial-of-service vector against the festival's own admin account. |
| 1.5 | `audit.ts` helper and the `/admin/audit` view. |
| 1.6 | Admin events CRUD: venue, date, capacity, status, sales window, prices, three-tab PL/EN/DE content editor. |
| 1.7 | Guard rail: capacity cannot go below `soldCount + heldCount`. |

**Acceptance:** an admin logs in, creates a concert in three languages, and it
exists in the database as `DRAFT`. A `SCANNER` account is rejected from every
admin page — verified by test, not by clicking.

---

## Phase 2 — Public program and buy box (week 3)

| # | Step |
|---|---|
| 2.1 | Program page: concerts filtered by status and sales window, localised, sorted by date. |
| 2.2 | Concert detail page with full translated content. |
| 2.3 | Locale switcher and currency switcher, with the currency default derived from locale. |
| 2.4 | Availability display: available / few remaining / sold out, computed from `capacity − sold − held`. |
| 2.5 | Buy box: quantity selector bounded by `maxPerOrder` and remaining capacity. |
| 2.6 | Buyer details form (react-hook-form + zod): email, name, optional phone, optional invoice fields, terms acceptance. |
| 2.7 | Terms (`regulamin`) and privacy policy pages in all three languages. |
| 2.8 | Responsive layout pass — most buyers arrive from a phone. |

**Acceptance:** a visitor browses the program in all three languages and both
currencies and reaches a validated checkout form. Nothing is charged yet.

---

## Phase 3 — Inventory and orders (week 4) — *the risky core*

| # | Step |
|---|---|
| 3.1 | `inventory.ts`: `hold()`, `release()`, `commit()`, `returnToSale()` built on the atomic conditional UPDATE. |
| 3.2 | `orders.ts`: create a `PENDING` order with price snapshots and a server-computed total; human-readable reference generation. |
| 3.3 | `promo.ts`: validation rules and discount arithmetic; usage counted at hold time. |
| 3.4 | `/api/cron/release-holds` + `vercel.json` schedule + `CRON_SECRET` protection. |
| 3.5 | **The oversell test:** N concurrent holds against capacity M; exactly M succeed. |
| 3.6 | Hold-expiry test: capacity and promo usage both return. |
| 3.7 | Promo concurrency test: `maxUses` cannot be exceeded. |

**Acceptance:** the concurrency tests pass repeatedly (run them 50 times in CI —
a race that passes once proves nothing). `soldCount + heldCount <= capacity`
holds under every test.

---

## Phase 4 — Stripe checkout (week 5)

| # | Step |
|---|---|
| 4.1 | Stripe account in test mode. Enable cards, BLIK, Przelewy24, Klarna. **Record which are actually available for a Polish account** and adjust the plan if Klarna is not. |
| 4.2 | `POST /api/checkout`: rate limit → validate → price server-side → hold → order → PaymentIntent with an idempotency key and `orderId` metadata. |
| 4.3 | The zero-total path: a 100% promo code fulfils immediately without Stripe. |
| 4.4 | Checkout page with the Payment Element, `automatic_payment_methods`, localised, `return_url` to the order page. |
| 4.5 | Order status page: pending / paid / failed / expired / cancelled states, with polling that stops after five minutes. |
| 4.6 | Error handling: declined cards, abandoned redirects, closed tabs. |

**Acceptance:** a test-card payment reaches Stripe and the PaymentIntent
succeeds. The order is still `PENDING` — fulfilment arrives in phase 5, and that
is correct, because the client must never grant tickets.

---

## Phase 5 — Webhooks and fulfilment (week 6)

| # | Step |
|---|---|
| 5.1 | `/api/webhooks/stripe`: Node runtime, raw body, signature verification. |
| 5.2 | Idempotency ledger; unknown event types acknowledged with 200. |
| 5.3 | Fulfilment part 1 (transactional): `PAID`, held → sold, generate tickets, flip to `SOLD_OUT` at capacity. |
| 5.4 | Handlers for `payment_failed`, `canceled`, `charge.refunded`, `charge.dispute.created`. |
| 5.5 | **The expired-hold race:** re-check capacity in the webhook; auto-refund and email an apology if the concert filled meanwhile. |
| 5.6 | QR generation and the PDF ticket (`pdf-lib`). |
| 5.7 | Resend integration; `react-email` ticket template in three languages. |
| 5.8 | Fulfilment part 2 (best-effort): render, send, set `emailSentAt`. |
| 5.9 | `/api/cron/retry-emails` for paid orders with no `emailSentAt`. |
| 5.10 | The web ticket page `/t/[code]`. |
| 5.11 | Idempotency test: deliver one event five times, get one set of tickets and one email. |

**Acceptance:** end to end — pay with a test card, receive an email with a PDF
whose QR scans, and see the ticket in the admin. Then replay the webhook and
confirm nothing is duplicated.

---

## Phase 6 — Invitations, promo admin, refunds (week 7)

| # | Step |
|---|---|
| 6.1 | Invitation issue form and list; capacity claimed like a purchase; audit-logged. |
| 6.2 | Promo code CRUD with usage statistics. |
| 6.3 | Full refund: Stripe refund with an idempotency key, tickets revoked, capacity returned, email sent. |
| 6.4 | Partial refund by selected tickets. |
| 6.5 | Refund confirmed by the `charge.refunded` webhook, not the API response. |
| 6.6 | Resend-ticket-email action in the admin. |
| 6.7 | Event cancellation: batched refunds for every paid order, all tickets revoked, all buyers emailed; safe to re-run. |

**Acceptance:** staff issue an invitation, create and use a promo code, and
refund an order — none of it requiring the Stripe dashboard. A refunded ticket
is rejected at the scanner with the `REVOKED` state.

---

## Phase 7 — Door scanner (week 8)

| # | Step |
|---|---|
| 7.1 | `/admin/scan`: mobile-first layout, camera access, QR decoding. |
| 7.2 | Event selector and a live checked-in / sold counter. |
| 7.3 | `POST /api/admin/scan` with the atomic first-scan-wins update. |
| 7.4 | Five result states, full-screen colour, sound and vibration feedback. |
| 7.5 | Manual code entry fallback. |
| 7.6 | Rate limiting and `SCANNER`-role authorisation on the endpoint. |
| 7.7 | Double-scan concurrency test. |
| 7.8 | Field test on real phones — iOS Safari and Android Chrome, in poor light. |

**Acceptance:** two phones scan the same ticket simultaneously and exactly one
shows green. A ticket for another concert shows `WRONG_EVENT`. A refunded ticket
shows `REVOKED`.

---

## Phase 8 — Dashboard, hardening, launch (weeks 9–10)

| # | Step |
|---|---|
| 8.1 | Sales dashboard: per-concert sold/held/available, revenue by currency, attention flags. |
| 8.2 | CSV export including invoice details, UTF-8 with BOM. |
| 8.3 | Rate limiting completed across checkout, promo, login and scan. |
| 8.4 | Security headers and CSP; `noindex` on `/admin/**` and `/t/**`; dependency audit. |
| 8.5 | RODO: retention job, DPAs with all four vendors, access/deletion procedure. |
| 8.6 | Full Playwright suite green in CI. |
| 8.7 | Load test the on-sale rush; verify Prisma pooling against Neon holds up. |
| 8.8 | Payment-method testing in Stripe test mode: BLIK, Przelewy24, Klarna, including abandoned redirects. |
| 8.9 | Email deliverability testing: Gmail, Outlook, GMX, WP.pl, Onet.pl. |
| 8.10 | Production setup: Neon production branch, Vercel production, `bilety.` DNS, Resend domain verified, Stripe live keys, live webhook endpoint. |
| 8.11 | Backups: verify Neon point-in-time recovery **by restoring**; add a scheduled logical dump off-platform. |
| 8.12 | Sentry error tracking with alerts on webhook and fulfilment failures; uptime monitoring to a phone someone carries. |
| 8.13 | Wix buttons pointed at the correct per-language URLs. |
| 8.14 | Staff runbook in Polish. |
| 8.15 | A real live transaction for a small amount, then refunded. |

**Acceptance:** a real card is charged in production, the ticket arrives, it
scans at the door, and the refund lands back on the card.

---

## Phase 9 — Rehearsal (before sales open)

Not a development phase, and the one most likely to be skipped. It should not be.

- A full dry run with festival staff: publish a test concert, buy tickets on
  their own phones, refund one, issue an invitation, scan them all at a door.
- Walk each venue and test mobile signal where the scanners will stand.
- Agree who is on call the evening sales open, and what they do if the scanner
  shows amber for a queue of people.

---

## Deliberately not in v1

Recorded here so they are decisions rather than oversights:

- Seat maps and numbered seating
- Festival passes / carnets covering multiple concerts
- Buyer accounts and order history
- Automatic VAT invoice generation
- Apple / Google Wallet passes
- Offline scanning mode
- Waiting lists for sold-out concerts
- Multiple ticket types per concert (the schema supports it; no UI)
- Ticket transfer or name changes
