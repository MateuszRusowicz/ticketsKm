# Plan 05 — Payments (checkout half)

**Goal:** a buyer with a `PENDING` order from Plan 04 pays through Stripe's
Payment Element (test-mode BLIK / Przelewy24 / Klarna / card / SEPA Debit), a
signed Stripe webhook fulfils the order atomically (`held → sold`, `PAID`,
`Ticket` rows), a signature-forged webhook is refused, expired holds release
seats without any Stripe call, and both sweeps run on Vercel cron.

**The safety net** — a payment that succeeds after its seats are released —
takes the `reclaim → fulfil` path if capacity is still available and the
two-transaction refund path otherwise. This is the primary line of defence
against oversell, not a secondary one.

**Not in this plan** (explicitly): ticket email, PDF, QR codes, the door
scanner, promo codes, invitations, staff-initiated refunds, promo-code
`usedCount` decrement, CSP, shared rate limiting across Vercel instances,
`experimental.serverActions.allowedOrigins`. Those are Plans 06–08.

**Architecture:**

- Amounts always come from `Order.total`; the client never sees a price it can
  tamper with.
- One Stripe idempotency key per order (`pi_<orderId>`) plus the `@unique` on
  `Order.stripePaymentIntentId` plus a bounded `idempotency_key_in_use` retry
  guarantee one PaymentIntent per order regardless of how many times Pay is
  clicked or how many tabs are open.
- Fulfilment is one Prisma transaction: a conditional `UPDATE` on `TicketType`
  that moves `heldCount → soldCount`; `Order → PAID`; `Ticket` rows with
  `crypto.randomBytes(16)` Crockford base32 codes; `Event → SOLD_OUT` if
  capacity is met. All in the same lock order as `holdCapacity` (Event first)
  so ABBA deadlocks cannot arise under concurrent hold + fulfil.
- The webhook route reads the raw request body (`request.text()`, never
  `request.json()`), verifies the signature with
  `stripe.webhooks.constructEvent`, then takes a per-event row lock on
  `StripeWebhookEvent` before dispatching. `processedAt IS NULL` on that row
  means the previous attempt died mid-flight — the retry reprocesses.
  Permanent failures are counted, and after `WEBHOOK_MAX_ATTEMPTS` the row is
  marked `deadLettered = true` with an ALERT audit.
- **Hold expiry no longer calls Stripe.** An abandoned card checkout has no
  authorised charge — Stripe cannot debit the buyer without their confirmation
  — so cancelling the PaymentIntent is hygiene, not safety. The one dangerous
  case (releasing seats while a payment is in flight) is protected by a
  predicate on `Order.paymentIntentStatus`, not a network call. A late success
  after the seats are released takes the reclaim-or-refund path.
- Async methods — Przelewy24, Klarna, **SEPA Debit** — extend `holdExpiresAt`
  on Pay-click so a buyer mid-3DS or mid-BLIK is never swept. The secondary
  sweep uses the async hold path for `processing` PIs and a hard 5-business-day
  timeout for SEPA specifically.
- The refund path — the one place real money moves — keeps a two-transaction
  pattern: (a) mark `refundRequestedAt` in tx1; (b) `stripe.refunds.create`
  outside any DB tx; (c) persist `stripeRefundId` and set `REFUNDED` in tx2.
  Reconciliation resumes anything stuck.

