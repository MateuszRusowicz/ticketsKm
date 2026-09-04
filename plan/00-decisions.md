# Settled decisions

Each row records what was decided and why, so nobody re-litigates it in month two.

## Product scope

| Decision | Choice | Reasoning |
|---|---|---|
| Seating | **General admission, no seats** | No seat-map UI, no per-seat locking. Capacity is a single number per concert. |
| Catalogue | **Full program — many concerts** | ~10 concerts, each with its own date, venue, capacity and price. |
| Ticket types | **One price per concert** | Modelled as a `TicketType` table with exactly one row per event, so a reduced price can be added later without a migration. |
| Buyer accounts | **Guest checkout only** | Sales happen once a year. Accounts would add registration, login, password reset, session security and a GDPR liability for zero benefit. |
| Multi-concert cart | **No — one concert per order** (27 Aug 2026) | The schema supports it, but the UI cost is roughly a week: persistent cart, cart page, cross-event availability at payment time, and partial-failure handling when one concert sells out mid-checkout. A buyer attending three concerts pays three times. |
| Hold duration | **30 minutes, flat across all venues** (30 Aug 2026) | Long enough for a Przelewy24 bank transfer, short enough that abandoned checkouts do not hoard a sold-out concert. A per-venue window was considered and rejected as complexity for a risk that only bites if 300 people check out at once on the 300-seat concert. Mitigated by releasing holds on failure rather than only on expiry — see below. |
| Free tickets | **Staff invitations + 100% promo codes** | Two distinct flows, both bypassing Stripe. |
| Refunds | **In-app, full and partial** | Staff must not have to use the Stripe dashboard for routine work. |
| Invoices | **Invoice on request — details captured only** | The app stores company name / NIP / address and exports them. It does not generate faktury; that stays with accounting. |
| Attendee names | **A name per ticket** (27 Aug 2026) | Decided against the plan's own recommendation of anonymous tickets. Enables name-checking at the door and discourages resale, at the cost of a longer checkout form and personal data on every ticket rather than just on the order — which widens the RODO retention job in Plan 08. `Ticket.holderName` already exists in the schema. |
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

**Currency freeze point.** `Order.currency` is set from the hidden `currency`
field on the checkout form, which reflects the `km_currency` cookie at the
moment the order page rendered. The switcher is hidden on
`/koncert/*/zamowienie` so the currency shown in the summary and the currency
charged never diverge. Decided 2 Sep 2026.

Two options were rejected. Leaving the switcher live on the order page lets the
displayed total and the charged total diverge if a buyer switches after the page
renders. Pinning currency earlier — at the concert page — was rejected as
surprising: a buyer who lands on a German-language page and wants to pay in
złoty should still be able to say so before committing.

## Delivery sequence: a test-mode demo before the domain

**Decided 2 September 2026 by the owner.** The next milestone is a
**demonstrable product running dummy payments and orders in Stripe test mode**,
for both Polish and German buyers. Connecting `krzyzowa-music.eu` — and linking
the ticketing app from the existing Wix site — happens *after* that demo
succeeds, not before.

Three things were settled with it:

| Question | Choice | Consequence |
|---|---|---|
| How far does the demo go? | **Buyer → hold → test payment → confirmed order.** No ticket email, no PDF, no QR, no door scanner. | Scope is **Plan 04 plus the payment half of Plan 05**. Fulfilment (email, PDF, scanner) stays in Plans 05–07 and is explicitly *not* demo scope. |
| "Multiple providers"? | **Several payment methods through one Stripe integration** — BLIK and Przelewy24 for PL, Klarna / PayPal / SEPA / cards for DE. | No change: this is the Payment Element decision already recorded under **Technical**. No provider-abstraction layer, one webhook path, one reconciliation story. |
| Which Stripe account? | **A fresh test-mode account with country PL**, created now. | Unblocks the build today. The real account's keys swap in at launch with no code change, because keys are environment variables. |

**What this unblocks.** Two of the three open questions in
[`09-open-questions.md`](09-open-questions.md) stop blocking the *demo*, though
both still block *launch*:

- **DNS control (question 1)** gated the subdomain and Resend's SPF/DKIM
  records. The demo connects no domain and sends no email, so neither applies.
  It remains the longest-lead-time item outstanding and still has to be answered
  before launch.