**Spec:** [`../03-purchase-flow.md`](../03-purchase-flow.md) (§ "The webhook",
§ "Fulfilment", § "The oversell race, handled explicitly"),
[`../06-i18n-email-pdf.md`](../06-i18n-email-pdf.md) (payment-method /
currency coupling only — email and PDF are out of scope),
[`../07-security-and-testing.md`](../07-security-and-testing.md) (§ "The five
things that actually matter"),
[`../00-decisions.md`](../00-decisions.md) (currency freeze, delivery sequence,
payment-methods-and-currency coupling, versions table, and — from Task 4 —
the "no PI cancel on hold expiry" decision).

**Depends on:** Plan 04 in full — `createOrder`, `expireOrder`,
`reclaimCapacityForOrder`, `failOrder`, the sweep, the
`?t=<accessToken>`-guarded order page, `StripeWebhookEvent`,
`Order.stripePaymentIntentId @unique`, `HOLD_DURATION_MS`.

> **Written 3 September 2026; revised 4 September 2026 (owner decision + a
> second critique pass).** Every claim about `src/`, `prisma/`, `tests/`,
> `package.json`, `vitest.config.mts`, `eslint.config.mjs`, `vercel.json`,
> `prisma.config.ts`, `plan/00-decisions.md` and the installed
> `node_modules/stripe/` typings has been verified by reading the file. The
> first pass found ten blockers; two subsequent passes found ten more (three
> convergent) and required a design simplification recorded in
> `plan/00-decisions.md`. The Findings log has forty-plus entries; keep
> adding as you execute.

---

## Findings log

Appended **as things are discovered**, not at the end. Each row says what the
plan assumed, what was actually true, and which task was corrected.

| Date | Finding | Action |
|---|---|---|
| 3 Sep (draft) | `03-purchase-flow.md` § "The checkout submission" said `POST /api/checkout`; Plan 04 corrected it to a server action. | Payment Element wiring is also a server action (`startPaymentAction`, `extendHoldAction`). |
| 3 Sep (draft) | Design § "Fulfilment" bulleted "move quantity from heldCount to soldCount" as one line; two `UPDATE`s is the drift bug Plan 04 flagged. | Task 7 emits one `UPDATE "TicketType" SET "heldCount" = "heldCount" - $1, "soldCount" = "soldCount" + $1 WHERE id = $2 AND "heldCount" >= $1`. |
| 3 Sep (draft) | `robots.ts` disallows `/*/order/` after site-wide `/`; verified: `disallow: ['/', '/*/order/']`; no `/admin` or `/t`. | Task 10 Step 5 adds `/api/webhooks/`, `/api/cron/` so they survive the Plan 02 Task 9 launch flip that removes the site-wide `/`. |
| 3 Sep (draft) | `Order.attendeeNames` stored as `[{index, name}]`; Task 7 maps by JSON index. | — |
| 3 Sep (draft) | The plan attributed a `SOLD_OUT` transition to Plan 04. Plan 04 does not carry it. | Attributed correctly to `03-purchase-flow.md`; Task 7 emits `Event → SOLD_OUT` in the same tx, guarded to `ON_SALE → SOLD_OUT`. |
| 4 Sep (critique, MEASURED) | `pnpm add stripe@19.5.0` 404s. Top 19.x is **19.3.1**; `latest` is 22.6.1. | Pinned at `19.3.1`. |
| 4 Sep (critique) | Hardcoded `PINNED_API_VERSION = '2025-09-30.clover'` was a tsc error. | Wrapper drops the pinned constant. `Stripe.API_VERSION` (runtime string) is logged for observability. |
| 4 Sep (critique, MEASURED) | Adding three required `STRIPE_*` env vars made ~290 db-importing tests fail because `.env.test` had only five vars. | Task 2 Step 2 extends `.env.test` **before** the schema change; Step 6 reruns the full suite as the gate. |
| 4 Sep (critique) | `superRefine` structural ambiguity in the earlier snippet. | Task 2 Step 4 gives the exact `.object({…}).superRefine(...)` structure. |
| 4 Sep (critique) | **Idempotency ledger short-circuited on P2002 unconditionally** → any first-attempt failure permanently silenced Stripe retries → money captured, order PENDING forever. | Task 10 rewrites: `INSERT ... ON CONFLICT DO NOTHING RETURNING`; on zero rows read the row and short-circuit only when `processedAt IS NOT NULL`. |
| 4 Sep (critique) | **PaymentIntent created on component mount** → `stripePaymentIntentId` set on every abandoned page-load → Plan 04's primary sweep (which filtered `IS NULL`) matched nothing. | Task 12 creates the PI only on Pay-click. Task 6 also writes `paymentIntentStatus` in the claim UPDATE. Task 11 makes the primary sweep PI-status-aware. |
| 4 Sep (critique) | **`payment_intent.payment_failed` must not call `failOrder`.** Declined card is retryable; releasing seats made the retry charge against a FAILED order and `fulfilOrder` skipped. | Task 8's dispatch: `payment_failed` audits + persists PI status; only `canceled` is terminal. |
| 4 Sep (critique) | **`fulfilOrder`'s non-fulfilable branch must refund, not skip.** Any `succeeded` against `FAILED`/`CANCELLED` is money held. | Task 7's contract adds `refunded_terminal`. |
| 4 Sep (critique) | **One stuck order blocked every release forever** — no per-order try/catch, `for(;;)` spun on the same page. | Task 11: per-order try/catch, `failed` counter, return `{expired, released, failed}`. `failed > 0` → 207 + ALERT. |
| 4 Sep (critique) | **`updateEvent` never cancelled the PI** on admin event-cancel → late success → tickets issued for a cancelled concert. (Now moot after the 4-Sep-late simplification — see next row — because `updateEvent` returns to Plan 04 shape.) | Task 11 Step 5 flips `Event.status = CANCELLED` FIRST inside the existing single-transaction shape (`events.ts:113`), then releases; `reclaimCapacityForOrder`'s Event.status guard (Task 7) is what stops late success from issuing tickets. |
| 4 Sep (critique) | **Stripe network calls inside open Postgres transactions** — measured to serialise 500 orders against a 30s tx budget, and put the refund at Stripe before the DB write. | The refund path IS two-transaction (Task 7). The **hold-expiry Stripe call is deleted entirely** — see the "no PI cancel on hold expiry" decision. |
| 4 Sep (critique) | **`reclaimCapacityForOrder` re-held on a CANCELLED event.** | Task 7 Step 3 adds an `Event.status IN ('ON_SALE', 'SOLD_OUT')` guard; `EventNoLongerPurchasableError` triggers refund. |
| 4 Sep (critique) | **ABBA deadlock risk** — `holdCapacity` locks Event then updates TicketType; `fulfilOrder` did the reverse. | Task 7 Step 3 takes `SELECT id FROM "Event" WHERE id = $1 FOR UPDATE` first, matching `holdCapacity`. |
| 4 Sep (critique) | **`fulfilOrder` never cross-checked the PI against the order.** | Task 7 Step 3 asserts `pi.id === order.stripePaymentIntentId`, `pi.amount_received === order.total`, `pi.currency === order.currency.toLowerCase()`. |
| 4 Sep (critique, MEASURED) | `vi.mock` factory TDZ trap — every existing repo `vi.mock` inlines literals only. | All new test files use `vi.hoisted(() => ({ fn: vi.fn() }))`. |
| 4 Sep (critique, MEASURED) | `require('@/lib/server/stripe')` alias cannot resolve in Vitest ESM. | Same-file identity via a second `import *` in the same test file. |
| 4 Sep (critique, MEASURED) | Raw-body negative control was a fixed point — `JSON.stringify(JSON.parse(p)) === p` for compact payloads, and Stripe's fixtures are compact. | Task 10 Step 6 fixture is `JSON.stringify(obj, null, 2)` (pretty); mutation is `JSON.stringify(JSON.parse(s))` (compact). Round-trip changes bytes. |
| 4 Sep (critique, MEASURED) | 1000 orders / 10 000 tickets blew Vitest's 5s default `testTimeout`; also needed distinct emails (dedupe) and `capacity >= 10000`. | Task 7 case 11: 100/1000, `testTimeout: 60_000`, distinct emails, `capacity: 10_000`. |
| 4 Sep (critique) | Task-13 i18n keys diverged from what the action returns. | Task 12 Step 5 pins the exact keys (`notPendingPAID`, `notPendingREFUNDED`, …). |
| 4 Sep (critique) | Task-9 audit-then-throw in one tx: the audit is rolled back. | Task 11's stalePI audit (Task 7's refund audit) uses a standalone client (no tx) then throws. |
| 4 Sep (critique) | Concurrent `create` case 3 was false-green — mock returned same id, Stripe's real 409 was unhandled. | Task 6 Step 3 adds bounded backoff on `idempotency_key_in_use` with DB re-read; case 3 fires literal `Promise.all` with distinct-id mock to prove the collision guard. |
| 4 Sep (critique) | Task-16 demo flow 3 (P24) was not executable as written. | Task 16 flow 3 uses Stripe's hosted redirect page's "Success" option; SEPA is used to exercise the async policy. |
| 4 Sep (critique) | No `maxDuration` set. | Task 10 sets 30 on the webhook; Task 13 sets 60 on the crons. |
| 4 Sep (critique) | `export const runtime = 'nodejs'` is against Next 16 guidance. | Removed. |
| 4 Sep (critique) | Sweep-cutoff Global Constraint said SQL `now()`; Task 12 draft passed a JS Date. | Task 11 secondary sweep computes cutoffs as `now() - make_interval(...)` in SQL. |
| 4 Sep (critique) | **5-minute crons require Vercel Pro**; Hobby silently rejects/downgrades. | Task 1 Step 7 confirms Pro; Task 13 states plainly what fails on Hobby. |
| 4 Sep (critique) | Cross-refs drifted; `reclaimCapacityForOrder` was cited at `orders.ts:296` (actual `:305`); `maxNetworkRetries` default said 100 (actual 2); `crypto.randomBytes` prose vs `getRandomValues` code. | Corrected. Task 16 Step 4 greps all task-cross-refs from a shell script rather than trusting prose. |
| **4 Sep (critique, VERIFIED)** | **`pi.charges` does not exist in `stripe@19.3.1`.** `types/PaymentIntents.d.ts:129` has `latest_charge: string \| Stripe.Charge \| null`. The plan's `extractPaymentMethodType` + SEPA prose read `pi.charges?.data?.[0]?.payment_method_details?.type` — a `tsc` error. | Task 8 rewrites `extractPaymentMethodType` to use `pi.latest_charge` (expanded on retrieve) OR the single-element case of `pi.payment_method_types`. Task 5's SEPA prose says the same. |
| **4 Sep (critique)** | **SEPA guardrail was dead code.** `extractPaymentMethodType` returned `null` for every non-`succeeded` event → `Order.paymentMethodType` never `'sepa_debit'` → cap query counted 0 forever → secondary sweep's SEPA branch never matched. | Task 8 sets `paymentMethodType` on the **first** webhook of ANY type. Task 5's cap query counts all `paymentIntentStatus IN ('processing','requires_action','requires_capture','requires_confirmation')` — the in-flight population, not just `processing`. Task 5 guards `if capacity * share < 1: allow SEPA unconditionally` so small concerts do not disable SEPA at count 0. |
| **4 Sep (critique)** | **`paymentIntentStatus` never written at PI creation** → primary sweep NULL-mishandling: `{notIn:[…]}` in Prisma emits `WHERE col NOT IN ($1)` with no `OR IS NULL`, so `NULL NOT IN (…)` is UNKNOWN → **sweep matches nothing**, reproducing the exact Plan 04 bug. Written as raw SQL with `OR IS NULL`, a buyer mid-3DS gets swept. | Task 6 writes `paymentIntentStatus = 'requires_confirmation'` in the SAME claim UPDATE as `stripePaymentIntentId`. Task 11 predicate expressed as raw SQL: `(paymentIntentStatus IS NULL OR paymentIntentStatus NOT IN (...))`. Task 12 adds `extendHoldAction` — Pay-click extends `holdExpiresAt` by `PAY_CLICK_HOLD_EXTENSION_MS` (default 15 min) so mid-payment orders are never swept. |
| **4 Sep (critique)** | **Webhook ledger: concurrent double-dispatch** — two deliveries land simultaneously, A inserts and dispatches, B sees zero rows + processedAt IS NULL, dispatches in parallel. Refund path is not idempotent enough to survive it. Also no dead-letter, no attempt counter — permanent failures 500 forever until Stripe disables the endpoint. | Task 3 adds `StripeWebhookEvent.attemptCount` and `deadLettered`. Task 10 takes `SELECT ... FOR UPDATE` on the ledger row before dispatch, so concurrent deliveries serialise. After `WEBHOOK_MAX_ATTEMPTS` (default 8, matches Stripe's ~3 days of retries), the row is marked `deadLettered = true` and an ALERT audit is written; Task 15 reconciliation surfaces the count. |
| **4 Sep (critique)** | **Refund exactly-once was not achieved** — Stripe idempotency keys expire in 24h; Stripe retries webhooks for 3 days; `charge_already_refunded` and `idempotency_key_in_use` propagated as errors. | Task 3 adds `Order.stripeRefundId` (unique). Task 7 checks `stripeRefundId IS NOT NULL` before the refund call — that field is our source of truth, not Stripe's key retention. Task 7 catches `charge_already_refunded` and `idempotency_key_in_use` and treats them as success (retrieves the existing refund id from Stripe by charge lookup). |
| **4 Sep (critique)** | **`updateEvent` ordering** — flipping `Event.status = CANCELLED` LAST left a window where seats are on sale but the event is still `ON_SALE`, and dropped the `SELECT … FOR UPDATE` serialisation. | With the no-PI-cancel simplification, `updateEvent` returns to Plan 04's single-transaction shape. Task 11 Step 5 says: **status flip first, THEN release**, inside the same transaction that took `SELECT … FOR UPDATE` on Event. Existing tests at `events.test.ts:202, 221, 236` assert `action: 'order.cancel'` with admin attribution in `AuditLog.actorId`; preserved. |
| **4 Sep (critique)** | **Sweep outer loop still spun** — page break only on `candidates.length < take`, a failing order stayed PENDING and was re-selected next page. ≥500 stuck → spin until `maxDuration`. | Task 11 uses keyset pagination on `(holdExpiresAt, id)`: each page's next query filters `WHERE (holdExpiresAt > $lastExpiresAt OR (holdExpiresAt = $lastExpiresAt AND id > $lastId))`. Failed orders are naturally skipped forward. |
| **4 Sep (critique)** | **Alerting was theatre** — Vercel logs capture stdout, not response body; `grep 'alerts=[1-9]'` would not match `"alerts":3` anyway. Pro log retention is 1 day. | Task 13 emits `console.error(\`RECONCILE alerts=${n} failed=${f} deadlettered=${d}\`)` (plus a similar line from each sweep) so the string is in the logs and matches the grep. `00-decisions.md` under "Payments — operational alerting" says plainly: **alerts are unmonitored until Plan 07 ships the admin dashboard**, other than the grep. |
| **4 Sep (critique)** | **Deployment ordering circular** — set env vars, redeploy, but `STRIPE_WEBHOOK_SECRET` did not exist yet, so the redeploy failed on the schema's placeholder-refusal. | Task 15 flips the order: register the Stripe endpoint FIRST, use that `whsec_` when setting env vars, THEN redeploy. |
| **4 Sep (critique)** | **`NEXT_PUBLIC_SITE_URL` never verified on Vercel** — if it stayed `http://localhost:3000`, every BLIK/P24/Klarna redirect went to localhost. Four of six demo flows broken. | Task 15 Step 4 explicitly reads back the Vercel value and asserts it is `https://tickets-km.vercel.app`. |
| **4 Sep (critique)** | **Reconciliation queried the wrong states.** | Task 14 queries: (a) `Order.paidAt IS NOT NULL AND (SELECT count(*) FROM "Ticket" WHERE "orderId" = "Order".id) < (SELECT sum(quantity) FROM "OrderItem" WHERE "orderId" = "Order".id)`; (b) `Order.refundRequestedAt IS NOT NULL AND stripeRefundId IS NULL AND status <> 'REFUNDED'`; (c) `StripeWebhookEvent.processedAt IS NULL AND attemptCount < WEBHOOK_MAX_ATTEMPTS AND receivedAt < now() - interval '10 minutes'`. |
| **4 Sep (critique)** | **`OrderBand` missing `processing` and `refunded`; `order-lookup.ts` did not select `paymentIntentStatus`; `REFUNDED` mapped to `paid`** (told a refunded buyer their order was paid). | Task 12 Step 1 modifies `getOrderForConfirmation`: adds `paymentIntentStatus` to the select, adds `processing` and `refunded` to `OrderBand`, `REFUNDED` and `PARTIALLY_REFUNDED` map to `refunded`, `PAID` alone maps to `paid`. |
| **4 Sep (critique)** | **Composite index `[status, paymentIntentStatus, holdExpiresAt]` was mis-ordered** — a `NOT IN` on column 2 prevents a range scan on column 3. | Task 3 uses `[status, holdExpiresAt, paymentIntentStatus]`. Primary sweep filters on the prefix; `paymentIntentStatus` is a filter, not a range. |
| **4 Sep (owner decision, VERIFIED)** | **The owner has decided: no PI cancellation on expiry.** Abandoned card checkout cannot charge — cancelling is hygiene, not safety. This deletes Task 11's primitive, the `expiringLockedAt` column, and most of the reconciliation cron. The reclaim-or-refund path graduates to the primary safety net. | Documented in `00-decisions.md` under a new heading (Task 4 Step 3). Task 11 keeps `expireOrderWith`'s Plan 04 `beforeRelease` hook (unused by Plan 05; a future plan may need it). Design docs corrected (Task 4). Task 7 (refund path) is what the entire safety story now rests on. |
| **4 Sep (executor to verify)** | Does Stripe automatically cancel abandoned PaymentIntents, and after how long? | Task 4 Step 3 asks the executor to read `node_modules/stripe/types/PaymentIntents.d.ts` and Stripe's docs, then record the answer in `00-decisions.md`. If yes, the hygiene argument for explicit cancellation disappears entirely; if no, explicit cancellation is a plan-06 clean-up item, not a plan-05 blocker. **The plan does not depend on the answer** — no `cancel` call runs from expiry. |
| **4 Sep (critique)** | Negative controls that could not fail: Task 10 raw-body (fixed point), Task 6 concurrent-create (same id from both writes), Task 12 JS-clock (local test can't distinguish), Task 13 Pay-click-gate (no DOM). Also: Task 5 SEPA env-override (env parsed at import, needs `vi.resetModules`); Task 7 ABBA (intermittent); Task 11 slow-Stripe (needs testTimeout above 30s). | Each is either rewritten to be deterministic, replaced by a spy-on-query check (Task 6), or dropped from the count with an explicit "cannot distinguish here" note (Task 11 SQL-vs-JS clock, Task 12 Pay-click). Following Plan 04's precedent with the pool-tuning smoke test. |

*(Executors: append rows here in the same turn a discovery is made, not at the end of the task.)*

---

## Global Constraints

- **Amount authority is the database.** `PaymentIntent.amount` from
  `Order.total`, always. The request body carries none.
- **Webhook signature verification is not optional.** Raw body via
  `await request.text()`; `stripe.webhooks.constructEvent(raw, sig,
  env.STRIPE_WEBHOOK_SECRET)` before any DB read.
- **Webhook idempotency uses a row lock + `processedAt` check.** Serialise
  concurrent deliveries with `SELECT ... FOR UPDATE` on the
  `StripeWebhookEvent` row; short-circuit only when `processedAt IS NOT
  NULL`; increment `attemptCount` each retry; after
  `WEBHOOK_MAX_ATTEMPTS` (default 8) mark `deadLettered = true` and audit
  at ALERT severity.
- **Fulfilment is idempotent on `Order.status`.** The conditional UPDATE
  is the lock — even if the ledger check is bypassed.
- **Held → sold in one UPDATE.** Splitting drifts.
- **Hold expiry does NOT call Stripe.** Owner decision (4 Sep 2026). An
  abandoned card charges nobody; the dangerous "in-flight payment" case
  is protected by a `paymentIntentStatus` predicate. A late success takes
  the reclaim-or-refund path — Task 7.
- **`Order.holdExpiresAt` is extended on Pay-click** by
  `PAY_CLICK_HOLD_EXTENSION_MS` (default 15 min). A buyer mid-3DS or
  mid-BLIK is never swept.
- **PaymentIntent creation is only triggered by the buyer's click of
  Pay** — never on mount, never on poll — so `stripePaymentIntentId` is
  never set for an abandoned page-load. `paymentIntentStatus =
  'requires_confirmation'` is written in the SAME UPDATE as
  `stripePaymentIntentId`, so the sweep's PI-status predicate sees a
  consistent state from the moment the id exists.
- **The primary sweep predicate is expressed as raw SQL** (Prisma's
  `{notIn:[…]}` omits the `OR IS NULL` and `NULL NOT IN` is UNKNOWN):
  `(paymentIntentStatus IS NULL OR paymentIntentStatus NOT IN
  ('processing','requires_action','requires_capture','requires_confirmation','succeeded'))`.
  MEASURED to matter.
- **PaymentIntent creation is idempotent per order.** Two seams: DB
  uniqueness on `stripePaymentIntentId` + Stripe idempotency key
  `pi_<orderId>` + a bounded retry on `idempotency_key_in_use` (Stripe's
  409, distinct from a duplicate) with DB re-read.
- **Refunds are idempotent by our own field, not Stripe's key
  retention.** `Order.stripeRefundId` is unique. Before calling
  `stripe.refunds.create`, check `stripeRefundId` — if set, skip. On
  `charge_already_refunded` or `idempotency_key_in_use`, retrieve the
  existing refund from Stripe by `charge` lookup and persist its id;
  treat as success.
- **Two-transaction refund pattern.** (a) tx1 sets `refundRequestedAt`
  and audits. (b) `stripe.refunds.create` outside any tx. (c) tx2 sets
  `stripeRefundId` and `status = 'REFUNDED'` (which exists —
  `prisma/schema.prisma:28`; not `CANCELLED`). Reconciliation recovers
  crashes.
- **Sweep loops use keyset pagination on `(holdExpiresAt, id)`** to avoid
  spinning on a page of stuck orders. Per-order try/catch; return `{
  expired, released, failed }`; `failed > 0` returns HTTP 207 and emits
  the alert grep string on stderr.
- **No Stripe network call inside an open Postgres transaction.** Refund
  is the only Stripe write in Plan 05 that adjusts DB state; it uses
  two-transaction. Every other Stripe call is a `retrieve` in service of
  a read.
- **Nothing inside a `$transaction` callback references the `db`
  singleton.** Plan 04 constraint, preserved.
- **`import 'server-only'` throws under Vitest.** Tests alias.
- **`src/components/**` may not import from `@/lib/server/*`.** No
  `allowTypeImports` escape. Shared types → `src/lib/shared/`.
- **Tests are Node-env, no DOM.** Payment Element is untested; every
  seam it touches is tested.
- **Test files share one DB and run sequentially.** Every writer file
  begins with `TRUNCATE ... RESTART IDENTITY CASCADE` on the tables it
  touches + `ALTER SEQUENCE "order_reference_seq" RESTART`. **Run the
  suite twice.**
- **`tsx` compiles to CJS.** No top-level `await` in scripts.
- **Money is integer minor units, PLN and EUR.** No conversion.
- **Currency method coupling stays untouched.** `Order.currency` frozen
  at checkout render. SEPA is EUR-only per Stripe.
- **SEPA is behind three guardrails, all computed server-side per
  order:** cap (`SEPA_HOLD_CAP_SHARE = 0.10`), near-sellout hide
  (`SELLOUT_HIDE_THRESHOLD = 0.20`), hard timeout
  (`SEPA_HARD_TIMEOUT_DAYS = 5`). Enforced via `payment_method_types` —
  `automatic_payment_methods` cannot; it has no per-order block-list.
- **The SEPA cap counts the full in-flight population** (`paymentIntentStatus
  IN ('processing', 'requires_action', 'requires_capture',
  'requires_confirmation')`), not only `processing`. If `capacity *
  SEPA_HOLD_CAP_SHARE < 1`, SEPA is allowed unconditionally — otherwise
  a 5-seat concert disables SEPA at count 0.
- **`payment_method_types` allow-list is enforced by Stripe.** If
  `sepa_debit` is not in the array, Stripe refuses the confirmation for
  that PI. Guardrail is real, not client-side hiding.
- **Klarna availability on live PL Stripe is unverified.** Test-mode
  presence is not evidence.
- **The confirmation page is `dynamic = 'force-dynamic'`,
  `fetchCache = 'default-no-store'`.** Plan 04.
- **`robots.ts` disallows `/`, `/*/order/`;** Task 10 adds
  `/api/webhooks/`, `/api/cron/` for the launch flip.
- **next-intl throws on missing keys.** Every wired component gets copy
  in all three locales in the same task.
- **Postgres `now()` is the authoritative clock in SQL.** Sweep cutoffs
  use `now() - make_interval(...)`, not JS `Date.now()`.
- **Vercel Pro is required.** 5-minute crons; `maxDuration > 10s`. Task
  1 Step 7 confirms it.
- **Operational alerting is `console.error('RECONCILE alerts=…')`
  strings on stderr**, grep-able in Vercel logs. Recorded in
  `00-decisions.md` as a stopgap until Plan 07's admin dashboard. **Not**
  email, Slack, or Sentry — those are Plan 08.
- **`psql`/`pg_dump` do not work.** Query through Prisma.
- **Commits are made by the human operator.**

---

## SEPA guardrail

Server-side; enforced by `payment_method_types`; the whole computation is
`computeAllowedPaymentMethods(orderId)` in Task 5.

| Constraint | Default | Env var | Behaviour |
|---|---|---|---|
| Concurrent SEPA holds per concert | `SEPA_HOLD_CAP_SHARE = 0.10` | `SEPA_HOLD_CAP_SHARE` | Count in-flight SEPA orders for the event (`paymentIntentStatus IN ('processing','requires_action','requires_capture','requires_confirmation') AND paymentMethodType = 'sepa_debit'`). If `>= floor(capacity * share)` AND `floor(capacity * share) >= 1`, drop `'sepa_debit'`. The floor guard prevents disabling SEPA at count 0 on small concerts. |
| Near-sellout cut-off | `SELLOUT_HIDE_THRESHOLD = 0.20` | `SELLOUT_HIDE_THRESHOLD` | `available <= floor(capacity * threshold)` drops `'sepa_debit'`. |
| Hard timeout on SEPA holds | `SEPA_HARD_TIMEOUT_DAYS = 5` | `SEPA_HARD_TIMEOUT_DAYS` | Secondary sweep uses days-based cutoff for `paymentMethodType = 'sepa_debit'`. |

`Order.paymentMethodType` is persisted on the **first** webhook of any
type that carries method details. Task 8 uses `pi.latest_charge` (expanded
via `retrieve`) OR `pi.payment_method_types[0]` when the allow-list
already collapsed to one method — reflects `stripe@19.3.1`'s actual type
surface (verified `types/PaymentIntents.d.ts:129`, no `pi.charges`).

---

## Operational alerting

- Every sweep and reconciliation cron emits **stderr** with a fixed
  format: `RECONCILE alerts=<n> failed=<f> deadlettered=<d>`,
  `SWEEP-PRIMARY expired=<e> released=<r> failed=<f>`,
  `SWEEP-ASYNC expired=<e> released=<r> failed=<f>`.
- Owner greps Vercel logs for `alerts=[1-9]` (or the equivalent). The
  string is on stderr — Vercel captures stdout AND stderr into runtime
  logs; response bodies never reach logs.
- **This is a stopgap.** Recorded in `00-decisions.md` under "Payments —
  operational alerting". Plan 07's admin dashboard is what makes ALERTs
  visible without a grep.
- Not: an email, a Slack ping, a Sentry event. Those are Plan 08.

---

## Task 0: Baseline gate

Verify Plan 04's landing state before touching anything.

- [ ] **Step 1: Clean tree, on the payments branch**

```bash
git status && git branch --show-current
```

Expected: clean; branch `feat/plan-04-inventory` (Plan 05 cuts at Task 16).

- [ ] **Step 2: Docker Postgres up, migrations applied, seed**

```bash
docker compose up -d
pnpm exec dotenv -e .env -- prisma migrate deploy
pnpm db:seed
```

Expected: `Seeded 2 venues, 10 concerts, 2 admin accounts.` + `Orders in database: N.`

- [ ] **Step 3: Clean-tree gate green as Plan 04 landed**

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: pass. `Test Files 34 … Tests 290 …`.

- [ ] **Step 4: Sweep and reconcile**

```bash
pnpm holds:sweep
pnpm holds:verify
```

Expected: first run some non-zero counts, second `{"expired":0,"released":0}`. Drift 0.

- [ ] **Per-task verification gate**

Observational only.

---

## Task 1: Owner block — Stripe test account, keys, Vercel Pro

Blocking. Every task from Task 5 onward needs the keys. Task 13 needs
Vercel Pro.

**Secrets never enter a transcript.**

- [ ] **Step 1: Owner — create test-mode Stripe account, country PL**

Dashboard registration; test mode; skip business verification. BLIK/P24
gated on account country.

- [ ] **Step 2: Owner — copy publishable + secret keys into `.env.local`**

Dashboard → Developers → API keys (test mode). `.env.local` git-ignored.
Never paste into a chat.

```
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_placeholder_replace_after_stripe_listen
```

- [ ] **Step 3: Owner — enable payment methods** in dashboard test mode:
  Card, BLIK, Przelewy24, Klarna, SEPA Direct Debit.

- [ ] **Step 4: Confirm file shape**

```bash
test -f .env.local && grep -c '^STRIPE_' .env.local
```

Expected: `3`. Do not `cat` the file.

- [ ] **Step 5: Owner — Stripe CLI and `stripe listen`**

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Copy printed `whsec_...` into `.env.local`.

- [ ] **Step 6: Placeholder gone**

```bash
grep -q '^STRIPE_WEBHOOK_SECRET=whsec_' .env.local && \
  ! grep -q 'whsec_placeholder' .env.local && echo ok
```

Expected: `ok`.

- [ ] **Step 7: Vercel Pro active**

Vercel dashboard → project → Settings → Plan. Confirm "Pro".

5-minute crons and `maxDuration > 10s` are Pro-only; Hobby silently
rejects/downgrades and both sweeps become inert.

- [ ] **Per-task verification gate**

None; downstream tasks fail loudly.

---

## Task 2: Install `stripe`, extend env schema, extend `.env.test`, update `.env.example`

**Files:** `package.json`, `src/lib/server/env-schema.ts`,
`tests/lib/server/env-schema.test.ts`, `.env.test`, `.env.example`.

- [ ] **Step 1: Install pinned versions**

```bash
pnpm add stripe@19.3.1 @stripe/stripe-js@5.7.0 @stripe/react-stripe-js@3.4.0
```

Verified: `latest` on npm is `stripe@22.6.1`; top 19.x is `19.3.1`.
Bumping to 22.x is deferred (API version + package layout changed).

Confirm:

```bash
grep '"stripe"\|@stripe/' package.json
```

Expected: three dependency lines pinned as above.

- [ ] **Step 2: Extend `.env.test` — this step matters most**

MEASURED: without this, ~290 db-importing tests fail at import in Step 6.
Do BEFORE Step 4's schema change.

Append to `.env.test`:

```
STRIPE_PUBLISHABLE_KEY=pk_test_dummy_for_tests_only
STRIPE_SECRET_KEY=sk_test_dummy_for_tests_only
STRIPE_WEBHOOK_SECRET=whsec_dummy_for_tests_only_32chars_min
CRON_SECRET=cron_secret_dummy_for_tests_only_32chars
SEPA_HOLD_CAP_SHARE=0.10
SELLOUT_HIDE_THRESHOLD=0.20
SEPA_HARD_TIMEOUT_DAYS=5
ASYNC_PAYMENT_TIMEOUT_MS=21600000
PAY_CLICK_HOLD_EXTENSION_MS=900000
WEBHOOK_MAX_ATTEMPTS=8
```

These never reach real Stripe — every test mocks the SDK.

- [ ] **Step 3: Env-schema tests first**

Extend `tests/lib/server/env-schema.test.ts`; extend the `valid` fixture
so existing cases pass; add new cases (accept keys; reject missing;
reject the `whsec_placeholder` literal; reject live keys under
`NODE_ENV=development`; defaults for the six numeric config vars;
`SEPA_HOLD_CAP_SHARE` bounds `[0, 1]`; `CRON_SECRET` min-length 32).
Nine new cases.

Run:

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/env-schema.test.ts
```

Expected: new cases fail; existing pass.

- [ ] **Step 4: Extend the schema**

```ts
export const envSchema = z
  .object({
    // …existing five…

    STRIPE_PUBLISHABLE_KEY: z.string().startsWith('pk_'),
    STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .startsWith('whsec_')
      .min(20)
      .refine((v) => v !== 'whsec_placeholder_replace_after_stripe_listen',
        { message: 'STRIPE_WEBHOOK_SECRET is the Task 1 placeholder — run `stripe listen` first' }),

    CRON_SECRET: z.string().min(32),

    ASYNC_PAYMENT_TIMEOUT_MS: z.string().default(String(6 * 60 * 60 * 1000))
      .transform((v) => Number.parseInt(v, 10))
      .refine((n) => Number.isFinite(n) && n >= 30 * 60 * 1000),

    PAY_CLICK_HOLD_EXTENSION_MS: z.string().default(String(15 * 60 * 1000))
      .transform((v) => Number.parseInt(v, 10))
      .refine((n) => Number.isFinite(n) && n >= 60_000),

    SEPA_HOLD_CAP_SHARE: z.string().default('0.10')
      .transform((v) => Number.parseFloat(v))
      .refine((n) => Number.isFinite(n) && n >= 0 && n <= 1),

    SELLOUT_HIDE_THRESHOLD: z.string().default('0.20')
      .transform((v) => Number.parseFloat(v))
      .refine((n) => Number.isFinite(n) && n >= 0 && n <= 1),

    SEPA_HARD_TIMEOUT_DAYS: z.string().default('5')
      .transform((v) => Number.parseInt(v, 10))
      .refine((n) => Number.isFinite(n) && n >= 1),

    WEBHOOK_MAX_ATTEMPTS: z.string().default('8')
      .transform((v) => Number.parseInt(v, 10))
      .refine((n) => Number.isFinite(n) && n >= 1 && n <= 100),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'development' &&
        (v.STRIPE_PUBLISHABLE_KEY.startsWith('pk_live_') ||
         v.STRIPE_SECRET_KEY.startsWith('sk_live_'))) {
      ctx.addIssue({ code: 'custom', path: ['STRIPE_SECRET_KEY'],
        message: 'live Stripe keys in NODE_ENV=development' })
    }
  })
```

Run:

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/env-schema.test.ts
```

Expected: pass.

- [ ] **Step 5: `.env.example`**

Add exact keys and shapes (no real values). Verify with `diff` against
the sorted expected list.

- [ ] **Step 6: Full suite still green — the Task 2 gate**

```bash
pnpm exec dotenv -e .env.test -- vitest run
```

Expected: all 290 existing + 9 new pass. If a db-importing test file
fails at import with `Invalid environment configuration:`, `.env.test`
is missing a var Step 2 was supposed to add.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && pnpm exec dotenv -e .env.test -- vitest run
```

---

## Task 3: Schema migration — four Order columns, ledger columns, sweep index

**Files:** `prisma/schema.prisma`, `prisma/migrations/<TS>_plan_05_pi_state/migration.sql`,
`tests/prisma/schema.test.ts`.

- [ ] **Step 1: Extend `Order` and `StripeWebhookEvent`**

```prisma
model Order {
  // …existing…

  // Mirrors Stripe PaymentIntent.status. Written by createPaymentIntent
  // in the SAME UPDATE as stripePaymentIntentId (initial value
  // 'requires_confirmation'), then updated by every subsequent webhook.
  paymentIntentStatus String?

  // The payment method the buyer chose. Populated by the FIRST webhook
  // that carries method details (via pi.latest_charge or
  // pi.payment_method_types when unambiguous). Used by the SEPA cap.
  paymentMethodType String?

  // Phase 1 of the two-transaction refund. When set and stripeRefundId
  // IS NULL, reconciliation resumes the refund.
  refundRequestedAt DateTime?

  // Phase 3 of the two-transaction refund. Unique to guarantee refund
  // exactly-once independent of Stripe idempotency-key retention.
  stripeRefundId String? @unique

  // …existing indexes plus:
  @@index([status, holdExpiresAt, paymentIntentStatus])
  @@index([refundRequestedAt])
}

model StripeWebhookEvent {
  stripeEventId String    @id
  type          String
  receivedAt    DateTime  @default(now())
  processedAt   DateTime?
  error         String?
  // New:
  attemptCount  Int       @default(0)
  deadLettered  Boolean   @default(false)
  @@index([processedAt, receivedAt])
}
```

Composite index is ordered `[status, holdExpiresAt, paymentIntentStatus]`
so the sweep can range-scan `holdExpiresAt` for `status = 'PENDING'`;
`paymentIntentStatus` is a residual filter. `[status,
paymentIntentStatus, holdExpiresAt]` (a `NOT IN` on col 2 followed by a
range on col 3) prevents the range scan — recorded in Findings.

- [ ] **Step 2: Generate the migration**

```bash
pnpm exec dotenv -e .env -- prisma migrate dev --create-only --name plan_05_pi_state
```

Hangs after applying in non-interactive shells (Plan 04 Task 2 finding).
Kill after the file appears. Inspect: pure `ALTER TABLE ADD COLUMN`
(nullable) + two indexes. Delete any `DEFAULT` Prisma emits.

- [ ] **Step 3: Apply and confirm**

```bash
pnpm exec dotenv -e .env -- prisma migrate deploy
pnpm exec dotenv -e .env -- prisma migrate status
pnpm exec dotenv -e .env -- prisma generate
```

Expected: `Database schema is up to date!`. Client regenerated.

- [ ] **Step 4: Schema test**

Extend `tests/prisma/schema.test.ts`:

```ts
it('Order has paymentIntentStatus, paymentMethodType, refundRequestedAt, stripeRefundId', async () => {
  const cols = await db.$queryRawUnsafe<Array<{ column_name: string }>>(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'Order'
       AND column_name IN ('paymentIntentStatus','paymentMethodType','refundRequestedAt','stripeRefundId')
  `)
  expect(cols.map((c) => c.column_name).sort()).toEqual(
    ['paymentIntentStatus','paymentMethodType','refundRequestedAt','stripeRefundId']
  )
})

it('StripeWebhookEvent has attemptCount, deadLettered', async () => {
  const cols = await db.$queryRawUnsafe<Array<{ column_name: string }>>(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'StripeWebhookEvent'
       AND column_name IN ('attemptCount','deadLettered')
  `)
  expect(cols.map((c) => c.column_name).sort()).toEqual(['attemptCount','deadLettered'])
})
```

Run:

```bash
pnpm exec dotenv -e .env.test -- prisma migrate deploy
pnpm exec dotenv -e .env.test -- vitest run tests/prisma/schema.test.ts
```

Expected: pass.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && pnpm exec dotenv -e .env.test -- vitest run tests/prisma
```

---

## Task 4: Correct design docs

**Files:** `plan/03-purchase-flow.md`, `plan/00-decisions.md`, `HANDOFF.md`.

- [ ] **Step 1: Sweep responsibilities and safety net**

`03-purchase-flow.md` § "Lifecycle of held capacity": update Plan 04/05/06
split. **Delete** the mandate to cancel PI before releasing. Replace with:

> **Plan 05's primary sweep** filters PENDING orders on
> `(paymentIntentStatus IS NULL OR paymentIntentStatus NOT IN
> ('processing','requires_action','requires_capture','requires_confirmation','succeeded'))`,
> releases seats, no Stripe call. Runs every 5 minutes on Vercel cron.
>
> **Plan 05's secondary sweep** handles async methods that stay
> `processing` past the primary window: cutoff `now() - make_interval(...)`
> in SQL, days-based for SEPA, seconds-based for others.
>
> **The safety net when a payment succeeds after seats are released** —
> `fulfilOrder` handles it: `reclaimCapacityForOrder` (Event.status
> guarded) if capacity is available; two-transaction refund
> (`refundRequestedAt` → `stripeRefundId` → `status = REFUNDED`) if not.

Rewrite § "The oversell race, handled explicitly" to name the exact
seams. **Delete** the "nastiest bug in the system" framing about
release-before-cancel — it presumed the wrong safety model.

- [ ] **Step 2: Payment method allow-list**

§ "The checkout submission" step 8: replace `automatic_payment_methods`
with `payment_method_types` computed server-side per order. Reference the
SEPA guardrail section of this plan.

- [ ] **Step 3: Record the owner decision AND async policy AND alerting AND Stripe auto-cancel research**

Append to `plan/00-decisions.md` under a new heading **"Hold expiry does
not call Stripe"**:

> Decided 4 September 2026. When a hold expires the sweep releases seats
> and marks the order EXPIRED; it does **not** call
> `stripe.paymentIntents.cancel`. Reasoning: an abandoned card checkout
> cannot charge — the buyer never confirmed — so cancellation is
> hygiene, not safety. The one dangerous case (releasing seats while a
> payment is genuinely in flight) is protected by
> `Order.paymentIntentStatus` on the sweep predicate, not by a network
> call. A late `payment_intent.succeeded` after release takes the
> reclaim-or-refund path (`fulfilOrder` in Plan 05). This inverts the
> guidance in `03-purchase-flow.md` § "Lifecycle" that mandated
> cancel-before-release; that doc is corrected in the same commit.
>
> **Stripe's automatic cancellation** — verify against
> `node_modules/stripe/types/PaymentIntents.d.ts` and Stripe's docs, then
> record the answer here. If Stripe auto-cancels abandoned PIs after N
> hours/days, the hygiene concern is fully handled; if not, an explicit
> cancellation pass is a Plan 06 clean-up item. The plan does not depend
> on the answer.

Append **"Async-payment hold policy (4 Sep 2026)"**: secondary sweep
timeouts (6h default, SEPA 5 business days), reclaim + refund on late
success.

Append **"SEPA Direct Debit enabled with server-side guardrails (4 Sep
2026)"**: three guardrails, defaults, tunability.

Append **"Payments — operational alerting (stopgap, 4 Sep 2026)"**:
stderr-grep mechanism, unmonitored beyond that until Plan 07.

- [ ] **Step 4: `HANDOFF.md` operations**

Add subsection "Operations — payments" describing exactly how to spot
ALERTs (grep Vercel logs) and where the reconciliation cron runs.

- [ ] **Step 5: Verify parity test**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/i18n tests/lib/shared
```

Expected: pass.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint
```

---

## Task 5: Stripe wrapper + allowed-methods computation

**Files:** `src/lib/server/stripe.ts`, `src/lib/server/payment-methods.ts`,
`tests/lib/server/stripe.test.ts`, `tests/lib/server/payment-methods.test.ts`.

- [ ] **Step 1: Wrapper tests first — no `require`, no network**

```ts
import { describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import { stripe, stripeCurrency, stripeAmount } from '@/lib/server/stripe'
import * as stripeModule from '@/lib/server/stripe'  // same-file identity

describe('stripe wrapper', () => {
  it('exports a single client instance', () => {
    expect(stripe).toBe(stripeModule.stripe)
  })
  it('uses a real Stripe client', () => { expect(stripe).toBeInstanceOf(Stripe) })
  it('lowercases currency', () => { expect(stripeCurrency('PLN')).toBe('pln'); expect(stripeCurrency('EUR')).toBe('eur') })
  it('reads amount from the order', () => { expect(stripeAmount({total:12345, currency:'PLN', id:'o1'})).toBe(12345) })
  it('refuses zero-amount', () => { expect(() => stripeAmount({total:0, currency:'PLN', id:'o1'})).toThrow(/zero-amount/i) })
})
```