- **The real Stripe account (question 2)** gated payments. Test mode needs no
  verified entity. **Klarna's availability to a Polish Stripe account is still
  unverified and must be checked on the real account** — a test-mode account
  offering it is not evidence that the live one will.

**What this defers.** Plan 02's tasks 7 and 9 (the CNAME and the production
database cutover) were already deferred to launch; this decision confirms them
and adds the Wix link-through to the same bucket. Task 8 — the Neon restore
drill — is unaffected and can still be rehearsed at any time.

**The demo runs on the Neon `development` branch with dummy data**, consistent
with the 27 Aug 2026 decision. Nothing about this milestone touches the dormant
`production` branch.

## Divergences from the original `plan.md`

| `plan.md` said | This plan says | Why |
|---|---|---|
| VPS (Hetzner) or serverless | Vercel + Neon | Seasonal load; ops risk on sale day |
| A `User` entity | No user table; buyer data lives on `Order` | Guest checkout only |
| giropay as a payment method | Klarna / PayPal / SEPA instead | giropay was discontinued |
| PDF ticket by email | PDF **and** a web link | Attachment deliverability |
| "Transaction" entity | `Order` (+ `OrderItem`) | Also covers zero-value invitations, so there is one fulfilment path |
| Nothing about concurrency | Transactional capacity enforcement from phase 3 | 900-seat venues sell out with real contention |

## Hold expiry does not call Stripe

**Decided 4 September 2026.** When a hold expires the sweep releases seats and
marks the order `EXPIRED`; it does **not** call `stripe.paymentIntents.cancel`.