Run and fail.

- [ ] **Step 2: Implement `stripe.ts`**

```ts
import 'server-only'
import Stripe from 'stripe'
import { env } from './env'

function createClient(): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, { typescript: true })
  // No apiVersion override — the SDK version pins it. Bumping SDK majors
  // is a separate plan item.
}

const g = globalThis as unknown as { stripe?: Stripe }
export const stripe = g.stripe ?? createClient()
if (env.NODE_ENV !== 'production') g.stripe = stripe

export function stripeCurrency(c: 'PLN' | 'EUR'): 'pln' | 'eur' {
  return c === 'PLN' ? 'pln' : 'eur'
}

export function stripeAmount(order: { total: number; currency: 'PLN' | 'EUR'; id: string }): number {
  if (order.total <= 0) throw new Error(`stripeAmount: zero-amount order ${order.id} (total=${order.total})`)
  return order.total
}
```

Green.

- [ ] **Step 3: `payment-methods.ts` tests first**

Cases:

| # | Case | Expected |
|---|---|---|
| 1 | PLN order, plenty of capacity, no in-flight | `['card','blik','p24']` |
| 2 | EUR, plenty capacity, no SEPA | `['card','klarna','sepa_debit']` |
| 3 | EUR, SEPA cap reached (10% of capacity in-flight SEPA) | `['card','klarna']` |
| 4 | EUR, near-sellout | `['card','klarna']` |
| 5 | PLN, near-sellout | `['card','blik','p24']` |
| 6 | EUR, tiny concert (capacity 5, cap floor = 0) | `['card','klarna','sepa_debit']` — floor guard kicks in |
| 7 | EUR, in-flight SEPA counts `requires_confirmation`, not just `processing` | cap works from the moment createPaymentIntent claims |
| 8 | Order does not exist | throws Prisma P2025 |

**Env-override tests** need `vi.resetModules()` around `vi.mock` of
`@/lib/server/env` — MEASURED: `env.ts` parses `process.env` once at
import. Pattern (put in test-utils if reused):

```ts
async function withEnv(overrides: Record<string, string>, fn: () => Promise<void>) {
  vi.resetModules()
  const originals = { ...process.env }
  Object.assign(process.env, overrides)
  try { await fn() } finally { process.env = originals; vi.resetModules() }
}
```

- [ ] **Step 4: Implement `payment-methods.ts`**

```ts
import 'server-only'
import { db } from './db'
import { env } from './env'

const IN_FLIGHT_PI_STATUSES = ['processing', 'requires_action', 'requires_capture', 'requires_confirmation'] as const

export async function computeAllowedPaymentMethods(orderId: string): Promise<string[]> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      currency: true,
      items: {
        select: {
          ticketType: {
            select: {
              eventId: true,
              event: { select: { capacity: true } },
            },
          },
        },
      },
    },
  })

  const methods = new Set<string>(['card'])

  if (order.currency === 'PLN') {
    methods.add('blik')
    methods.add('p24')
  } else {
    methods.add('klarna')

    const eventId = order.items[0].ticketType.eventId
    const capacity = order.items[0].ticketType.event.capacity

    // Near-sellout — cheaper than the SEPA-cap join.
    const totals = await db.ticketType.aggregate({
      where: { eventId },
      _sum: { soldCount: true, heldCount: true },
    })
    const available = capacity - (totals._sum.soldCount ?? 0) - (totals._sum.heldCount ?? 0)
    const nearSellout = available <= Math.floor(capacity * env.SELLOUT_HIDE_THRESHOLD)

    // SEPA cap — count in-flight (any of the four PI states), not just processing.
    const sepaCap = Math.floor(capacity * env.SEPA_HOLD_CAP_SHARE)
    let sepaBlocked = false
    if (sepaCap >= 1) {  // guard: capacity too small to have a meaningful cap
      const sepaHolds = await db.order.count({
        where: {
          status: 'PENDING',
          paymentIntentStatus: { in: [...IN_FLIGHT_PI_STATUSES] },
          paymentMethodType: 'sepa_debit',
          items: { some: { ticketType: { eventId } } },
        },
      })
      sepaBlocked = sepaHolds >= sepaCap
    }

    if (!nearSellout && !sepaBlocked) methods.add('sepa_debit')
  }

  return [...methods]
}
```

- [ ] **Step 5: Green**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/stripe.test.ts tests/lib/server/payment-methods.test.ts
```

Expected: pass.

- [ ] **Step 6: NEGATIVE CONTROLS — each provably fails**

- Comment out the SEPA-cap block; re-run Test 3 → returned array includes
  `sepa_debit`. Test fails. Record. Restore.
- Comment out the near-sellout block; re-run Test 4 → `sepa_debit` still
  present. Fails. Record. Restore.
- Remove the `sepaCap >= 1` floor guard; re-run Test 6 → `sepa_debit`
  dropped for a tiny concert (`sepaHolds >= 0` is always true). Fails.
  Record. Restore.
- Change the IN_FLIGHT list to `['processing']` only; re-run Test 7 → cap
  count is 0 (no `processing` orders because they are all in
  `requires_confirmation`). `sepa_debit` present. Fails. Record. Restore.

Env-override control (Test 3 mutating `SEPA_HOLD_CAP_SHARE`) uses the
`withEnv` helper above — verifies the env parse is what would fail
otherwise.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/stripe.test.ts tests/lib/server/payment-methods.test.ts
```

---

## Task 6: `createPaymentIntent(orderId)` — writes PI status, extends hold

**Files:** `src/lib/server/payment-intent.ts`,
`tests/lib/server/payment-intent.test.ts`, plus a `paymentIntentStatus`
column write in the claim UPDATE.

- [ ] **Step 1: Contract**

```ts
async function createPaymentIntent(orderId: string): Promise<{
  clientSecret: string; paymentIntentId: string; publishableKey: string
}>
```

Task 12's action layer calls `extendHoldAction` (which also calls
`createPaymentIntent`) — Pay-click sets both `stripePaymentIntentId` +
`paymentIntentStatus = 'requires_confirmation'` in one UPDATE and
extends `holdExpiresAt`.

- [ ] **Step 2: Tests first — `vi.hoisted`, no `require`**

```ts
const { paymentIntentsCreate, paymentIntentsRetrieve } = vi.hoisted(() => ({
  paymentIntentsCreate: vi.fn(),
  paymentIntentsRetrieve: vi.fn(),
}))
vi.mock('@/lib/server/stripe', () => ({
  stripe: { paymentIntents: { create: paymentIntentsCreate, retrieve: paymentIntentsRetrieve } },
  stripeCurrency: (c: 'PLN'|'EUR') => (c === 'PLN' ? 'pln' : 'eur'),
  stripeAmount: (o: {total:number}) => o.total,
}))
vi.mock('@/lib/server/payment-methods', () => ({
  computeAllowedPaymentMethods: vi.fn(async () => ['card','blik','p24']),
}))
```

Eleven cases:

| # | Case | Expected |
|---|---|---|
| 1 | Happy — first call | `create` once, `Order.stripePaymentIntentId` set, `paymentIntentStatus = 'requires_confirmation'` set in the SAME UPDATE |
| 2 | Second call | `retrieve` called, `create` NOT called, same clientSecret |
| 3 | Concurrent — Promise.all(2), mock returns two DIFFERENT ids (simulating the collision-guard failure mode) | assert exactly one order id survives; the loser's UPDATE returns zero rows and the sanity check `if (winner.id !== pi.id) throw` fires — test asserts the throw |
| 4 | 409 `idempotency_key_in_use` on first call | wait 250ms, re-read DB, retrieve if now present, else retry create; total up to 3 attempts |
| 5 | Order not PENDING | `PaymentIntentReuseError('notPending')` |
| 6 | Order PAID | `PaymentIntentReuseError('alreadyPaid')` |
| 7 | Order does not exist | Prisma P2025 |
| 8 | Amount from DB — mutate `Order.total` between createOrder and createPaymentIntent, assert `create` called with mutated value | verifies amount authority |
| 9 | Currency EUR → `create` called with `currency: 'eur'` | correct |
| 10 | Zero-amount refusal | `stripeAmount` throws |
| 11 | `payment_method_types` came from `computeAllowedPaymentMethods` | mock returns `['card','sepa_debit']`; create called with that exactly |

Run and fail.

- [ ] **Step 3: Implement — key snippets**

```ts
const IDEMPOTENCY_RETRY_LIMIT = 3
const IDEMPOTENCY_BACKOFF_MS = 250

export async function createPaymentIntent(orderId: string) {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, reference: true, email: true, total: true,
              currency: true, status: true, stripePaymentIntentId: true },
  })

  if (['PAID','REFUNDED','PARTIALLY_REFUNDED'].includes(order.status)) {
    throw new PaymentIntentReuseError('alreadyPaid')
  }
  if (order.status !== 'PENDING') throw new PaymentIntentReuseError('notPending')

  if (order.stripePaymentIntentId) {
    const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId)
    return { clientSecret: pi.client_secret!, paymentIntentId: pi.id, publishableKey: env.STRIPE_PUBLISHABLE_KEY }
  }

  const methods = await computeAllowedPaymentMethods(order.id)
  const params: Stripe.PaymentIntentCreateParams = {
    amount: stripeAmount(order),
    currency: stripeCurrency(order.currency),
    payment_method_types: methods,
    metadata: { orderId: order.id, reference: order.reference },
    receipt_email: order.email,
  }

  const pi = await createWithRetry(params, `pi_${order.id}`, order.id)

  // Claim UPDATE — write BOTH fields together so the sweep predicate is
  // never inconsistent. Guarded on IS NULL so a concurrent winner is
  // detected.
  const claimed = await db.$queryRawUnsafe<Array<{id:string}>>(
    `UPDATE "Order"
        SET "stripePaymentIntentId" = $1,
            "paymentIntentStatus"    = 'requires_confirmation'
      WHERE id = $2 AND "stripePaymentIntentId" IS NULL
    RETURNING id`,
    pi.id, order.id,
  )
  if (claimed.length === 0) {
    const winner = await db.order.findUniqueOrThrow({
      where: { id: order.id }, select: { stripePaymentIntentId: true },
    })
    if (winner.stripePaymentIntentId !== pi.id) {
      throw new Error(`Idempotency-key collision: local ${pi.id}, DB ${winner.stripePaymentIntentId}`)
    }
  }

  return { clientSecret: pi.client_secret!, paymentIntentId: pi.id, publishableKey: env.STRIPE_PUBLISHABLE_KEY }
}

async function createWithRetry(params, idempotencyKey, orderId) {
  for (let attempt = 0; attempt < IDEMPOTENCY_RETRY_LIMIT; attempt++) {
    try { return await stripe.paymentIntents.create(params, { idempotencyKey }) }
    catch (e) {
      const err = e as { code?: string; raw?: { code?: string } }
      const code = err.raw?.code ?? err.code
      if (code === 'idempotency_key_in_use') {
        await new Promise(r => setTimeout(r, IDEMPOTENCY_BACKOFF_MS))
        const now = await db.order.findUniqueOrThrow({
          where: { id: orderId }, select: { stripePaymentIntentId: true },
        })
        if (now.stripePaymentIntentId) return stripe.paymentIntents.retrieve(now.stripePaymentIntentId)
        continue
      }
      throw e
    }
  }
  throw new Error(`createPaymentIntent: idempotency_key_in_use after ${IDEMPOTENCY_RETRY_LIMIT} retries`)
}
```

- [ ] **Step 4: Green + NEGATIVE CONTROLS**

- Remove the `paymentIntentStatus = 'requires_confirmation'` write from
  the UPDATE. Re-run any Task 11 sweep test with an order that just had a
  PI created. Expected: sweep predicate misses it (or hits it, depending
  on the predicate form). Record. Restore.
- Remove `WHERE "stripePaymentIntentId" IS NULL`. Re-run case 3 with mock
  returning DIFFERENT ids. Expected: both writes succeed, the second
  overwrites the first, sanity throw doesn't fire, test fails. Record.
  Restore.
- Reduce `IDEMPOTENCY_RETRY_LIMIT` to 0. Re-run case 4 → throws
  immediately. Fails. Record. Restore.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/payment-intent.test.ts
```

---

## Task 7: `fulfilOrder(orderId, refundHook, pi)` — the primary safety net

**Files:** `src/lib/server/orders.ts` (add `fulfilOrder`,
`EventNoLongerPurchasableError`, refund helper, extend
`reclaimCapacityForOrder`), split test file to
`tests/lib/server/fulfil-order.test.ts` (`orders.test.ts` is already 16 KB).

- [ ] **Step 1: Contract**

```ts
type FulfilResult =
  | { fulfilled: true; ticketIds: string[] }
  | { skipped: 'alreadyFulfilled' }
  | { refunded: true; reason: 'oversoldOnLateSuccess' | 'eventCancelledOnLateSuccess' | 'terminalStateOnLateSuccess' }

async function fulfilOrder(orderId: string, refundHook: RefundHook, pi: Stripe.PaymentIntent): Promise<FulfilResult>
```

Transitions per critique row on `fulfilOrder`'s non-fulfilable branch:
`FAILED`/`CANCELLED` → REFUNDED, not skip.

- [ ] **Step 2: Tests first — 11 cases**

Extend earlier draft; case 11 is now 100 orders / 1000 tickets with
`testTimeout: 60_000`, distinct emails, `capacity: 10_000`.

Case 10 (PI cross-check) uses a PI with `amount_received` different from
`Order.total` → throws before any DB write.

- [ ] **Step 3: Implement — three specifics**

```ts
import Stripe from 'stripe'
import { randomBytes } from 'node:crypto'

function ticketCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const bytes = randomBytes(16)
  let out = '', value = 0, bits = 0
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31]
  return out
}

export class EventNoLongerPurchasableError extends Error {
  constructor(readonly reason: 'cancelled' | 'closed' | 'draft') {
    super(`Event no longer purchasable: ${reason}`)
    this.name = 'EventNoLongerPurchasableError'
  }
}

export type RefundHook = (paymentIntentId: string, chargeId: string | null) => Promise<{ refundId: string }>

export async function fulfilOrder(orderId: string, refundHook: RefundHook, pi: Stripe.PaymentIntent): Promise<FulfilResult> {
  // PI cross-check FIRST, before any DB write.
  const order0 = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, total: true, currency: true, stripePaymentIntentId: true, stripeRefundId: true },
  })
  if (pi.id !== order0.stripePaymentIntentId) {
    throw new Error(`fulfilOrder: PI id mismatch: pi=${pi.id}, order=${order0.stripePaymentIntentId}`)
  }
  if (pi.amount_received !== order0.total) {
    throw new Error(`fulfilOrder: amount mismatch: pi=${pi.amount_received}, order=${order0.total}`)
  }
  if (pi.currency !== order0.currency.toLowerCase()) {
    throw new Error(`fulfilOrder: currency mismatch: pi=${pi.currency}, order=${order0.currency}`)
  }
  // If a refund already went out for this order, do nothing.
  if (order0.stripeRefundId) return { skipped: 'alreadyFulfilled' }

  const result = await db.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true, status: true, stripePaymentIntentId: true, attendeeNames: true,
        items: { select: { ticketTypeId: true, quantity: true,
                           ticketType: { select: { eventId: true } } } },
      },
    })

    if (['PAID','REFUNDED','PARTIALLY_REFUNDED'].includes(order.status)) {
      return { skipped: 'alreadyFulfilled' as const }
    }

    if (order.status === 'EXPIRED') {
      try { await reclaimCapacityForOrder(order.id, tx) }
      catch (e) {
        if (e instanceof InsufficientCapacityError) return { needsRefund: 'oversoldOnLateSuccess' as const }
        if (e instanceof EventNoLongerPurchasableError) return { needsRefund: 'eventCancelledOnLateSuccess' as const }
        throw e
      }
    } else if (order.status === 'FAILED' || order.status === 'CANCELLED') {
      return { needsRefund: 'terminalStateOnLateSuccess' as const }
    } else if (order.status !== 'PENDING') {
      return { skipped: 'alreadyFulfilled' as const }
    }

    // ABBA-safe: Event lock first, matching holdCapacity.
    const eventId = order.items[0].ticketType.eventId
    await tx.$executeRawUnsafe(`SELECT id FROM "Event" WHERE id = $1 FOR UPDATE`, eventId)

    for (const item of order.items) {
      const rows = await tx.$queryRawUnsafe<Array<{id:string}>>(
        `UPDATE "TicketType"
            SET "heldCount" = "heldCount" - $1,
                "soldCount" = "soldCount" + $1,
                "updatedAt" = now()
          WHERE id = $2 AND "heldCount" >= $1
        RETURNING id`,
        item.quantity, item.ticketTypeId,
      )
      if (rows.length === 0) throw new Error(`fulfilOrder: heldCount too low for ${item.ticketTypeId}`)
    }

    const paid = await tx.$queryRawUnsafe<Array<{id:string}>>(
      `UPDATE "Order" SET status = 'PAID', "paidAt" = now()
        WHERE id = $1 AND status IN ('PENDING') RETURNING id`, orderId)
    if (paid.length === 0) throw new Error(`fulfilOrder: not PENDING at PAID transition`)

    const attendees = (order.attendeeNames as Array<{index:number;name:string}> | null) ?? []
    const byIndex = new Map(attendees.map((a) => [a.index, a.name]))
    const ticketIds: string[] = []
    let idx = 0
    for (const item of order.items) {
      for (let i = 0; i < item.quantity; i++) {
        const c = await tx.ticket.create({
          data: { code: ticketCode(), orderId, eventId: item.ticketType.eventId,
                  ticketTypeId: item.ticketTypeId, holderName: byIndex.get(idx) ?? null, status: 'VALID' },
          select: { id: true },
        })
        ticketIds.push(c.id); idx += 1
      }
    }

    await tx.$executeRawUnsafe(
      `UPDATE "Event" SET status = 'SOLD_OUT'
        WHERE id = $1 AND status = 'ON_SALE'
          AND capacity <= (SELECT COALESCE(SUM("soldCount"), 0) FROM "TicketType" WHERE "eventId" = $1)`,
      eventId,
    )

    await recordAudit({ action: 'order.fulfil', entityType: 'Order', entityId: orderId,
      meta: { ticketCount: ticketIds.length, paymentIntentId: order.stripePaymentIntentId } }, tx)

    return { fulfilled: true as const, ticketIds }
  })

  if ('needsRefund' in result) return processLateSuccessRefund(orderId, result.needsRefund, refundHook, pi)
  return result
}

async function processLateSuccessRefund(orderId, reason, refundHook, pi) {
  // Phase 1
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { refundRequestedAt: new Date() } })
    await recordAudit({ action: 'order.refund_requested', entityType: 'Order', entityId: orderId,
      meta: { reason, paymentIntentId: pi.id, severity: 'ALERT' } }, tx)
  })

  // Phase 2 — outside any DB transaction.
  const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id ?? null
  const { refundId } = await refundHook(pi.id, chargeId)

  // Phase 3
  await db.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { status: 'REFUNDED', stripeRefundId: refundId },
    })
    await recordAudit({ action: 'order.refunded', entityType: 'Order', entityId: orderId,
      meta: { reason, paymentIntentId: pi.id, refundId } }, tx)
  })

  return { refunded: true, reason }
}
```

Refund hook (in Task 9 dispatch closure) handles success-equivalent errors:

```ts
const refund: RefundHook = async (piId, chargeId) => {
  try {
    const r = await stripe.refunds.create(
      { payment_intent: piId, reason: 'requested_by_customer' },
      { idempotencyKey: `refund_${piId}` },
    )
    return { refundId: r.id }
  } catch (e) {
    const err = e as { raw?: { code?: string } }
    const code = err.raw?.code
    if (code === 'charge_already_refunded' || code === 'idempotency_key_in_use') {
      // Retrieve existing refund from charge or PI.
      if (chargeId) {
        const list = await stripe.refunds.list({ charge: chargeId, limit: 1 })
        if (list.data[0]) return { refundId: list.data[0].id }
      }
      const list = await stripe.refunds.list({ payment_intent: piId, limit: 1 })
      if (list.data[0]) return { refundId: list.data[0].id }
      throw new Error(`refund: ${code} but no existing refund found for ${piId}`)
    }
    throw e
  }
}
```

Also extend `reclaimCapacityForOrder` (`orders.ts:305` verified):

```ts
export async function reclaimCapacityForOrder(orderId, tx) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      status: true,
      items: { select: { ticketTypeId: true, quantity: true,
                         ticketType: { select: { event: { select: { status: true } } } } } },
    },
  })
  if (order.status !== 'EXPIRED') throw new Error(`reclaimCapacityForOrder: order ${orderId} is ${order.status}`)

  const eventStatus = order.items[0].ticketType.event.status
  if (!['ON_SALE', 'SOLD_OUT'].includes(eventStatus)) {
    throw new EventNoLongerPurchasableError(
      eventStatus === 'CANCELLED' ? 'cancelled' :
      eventStatus === 'CLOSED' ? 'closed' : 'draft')
  }
  // …existing hold + status logic…
}
```

- [ ] **Step 4: Green**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/fulfil-order.test.ts tests/lib/server/orders.test.ts
```

Expected: pass.

- [ ] **Step 5: NEGATIVE CONTROLS**

- **PI cross-check** — remove the three assertions before the tx. Re-run
  case 10. Fails. Record. Restore.
- **Terminal-state refund** — change `FAILED`/`CANCELLED` back to
  `skipped: 'alreadyFulfilled'`. Re-run case 9. `refundHook` not called;
  test fails. Record. Restore.
- **Event.status reclaim guard** — remove the check. Re-run case 8.
  Reclaim proceeds against CANCELLED event, Ticket rows issued; test
  fails. Record. Restore.
- **ABBA** — deterministic re-order: swap `SELECT ... FOR UPDATE` after
  the TicketType UPDATE. Run a specific serial test that fires two
  `Promise.all`: `[fulfilOrder(order), holdCapacity(anotherOrder)]` on
  the same event with a `setTimeout(50)` before the `FOR UPDATE` inside
  `holdCapacity` (mock the timing so ordering is deterministic).
  Expected: deadlock 40P01 caught in one of the two. Fails. Record.
  Restore.
- **`stripeRefundId` idempotency** — remove the pre-tx short-circuit
  `if (order0.stripeRefundId) return skipped`. Fire two `fulfilOrder`s
  for the same order + refund reason. Expected: second call attempts
  another refund path; `refunds.create` is called twice; test fails on
  the mock call count. Record. Restore.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib/server
```

---

## Task 8: `recordPaymentAttempt` — payment_failed/processing/requires_action; `pi.latest_charge`

**Files:** `src/lib/server/orders.ts` (add `recordPaymentAttempt`,
`extractPaymentMethodType`), tests in the same suite.

- [ ] **Step 1: Contract**

```ts
async function recordPaymentAttempt(
  orderId: string,
  pi: Stripe.PaymentIntent,
  meta: { reason: 'processing' | 'requires_action' | 'declined' },
): Promise<void>
```

Persists `Order.paymentIntentStatus` = `pi.status` and
`Order.paymentMethodType` (from `pi.latest_charge`); writes an audit row;
**does not touch `Order.status`**. That is the whole point.

- [ ] **Step 2: Tests first**

| # | Case | Expected |
|---|---|---|
| 1 | `payment_failed` on PENDING | `Order.status` PENDING; `paymentIntentStatus = 'requires_payment_method'`; audit `stripe.declined`; hold intact |
| 2 | Buyer retries card successfully after decline | fulfilOrder proceeds normally |
| 3 | `processing` | `paymentIntentStatus = 'processing'`, `paymentMethodType` from `pi.latest_charge` or `pi.payment_method_types[0]` |
| 4 | `requires_action` | `paymentIntentStatus = 'requires_action'`; no method write if not yet decided |
| 5 | `pi.latest_charge` present (expanded object) | `paymentMethodType` extracted from `charge.payment_method_details.type` |
| 6 | `pi.latest_charge` is a string (unexpanded) | fall through to `pi.payment_method_types` — persist first element if length 1, else null |
| 7 | `pi.charges` referenced anywhere | tsc error — the test asserts the field doesn't exist on `stripe@19.3.1`'s type via a type-only import |

- [ ] **Step 3: Implement**

```ts
export async function recordPaymentAttempt(orderId, pi, meta) {
  await db.order.update({
    where: { id: orderId },
    data: {
      paymentIntentStatus: pi.status,
      paymentMethodType: extractPaymentMethodType(pi),
    },
  })
  await recordAudit({
    action: `stripe.${meta.reason}`,
    entityType: 'Order',
    entityId: orderId,
    meta: {
      paymentIntentId: pi.id,
      status: pi.status,
      lastPaymentError: pi.last_payment_error?.code ?? null,
    },
  })
}