**Reasoning:** An abandoned card checkout cannot charge — the buyer never
confirmed the PaymentIntent, so Stripe cannot debit anyone. Cancelling is
hygiene, not safety. The one dangerous case (releasing seats while a payment is
genuinely in flight — i.e. the buyer clicked Pay, the PI is `processing` or
`requires_action`) is protected by the `paymentIntentStatus` predicate on the
sweep's `WHERE` clause, not by a network call. The predicate is expressed as
raw SQL (`paymentIntentStatus IS NULL OR paymentIntentStatus NOT IN (...)`)
because Prisma's `{notIn:[…]}` omits the `OR IS NULL` branch and `NULL NOT IN
(…)` is UNKNOWN under SQL three-valued logic.

A late `payment_intent.succeeded` after the seats are released takes the
reclaim-or-refund path in `fulfilOrder` (Plan 05, Task 7): re-claim capacity if
available, two-transaction refund otherwise. This path is the **primary** safety
net against oversell; it is not a secondary one.

**This inverts the guidance in `plan/03-purchase-flow.md` § "Lifecycle of held
capacity" that previously mandated cancel-before-release.** That document is
corrected in the same commit as this entry. Anyone who finds the old guidance
(the five-step list with step 5 calling `stripe.paymentIntents.cancel`) quoted
elsewhere should treat this entry as authoritative, together with the corrected
§ in `03-purchase-flow.md`.

**Does Stripe automatically cancel abandoned PaymentIntents?**

Verified against `node_modules/stripe/types/PaymentIntents.d.ts` and Stripe's
published PaymentIntent lifecycle documentation.

- `types/PaymentIntents.d.ts:67` documents `cancellation_reason` as "either
  user-provided (`duplicate`, `fraudulent`, `requested_by_customer`, or
  `abandoned`) or generated by Stripe internally (`failed_invoice`,
  `void_invoice`, `automatic`, or `expired`)". **`abandoned` is
  user-provided** — Stripe will never set it on our behalf.
- Stripe's PaymentIntent lifecycle documentation states only that
  PaymentIntents "might also automatically transition to `canceled` if they're
  confirmed too many times." There is **no time-based automatic cancellation**
  for PIs in `requires_payment_method`, `requires_confirmation`, or
  `requires_action`.
- The commonly cited "7 days" applies to **uncaptured** PaymentIntents in
  `requires_capture` — i.e. manual-capture holds. Plan 05 uses automatic
  capture, so it does not apply.

**Conclusion:** Abandoned PaymentIntents linger indefinitely. This does not
affect safety — an unconfirmed PI cannot charge anyone — but the hygiene
concern is *not* self-resolving. An explicit cancellation pass for abandoned
PIs is a **Plan 06 clean-up item**, not a Plan 05 blocker.

## Async-payment hold policy (4 Sep 2026)

Async payment methods (Przelewy24, Klarna, SEPA Direct Debit) can stay in
`processing` for minutes to days after the buyer confirms. Plan 05's secondary
sweep handles these on a longer clock than the primary 30-minute hold:

- **Default timeout for non-SEPA async methods:** 6 hours
  (`ASYNC_PAYMENT_TIMEOUT_MS = 21_600_000`). If a P24 or Klarna PI is still
  `processing` after 6 hours it is treated as failed; the order is expired and
  the hold released.
- **Default timeout for SEPA Direct Debit:** 5 business days
  (`SEPA_HARD_TIMEOUT_DAYS = 5`). SEPA mandates can take up to 5 business days
  to settle under the SEPA Direct Debit scheme rules.
- Cutoffs are computed as `now() - make_interval(...)` in SQL — Postgres is the
  authoritative clock.

If a payment succeeds after the secondary sweep has released the seats, the
reclaim-or-refund path in `fulfilOrder` applies exactly as it does for the
primary sweep. The two-transaction refund is idempotent: `Order.stripeRefundId`
is unique and is the source of truth; Stripe's idempotency-key retention is not
relied on.

## SEPA Direct Debit enabled with server-side guardrails (4 Sep 2026)

SEPA Direct Debit is offered as a payment method for EUR orders, subject to
three guardrails, all computed server-side per order by
`computeAllowedPaymentMethods` in `src/lib/server/payment-methods.ts`:

| Guardrail | Default | Env var | Effect |
|---|---|---|---|
| Concurrent SEPA hold cap | 10% of capacity | `SEPA_HOLD_CAP_SHARE` | Count in-flight SEPA orders for the event (`paymentIntentStatus IN ('processing','requires_action','requires_capture','requires_confirmation') AND paymentMethodType = 'sepa_debit'`). If at or above `floor(capacity × share)` AND the floor is ≥ 1, drop `sepa_debit` from the allow-list. The floor guard prevents disabling SEPA on small concerts at count 0. |
| Near-sellout cut-off | 20% remaining | `SELLOUT_HIDE_THRESHOLD` | `available <= floor(capacity × threshold)` drops `sepa_debit`. |
| Hard timeout | 5 business days | `SEPA_HARD_TIMEOUT_DAYS` | Secondary sweep uses days-based cutoff for `paymentMethodType = 'sepa_debit'`. |

Guardrails are enforced via `payment_method_types` on the PaymentIntent, not via
UI hiding. If `sepa_debit` is absent from `payment_method_types`, Stripe refuses
SEPA confirmation for that PI. Client-side hiding is cosmetic; the server-side
allow-list is what actually guards.

`Order.paymentMethodType` is persisted on the first webhook of any type that
carries method details, via `pi.latest_charge` (expanded on retrieve) or
`pi.payment_method_types[0]` when the allow-list has already collapsed to one
method. This is the field the SEPA cap query reads.

Klarna availability for a live PL Stripe account remains unverified. A test-mode
account offering it is not evidence that the live account will.

## Payments — operational alerting (stopgap, 4 Sep 2026)

Until Plan 07 ships an admin dashboard, payment-related alerts are surfaced only
through Vercel runtime logs. Three cron endpoints emit fixed-format strings to
**stderr** (Vercel captures both stdout and stderr into runtime logs; response
bodies do not reach logs):

| String | Source |
|---|---|
| `SWEEP-PRIMARY expired=<e> released=<r> failed=<f>` | Primary hold-expiry sweep |
| `SWEEP-ASYNC expired=<e> released=<r> failed=<f>` | Secondary async-method sweep |
| `RECONCILE alerts=<n> failed=<f> deadlettered=<d>` | Reconciliation cron |

To check for problems, grep Vercel logs for `alerts=[1-9]` (one or more alerts),
`failed=[1-9]`, or `deadlettered=[1-9]`. Any non-zero value warrants
investigation. The grep is manual — there is **no automated notification**
(no email, no Slack, no Sentry) until Plan 08.

**This is a deliberate stopgap**, acknowledged by the owner on 4 Sep 2026. The
alternative — wiring Sentry or a Slack webhook — is Plan 08 scope. On the one
day that matters (ticket sale launch), the operator should have a Vercel log
stream open in a browser tab.