export function extractPaymentMethodType(pi: Stripe.PaymentIntent): string | null {
  // stripe@19.3.1: pi.charges does NOT exist (verified types/PaymentIntents.d.ts:129).
  // Use pi.latest_charge — string | Stripe.Charge | null. When expanded via retrieve,
  // read the charge's payment_method_details.type.
  const lc = pi.latest_charge
  if (lc && typeof lc !== 'string') {
    const t = lc.payment_method_details?.type
    if (t) return t
  }
  // Fall back to the allow-list — reliable only if it collapsed to one method.
  if (pi.payment_method_types.length === 1) return pi.payment_method_types[0]
  return null
}
```

For webhooks (Task 9), the dispatch retrieves the PI with
`expand: ['latest_charge']` when it needs the method — Task 9 handles it.

- [ ] **Step 4: Green + NEGATIVE CONTROL**

Change `recordPaymentAttempt` on `payment_failed` to call `failOrder`
instead. Re-run case 2 — buyer's retry lands on FAILED; test fails.
Record. Restore.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/orders.test.ts
```

---

## Task 9: Webhook event dispatch

**Files:** `src/lib/server/webhook-dispatch.ts`,
`tests/lib/server/webhook-dispatch.test.ts`.

- [ ] **Step 1: Table**

| Event | Action | Order.status |
|---|---|---|
| `payment_intent.succeeded` | expand `latest_charge` via retrieve, then `fulfilOrder(orderId, refund, pi)` | PENDING → PAID (or REFUNDED via late branches) |
| `payment_intent.processing` | `recordPaymentAttempt(orderId, pi, { reason: 'processing' })` | unchanged |
| `payment_intent.requires_action` | `recordPaymentAttempt(orderId, pi, { reason: 'requires_action' })` | unchanged |
| `payment_intent.payment_failed` | `recordPaymentAttempt(orderId, pi, { reason: 'declined' })` | **unchanged (PENDING)** |
| `payment_intent.canceled` | `failOrder(orderId, 'stripe.canceled:…')` | PENDING → FAILED |
| `charge.dispute.created` | audit `stripe.dispute` at ALERT | unchanged |
| anything else | 200 ignore | unchanged |

- [ ] **Step 2: Tests first — 10 cases + `vi.hoisted` mocks**

Cases as before + the `latest_charge` expand call on `succeeded` (mock
`paymentIntents.retrieve` to return the same PI with `latest_charge`
expanded).

- [ ] **Step 3: Implement**

```ts
import 'server-only'
import { z } from 'zod'
import type Stripe from 'stripe'
import { recordAudit } from './audit'
import { failOrder, fulfilOrder, recordPaymentAttempt, type RefundHook } from './orders'
import { stripe } from './stripe'

export class WebhookMalformedError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'WebhookMalformedError' }
}

const orderIdSchema = z.uuid()

export async function dispatchWebhookEvent(event: Stripe.Event) {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi0 = event.data.object as Stripe.PaymentIntent
      const orderId = extractOrderId(pi0)
      // Expand latest_charge so extractPaymentMethodType sees the object.
      const pi = await stripe.paymentIntents.retrieve(pi0.id, { expand: ['latest_charge'] })
      const refund: RefundHook = async (piId, chargeId) => {
        try {
          const r = await stripe.refunds.create(
            { payment_intent: piId, reason: 'requested_by_customer' },
            { idempotencyKey: `refund_${piId}` },
          )
          return { refundId: r.id }
        } catch (e) {
          const code = (e as {raw?:{code?:string}}).raw?.code
          if (code === 'charge_already_refunded' || code === 'idempotency_key_in_use') {
            const list = await stripe.refunds.list(
              chargeId ? { charge: chargeId, limit: 1 } : { payment_intent: piId, limit: 1 }
            )
            if (list.data[0]) return { refundId: list.data[0].id }
            throw new Error(`refund: ${code} but no existing refund for ${piId}`)
          }
          throw e
        }
      }
      const result = await fulfilOrder(orderId, refund, pi)
      return { acknowledged: true as const, action: 'fulfilOrder', detail: JSON.stringify(result) }
    }
    case 'payment_intent.processing': {
      const pi = event.data.object as Stripe.PaymentIntent
      const orderId = extractOrderId(pi)
      // Expand for method extraction.
      const piExp = await stripe.paymentIntents.retrieve(pi.id, { expand: ['latest_charge'] })
      await recordPaymentAttempt(orderId, piExp, { reason: 'processing' })
      return { acknowledged: true as const, action: 'processing' }
    }
    case 'payment_intent.requires_action': {
      const pi = event.data.object as Stripe.PaymentIntent
      await recordPaymentAttempt(extractOrderId(pi), pi, { reason: 'requires_action' })
      return { acknowledged: true as const, action: 'requires_action' }
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent
      await recordPaymentAttempt(extractOrderId(pi), pi, { reason: 'declined' })
      return { acknowledged: true as const, action: 'declined' }
    }
    case 'payment_intent.canceled': {
      const pi = event.data.object as Stripe.PaymentIntent
      const result = await failOrder(extractOrderId(pi), `stripe.canceled:${pi.cancellation_reason ?? 'unknown'}`)
      return { acknowledged: true as const, action: 'failOrder', detail: JSON.stringify(result) }
    }
    case 'charge.dispute.created': {
      const d = event.data.object as Stripe.Dispute
      await recordAudit({
        action: 'stripe.dispute', entityType: 'Charge',
        entityId: typeof d.charge === 'string' ? d.charge : d.charge.id,
        meta: { severity: 'ALERT', reason: d.reason, amount: d.amount, currency: d.currency },
      })
      return { acknowledged: true as const, action: 'dispute_flagged' }
    }
    default:
      return { acknowledged: true as const, action: 'ignored', detail: event.type }
  }
}

function extractOrderId(pi: Stripe.PaymentIntent): string {
  const parsed = orderIdSchema.safeParse(pi.metadata?.orderId)
  if (!parsed.success) throw new WebhookMalformedError(`PaymentIntent ${pi.id} metadata.orderId invalid`)
  return parsed.data
}
```

- [ ] **Step 4: Green + NEGATIVE CONTROL**

Route `payment_failed` to `failOrder`. Re-run case 4 — assert
`recordPaymentAttempt` called and `failOrder` NOT. Fails. Record.
Restore.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/webhook-dispatch.test.ts
```

---

## Task 10: Webhook route — row-lock ledger, attempt counter, dead-letter

**Files:** `src/app/api/webhooks/stripe/route.ts`,
`tests/app/api/stripe-webhook.test.ts`, `src/app/robots.ts`.

- [ ] **Step 1: Ledger flow, corrected**

1. Verify signature.
2. `INSERT ... ON CONFLICT DO NOTHING RETURNING`.
3. Whether row is ours or existing, take `SELECT ... FOR UPDATE` on it —
   serialises concurrent deliveries of the same event id.
4. If `processedAt IS NOT NULL`: 200, no dispatch.
5. If `deadLettered = true`: 200, no dispatch (already given up).
6. If `attemptCount >= WEBHOOK_MAX_ATTEMPTS`: set `deadLettered = true`,
   ALERT audit, 200 (further retries are noise).
7. Otherwise: increment `attemptCount`, dispatch. On success set
   `processedAt = now()`, `error = NULL`. On `WebhookMalformedError` set
   `processedAt = now()`, `error = <msg>` and return 400 (a corrected
   payload never arrives on retry). On other throw: leave `processedAt =
   NULL`, set `error`, throw so route returns 500.

- [ ] **Step 2: Tests first — 8 cases**

| # | Case | Expected |
|---|---|---|
| 1 | Happy | dispatch called; row `processedAt` set, `attemptCount = 1`; 200 |
| 2 | **NEGATIVE CONTROL — forged signature** | 400; no ledger; no dispatch |
| 3 | Duplicate delivery (previous attempt processedAt set) | 200, dispatch NOT called |
| 4 | Concurrent double-dispatch — two calls with same event id race | dispatch called EXACTLY ONCE; the second waits on FOR UPDATE and short-circuits |
| 5 | First attempt fails; retry succeeds | first 500, second 200, dispatch called twice, attemptCount ends at 2 |
| 6 | Dead-letter — attemptCount hits WEBHOOK_MAX_ATTEMPTS | row marked deadLettered, ALERT audit written, 200 |
| 7 | WebhookMalformedError | 400, processedAt set (do not retry), error populated |
| 8 | Missing `stripe-signature` header | 400 |

- [ ] **Step 3: Implement**

```ts
import type Stripe from 'stripe'
import { NextResponse } from 'next/server'
import { db } from '@/lib/server/db'
import { env } from '@/lib/server/env'
import { stripe } from '@/lib/server/stripe'
import { dispatchWebhookEvent, WebhookMalformedError } from '@/lib/server/webhook-dispatch'
import { recordAudit } from '@/lib/server/audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get('stripe-signature')
  if (!signature) return new NextResponse('missing stripe-signature', { status: 400 })

  const raw = await request.text()

  let event: Stripe.Event
  try { event = stripe.webhooks.constructEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET) }
  catch (e) { return new NextResponse(`invalid signature: ${(e as Error).message}`, { status: 400 }) }

  return db.$transaction(async (tx) => {
    // Insert-or-continue.
    await tx.$executeRawUnsafe(
      `INSERT INTO "StripeWebhookEvent" ("stripeEventId", type)
        VALUES ($1, $2) ON CONFLICT ("stripeEventId") DO NOTHING`,
      event.id, event.type,
    )
    // Row lock. Serialises concurrent deliveries.
    const rows = await tx.$queryRawUnsafe<Array<{
      stripeEventId: string; processedAt: Date | null; attemptCount: number; deadLettered: boolean;
    }>>(
      `SELECT "stripeEventId", "processedAt", "attemptCount", "deadLettered"
         FROM "StripeWebhookEvent" WHERE "stripeEventId" = $1 FOR UPDATE`,
      event.id,
    )
    const row = rows[0]

    if (row.processedAt) {
      return new NextResponse('duplicate, already processed', { status: 200 })
    }
    if (row.deadLettered) {
      return new NextResponse('dead-lettered', { status: 200 })
    }
    if (row.attemptCount >= env.WEBHOOK_MAX_ATTEMPTS) {
      await tx.stripeWebhookEvent.update({
        where: { stripeEventId: event.id }, data: { deadLettered: true },
      })
      await recordAudit({
        action: 'stripe.webhook_dead_lettered', entityType: 'StripeWebhookEvent',
        entityId: event.id, meta: { severity: 'ALERT', type: event.type, attemptCount: row.attemptCount },
      }, tx)
      // 200 — Stripe stops retrying. The ALERT is what surfaces this.
      return new NextResponse('dead-lettered on this attempt', { status: 200 })
    }

    await tx.stripeWebhookEvent.update({
      where: { stripeEventId: event.id },
      data: { attemptCount: { increment: 1 } },
    })
  }, { timeout: 10_000 }).then(async (early) => {
    if (early) return early  // 200/400 short-circuits above

    // Dispatch OUTSIDE the ledger transaction (a slow dispatch cannot hold the row lock).
    try {
      const result = await dispatchWebhookEvent(event)
      await db.stripeWebhookEvent.update({
        where: { stripeEventId: event.id },
        data: { processedAt: new Date(), error: null },
      })
      return NextResponse.json(result, { status: 200 })
    } catch (e) {
      if (e instanceof WebhookMalformedError) {
        await db.stripeWebhookEvent.update({
          where: { stripeEventId: event.id },
          data: { processedAt: new Date(), error: e.message },
        })
        return new NextResponse(e.message, { status: 400 })
      }
      await db.stripeWebhookEvent.update({
        where: { stripeEventId: event.id },
        data: { error: (e as Error).message },
      })
      throw e
    }
  })
}
```

**Concurrent-dispatch note:** the row lock is released when the ledger
tx commits (or rolls back). The critical property is that
`attemptCount` is incremented atomically under the lock, and any
second delivery that arrives before the first commits will wait on the
FOR UPDATE. This bounds parallelism to exactly one dispatch per event id
at a time, which is sufficient. Actual parallel dispatch of *different*
events remains unaffected.

- [ ] **Step 4: `robots.ts` — add missing paths**

```bash
cat src/app/robots.ts
```

Verified: `disallow: ['/', '/*/order/']`. Add:

```ts
disallow: ['/', '/*/order/', '/api/webhooks/', '/api/cron/']
```

- [ ] **Step 5: NEGATIVE CONTROLS**

- **Forged signature** — comment out `constructEvent`; case 2 fails.
  Record. Restore.
- **Raw body** — change to `JSON.stringify(JSON.parse(await request.text()))`
  (compact re-serialise). Build the case 1 fixture with
  `JSON.stringify(obj, null, 2)` (pretty). Re-run: verification fails
  because pretty → compact changes bytes. Record. Restore.
- **P2002 short-circuit** — bring back the old "on conflict return 200"
  branch without the `processedAt` check. Re-run case 5. Retry returns
  200 without dispatch; second attempt count stays at 1; test fails.
  Record. Restore.
- **Dead-letter counter** — set `WEBHOOK_MAX_ATTEMPTS` to 1000; re-run
  case 6. `deadLettered` never set; test fails. Record. Restore.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib/server tests/app/api
```

---

## Task 11: Sweeps — PI-status-aware primary; SEPA-aware secondary; keyset pagination; no PI cancel

**Files:** `src/lib/shared/holds-sweep.ts` (rewrite both sweep functions;
keep `expireOrderWith` and its `beforeRelease` hook as Plan 04 built —
Plan 05 passes nothing), `src/lib/server/sweep-holds.ts` (bindings),
`src/lib/server/events.ts` (single-transaction cancel, status FIRST),
`tests/lib/server/sweep-holds.test.ts`, `tests/lib/server/events.test.ts`
tweaks.

- [ ] **Step 1: The primary sweep predicate — raw SQL, keyset paginated**

```sql
SELECT id, "holdExpiresAt" FROM "Order"
 WHERE status = 'PENDING'
   AND "holdExpiresAt" < now()
   AND (
     "paymentIntentStatus" IS NULL
     OR "paymentIntentStatus" NOT IN ('processing','requires_action','requires_capture','requires_confirmation','succeeded')
   )
   AND (
     $lastExpiresAt IS NULL
     OR "holdExpiresAt" > $lastExpiresAt
     OR ("holdExpiresAt" = $lastExpiresAt AND id > $lastId)
   )
 ORDER BY "holdExpiresAt" ASC, id ASC
 LIMIT $take
```

Keyset pagination on `(holdExpiresAt, id)`: a stuck order (which stays
`PENDING`) is naturally left behind as the cursor advances. On a next
tick, the sweep starts from `$lastExpiresAt = NULL` again and picks it
up — it is retried each tick without blocking newer expirations.

Per-order try/catch; return `{ expired, released, failed }`. Emit stderr
`SWEEP-PRIMARY expired=... released=... failed=...`.

- [ ] **Step 2: Secondary sweep — SEPA vs non-SEPA branches**

```sql
SELECT id, "holdExpiresAt" FROM "Order"
 WHERE status = 'PENDING'
   AND "paymentIntentStatus" IN ('processing','requires_action','requires_capture')
   AND (
     ("paymentMethodType" = 'sepa_debit' AND "holdExpiresAt" < now() - make_interval(days => $1))
     OR
     ("paymentMethodType" IS DISTINCT FROM 'sepa_debit' AND "holdExpiresAt" < now() - make_interval(secs => $2))
   )
   -- keyset cursor as above
 ORDER BY "holdExpiresAt" ASC, id ASC
 LIMIT $take
```

Same per-order try/catch, stderr line `SWEEP-ASYNC ...`.

- [ ] **Step 3: `expireOrderWith` — Plan 05 passes nothing**

The Plan 04 `expireOrderWith(client, id, opts?)` signature stays. The
`beforeRelease` hook stays defined. Plan 05's sweep bindings pass no
`opts`. Comment updated:

> Plan 05 does not use `beforeRelease`. The 4 September 2026 decision is
> that hold expiry does not call Stripe (see `plan/00-decisions.md`
> "Hold expiry does not call Stripe"). The hook stays available for
> future plans.

- [ ] **Step 4: Tests**

Cases:

| # | Case | Expected |
|---|---|---|
| 1 | Order with no PI, expired | swept, released, `SWEEP-PRIMARY expired=1` on stderr |
| 2 | Order with `paymentIntentStatus = 'requires_confirmation'`, expired | NOT swept (in-flight predicate) |
| 3 | Order with `paymentIntentStatus = 'processing'`, expired | NOT swept (in-flight) |
| 4 | Order with `paymentIntentStatus = 'requires_payment_method'` (after decline), expired | swept — the buyer bailed |
| 5 | Head-of-line: 3 orders, middle throws | `expired: 2, failed: 1`; keyset cursor advances past the failed one on the same tick, so it does not spin |
| 6 | Secondary sweep: SEPA order 6 days old | swept; audit meta includes `trigger: 'sepa_hard_timeout'` |
| 7 | Secondary sweep: non-SEPA processing order 7h old | swept |
| 8 | Secondary sweep: SEPA order 4 days old | NOT swept (within hard cap) |
| 9 | Stderr line format | assert `console.error` called with a string matching `/^SWEEP-PRIMARY /` |

- [ ] **Step 5: `updateEvent` — single-transaction, status FIRST, then release**

`src/lib/server/events.ts:113` (verified). Restructure the `cancelling`
block: inside the same outer transaction that takes `SELECT ... FOR
UPDATE` on Event, (a) `UPDATE "Event" SET status = 'CANCELLED'`, (b)
select PENDING orders, (c) transition each `PENDING → CANCELLED` via
raw UPDATE, (d) `releaseCapacity` for each. Preserve the existing
`AuditLog` contract: `action: 'order.cancel'`, `actorId: <admin>` (not
in `meta`).

Verify with the three existing tests (`events.test.ts:202,221,236`) —
none change.

- [ ] **Step 6: NEGATIVE CONTROLS**

- **NULL-mishandling** — write the predicate as Prisma
  `{notIn:[...]}`; observe that `paymentIntentStatus IS NULL` orders
  are never returned; case 1 fails. Record. Restore.
- **In-flight mid-3DS** — change the in-flight list to omit
  `'requires_confirmation'`; case 2 fails (a mid-checkout order is
  swept). Record. Restore.
- **Head-of-line** — remove keyset pagination (use OFFSET/LIMIT); a
  failing order stays at page position 0 and blocks the tick. Case 5
  fails. Record. Restore.
- **Per-order try/catch** — remove it. Case 5 fails on `expired: 0` vs
  `expired: 2`. Record. Restore.

**Controls dropped from the count** (following Plan 04 pool-tuning
precedent):

- SQL-vs-JS clock: local Docker cannot distinguish; documented in
  Global Constraints; no runnable control.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && pnpm exec dotenv -e .env.test -- vitest run
```

Full suite — this task touches shared code.

---

## Task 12: Payment Element on the order page — click-gate PI, `processing` band, `refunded` band, polling, i18n

**Files:** `src/app/(shop)/[locale]/order/[reference]/page.tsx`,
`src/app/(shop)/[locale]/order/[reference]/actions.ts`,
`src/lib/server/order-lookup.ts` (add `paymentIntentStatus` to select;
add `processing` and `refunded` bands; correct REFUNDED mapping),
`src/components/PaymentElementIsland.tsx`,
`src/components/OrderProcessingIsland.tsx`,
`src/messages/pl.json`, `en.json`, `de.json`.

- [ ] **Step 1: Extend `getOrderForConfirmation`**

Add `paymentIntentStatus` to the select. Compute band:

```ts
type OrderBand = 'holding' | 'processing' | 'expired' | 'cancelled' | 'paid' | 'refunded'

const band: OrderBand =
  order.status === 'REFUNDED' || order.status === 'PARTIALLY_REFUNDED' ? 'refunded' :
  order.status === 'PAID' ? 'paid' :
  order.status !== 'PENDING' ? 'cancelled' :
  order.paymentIntentStatus && ['processing','requires_action','requires_capture'].includes(order.paymentIntentStatus) ? 'processing' :
  (order.holdExpiresAt?.getTime() ?? 0) <= now ? 'expired' :
  'holding'
```

**Fix**: REFUNDED had been mapping to `paid` in the earlier draft —
telling refunded buyers their order was paid.

- [ ] **Step 2: Actions — `startPaymentAction` and `extendHoldAction`**

`extendHoldAction` runs on Pay-click BEFORE the client mounts Stripe
Elements. Extends `holdExpiresAt` by `env.PAY_CLICK_HOLD_EXTENSION_MS`
so the buyer mid-3DS is never swept:

```ts
export async function extendHoldAction(_prev, form: FormData) {
  const reference = String(form.get('reference') ?? '')
  const token = String(form.get('accessToken') ?? '')
  const order = await db.order.findUnique({
    where: { reference },
    select: { id: true, accessToken: true, status: true },
  })
  if (!order || !tokenMatches(order.accessToken, token)) return { errors: { _form: ['notFound'] } }
  if (order.status !== 'PENDING') return { errors: { _form: [`notPending${order.status}`] } }

  const newExpiresAt = new Date(Date.now() + env.PAY_CLICK_HOLD_EXTENSION_MS)
  await db.$queryRawUnsafe(
    `UPDATE "Order" SET "holdExpiresAt" = $1
      WHERE id = $2 AND status = 'PENDING' AND "holdExpiresAt" < $1`,
    newExpiresAt, order.id,
  )

  try {
    const { clientSecret, paymentIntentId, publishableKey } = await createPaymentIntent(order.id)
    return { clientSecret, publishableKey, paymentIntentId }
  } catch (e) {
    if (e instanceof PaymentIntentReuseError) return { errors: { _form: [`piReuse${e.reason}`] } }
    throw e
  }
}
```

- [ ] **Step 3: `PaymentElementIsland` — Pay-click gate**

Render a Pay button initially. On click → `extendHoldAction`. On success
→ mount `<Elements stripe={loadStripe(publishableKey)}
options={{clientSecret}}> <PaymentElement /> <SubmitButton /> </Elements>`.
`loadStripe` module-scoped, called once. `confirmPayment` uses `return_url`
built from `env.NEXT_PUBLIC_SITE_URL` (Task 15 verifies this on Vercel).

- [ ] **Step 4: `OrderProcessingIsland`**

Polls `window.location.href` every 3s; after 5 min shows
`processing.timeoutBody` copy. On band change (server re-renders show a
different heading), the polling triggers a hard reload.

- [ ] **Step 5: i18n keys — all three locales, same task, exact names**

`order.holding.payButton`, `paymentLoading`, `paymentError`,
`notFound`, `notPendingPAID`, `notPendingFAILED`, `notPendingCANCELLED`,
`notPendingEXPIRED`, `notPendingREFUNDED`, `piReuseAlreadyPaid`,
`piReuseNotPending`, `sepaNote`, `currencyMethodNote`.

`order.processing.heading`, `body`, `timeoutBody`.

`order.refunded.heading`, `body` (new band).

The action returns `notPending${status}` (e.g. `notPendingPAID`),
`piReuse${reason}` (`piReuseAlreadyPaid`, `piReuseNotPending`). Match
one to the other exactly — next-intl throws on a missing key.

- [ ] **Step 6: Wire the page**

```tsx
{band === 'holding' && (<><PaymentElementIsland …/><CancelOrderButton …/></>)}
{band === 'processing' && <OrderProcessingIsland />}
{band === 'paid' && …}
{band === 'refunded' && …}
{band === 'expired' && …}
{band === 'cancelled' && …}
```

- [ ] **Step 7: Server action tests + NEGATIVE CONTROLS**

`tests/app/shop/start-payment-action.test.ts`,
`extend-hold-action.test.ts` — six cases each as previous draft.

- **Token guard** — comment out `tokenMatches`. Wrong-token case
  succeeds; test fails. Record. Restore.

**Dropped from control count**: mount-vs-click PI creation
(no DOM; the seam test in Task 6 already covers that the DB write
happens when `createPaymentIntent` is called). Documented following
Plan 04 pool-tuning precedent.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/app/shop tests/lib
```

---

## Task 13: Cron routes + `vercel.json`

**Files:** `src/app/api/cron/release-holds/route.ts`,
`src/app/api/cron/async-release-holds/route.ts`, `vercel.json`,
`tests/app/api/cron-release-holds.test.ts`.

- [ ] **Step 1: Route shape — grep-friendly stderr**

```ts
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${env.CRON_SECRET}`) return new NextResponse('unauthorized', { status: 401 })
  const r = await sweepExpiredHolds()  // or sweepAsyncExpiredHolds()
  console.error(`SWEEP-PRIMARY expired=${r.expired} released=${r.released} failed=${r.failed}`)
  return NextResponse.json(r, { status: r.failed > 0 ? 207 : 200 })
}
```

- [ ] **Step 2: `vercel.json`**

Verified current: `{ "regions": ["fra1"] }`.

```json
{
  "regions": ["fra1"],
  "crons": [
    { "path": "/api/cron/release-holds", "schedule": "*/5 * * * *" },
    { "path": "/api/cron/async-release-holds", "schedule": "*/30 * * * *" },
    { "path": "/api/cron/reconcile", "schedule": "*/10 * * * *" }
  ]
}
```

**Vercel Pro required.** Task 1 Step 7.

- [ ] **Step 3: Tests**

Standard auth/GET/207/mock-invoked cases.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/app/api
```

---

## Task 14: Reconciliation cron — the three narrow states

**Files:** `src/app/api/cron/reconcile/route.ts`,
`src/lib/server/reconcile.ts`, `tests/lib/server/reconcile.test.ts`.

- [ ] **Step 1: What it queries**

Three narrow states — "money taken, nothing delivered" is the theme.

- **A. Stuck refunds.** `Order.refundRequestedAt IS NOT NULL AND
  stripeRefundId IS NULL AND status <> 'REFUNDED'` — resume the refund
  from phase 2. Same success-equivalent handling of
  `charge_already_refunded` and `idempotency_key_in_use` as Task 7.
- **B. Stuck webhooks.** `StripeWebhookEvent.processedAt IS NULL AND
  deadLettered = false AND attemptCount < WEBHOOK_MAX_ATTEMPTS AND
  receivedAt < now() - interval '10 minutes'` — nothing to do about
  Stripe's own retries, but count them and ALERT if any are older than an
  hour (a fully stuck event Stripe isn't retrying).
- **C. Paid with missing tickets.** `Order.paidAt IS NOT NULL AND
  (SELECT count(*) FROM "Ticket" WHERE "orderId" = "Order".id) <
  (SELECT coalesce(sum(quantity),0) FROM "OrderItem" WHERE "orderId" =
  "Order".id)` — money taken, no ticket. **Only counted and ALERTed** —
  the actual recovery is a manual admin action; this cron does not
  guess.

Return `{ recoveredRefunds, stuckWebhooks, ticketGaps, alerts }`. Emit
stderr `RECONCILE recovered=<r> stuckWebhooks=<w> ticketGaps=<g>
alerts=<a>`.

- [ ] **Step 2: Tests**

| # | Case | Expected |
|---|---|---|
| 1 | Stuck refund | resumed; status → REFUNDED; `stripeRefundId` set; `recoveredRefunds: 1` |
| 2 | Stuck refund, `refunds.create` returns `charge_already_refunded` | success equivalent — `stripeRefundId` set from `refunds.list` |
| 3 | Webhook stuck 30 min, attemptCount 3 | counted, not touched; `stuckWebhooks: 1` |
| 4 | Webhook stuck 2 hours | ALERT audit; `alerts: 1` |
| 5 | Paid order with quantity 2 but 0 Ticket rows | `ticketGaps: 1`, ALERT audit |
| 6 | Everything clean | zeros across the board; no ALERT |
| 7 | Stderr format | `console.error` called with `/^RECONCILE /` |

- [ ] **Step 3: Route** — same shape as Task 13's; `maxDuration = 60`.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/reconcile.test.ts tests/app/api
```

---

## Task 15: Vercel deployment — Stripe endpoint FIRST, verify SITE_URL

**Files:** none in the repo; owner + Vercel + Stripe dashboards.

- [ ] **Step 1: Register the Stripe production webhook FIRST**

Stripe Dashboard → Developers → Webhooks → Add endpoint:

- URL: `https://tickets-km.vercel.app/api/webhooks/stripe`
- Events: `payment_intent.succeeded`, `.processing`, `.payment_failed`,
  `.canceled`, `.requires_action`, `charge.dispute.created`.
- Copy the `whsec_...` shown after creation.

**This is production's secret**, distinct from `.env.local`'s. Do not
paste into a chat.

- [ ] **Step 2: Set Vercel env vars — Production + Preview**

Vercel dashboard → project → Settings → Environment Variables. For
Production and Preview:

- `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY` — same test-mode keys as
  `.env.local` for the demo.
- `STRIPE_WEBHOOK_SECRET` — from Step 1.
- `CRON_SECRET` — freshly generated (`openssl rand -base64 32`),
  distinct from `.env.local`.
- Numeric config vars: `ASYNC_PAYMENT_TIMEOUT_MS`, `SEPA_HOLD_CAP_SHARE`,
  `SELLOUT_HIDE_THRESHOLD`, `SEPA_HARD_TIMEOUT_DAYS`,
  `PAY_CLICK_HOLD_EXTENSION_MS`, `WEBHOOK_MAX_ATTEMPTS`.

- [ ] **Step 3: Verify `NEXT_PUBLIC_SITE_URL` — the four-flows breaker**

```bash
# Local read-back — Vercel CLI required; if not installed, use the dashboard
vercel env ls production | grep NEXT_PUBLIC_SITE_URL
```

Expected: `https://tickets-km.vercel.app`. **If it is `http://localhost:3000`,
every BLIK/P24/Klarna redirect sends the buyer to localhost** and four
of six Task 16 flows silently break. Fix in the dashboard before
proceeding.

- [ ] **Step 4: Redeploy**

Vercel Deployments → Redeploy the latest Production deployment. Env
changes take effect on redeploy.

Expected: build succeeds. If `env.ts` throws `Invalid environment
configuration:`, Step 2 was skipped or has a typo.

- [ ] **Step 5: Deployed-URL smoke**

```bash
curl -i -X GET https://tickets-km.vercel.app/api/cron/release-holds
```

Expected: `HTTP/2 401`.

```bash
curl -i -X POST https://tickets-km.vercel.app/api/webhooks/stripe -d '{}'
```

Expected: `HTTP/2 400 missing stripe-signature`.

- [ ] **Step 6: End-to-end demo on deployed URL** (Task 16 covers the six flows)

- [ ] **Per-task verification gate**

The smoke curls above.

---

## Task 16: Full verification, owner walkthrough, STATUS.md

- [ ] **Step 1: Docker, migrations, seed**

```bash
docker compose up -d
pnpm exec dotenv -e .env -- prisma migrate deploy
pnpm db:seed
```

- [ ] **Step 2: Clean-tree gate**

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Suite target: Plan 04's 290 + Plan 05's additions (~110). Record the
actual count.

- [ ] **Step 3: Twice**

```bash
pnpm test && pnpm test
```

- [ ] **Step 4: Cross-reference audit — grep, not assert**

```bash
# Every "Task N" reference in the plan text should point somewhere real.
grep -oE 'Task [0-9]+' plan/steps/05-payments.md | sort -u
# Line count check — should list Tasks 0 through 16 only.

# Any "Task 1[7-9]" or higher is a stale reference from a previous
# renumbering pass.
grep -nE 'Task 1[7-9]|Task 2[0-9]' plan/steps/05-payments.md
# Expected: no matches.

# The old primitive name must not appear anywhere:
grep -n 'cancelPaymentIntentThenRelease\|expiringLockedAt\|checkPiAndCancel\|retrieveAsyncPiStatus' \
     plan/steps/05-payments.md
# Expected: no matches.

# `pi.charges` must not appear (does not exist on stripe@19.3.1):
grep -n 'pi\.charges' plan/steps/05-payments.md src/
# Expected: no matches.
```

If any match — fix in the plan **and** re-run the grep. The audit is
run by the executor before Step 8.

- [ ] **Step 5: Findings log — every negative control recorded**

Confirm each negative control that ran (Tasks 5, 6, 7, 8, 9, 10, 11, 12
— roughly 15) has an entry with the observed failure. Missing entries →
the tests are decoration.

- [ ] **Step 6: Reconciliation**

```bash
pnpm holds:sweep
pnpm holds:verify
```

Expected: drift 0.

- [ ] **Step 7: Manual walkthrough with `stripe listen`** *(owner — browser + Stripe CLI)*

Two terminals: `pnpm dev`; `stripe listen --forward-to
localhost:3000/api/webhooks/stripe`.

Six flows:

1. **PL / card** — `4242 4242 4242 4242` → PAID band; 2 Ticket rows.
2. **PL / BLIK** — Stripe's BLIK test code → `processing` band briefly →
   PAID.
3. **PL / P24** — Stripe's hosted page "Success" → `processing` briefly
   → PAID.
4. **DE / Klarna** — if offered, complete Klarna test flow → PAID; if
   NOT offered, record in Findings.
5. **DE / card, declined** — `4000 0000 0000 9995`. Payment Element
   shows decline; **`Order.status` stays PENDING**; retry with `4242 …`
   → PAID. (Blocker fix from critique row on `payment_failed`.)
6. **EUR / SEPA + hard-timeout simulation** — SEPA test IBAN
   `DE89370400440532013000`. Manually set
   `holdExpiresAt = now() - interval '6 days'` on this order via
   Prisma. Trigger secondary sweep (`curl` with `CRON_SECRET`).
   Expected: EXPIRED, no Stripe call (per the "no PI cancel on hold
   expiry" decision).

Record method availability per locale × currency.

- [ ] **Step 8: Update `plan/STATUS.md`**

Move Plan 05 from "Next" into "Done". Include:

- Suite count.
- Webhook signature negative-control result.
- Idempotency ledger negative-control result.
- Payment methods that appeared in Task 15 Step 6 and Task 16 Step 7.
- SEPA guardrail values.
- Klarna verdict.
- The stderr-grep alert mechanism's status and when Plan 07 supersedes it.

Under "Next", set the remaining Plan 05 (fulfilment half — email + PDF +
QR + retry cron).

- [ ] **Step 9: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: Stripe payments — PI, webhook, fulfilment, reclaim-or-refund safety net (Plan 05)"
```

---

## Definition of done

- [ ] End-to-end demo: buyer → hold → test payment (BLIK/P24/Klarna/
      SEPA/card) → PAID confirmation, three locales, both currencies,
      on `tickets-km.vercel.app`
- [ ] `stripe@19.3.1`, `@stripe/stripe-js@5.7.0`,
      `@stripe/react-stripe-js@3.4.0` installed
- [ ] Env schema extended (10 new keys); `.env.example`, `.env.test`,
      `.env.local` coherent; `whsec_placeholder` refused at boot;
      full test suite green after Task 2 (measurement of the extension)
- [ ] Vercel env vars set for Production and Preview; production
      webhook registered in Stripe dashboard; `NEXT_PUBLIC_SITE_URL`
      verified as `https://tickets-km.vercel.app`
- [ ] Migration adds `Order.paymentIntentStatus`, `paymentMethodType`,
      `refundRequestedAt`, `stripeRefundId`;
      `StripeWebhookEvent.attemptCount`, `deadLettered`; composite index
      `[status, holdExpiresAt, paymentIntentStatus]`
- [ ] `createPaymentIntent` idempotent — DB uniqueness + Stripe
      idempotency key + `idempotency_key_in_use` retry with DB re-read;
      writes `paymentIntentStatus = 'requires_confirmation'` in the
      SAME UPDATE as `stripePaymentIntentId`
- [ ] `payment_method_types` computed by `computeAllowedPaymentMethods`
      — always includes `card`; currency-specific methods; **removes
      `sepa_debit` when SEPA cap reached (in-flight count, not just
      processing), near-sellout hit, or cap floor is 0**
- [ ] `Order.paymentMethodType` set on the FIRST webhook that carries
      method details, via `pi.latest_charge` (verified against
      `stripe@19.3.1` types — no `pi.charges`)
- [ ] `PaymentIntent.amount` from `Order.total`; PI cross-checked in
      `fulfilOrder` (`pi.id`, `pi.amount_received`, `pi.currency`)
- [ ] Payment Element creates PI only on Pay-click; `extendHoldAction`
      extends `holdExpiresAt` by `PAY_CLICK_HOLD_EXTENSION_MS` (default
      15 min) on that same click
- [ ] Primary sweep raw-SQL predicate: `(paymentIntentStatus IS NULL OR
      paymentIntentStatus NOT IN
      ('processing','requires_action','requires_capture','requires_confirmation','succeeded'))`;
      keyset paginated on `(holdExpiresAt, id)`; per-order try/catch;
      `{expired, released, failed}` return type
- [ ] **Hold expiry does NOT call Stripe.** Owner decision recorded in
      `00-decisions.md`; design docs corrected; `expireOrderWith`'s
      `beforeRelease` hook kept but unused by Plan 05
- [ ] `payment_intent.payment_failed` does NOT change `Order.status`;
      writes audit + PI status; hold intact for buyer retry
- [ ] `payment_intent.canceled` calls `failOrder`; `.processing` /
      `.requires_action` write PI status only
- [ ] Late success — `EXPIRED → PENDING → PAID` via
      `reclaimCapacityForOrder` with an `Event.status` guard
      (`ON_SALE`/`SOLD_OUT`); on `EventNoLongerPurchasableError` or
      `InsufficientCapacityError`, two-transaction refund
      (`refundRequestedAt` → `stripeRefundId` → `REFUNDED`)
- [ ] Any `succeeded` webhook against terminal `FAILED`/`CANCELLED`
      order refunds automatically
- [ ] **Refund exactly-once** — `Order.stripeRefundId` is our source of
      truth; `charge_already_refunded` and `idempotency_key_in_use`
      handled as success by retrieving the existing refund
- [ ] Webhook ledger: `INSERT ... ON CONFLICT DO NOTHING RETURNING`,
      per-event `SELECT ... FOR UPDATE`, `attemptCount` increment,
      dead-letter at `WEBHOOK_MAX_ATTEMPTS`, ALERT audit on
      dead-letter; short-circuit only on `processedAt IS NOT NULL`
- [ ] Signature verification refuses forged payloads (recorded negative
      control) via `constructEvent(raw, sig, secret)` on
      `await request.text()`
- [ ] Payment Element rendered when band = `holding`; `processing` band
      polls every 3s and stops at 5 min; `refunded` band exists
      (REFUNDED no longer maps to `paid`); four bands' copy present in
      `pl.json`, `en.json`, `de.json`; keys match action return values
      exactly (`notPendingPAID`, `piReuseAlreadyPaid`, …)
- [ ] Sweep clocks use SQL `now() - make_interval(...)`; secondary
      sweep predicate branches SEPA vs non-SEPA
- [ ] Vercel Pro confirmed as prerequisite before Task 13
- [ ] `robots.ts` disallows `/api/webhooks/`, `/api/cron/`
- [ ] `export const maxDuration` set on webhook (30) and cron routes
      (60)
- [ ] Reconciliation cron queries the three actual states —
      `stripeRefundId` gap, `StripeWebhookEvent.processedAt IS NULL`,
      `paidAt IS NOT NULL AND ticketCount < expected` — and emits
      `RECONCILE alerts=... ...` on stderr; `SWEEP-PRIMARY/ASYNC`
      likewise
- [ ] Every negative control recorded — approximately 15 across Tasks
      5–12 — each with observed failure text in the Findings log;
      four controls that cannot fail (SQL-vs-JS clock, Pay-click DOM,
      raw-body fixed point pre-fix, concurrent-create same-id pre-fix)
      are documented as dropped following Plan 04 pool-tuning precedent
- [ ] `vi.hoisted` used everywhere `vi.mock` needs mocks; no
      `require()` alias in Vitest ESM files; raw-body negative control
      uses pretty-printed fixture + compact-serialise mutation
- [ ] Task 16 Step 4 cross-reference grep run — no stale `Task 17+`,
      no `cancelPaymentIntentThenRelease`, no `expiringLockedAt`, no
      `pi.charges`
- [ ] Clean-tree gate green; suite green twice

---

## What this plan does not cover

- **Ticket email, PDF, QR** — Plan 05 fulfilment half.
- **Retry cron for failed emails** — Plan 05 fulfilment half.
- **Door scanner** — Plan 07.
- **Staff-initiated refunds** — Plan 06.
- **`charge.refunded` webhook** — Plan 06.
- **Promo codes, invitations, `promoCodeId` decrement on expiry** —
  Plan 06.
- **Sentry, Slack/email alerts** — Plan 08. Plan 05's mechanism is
  stderr strings grep-able in Vercel logs; Plan 07's admin dashboard
  surfaces the same audit rows.
- **CSP, HSTS, X-Content-Type-Options** — Plan 08.
- **`experimental.serverActions.allowedOrigins`** — Plan 08.
- **Shared rate limiting across Vercel instances** — Plan 08.
- **RODO retention** — Plan 08. Plan 05 adds `Order.paymentMethodType`
  and two lifecycle timestamps to the retention scope.
- **Bumping `stripe` beyond 19.x** — separate plan item. API version
  and package layout changed in 22.x.
- **Explicit `stripe.paymentIntents.cancel` on abandoned PIs** — Plan
  06 clean-up item, only if Task 4 Step 3's investigation shows Stripe
  does not auto-cancel.
