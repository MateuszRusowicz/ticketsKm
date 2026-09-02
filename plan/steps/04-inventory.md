# Plan 04 — Inventory and orders

**Goal:** a validated checkout form creates a `PENDING` `Order` that holds
capacity for 30 minutes and cannot oversell a 900-seat concert under any
contention pattern. **No Stripe, no `Ticket` rows, no email, no PDF** — those
are Plan 05.

**Architecture:** capacity is claimed by a single conditional `UPDATE` on
`TicketType`, joined against `Event`, that Postgres row-locks against itself.
`Order` creation happens in the same transaction as the hold, so a failure
after the hold cannot leak capacity. Holds are released explicitly on failure,
cancellation and expiry; buyer abandonment reduces to expiry (the tab is gone,
no signal reaches the server) and Task 6's per-buyer dedupe converts a
re-opened tab into a resumed session rather than a second hold. The sweep
every 5 minutes is the backstop for the abandoned-tab case.

**Spec:** [`../03-purchase-flow.md`](../03-purchase-flow.md) (§ "Preventing
oversell", § "The checkout endpoint", § "Lifecycle of held capacity"),
[`../02-data-model.md`](../02-data-model.md) (§ "Invariants"),
[`../00-decisions.md`](../00-decisions.md) (hold duration, one-concert-per-order,
name-per-ticket).

**Depends on:** Plan 03 (`checkoutSchema`, `getPublicEvent`, the concert and
order pages, the currency cookie). Plan 02 is **not** a dependency — this is
built and tested entirely locally.

> **Revised 2 Sep 2026 after three independent critique passes.** Two ran the
> plan's code against `km_test`, so their findings are measurements not
> opinions. The core primitive — one conditional `UPDATE` under `READ
> COMMITTED` relying on Postgres's `EvalPlanQual` recheck — is correct, and
> delivers exactly 900 held / 100 rejected out of 1000 concurrent buyers. The
> plumbing around it, the harness meant to prove it, and the fact that the
> capacity invariant spans two tables while only one row was locked were all
> wrong. Every fix is below; the Findings log records what changed and why.

---

## Findings log

Appended **as things are discovered**, not at the end. Each entry says what the
plan assumed, what was actually true, and which step was corrected. If a finding
outlives this plan, add it to the traps list in `/CLAUDE.md` — that file is
loaded automatically every session; this one is not.

| Date | Finding | Action |
|---|---|---|
| 2 Sep (critique) | `generateOrderReference` in the original Task 4 used the module-singleton `db` inside `db.$transaction`. Measured: 100 of 100 concurrent createOrder calls fail; at 12 concurrent, 10 die on the 5s transaction timeout. The pattern is: transaction holds one pooled connection, then awaits a second query on `db` which also needs one — pool starves, everything deadlocks. Invisible in single-request tests. | Task 4 rewritten so `generateOrderReference(now, client)` takes a `Prisma.TransactionClient`; likewise `holdCapacity`, `releaseCapacity`, `recordAudit`. New Global Constraint: **nothing inside a `$transaction` callback may reference the `db` singleton.** |
| 2 Sep (critique) | The original Task 10 asserted `succeeded === 900` with Prisma's defaults (`maxWait: 2000`, `timeout: 5000`) against a 10-connection pool. Measured: 166–431 succeed depending on shape; most transactions reject with `P2028` before ever running. With `transactionOptions: { maxWait: 60_000, timeout: 60_000 }` and `new PrismaPg({ max: 20 })` the exact same code produces 900 succeeded / 100 `InsufficientCapacityError` / `heldCount === 900` in ~4–10s. | Task 10 constructs a dedicated client with those options. Task 3 also raises `db.ts` pool + `transactionOptions` for production, since the same defaults would surface as an outage under real on-sale load. |
| 2 Sep (critique) | Task 10 had no negative control. A critique deleted the capacity predicate from `holdCapacity` and re-ran with the fixed harness: the assertions failed *identically* to how they fail with the predicate present when the harness is broken. **A test that fails the same way whether the protection exists or not proves nothing.** | New Task 10 Step 4: temporarily neuter the capacity predicate, re-run, record that the neutered version produced 1000 successes and `heldCount === 1000`, then restore. Verified during critique to distinguish real from fake results. |
| 2 Sep (critique) | The original Task 4 wrapped `Order.create` in a `for (attempt < 3)` retry catching `P2002`. `nextval` cannot collide (that is the whole reason for using a sequence), and a unique violation inside a Postgres transaction aborts the transaction (`25P02`) — every subsequent statement fails. Measured. The "second attempt succeeds" test row was unimplementable. | Retry loop deleted; `OrderReferenceExhausted` deleted; the test row deleted. |
| 2 Sep (critique) | Original Task 4 read `view.capacity`; `PublicEvent` in `src/lib/shared/public-event.ts` exposes `available`, not `capacity`. Hard `tsc` failure. | Resolved by the Task 3 rewrite — capacity is no longer a JS value at all. |
| 2 Sep (critique) | Original Task 5 Step 2's SQL threw `42P08`: `$1` was inferred as `"OrderStatus"` from `SET status = $1` and as `text` from `$1 = 'CANCELLED'`. Measured. | Cast explicitly: `$1::"OrderStatus"`, plus a second parameter for the CASE branch. |
| 2 Sep (execution, Task 0) | Task 0 Step 4 instructed the executor to seed `Order.accessToken`. That column does not exist until **Task 2's** migration adds it — Task 0 runs first, so the seed would fail on an unknown column. Ordering defect introduced by the critique revision, which added `accessToken` to Task 2 without re-checking Task 0's dependency on it. | The whole seed extension (11th concert, `heldCount`, `Order`, `OrderItem`, `accessToken`) moved from Task 0 Step 4 to **Task 2 Step 6**, after the migration. Task 0 Step 4 is now a pointer. Keeping it whole also preserves invariant 2 (`heldCount` = sum of PENDING quantities) at every point in the plan, which a two-stage split would have violated between Task 0 and Task 2. |
| 2 Sep (execution, Task 0) | Task 0 Step 4 said to set `heldCount: 5` "in BOTH the `create` and `update` branches of the `db.ticketType.upsert`". There is no `db.ticketType.upsert` in `prisma/seed.ts` — ticket types are a **nested create** inside `db.event.upsert` (`prisma/seed.ts:225`), and that upsert's `update` branch deliberately touches only scheduling fields, with a comment explaining that updating nested creates would duplicate them. | Task 2 Step 6 now specifies a **separate, explicit `db.ticketType.updateMany`** keyed on the event, run after the event upsert, so `heldCount` is set idempotently on both first and subsequent seeds without touching the nested-create path. |
| 2 Sep (execution, Task 0) | Task 0 Step 6 claimed its `db.ts` test meant "a future edit that halves the pool will fail it". **Negative control disproves it:** with `transactionOptions` and `max` removed and Prisma's stock defaults restored, the 500-query and 50-transaction tests still pass. Local Docker accepts connections far too fast to reproduce the condition the tuning exists for (Neon cold start; cross-instance contention on one `TicketType` row). The test was decoration — the exact failure mode this plan added a negative control to Task 10 to prevent. | Test kept as an honest **load smoke test**, with a comment recording the negative control and stating that a green run is not evidence the tuning is present. Step 6's claim corrected. The tuning is retained — the reasoning is sound, it simply cannot be verified locally; real verification belongs to Plan 05/08 against Neon. |
| 2 Sep (execution, Task 2) | Task 2 Step 1's migration left `DEFAULT gen_random_uuid()::text` permanently on `Order.accessToken`. Prisma's `@default(uuid())` is **client-side** and emits no database default, so a permanent DB default is drift the next `migrate dev` would try to remove. | Migration now adds the column *with* the volatile default (so any existing row is backfilled with a distinct UUID) and then `ALTER COLUMN ... DROP DEFAULT`. Verified: `prisma migrate status` reports "Database schema is up to date!" with no drift. |
| 2 Sep (execution, Task 2) | The dedupe index was named `Order_email_ticketTypeId_pending_idx`, but it is on **`OrderItem`**, references no email, and is not partial. Misleading names cost more than they save. | Renamed `OrderItem_ticketTypeId_orderId_idx`. |
| 2 Sep (execution, Task 2) | Step 1 said `gen_random_uuid()` "is in the `pgcrypto` extension". It has been in **core Postgres since 13** and needs no extension. Verified on the local image: PostgreSQL 16.15, `gen_random_uuid()` returns a valid v4. | Note corrected; no `CREATE EXTENSION` needed on Neon or locally. |
| 2 Sep (execution, Task 2) | `prisma migrate dev` hangs indefinitely in a non-interactive shell — it applies the migration, then blocks on a prompt that can never be answered, and the harness kills it (exit 144) after the work is already done. | Apply with `migrate dev`, then confirm with `prisma migrate status` and run `prisma generate` separately rather than trusting the exit code. **Trap-list candidate for `/CLAUDE.md`.** |
| 2 Sep (execution, Task 2) | `tsx` compiles to CJS in this repo, so a throwaway probe script using **top-level `await`** fails with `Top-level await is currently not supported with the "cjs" output format`. `prisma/seed.ts` and `scripts/create-admin.ts` wrap everything in `async function main()` for exactly this reason. | Task 9's CLI must use the `main()` wrapper idiom. **Trap-list candidate for `/CLAUDE.md`.** |
| 2 Sep (critique) | Original Task 2 verification snippet used `SELECT nextval("order_reference_seq")` — double quotes are an identifier in Postgres; `42703`. Measured. The Task 2 Step 3 implementation used single quotes correctly; only the verification was wrong. Secondary: `tsx -e` with `import("@/generated/prisma/client")` does not reliably resolve tsconfig paths. | Verification switched to a relative-path `tsx -e` matching the `prisma/seed.ts` and `scripts/create-admin.ts` idiom. |
| 2 Sep (critique) | Original Task 2's overflow test called `setval(..., 999999)` on a shared sequence. `TRUNCATE ... RESTART IDENTITY CASCADE` does **not** reset a standalone sequence — measured — so the sequence stayed at 999999 for the rest of the run and every subsequent `createOrder` threw `OrderReferenceOverflow`, deterministically, looking like an oversell bug. Precisely the ordering trap Global Constraints warned against. | Overflow tested against a pure function `formatOrderReference(seq, year)` with an injected `seq`. The sequence itself is added to every `TRUNCATE ... RESTART IDENTITY` reset with an explicit `ALTER SEQUENCE "order_reference_seq" RESTART`. |
| 2 Sep (critique) | Original Task 9 CLI parameterised `db` but the target module still starts with `import 'server-only'`, which throws under `tsx`. `scripts/create-admin.ts` and `prisma/seed.ts` import *nothing* from `src/lib/server/` — that is the documented pattern in `/CLAUDE.md`. | Task 9 split: pure sweep logic goes in `src/lib/shared/holds-sweep.ts`, the `server-only` wrapper in `src/lib/server/sweep-holds.ts` binds the singleton, the CLI (Task 9) constructs its own client and calls the shared function. No duplication. |
| 2 Sep (critique) | Original Task 6's action called `flatten(parsed.error)` — never defined or imported. Zod 4 removed `ZodError.flatten()` in favour of `z.flattenError()`. Original Step 3 wrote `React.useActionState` but the component imports named hooks only. And the test table expected `{ ok: true, reference }` while the action `redirect(...)`s (which throws). | Rewritten: `z.flattenError()` used verbatim, `useActionState` imported by name, tests assert on the thrown `REDIRECT:...` string, following `tests/app/admin/events-action.test.ts`. |
| 2 Sep (critique) | Task 10's `makeEvent` was called with no definition. `createOrder` routes through `getPublicEvent`, which returns `null` without an `EventTranslation` for the requested locale, so the naive helper would surface as `EventNotPurchasableError('unknown')` on all 1000 attempts. | Task 10 spells out the helper: ON_SALE, future `startsAt`, one `EventTranslation` per locale, one active `TicketType`. |
| 2 Sep (critique) | **A genuine oversell race**: capacity is on `Event`, the original UPDATE locked only `TicketType`, and read capacity outside the transaction. Interleaving: buyer reads capacity 900 → admin `updateEvent(capacity: 896)` → buyer's UPDATE evaluates against stale 900 → `heldCount` 900 against capacity 896. The claim that `updateEvent`'s guard protected against this was wrong — that guard has the identical read-outside/write-inside race. | Task 3 rewrites `holdCapacity`: the predicate joins `Event` inside the SQL statement, and a `SELECT capacity FROM "Event" WHERE id = $1 FOR UPDATE` at the top of the transaction serialises against `updateEvent`, which also acquires the same lock (Task 5 Step 5 modifies `updateEvent`). Explicit note in Task 3 Step 2 about `EvalPlanQual` recheck bounds. |
| 2 Sep (critique) | `checkoutSchema.quantity` is unbounded (`z.number().int().positive()`). One POST with `quantity: 900` holds an entire venue for 30 minutes — Plan 01's per-instance rate limiter does not stop a single request. `src/lib/shared/public-event.ts` literally promises "Plan 04 re-checks transactionally at order creation". | Task 4 Step 2 adds an explicit `input.quantity > view.maxPerOrder` guard throwing `QuantityAboveMaxPerOrderError`; Task 4 Step 5 adds `.max(50)` to `checkoutSchema.quantity`. Test row added. |
| 2 Sep (critique) | Anyone could cancel anyone's order: `cancelOrderAction` looked up by `reference` alone with no ownership proof, and references are a monotonic sequence. Enumerating `KM-2026-000001…N` would release every live hold in the festival. Framed originally as a read/privacy risk; actually an unauthenticated destructive write, squarely in scope for Plan 04's done-when condition. **Owner has approved fixing in Plan 04** with the cheaper of the two proposals. | Task 2 migration adds `Order.accessToken String @default(uuid())`. Task 6 redirects to `/order/[reference]?t=<token>`. Task 7's page and cancel action both require the token. Task 7 also adds `/[locale]/order/` to `robots.ts` and marks the page `force-dynamic` with `no-store` — buyer PII on a live hold-state page must not cache. |
| 2 Sep (critique) | Nothing bound a buyer to their outstanding holds. Double-submit, two tabs, back-into-bfcache each leaked a 30-minute hold. The original fallback ("second submission hits `InsufficientCapacityError`") is only true on an already-full concert, i.e. exactly when the leak does not matter. **This fix is what makes the plan's central safety claim true.** | Task 4 Step 3 (new): before creating, look for an unexpired `PENDING` order with the same `email` + `ticketTypeId` and return that reference instead of creating a second. One indexed query. Task 6 Step 1's dedupe test now asserts the returned reference is the *same* one, not a second. |
| 2 Sep (critique) | Admin cancelling an event released nothing. `updateEvent` guards capacity and price but not status. Holds would survive and `PENDING` orders would stay chargeable in Plan 05 — money for a cancelled concert. | Task 5 Step 5 (new): when `updateEvent` transitions status to `CANCELLED`, cancel every `PENDING` order on that event and release its holds. |
| 2 Sep (critique) | Original Task 5 contradicted itself: the table claimed idempotent no-ops on already-terminal orders, then the prose specified a pre-transaction guard that throws on `EXPIRED`. Task 7 Step 3's "second click no-ops without error" test would have failed on the sequential case while passing on the concurrent case — backwards. | Task 5 rewritten: pre-transaction guard deleted, the conditional `UPDATE ... WHERE status = 'PENDING'` is the sole arbiter, returns a discriminated result `{ released } | { alreadyTerminal }`. Table corrected. |
| 2 Sep (critique) | Przelewy24, Klarna and SEPA are asynchronous — Stripe holds them `processing` for minutes to days. The original sweep would expire any `PENDING` past `holdExpiresAt`, so a P24 transfer confirming at minute 34 would land on an EXPIRED order with seats already resold. These are the payment methods the demo showcases; Plan 05 could not have fixed this by wrapping. | Task 9 sweep predicate adds `AND "stripePaymentIntentId" IS NULL`. Once Plan 05 sets the ID at hold time, the sweep leaves the order alone. |
| 2 Sep (critique) | The original expire-then-cancel ordering was backwards: a Plan 05 wrapper that expires and *then* cancels the PaymentIntent leaves a window where the order is EXPIRED and seats are resold while Stripe will still charge. `03-purchase-flow.md` itself calls this "the nastiest bug in the system". | Task 5 Step 2's `expireOrder` accepts an optional `beforeRelease?: (order) => Promise<void>` hook that runs inside the transaction and aborts on throw. Plan 04 passes nothing; Plan 05 will pass `cancelPaymentIntent`. |
| 2 Sep (critique) | The original Task 5 asserted transitions are one-way `PENDING → terminal`; `03-purchase-flow.md` § "The oversell race" requires `EXPIRED → re-claim → PAID` for a late success. Plan 04 would have shipped a test forbidding what Plan 05 must do. | Task 5 Step 1's transition set expressed as an explicit `{ from, to }` table so Plan 05 adds a row rather than rewriting guards. `reclaimCapacityForOrder(orderId, tx)` primitive exported — it is `holdCapacity` with the order's items. |
| 2 Sep (critique) | `src/lib/server/db.ts` set neither `transactionOptions` nor `connection_limit`. Every Vercel instance opens its own 10-connection pool; on-sale rush serialises on one `TicketType` row, real buyers get `P2028`, and Neon's scale-to-zero cold start alone can exceed the 2s default `maxWait`. | Task 0 Step 6 (new): `db.ts` gets explicit `transactionOptions: { maxWait: 15_000, timeout: 30_000 }` and `new PrismaPg({ connectionString, max: 10 })` with a comment sizing it against Neon's pooler budget. |
| 2 Sep (critique) | `releaseCapacity`'s `GREATEST(x - $1, 0)` clamp silently manufactures capacity when drift occurs. | Clamp deleted. Task 2 migration adds `CHECK ("heldCount" >= 0)` and `CHECK ("soldCount" >= 0)` — the only invariant Postgres can enforce given capacity spans tables. |
| 2 Sep (critique) | Counter drift is the one failure that does not self-heal within 30 minutes. | Task 9 also ships `pnpm holds:verify`: reports `heldCount` vs `SUM(PENDING items.quantity)` per ticket type; `--fix` corrects with an audit entry. |
| 2 Sep (critique) | Task 7 rendered `expired` copy without expiring — the buyer was told seats were released and offered "Start over", then rejected by their own still-live hold. | Task 7 Step 2's page-level guard calls `expireOrder` before rendering `expired` band (idempotent, races safely). |
| 2 Sep (critique) | Task 9's `take: 500` had no `orderBy` and no loop — a large backlog silently left rows behind. | Ordered by `holdExpiresAt asc`, loops while `candidates.length === take`. |
| 2 Sep (critique) | `expireOrder`'s conditional UPDATE checked status only, not `holdExpiresAt`. Harmless in Plan 04, but the moment Plan 05 extends a hold on a payment retry, the sweep would expire a live order. | `AND "holdExpiresAt" < now()` added to the EXPIRED transition. |
| 2 Sep (critique) | Task 4 did not catch `P2025` from `findFirstOrThrow` for an unknown-but-well-formed `ticketTypeId` — 500 instead of a `notPurchasable` banner. | Caught and re-thrown as `EventNotPurchasableError('unknown')`. |
| 2 Sep (critique) | Original Task 4 test table expected distinguishable reasons for DRAFT/CANCELLED/past. `getPublicEvent` filters these out at the query level, so all three collapse to `EventNotPurchasableError('unknown')`. | Table corrected: DRAFT/CANCELLED/past → `unknown`; SOLD_OUT/CLOSED/notYetOpen/inactive → their specific reason. |
| 2 Sep (critique) | Task 0's seed used `KM-SEED-000001` — violates the `/^KM-\d{4}-\d{6}$/` regex the Definition of Done asserts. `heldCount` was only set on `create`, so re-seeding after a sweep left `PENDING` with `heldCount: 0`. `OrderItem.quantity` was not pinned, so Task 9's `{ expired: 1, released: 5 }` assertion drifted. | Reference `KM-0000-000001` (year 0000 obviously seed). `heldCount` set in the upsert `update` branch too. `OrderItem.quantity: 5` pinned. |
| 2 Sep (critique) | `src/lib/server/ratelimit.ts` keeps a module-level Map with no reset; the mock idiom returns `'127.0.0.1'` for every header, so every test in a file shares one 10-request budget. The rate-limit test then poisons everything after it. | Task 6 Step 1: export `__resetRateLimits()` from `ratelimit.ts` and call in `beforeEach`. Mock returns a per-test IP via `let currentIp = '…'`. |
| 2 Sep (critique) | `order.holdingBody` formats `holdExpiresAt` via next-intl; `src/i18n/request.ts` sets no `timeZone`, so it renders in the server's zone (UTC on Vercel) — the exact trap `src/lib/shared/format.ts` documents. | Task 8: use `formatConcertTime` for the holdExpiresAt render, not raw next-intl `{,time,short}`. |
| 2 Sep (critique) | Original Task 10 Test 3: `toCancel.map(cancelOrder)` passed the array index as the `reason` argument; `toBeLessThanOrEqual(100)` would have passed at 0; counts were global rather than per-event. | Corrected: `.map((id) => cancelOrder(id, 'test'))`; assertions on `equal(pendingForThisEvent)` not `lessThanOrEqual(100)`; per-event counts. |
| 2 Sep (critique) | Task 10's beforeEach was described in prose, not written. `orders.test.ts` sorts alphabetically before `oversell.test.ts` and leaves `PENDING` rows behind. Global counts would pick them up. | Task 10 Step 2 spells out a beforeEach TRUNCATE plus explicit `ALTER SEQUENCE order_reference_seq RESTART`; assertions scoped to the ticket type under test. |
| 2 Sep (critique) | Task 1's Step 3 said Plan 04's sweep decrements a promo code's `usedCount`. Promo codes are Plan 06 and there is no `promoCodeId` set by Plan 04's `createOrder`. Also Task 1's citation of `src/lib/shared/schemas.ts` for the checkout payload — the real module is `src/lib/shared/checkout.ts`. | Task 1 Step 3 rewritten: promo-code decrement removed from Plan 04's sweep responsibility entirely (Plan 06 will layer it in). Task 1 Step 1 cites `checkout.ts`. |
| 2 Sep (critique) | `prisma format` has no check mode; "clean" is not observable. `CREATE SEQUENCE` and `CHECK` constraints are not expressible in `schema.prisma`. | Task 2 Step 1 flow: `pnpm exec prisma migrate dev --create-only --name plan_04_order_extras` to stub the file from the schema diff, then hand-edit to add `CREATE SEQUENCE`, `CHECK`, and the `Order.accessToken` default; then `pnpm exec prisma migrate dev` to apply. `pnpm exec prisma format` runs (it rewrites, does not check). |
| 2 Sep (critique) | `attendeeNames` as a bare positional `["Ala", "Bob"]` array in JSON with the server action assembling from `Object.fromEntries` + numeric sort: a missing `attendeeNames.2` silently shifts every later name onto the wrong ticket while the count still matches. Also the original justification for the column ("keeps RODO to one table") is wrong — names are copied to `Ticket.holderName` at fulfilment anyway, so Plan 08 walks both. The real reason is invariant 3. | Task 4 Step 2: server action iterates `for (let i = 0; i < quantity; i++)` reading `form.get(\`attendeeNames.${i}\`)` explicitly, failing on any missing index; stored on Order as `[{ index: 0, name: 'Ala' }, { index: 1, name: 'Bob' }]`. Task 2 migration adds `CHECK (jsonb_typeof("attendeeNames") = 'array')`. Justification rewritten. Multi-concert-reversal claim dropped. |
| 2 Sep (critique) | Currency-freeze point was left open in the original draft. Owner has chosen Option B. `CurrencySwitcher.tsx` uses `useRouter`, not `usePathname` — so a hide-on-`/zamowienie` check needs two imports and `usePathname` from `@/i18n/routing` strips the locale prefix. | Task 0 Step 3 records the decision as settled and notes the exact import change. |
| 2 Sep (critique) | Global Constraints said this plan releases holds "on failure, abandonment and cancellation — not only on expiry." False: `failOrder` had no caller until Plan 05, Cancel is a button the abandoning buyer has already left, sweep was a manual CLI with no schedule. | Global Constraints rephrased accurately; abandonment reduces to expiry, mitigated by Task 4's dedupe. |
| 2 Sep (critique) | `holdExpiresAt` came from JS `new Date()` in one place and Postgres `now()` in another. Time-based sweep predicates using `now()` and stored `holdExpiresAt` written from JS drift under clock skew — measurable on Vercel + Neon. | Global Constraint added: Postgres `now()` is the authoritative clock inside transactions; `holdExpiresAt` is computed once in JS at insert time (Postgres has no direct expression for "now + interval, as of the row commit time"), and every subsequent comparison reads it back against `now()`. |
| 2 Sep (critique) | Held→sold conversion path — where the counters will actually drift under Plan 05's fulfilment — was not called out. | "What this plan does not cover" adds a paragraph: the conversion must be a single `UPDATE ... SET heldCount = heldCount - n, soldCount = soldCount + n WHERE ...` in Plan 05, atomic on the row. |

---

## Global Constraints

- **One concert per order.** Settled 27 Aug 2026. The checkout payload is flat
  (`ticketTypeId`, `quantity`) — no `items[]` array. Do not add cart shape "just
  in case"; `03-purchase-flow.md`'s cart-style example is out of date and is
  corrected by Task 1.
- **A name per ticket.** Settled 27 Aug 2026. `attendeeNames.length ===
  quantity`, enforced by `checkoutSchema.superRefine` (Plan 03). Stored on the
  `Order` as `[{ index, name }]` (Task 2's column addition), copied onto
  `Ticket.holderName` at fulfilment in Plan 05. `Ticket` rows are NOT created
  in this plan — invariant 3 in `02-data-model.md` says they exist only for
  `PAID`/`REFUNDED`/`PARTIALLY_REFUNDED` orders. The column on `Order` is
  because a `PENDING` order has no `Ticket` yet, so the names have to live
  somewhere; the retention job in Plan 08 anonymises them alongside buyer PII.
- **Hold duration: 30 minutes, flat across all venues.** Settled 30 Aug 2026.
  Safe only because Task 5 releases holds on failure and cancellation, Task 4
  dedupes double-submits by buyer, and Task 9's sweep is the backstop for
  abandonment (a closed tab sends no signal, so it reduces to expiry).
- **Nothing inside a `$transaction` callback may reference the `db`
  singleton.** Every server helper called from within a transaction accepts a
  `Prisma.TransactionClient` and uses it. This includes `generateOrderReference`,
  `holdCapacity`, `releaseCapacity`, `recordAudit`, `releaseHoldForOrder`, and
  everything they call. Reason: `db` borrows one connection from the pool;
  awaiting a second query on `db` inside a transaction that already holds one
  deadlocks the pool the moment concurrency exceeds `pool_size / 2`. Measured
  under critique — 100 of 100 concurrent createOrder calls fail with the
  original design. This is why several existing helpers (`recordAudit`) need a
  Plan 04 revision to accept a client.
- **Postgres `now()` is the authoritative clock inside transactions.** JS
  `new Date()` values drift under NTP jitter, VM clock skew and (on Vercel)
  cold-start clock warmup. Time-based transitions in SQL (`holdExpiresAt <
  now()`) always use `now()`. `holdExpiresAt` itself is a JS `new Date(Date.now()
  + HOLD_DURATION_MS)` at insert time only, because Postgres has no direct
  expression for "commit time plus interval" on an INSERT.
- **Server-side `maxPerOrder` guard is mandatory.** `PublicEvent`'s
  `clampQuantity` is UX. Every `createOrder` re-checks `input.quantity <=
  ticketType.maxPerOrder` and throws before touching capacity, so a single
  unauthenticated POST cannot lock an entire venue for 30 minutes.
- **Money is integer minor units.** `subtotal`, `total`, `unitPrice` are
  grosze / eurocents. Never floats, never live FX conversion. Currency is
  frozen onto the order at creation (`Order.currency`) and never changes.
- **Prices come from the database, not the request.** The request carries
  `ticketTypeId` and `quantity`; the server loads `pricePln`/`priceEur` from
  `TicketType` (through `getPublicEvent`) and computes `unitPrice`, `subtotal`
  and `total` itself. Single most load-bearing line in `createOrder`.
- **Prices and counters live on `TicketType`; capacity lives on `Event`.**
  Availability is `event.capacity − ticketType.soldCount − ticketType.heldCount`.
  Plan 04 writes to `heldCount` only; `soldCount` moves at fulfilment in Plan 05.
- **Server actions, not `/api/checkout`.** Task 1 corrects the design doc,
  written before that convention landed. The `/api/cron/release-holds` route
  from `03-purchase-flow.md` § "Lifecycle" is Plan 05's — Plan 04 ships the
  function it calls plus a `pnpm holds:sweep` CLI.
- **`import 'server-only'` throws under Vitest and tsx.** Tests alias it; the
  sweep CLI (Task 9) opens its own `PrismaClient` and calls the pure sweep
  function from `src/lib/shared/holds-sweep.ts`, exactly like
  `scripts/create-admin.ts` and `prisma/seed.ts` do. It never transitively
  imports from `src/lib/server/*`.
- **Nothing under `src/components/` may import from `@/lib/server/*`.**
  `eslint.config.mjs` bans it with no `allowTypeImports` escape. Shared types
  and pure logic go in `src/lib/shared/`.
- **Tests are Node-environment with no DOM.** `vitest.config.mts` is
  `environment: 'node'`, `include: ['tests/**/*.test.ts']`, no jsdom, no
  `@testing-library/react`. This plan tests pure functions and server modules,
  never components.
- **Tests share one Postgres database and run sequentially.**
  `fileParallelism: false`, `maxWorkers: 1`. Every test file that writes new
  rows begins with a `TRUNCATE` of the tables it touches — **and an
  `ALTER SEQUENCE "order_reference_seq" RESTART`.** `TRUNCATE ... RESTART
  IDENTITY CASCADE` does NOT reset a standalone sequence; the plan's own
  overflow test measurably poisoned every later run before this was fixed.
  **Run the suite twice.** Task 10 asserts an exact `heldCount === capacity`,
  and a stray row from an earlier file would blow up in the most confusing way.
- **`pnpm db:reset` is refused by Prisma 7 without
  `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`, even locally.** `pnpm db:seed`
  upserts, so a re-seed is enough for every state exercised here.
- **Commits are made by the human operator.**

---

## Task 0: Make the ground ready

Six things this plan assumes that the repository does not yet reflect. Fix them
here rather than mid-task.

**Files:** `../03-purchase-flow.md`, `../00-decisions.md`, `prisma/seed.ts`,
`tests/prisma/seed.test.ts`, `src/lib/server/db.ts`,
`src/components/CurrencySwitcher.tsx`, `plan/STATUS.md`.

- [x] **Step 1: Docker Postgres up, migrations applied**

```bash
docker compose up -d
pnpm db:seed
```

Expected: containers healthy, `Seeded 2 venues, 10 concerts, 2 admin accounts.`

- [x] **Step 2: Baseline is green before touching anything**

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: pass. If it does not, stop — Plan 03 was merged in this state, and
anything red here is a regression that has to be fixed before Plan 04 begins.

- [x] **Step 3: Currency-freeze point — record the settled decision**

The 27 Aug decision put currency and payment method in a coupling relationship
(BLIK is PLN-only; Klarna in Germany prefers EUR — `00-decisions.md` § "Payment
methods and currency are coupled"). Plan 03 shipped a client-side switcher that
writes a cookie, read server-side. So a Polish buyer who switches to EUR loses
BLIK at the payment step; a German buyer in PLN loses Klarna.

**Owner has chosen Option B**: pin `Order.currency` at the `/zamowienie` page
render, and hide the switcher on that route so what is shown on the summary is
what will be charged. Any switch on other pages takes effect from the next
order onwards.

Record it in `00-decisions.md` under "Payment methods and currency are coupled",
as decided (not open):

> **Currency freeze point.** `Order.currency` is set from the hidden `currency`
> field on the checkout form, which reflects the `km_currency` cookie at the
> moment the order page rendered. The switcher is hidden on
> `/koncert/*/zamowienie` so the currency shown in the summary and the
> currency charged never diverge. Decided 2 Sep 2026.

The implementation lives in `CurrencySwitcher.tsx` — two changes:

- Import `usePathname` from `@/i18n/routing` (NOT `next/navigation`; the
  routing variant strips the locale prefix so the pathname to guard on is
  `/koncert/…/zamowienie`, with a leading slash). Contrast `LocaleSwitcher.tsx`
  which already uses this import.
- Early-return `null` when `usePathname().endsWith('/zamowienie')`.

`useRouter` is already imported for the cookie-write action and stays.

- [x] **Step 4: Extend the seed — MOVED to Task 2 Step 6**

Superseded during execution, 2 Sep 2026. This step originally added the 11th
concert (`test-w-rezerwacji`) with a stale `PENDING` hold here in Task 0. It
cannot run here: it seeds `Order.accessToken`, and that column does not exist
until Task 2's migration.

Splitting it (seed the order now, add the token later) was rejected — it would
leave `heldCount: 5` with no matching `PENDING` order between Task 0 and Task 2,
violating invariant 2 and making `pnpm holds:verify` report false drift the
moment Task 9 introduces it.

**The full seed extension now lives in Task 2 Step 6**, which runs immediately
after the migration that makes it possible. Nothing to do here.

- [x] **Step 5: Note that the shop tests directory is empty**

`tests/app/shop/` has no `.test.ts` files. Plan 03 folded its shop tests into
`tests/lib/shared/` and `tests/lib/server/`. Plan 04 puts its server-action test
here (Task 6) — the pattern is `tests/app/admin/events-action.test.ts`.
Copy that mock idiom verbatim; deviating from it will burn an hour diagnosing
"cookies is not a function".

Two changes to that idiom Plan 04 needs:

- The header mock returns a `let currentIp = '127.0.0.1'` that a test can
  reassign, rather than the fixed literal — Task 6's rate-limit test needs a
  distinct IP per test.
- Every `beforeEach` calls `__resetRateLimits()` (exported from
  `src/lib/server/ratelimit.ts` in Task 6 Step 1), so the module-level Map
  does not carry a used budget between tests in the same file.

- [x] **Step 6: Configure `src/lib/server/db.ts` for production concurrency**

Neon's scale-to-zero cold start alone can exceed Prisma's default `maxWait:
2000` on the first checkout after idle, giving a `P2028` `Transaction API
error` to a buyer who did nothing wrong. Under a real on-sale rush every Vercel
instance opens its own 10-connection pool and serialises on one `TicketType`
row — again `P2028`, again looking like an outage rather than a sell-out.

Modify `src/lib/server/db.ts`:

- Pass `transactionOptions: { maxWait: 15_000, timeout: 30_000 }` to
  `new PrismaClient`. `maxWait` covers cold starts; `timeout` covers a slow
  hold-plus-order chain under contention.
- Pass `max: 10` to `new PrismaPg({ connectionString, max: 10 })`. Neon's
  pooled endpoint gives 10k connections across all clients — leaving 10 per
  Vercel instance keeps us well under budget at up to 1000 concurrent
  instances, which is far beyond festival scale.
- One comment explaining each number and where the tuning trade-off is.

Add one test in `tests/lib/server/db.test.ts` pinging with a large
`Promise.all` — "500 concurrent `SELECT 1`s all succeed within 60s", plus 50
concurrent interactive transactions.

**Be honest about what this test is.** Run the negative control before
believing it: strip `transactionOptions` and `max`, re-run, and observe that it
*still passes*. Local Docker accepts connections too quickly to reproduce a
Neon cold start or cross-instance row contention, so this is a load **smoke
test**, not a guard on the tuning — a green run is not evidence the tuning is
present. Say so in a comment on the test, so nobody later mistakes it for one.
The tuning stays because the reasoning is sound; verifying it needs Neon, which
belongs to Plan 05 or Plan 08.

Verification:

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/db.test.ts
```

---

## Task 1: Correct `03-purchase-flow.md`

The design document was written before three decisions landed. Fix the paper
first, so the plan below cites correct references.

**Files:** `../03-purchase-flow.md`, `../01-architecture.md`.

- [x] **Step 1: Payload shape**

The § "The checkout endpoint" block still shows:

```
items: [{ ticketTypeId: string, quantity: number }],
```

The 27 Aug 2026 decision made one concert per order the settled shape, and
`src/lib/shared/checkout.ts` (NOT `src/lib/shared/schemas.ts`, which the
design doc's line 102 still cites for the checkout payload) already reflects
it — `ticketTypeId` and `quantity` are flat top-level fields. Rewrite the
block to match, correct the citation, and add one paragraph explaining that
the array shape is not present because the settled decision made it
unnecessary; the schema still supports many `OrderItem` rows per `Order` so
a future reversal would not need a data migration.

- [x] **Step 2: The transport**

The document says `POST /api/checkout`. The application uses server actions
everywhere else — login, admin CRUD — and there is no `src/app/api/` at all.
Rewrite as **a server action colocated with the order page**, at
`src/app/(shop)/[locale]/koncert/[slug]/zamowienie/actions.ts`. The signature
is `submitCheckout(prev, formData) → { errors }` (success path throws through
`redirect(...)`, following the `tests/app/admin/events-action.test.ts`
idiom). Cross-reference `src/app/(admin)/admin/events/actions.ts`.

`experimental.serverActions.allowedOrigins` still has to be set at launch —
that stays a Plan 08 item.

- [x] **Step 3: Sweep responsibilities**

The § "Expiry" list currently includes "cancel the Stripe PaymentIntent" and
"decrement the promo code's `usedCount`". Plan 04 has no Stripe and no
`promoCodeId` on any `Order` it creates. Split the list into two:

> **Plan 04's sweep** finds `PENDING` orders where `holdExpiresAt < now()`
> AND `stripePaymentIntentId IS NULL`, decrements `heldCount`, marks the
> order `EXPIRED`, and writes an audit entry.
>
> **Plan 05's sweep** wraps Plan 04's via the `beforeRelease` hook (Task 5
> Step 2) and adds: cancel the Stripe `PaymentIntent` before releasing the
> hold, so a late confirmation cannot succeed. The `IS NULL` clause means
> P24/Klarna/SEPA orders (which sit `processing` for minutes-to-days) are
> only swept once Plan 05 knows their PaymentIntent exists.
>
> **Plan 06's sweep** additionally decrements a promo code's `usedCount`
> when the expired order carried one.

The `vercel.json` schedule config is Plan 05's — Plan 04 ships the callable
function and a `pnpm holds:sweep` script; Plan 05 wires it to a route handler.

- [x] **Step 4: The `Order.reference` regex**

`01-foundations.md`'s closing notes flag this as Plan 04's job. Task 2 writes
the generator; note here (one sentence) that the format is `KM-{YYYY}-{NNNNNN}`
from a Postgres sequence, that server code never accepts a reference from
user input (only generated on `createOrder`, only read as a lookup key from a
URL the fulfilment page controls), and that the `?t=<accessToken>` guard on
that URL is Task 7 Step 1.

- [x] **Step 5: Verify the doc changes did not break the message catalogue tests**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/i18n
```

Expected: pass. (No new keys yet — that is Task 8.)

---

## Task 2: Schema additions

Four schema changes in one migration. All the rest of the plan depends on them.

**Files:**
- Create: `prisma/migrations/YYYYMMDDHHMMSS_plan_04_order_extras/migration.sql`
- Modify: `prisma/schema.prisma`
- Create: `src/lib/shared/order-reference.ts` (pure formatter)
- Create: `tests/lib/shared/order-reference.test.ts`

- [x] **Step 1: Stub the migration from the schema diff**

Add to `Order` in `prisma/schema.prisma`:

```
attendeeNames Json?
accessToken   String @default(uuid())
```

Then stub the migration WITHOUT applying it — the `CREATE SEQUENCE` and
`CHECK` constraints are not expressible in `schema.prisma` and have to be
hand-added to the SQL file:

```bash
pnpm exec dotenv -e .env -- prisma migrate dev --create-only --name plan_04_order_extras
```

Expected: a new `prisma/migrations/…_plan_04_order_extras/migration.sql`
containing the two `ALTER TABLE`s from the schema diff, and NO application.

Open the file and add, above the ALTER TABLEs so a rollback drops the sequence
after the column:

```sql
CREATE SEQUENCE "order_reference_seq";

ALTER TABLE "Order" ADD COLUMN "attendeeNames" JSONB;
ALTER TABLE "Order" ADD COLUMN "accessToken" TEXT NOT NULL DEFAULT gen_random_uuid()::text;

ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_heldCount_nonneg" CHECK ("heldCount" >= 0);
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_soldCount_nonneg" CHECK ("soldCount" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_attendeeNames_is_array"
  CHECK ("attendeeNames" IS NULL OR jsonb_typeof("attendeeNames") = 'array');

CREATE INDEX "Order_email_ticketTypeId_pending_idx"
  ON "OrderItem" ("ticketTypeId")
  INCLUDE ("orderId");
```

`gen_random_uuid()` is in the `pgcrypto` extension, present by default on
Neon and enabled on the local Postgres image. Verify with `SELECT
gen_random_uuid()` through Prisma before applying if unsure.

The index on `OrderItem(ticketTypeId)` supports Task 4 Step 3's dedupe lookup:
finding a PENDING order by `email + ticketTypeId` requires this join to be
cheap. The existing `Order.email` index alone is not enough — the join back
to `OrderItem` would scan otherwise.

Now apply:

```bash
pnpm exec dotenv -e .env -- prisma migrate dev
```

Expected: migration applied, Prisma client regenerates, no schema drift.

- [x] **Step 2: Verify the sequence exists**

```bash
pnpm exec dotenv -e .env -- tsx -e "
  import('./src/generated/prisma/client').then(async ({ PrismaClient }) => {
    const { PrismaPg } = await import('@prisma/adapter-pg')
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL }) })
    const [row] = await db.\$queryRawUnsafe('SELECT nextval(\\'order_reference_seq\\') AS n')
    console.log('nextval:', row.n)
    await db.\$disconnect()
  })
"
```

Expected: `nextval: 1`. A `2` is fine (the sequence pre-existed from an
earlier attempt); the generator is agnostic to the starting number.

Import path is relative (`./src/generated/prisma/client`) not aliased —
`tsx -e` does not reliably resolve `@/` paths, and this matches
`prisma/seed.ts` and `scripts/create-admin.ts`.

- [ ] **Step 3: Write the tests first — pure formatter, then DB-bound generator**

`tests/lib/shared/order-reference.test.ts` (pure — no database):

| Case | Expected |
|---|---|
| Format | `formatOrderReference(137, 2026)` returns `'KM-2026-000137'` |
| Zero-padding | `formatOrderReference(1, 2026)` returns `'KM-2026-000001'` |
| Overflow | `formatOrderReference(1_000_000, 2026)` throws `OrderReferenceOverflow` |
| Regex export | `REFERENCE_RE.test('KM-2026-000137')` is true; `'KM-2026-1234567'` is false; `'KM-26-000137'` is false |

`tests/lib/server/order-reference.test.ts` (DB-bound):

| Case | Expected |
|---|---|
| Year | Passes `new Date('2027-06-15Z')`, gets `KM-2027-…` |
| Monotonic under `Promise.all(100)` inside one transaction | All 100 distinct, all in `KM-YYYY-NNNNNN` shape |
| Accepts a `Prisma.TransactionClient` | Called with `tx`, works inside a `$transaction` that then throws — the reference still advanced (sequences are not transactional in Postgres), but no `Order` row exists |

Both files' `beforeEach` (where applicable) includes:

```ts
await db.$executeRawUnsafe('ALTER SEQUENCE "order_reference_seq" RESTART')
```

Otherwise the overflow test would advance the sequence for every later run.

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/shared/order-reference.test.ts tests/lib/server/order-reference.test.ts
```

Expected: failures. Neither module exists.

- [ ] **Step 4: Implement**

Pure formatter in `src/lib/shared/order-reference.ts`:

```ts
export const REFERENCE_RE = /^KM-\d{4}-\d{6}$/
const MAX_SEQ = 1_000_000

export class OrderReferenceOverflow extends Error {
  constructor(readonly seq: number) {
    super(`Order reference sequence exhausted at ${seq}`)
    this.name = 'OrderReferenceOverflow'
  }
}

export function formatOrderReference(seq: number, year: number): string {
  if (seq >= MAX_SEQ) throw new OrderReferenceOverflow(seq)
  return `KM-${year}-${String(seq).padStart(6, '0')}`
}
```

DB-bound generator in `src/lib/server/order-reference.ts`:

```ts
import 'server-only'
import type { Prisma } from '@/generated/prisma/client'
import { formatOrderReference } from '@/lib/shared/order-reference'

export async function generateOrderReference(
  now: Date,
  client: Prisma.TransactionClient,
): Promise<string> {
  const rows = await client.$queryRawUnsafe<{ nextval: bigint }[]>(
    `SELECT nextval('order_reference_seq') AS nextval`,
  )
  return formatOrderReference(Number(rows[0].nextval), now.getUTCFullYear())
}
```

`nextval` is atomic — two concurrent transactions cannot get the same number
even without holding a row lock, so there is no retry loop and no unique-
violation branch. This is the whole reason for choosing a sequence over
`SELECT MAX(...) + 1`.

`client` is required, not optional — a caller passing `db` from outside a
transaction would work in isolation but starve the pool inside one. The
constraint is captured by the type.

- [ ] **Step 5: Green**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/shared/order-reference.test.ts tests/lib/server/order-reference.test.ts
```

Expected: all cases pass.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib tests/prisma
```

Expected: pass. Prisma schema tests still green with the new columns.

---

- [ ] **Step 6: Extend the seed with the states this plan verifies** *(moved here from Task 0 Step 4 — needs the migration above)*

Plan 03 seeded ten concerts and zero orders. Plan 04 needs an eleventh: **a
concert carrying a pre-existing stale `PENDING` hold**, so Task 9's sweep has
something to sweep on a fresh database, and so `updateEvent`'s "refuse a price
change while held" branch can be smoke-tested by hand.

Add to the `concerts` array in `prisma/seed.ts`:

| Field | Value |
|---|---|
| `slug` | `test-w-rezerwacji` |
| `status` | `ON_SALE` |
| `capacity` | 100 |
| `startsAt` | `inDays(80)` |
| `pricePln` / `priceEur` | 5000 / 1200 |
| `soldCount` | 0 |

Then, **after** the concerts loop (not inside the `event.upsert`), add an
explicit block. It must be idempotent — `pnpm db:seed` is run repeatedly and
the plan's own expected output asserts identical counts on the second run.

- **`db.ticketType.updateMany({ where: { event: { slug: 'test-w-rezerwacji' } }, data: { heldCount: 5 } })`.**
  A separate statement, *not* a field on the nested `ticketTypes.create` —
  the event upsert's `update` branch deliberately leaves nested creates alone
  (`prisma/seed.ts:225` and the comment above it), so a value set only in
  `create` would silently revert to 0 on the second seed and Task 9's
  `released: 5` assertion would drift between runs.
- **`db.order.upsert`** keyed on `reference`, with:
  - `reference: 'KM-0000-000001'` — matches `/^KM-\d{4}-\d{6}$/`, and the
    `0000` year marks it as obviously seeded so it can never collide with a
    real reference drawn from the sequence.
  - `accessToken: 'seed0000-0000-4000-8000-000000000001'` — deterministic, so
    a manual smoke of Task 7's guarded URL is reproducible. Must be a
    syntactically valid v4 UUID: Zod 4's `z.uuid()` checks the version and
    variant bits, which is what broke a Plan 03 fixture (see `/CLAUDE.md`).
  - `kind: 'PURCHASE'`, `status: 'PENDING'`, `holdExpiresAt: inDays(-1)`
    (already expired, so the sweep has work to do), `total: 25000`,
    `currency: 'PLN'`, and buyer fields.
  - `attendeeNames`: five entries in the `[{ index, name }]` shape from Task 4.
  - An `update: {}` branch plus a nested `OrderItem` created only on insert,
    so re-seeding neither duplicates the item nor resurrects a swept order.
- **`OrderItem.quantity: 5`, `unitPrice: 5000`, `currency: 'PLN'`** — Task 9
  asserts `released === 5`, which only holds if the quantity matches the
  `heldCount` above.

Update `tests/prisma/seed.test.ts`: `event.count()` becomes 11, `order.count()`
becomes 1, plus a test asserting the `test-w-rezerwacji` concert has a matching
`PENDING` order whose `holdExpiresAt` is in the past and whose `heldCount` is 5.

```bash
pnpm db:seed && pnpm db:seed
```

Expected, **identically both times** (the second run is the real test — it
proves the `updateMany` and the `upsert` are idempotent):

```
Seeded 2 venues, 11 concerts, 1 orders, 2 admin accounts.
```

Then:

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/prisma/seed.test.ts
```

Expected: green, including the new stale-hold test.

---

## Task 3: The atomic capacity hold

The mechanism this whole plan turns on. One conditional `UPDATE` joined
against `Event`, preceded by a `SELECT ... FOR UPDATE` lock on the Event row.
Postgres row-locks the `TicketType` UPDATE against itself; the Event lock
serialises against `updateEvent` (Task 5 Step 5). No isolation-level tuning,
no `SELECT ... FOR UPDATE` on the TicketType, no advisory locks.

**Files:**
- Create: `src/lib/server/holds.ts`
- Create: `tests/lib/server/holds.test.ts`

- [ ] **Step 1: Write the tests first — single-threaded cases**

| Case | Expected |
|---|---|
| Increases `heldCount` from 0 by the exact quantity | `heldCount === 5` after `holdCapacity(id, eventId, 5, tx)` |
| Refuses when it would push over `capacity − soldCount` | throws `InsufficientCapacityError({ requested, available })` |
| Refuses when `TicketType.active === false` | throws `InsufficientCapacityError`, `heldCount` unchanged |
| Refuses when quantity ≤ 0 | throws `InvalidQuantityError` (caller bug, distinct type) |
| `releaseCapacity(id, N, tx)` decrements by exactly N | `heldCount === 3` after `holdCapacity(5); releaseCapacity(2)` |
| `releaseCapacity` refuses to go below 0 (would violate the CHECK) | Postgres throws `23514`, wrapped as `HeldCountUnderflow` |
| `releaseCapacity` on a non-existent id does not throw and does not create a row | idempotency |
| Requires a `Prisma.TransactionClient` (parameter is required at the type level) | verified by TypeScript, plus a runtime test that calls inside a transaction that then throws — `heldCount` reverts |
| Reads capacity from `Event` inside the SQL, not from a caller argument | verified by a test that lowers `Event.capacity` via `updateEvent` between the caller's read and the hold — the hold uses the fresh capacity |

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/holds.test.ts
```

Expected: failures. `holds.ts` does not exist.

- [ ] **Step 2: The JOIN'd atomic UPDATE, with an Event-row lock**

```ts
// src/lib/server/holds.ts
import 'server-only'
import type { Prisma } from '@/generated/prisma/client'

export class InsufficientCapacityError extends Error { /* requested, available */ }
export class InvalidQuantityError extends Error {}
export class HeldCountUnderflow extends Error {}

export async function holdCapacity(params: {
  ticketTypeId: string
  eventId: string
  quantity: number
  client: Prisma.TransactionClient
}): Promise<void> {
  if (params.quantity <= 0) throw new InvalidQuantityError()

  // Step A. Lock the Event row for the duration of this transaction. Two
  // reasons this is not optional:
  //   1) The predicate reads Event.capacity inside the UPDATE below, and
  //      Postgres's EvalPlanQual rechecks only the target tuple (TicketType)
  //      when a concurrent write forces a re-read — the join side stays on
  //      the transaction's original snapshot. Without this lock a concurrent
  //      updateEvent lowering capacity can commit between the buyer's read
  //      and the buyer's UPDATE, and the buyer's UPDATE uses the older
  //      value.
  //   2) updateEvent (Task 5 Step 5) takes the same lock before changing
  //      capacity or status, so a hold in flight blocks an admin's
  //      concurrent capacity change and vice versa.
  await params.client.$executeRawUnsafe(
    `SELECT id FROM "Event" WHERE id = $1 FOR UPDATE`,
    params.eventId,
  )

  // Step B. The critical UPDATE. Row-locks TicketType at UPDATE time;
  // Postgres re-evaluates the WHERE clause against the freshly-locked row.
  // The JOIN reads Event.capacity through the lock we just took.
  const rows = await params.client.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "TicketType" tt
        SET "heldCount" = tt."heldCount" + $1,
            "updatedAt" = now()
       FROM "Event" e
      WHERE tt.id = $2
        AND e.id = tt."eventId"
        AND tt.active
        AND tt."soldCount" + tt."heldCount" + $1 <= e.capacity
    RETURNING tt.id`,
    params.quantity, params.ticketTypeId,
  )

  if (rows.length === 0) {
    // Compute what IS available for the error message. Cheap — one row,
    // indexed by primary key. Read through the same client so it sees our
    // own uncommitted state.
    const t = await params.client.ticketType.findUnique({
      where: { id: params.ticketTypeId },
      select: {
        soldCount: true,
        heldCount: true,
        active: true,
        event: { select: { capacity: true } },
      },
    })
    const available = t?.active
      ? Math.max(0, t.event.capacity - t.soldCount - t.heldCount)
      : 0
    throw new InsufficientCapacityError(params.quantity, available)
  }
}

export async function releaseCapacity(params: {
  ticketTypeId: string
  quantity: number
  client: Prisma.TransactionClient
}): Promise<void> {
  try {
    await params.client.$executeRawUnsafe(
      `UPDATE "TicketType"
          SET "heldCount" = "heldCount" - $1,
              "updatedAt" = now()
        WHERE id = $2`,
      params.quantity, params.ticketTypeId,
    )
  } catch (e) {
    if (e instanceof Error && String(e.message).includes('TicketType_heldCount_nonneg')) {
      throw new HeldCountUnderflow(`heldCount would go negative for ${params.ticketTypeId}`)
    }
    throw e
  }
}
```

Deliberately no `GREATEST(x - $1, 0)` clamp. Drift is a real bug and Postgres
raising the CHECK is how we hear about it; masking with `GREATEST` silently
manufactures capacity.

**One critique proposed adding `@@unique([eventId])` to `TicketType`** so the
predicate never has to think about multi-type events. That contradicts
`plan/00-decisions.md:11`: the one-row-per-event pattern exists specifically
"so a reduced price can be added later without a migration". This plan
assumes one active `TicketType` per event (which `createEvent` in Plan 01
enforces at insert time), and calls out — as a known limitation, not a fix —
that a future multi-type event would need `holdCapacity` to SUM
`soldCount`/`heldCount` across active types in the predicate, and the caller
to iterate one hold per selected type.

- [ ] **Step 3: Green**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/holds.test.ts
```

Expected: nine cases pass.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/holds.test.ts
```

---

## Task 4: `createOrder` in one transaction

**Files:**
- Modify: `src/lib/shared/checkout.ts` (add `.max(50)` to `quantity`)
- Create: `src/lib/server/orders.ts`
- Modify: `src/lib/server/audit.ts` (accept optional `Prisma.TransactionClient`)
- Create: `tests/lib/server/orders.test.ts`

- [ ] **Step 1: Add `.max(50)` to the schema**

`src/lib/shared/checkout.ts` currently declares
`quantity: z.number().int().positive()` — unbounded. Change to
`z.number().int().positive().max(50)`. Match the `.max(50)` already in
`schemas.ts` for admin `maxPerOrder`.

Add one test row to `tests/lib/shared/checkout-schema.test.ts`:
`quantity: 900` is rejected with error key `quantity`.

- [ ] **Step 2: `recordAudit` accepts an optional client**

`src/lib/server/audit.ts:15` uses the module-singleton `db`. Change signature:

```ts
export async function recordAudit(
  entry: AuditEntry,
  client: Prisma.TransactionClient | typeof db = db,
): Promise<void>
```

All existing callers pass no second argument (unchanged behaviour). Task 4's
`createOrder` passes `tx`. Test that `recordAudit` inside a rolled-back
transaction leaves no row.

- [ ] **Step 3: Write the tests first**

| Case | Expected |
|---|---|
| Happy path | Returns `{ orderId, reference, accessToken, holdExpiresAt }`; `Order` in `PENDING`; `OrderItem` created with `unitPrice` snapshotted from `TicketType`; `TicketType.heldCount` incremented; `Order.attendeeNames` matches `[{index:0,name:'A'},…]` |
| Total computed from DB | `subtotal === unitPrice * quantity`; `total === subtotal`; `discount === 0` (promo codes are Plan 06) |
| `holdExpiresAt` is now + 30 minutes | `HOLD_DURATION_MS === 1_800_000`, tested against a mocked clock |
| `EventNotPurchasableError('unknown')` for **unknown-slug / DRAFT / CANCELLED / past** ticketTypeId | Same reason for all four, because `getPublicEvent` filters those at the query level; `P2025` from `findFirstOrThrow` is caught and re-thrown |
| `EventNotPurchasableError` with specific reason for **SOLD_OUT / CLOSED / notYetOpen / inactive TicketType** | reason matches `notPurchasableReason` |
| Not enough capacity | `InsufficientCapacityError` (from Task 3); no Order row |
| `input.quantity > ticketType.maxPerOrder` | `QuantityAboveMaxPerOrderError({ requested, max })`; no Order row; no capacity held |
| Dedupe on `email + ticketTypeId` when a `PENDING` unexpired order already exists | Returns the SAME `reference` and `accessToken`; no new Order; `heldCount` unchanged |
| Dedupe misses when the existing order is EXPIRED / CANCELLED / FAILED / PAID | New order created; new reference |
| Dedupe misses when the existing order's `holdExpiresAt < now()` (a `PENDING` past-expiry order still on the books because the sweep has not run yet) | New order created; the old one is left to the sweep — do NOT synchronously expire from `createOrder` |
| Transactional atomicity | If `recordAudit` throws (mock it), the Order and hold are still committed — audit is best-effort by design; verified by pre-mock counting rows |
| Attendee-name ordering | Server-side assembly uses explicit indices, so submitting `attendeeNames.0`, `attendeeNames.2` (missing 1) rejects at the action layer, and stored order is `[{index:0,name},{index:1,name},…]` |

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/orders.test.ts
```

Expected: failures.

- [ ] **Step 4: Implement**

```ts
// src/lib/server/orders.ts
import 'server-only'
import { Prisma } from '@/generated/prisma/client'
import { db } from './db'
import { recordAudit } from './audit'
import { holdCapacity, InsufficientCapacityError } from './holds'
import { getPublicEvent } from './public-events'
import { generateOrderReference } from './order-reference'
import { checkoutSchema, type CheckoutInput } from '@/lib/shared/checkout'

export const HOLD_DURATION_MS = 30 * 60 * 1000  // 30 min, 00-decisions

export class EventNotPurchasableError extends Error {
  constructor(readonly reason: string) { super(`Concert not purchasable: ${reason}`) }
}
export class QuantityAboveMaxPerOrderError extends Error {
  constructor(readonly requested: number, readonly max: number) {
    super(`Requested ${requested} tickets, max per order is ${max}`)
  }
}

export type CreateOrderResult = {
  orderId: string
  reference: string
  accessToken: string
  holdExpiresAt: Date
}

export async function createOrder(raw: CheckoutInput): Promise<CreateOrderResult> {
  const input = checkoutSchema.parse(raw)
  const now = new Date()

  // A. Load the concert through the same query the shop uses. This is the
  // single source of truth for "is this purchasable?"; deriving it again here
  // drifts. `findFirstOrThrow` throws P2025 for a well-formed but unknown
  // ticketTypeId, which surfaces as `EventNotPurchasableError('unknown')`
  // rather than a 500.
  let event: { id: string; slug: string; capacity: number }
  try {
    event = await db.event.findFirstOrThrow({
      where: { ticketTypes: { some: { id: input.ticketTypeId } } },
      select: { id: true, slug: true, capacity: true },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new EventNotPurchasableError('unknown')
    }
    throw e
  }

  const view = await getPublicEvent(event.slug, input.locale)
  if (!view) throw new EventNotPurchasableError('unknown')
  if (!view.purchasable) throw new EventNotPurchasableError(view.notPurchasableReason ?? 'unknown')
  if (view.ticketTypeId !== input.ticketTypeId) throw new EventNotPurchasableError('ticketTypeChanged')

  // B. maxPerOrder guard — server-side, before touching capacity.
  if (input.quantity > view.maxPerOrder) {
    throw new QuantityAboveMaxPerOrderError(input.quantity, view.maxPerOrder)
  }

  // C. Dedupe: an existing PENDING unexpired order for the same email +
  // ticketTypeId returns the same reference. Runs outside the transaction —
  // if we lose the race and end up creating a duplicate, that is one extra
  // hold released at expiry; it is not a correctness problem.
  const existing = await db.order.findFirst({
    where: {
      email: input.email,
      status: 'PENDING',
      holdExpiresAt: { gt: now },
      items: { some: { ticketTypeId: input.ticketTypeId } },
    },
    select: { id: true, reference: true, accessToken: true, holdExpiresAt: true },
    orderBy: { createdAt: 'desc' },
  })
  if (existing) {
    return {
      orderId: existing.id,
      reference: existing.reference,
      accessToken: existing.accessToken,
      holdExpiresAt: existing.holdExpiresAt!,
    }
  }

  const unitPrice = input.currency === 'PLN' ? view.pricePln : view.priceEur
  const subtotal = unitPrice * input.quantity
  const total = subtotal
  const holdExpiresAt = new Date(now.getTime() + HOLD_DURATION_MS)

  // D. The transaction: hold + create Order + audit. All-or-nothing.
  const result = await db.$transaction(async (tx) => {
    await holdCapacity({
      ticketTypeId: input.ticketTypeId,
      eventId: event.id,
      quantity: input.quantity,
      client: tx,
    })

    const reference = await generateOrderReference(now, tx)

    const attendeeNames = input.attendeeNames.map((name, index) => ({ index, name }))

    const order = await tx.order.create({
      data: {
        reference,
        kind: 'PURCHASE',
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone ?? null,
        locale: input.locale,
        currency: input.currency,
        subtotal, discount: 0, total,
        status: 'PENDING',
        needsInvoice: input.needsInvoice,
        companyName: input.needsInvoice ? input.companyName! : null,
        nip: input.needsInvoice ? input.nip! : null,
        invoiceAddress: input.needsInvoice ? input.invoiceAddress! : null,
        attendeeNames: attendeeNames as Prisma.InputJsonValue,
        holdExpiresAt,
        items: {
          create: [{
            ticketTypeId: input.ticketTypeId,
            quantity: input.quantity,
            unitPrice,
            currency: input.currency,
          }],
        },
      },
      select: { id: true, reference: true, accessToken: true, holdExpiresAt: true },
    })

    await recordAudit(
      {
        action: 'order.create',
        entityType: 'Order',
        entityId: order.id,
        meta: { reference, ticketTypeId: input.ticketTypeId, quantity: input.quantity },
      },
      tx,
    )

    return {
      orderId: order.id,
      reference: order.reference,
      accessToken: order.accessToken,
      holdExpiresAt: order.holdExpiresAt!,
    }
  })

  return result
}
```

`recordAudit` gets the `tx` — so an audit failure aborts the whole
transaction. This deliberately reverses `recordAudit`'s default "best-effort"
behaviour: for an order-create the audit is the paper trail; a rare Postgres
JSON serialization error is a worse failure to hide than to surface.

- [ ] **Step 5: Green**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/orders.test.ts
```

Expected: twelve cases pass.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib
```

---

## Task 5: Hold-release lifecycle

Every path out of `PENDING` releases the hold. Adds `reclaimCapacityForOrder`
for Plan 05's late-succeed path (`EXPIRED → re-claim → PAID`), and modifies
`updateEvent` so an admin cancelling a concert releases every hold on it.

**Files:**
- Modify: `src/lib/server/orders.ts`
- Modify: `src/lib/server/events.ts` (admin cancel-event releases holds)
- Modify: `tests/lib/server/orders.test.ts`
- Modify: `tests/lib/server/events.test.ts`

- [ ] **Step 1: The transition table**

Express legal transitions once, so Plan 05 adds a row rather than rewriting
every guard:

| From | To | Function | Also |
|---|---|---|---|
| `PENDING` | `CANCELLED` | `cancelOrder(orderId, reason)` | `heldCount -=`, `cancelledAt = now()`, audit `order.cancel` |
| `PENDING` where `holdExpiresAt < now()` | `EXPIRED` | `expireOrder(orderId, opts?)` | `heldCount -=`, audit `order.expire`; optional `beforeRelease` hook |
| `PENDING` | `FAILED` | `failOrder(orderId, reason)` | `heldCount -=`, audit `order.fail` — no caller in Plan 04; stubbed for Plan 05's `payment_failed`/`payment_intent.canceled` |
| `EXPIRED` | `PENDING` | `reclaimCapacityForOrder(orderId, tx)` — Plan 05 only | `holdCapacity` for the order's items, sets `holdExpiresAt = now() + …` |
| `PENDING` | `PAID` | Plan 05 fulfilment | `heldCount −= n; soldCount += n` in one UPDATE |

All four Plan 04 transitions are **idempotent no-ops when already terminal**.
The conditional `UPDATE ... WHERE status = 'PENDING'` is the sole arbiter —
no pre-transaction guard, no thrown-error-on-second-call. Return type is a
discriminated union: `{ released: number } | { alreadyTerminal: true }`.

Tests:

- Each transition decrements `heldCount` by the sum of `items.quantity`.
- Each is idempotent — calling twice does not double-decrement, second call
  returns `{ alreadyTerminal: true }`.
- Under contention: 10 concurrent `cancelOrder` calls on the same order →
  exactly one returns `{ released }`, nine return `{ alreadyTerminal }`,
  `heldCount` decrements exactly once.
- `expireOrder` respects `holdExpiresAt`: called on a `PENDING` order whose
  hold has NOT expired, returns `{ alreadyTerminal: true }` (or a new
  `NotYetExpired` — decide during implementation which reads better in Plan
  05's wrapper); `heldCount` unchanged.
- `expireOrder`'s `beforeRelease` hook: passes an object that throws; the
  whole transaction rolls back, `heldCount` unchanged, status still
  `PENDING`.
- `reclaimCapacityForOrder`: on `EXPIRED`, restores hold and sets status
  `PENDING`; on non-`EXPIRED`, throws. This is Plan 05's tool; the Plan 04
  test exists only to lock in the shape.
- Each writes exactly one `AuditLog` entry per real transition (idempotent
  no-ops write nothing).

- [ ] **Step 2: Implement**

```ts
// src/lib/server/orders.ts (continued)

type ReleaseResult = { released: number } | { alreadyTerminal: true }

async function releaseHoldForOrder(
  orderId: string,
  nextStatus: 'CANCELLED' | 'EXPIRED' | 'FAILED',
  extraGuard: string,  // e.g. '' or 'AND "holdExpiresAt" < now()'
  tx: Prisma.TransactionClient,
): Promise<ReleaseResult> {
  // Conditional UPDATE is the lock. Cast $1 to OrderStatus once, and to
  // text separately for the CASE branch — Postgres refuses to guess.
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "Order"
        SET status = $1::"OrderStatus",
            "cancelledAt" = CASE WHEN $2::text = 'CANCELLED' THEN now() ELSE "cancelledAt" END
      WHERE id = $3 AND status = 'PENDING' ${extraGuard}
      RETURNING id`,
    nextStatus, nextStatus, orderId,
  )
  if (rows.length === 0) return { alreadyTerminal: true }

  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { ticketTypeId: true, quantity: true },
  })
  let released = 0
  for (const it of items) {
    await releaseCapacity({ ticketTypeId: it.ticketTypeId, quantity: it.quantity, client: tx })
    released += it.quantity
  }
  return { released }
}

export async function cancelOrder(orderId: string, reason: string): Promise<ReleaseResult> {
  return db.$transaction(async (tx) => {
    const result = await releaseHoldForOrder(orderId, 'CANCELLED', '', tx)
    if ('released' in result) {
      await recordAudit({
        action: 'order.cancel', entityType: 'Order', entityId: orderId, meta: { reason },
      }, tx)
    }
    return result
  })
}

export async function expireOrder(
  orderId: string,
  opts?: { beforeRelease?: (client: Prisma.TransactionClient) => Promise<void> },
): Promise<ReleaseResult> {
  return db.$transaction(async (tx) => {
    // Plan 05 uses this to cancel the Stripe PaymentIntent BEFORE the hold
    // is released. If the cancel throws, the whole expire is aborted —
    // seats stay held, order stays PENDING, and the next sweep tick tries
    // again. This is why cancel-then-release ordering matters: the reverse
    // opens a window where seats are back on sale but Stripe will still
    // charge.
    if (opts?.beforeRelease) await opts.beforeRelease(tx)

    const result = await releaseHoldForOrder(
      orderId, 'EXPIRED',
      // Guard against the moment Plan 05 extends a hold on a payment retry:
      // the sweep would otherwise expire a live order.
      `AND "holdExpiresAt" < now()`,
      tx,
    )
    if ('released' in result) {
      await recordAudit({
        action: 'order.expire', entityType: 'Order', entityId: orderId, meta: {},
      }, tx)
    }
    return result
  })
}

export async function failOrder(orderId: string, reason: string): Promise<ReleaseResult> {
  // No caller in Plan 04; Plan 05's webhook handler for
  // payment_intent.payment_failed / .canceled will call this.
  return db.$transaction(async (tx) => {
    const result = await releaseHoldForOrder(orderId, 'FAILED', '', tx)
    if ('released' in result) {
      await recordAudit({
        action: 'order.fail', entityType: 'Order', entityId: orderId, meta: { reason },
      }, tx)
    }
    return result
  })
}

export async function reclaimCapacityForOrder(
  orderId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  // Plan 05's late-succeed path. Kept in this module because it composes
  // holdCapacity with an order's items; Plan 05 owns the caller.
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true, items: { select: { ticketTypeId: true, quantity: true } } },
  })
  if (order.status !== 'EXPIRED') {
    throw new Error(`reclaimCapacityForOrder: order ${orderId} is ${order.status}, expected EXPIRED`)
  }
  // The Event id is a join away; use the OrderItem's TicketType to reach it.
  const eventsByTicketType = new Map<string, string>()
  for (const it of order.items) {
    if (!eventsByTicketType.has(it.ticketTypeId)) {
      const tt = await tx.ticketType.findUniqueOrThrow({
        where: { id: it.ticketTypeId },
        select: { eventId: true },
      })
      eventsByTicketType.set(it.ticketTypeId, tt.eventId)
    }
    await holdCapacity({
      ticketTypeId: it.ticketTypeId,
      eventId: eventsByTicketType.get(it.ticketTypeId)!,
      quantity: it.quantity,
      client: tx,
    })
  }
  const newHoldExpiresAt = new Date(Date.now() + HOLD_DURATION_MS)
  await tx.order.update({
    where: { id: orderId },
    data: { status: 'PENDING', holdExpiresAt: newHoldExpiresAt },
  })
}
```

- [ ] **Step 3: Green — lifecycle tests**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/orders.test.ts
```

- [ ] **Step 4: Verify idempotency and contention**

```bash
pnpm test && pnpm test
```

Expected: green both runs. The "10 concurrent cancels" test is the ordering-
bug catcher; if it fails only on the second run, an earlier file is leaking
state.

- [ ] **Step 5: `updateEvent` releases holds on admin cancellation**

`src/lib/server/events.ts`'s `updateEvent` currently guards capacity and
price but not status. Modify: when `input.status === 'CANCELLED'` and the
existing status was something else, inside the same transaction that writes
the new status, iterate every `PENDING` order on the event and call
`cancelOrder`-equivalent logic (do not call `cancelOrder` directly — it would
open a nested transaction and the audit entry would land twice).

Also acquire the same Event row lock at the top: `SELECT id FROM "Event"
WHERE id = $1 FOR UPDATE` — this serialises against `holdCapacity` (Task 3),
so an in-flight buyer either commits before the cancellation or fails cleanly
after it.

Add to `tests/lib/server/events.test.ts`:

- `updateEvent(status: 'CANCELLED')` on an event with 3 PENDING orders → all
  3 become CANCELLED, `heldCount === 0`, 3 audit entries `order.cancel`
  meta `{ reason: 'event_cancelled' }`, one audit `event.update`.
- Same call on an event with 0 PENDING orders → succeeds, no order-cancel
  entries.
- Same call while a hold is in flight (mock a slow `holdCapacity`) → either
  the hold commits first and the cancellation cancels it, or the
  cancellation commits first and the hold sees the fresh status via
  `getPublicEvent` (which reads status). Assert: `heldCount === 0` at the
  end; either 0 or 1 `PENDING` orders that got cancelled.

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/events.test.ts
```

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib
```

---

## Task 6: Wire the form — the checkout server action

Replaces the `PLAN-04:` marker at `src/components/CheckoutForm.tsx:59`.

**Files:**
- Create: `src/app/(shop)/[locale]/koncert/[slug]/zamowienie/actions.ts`
- Modify: `src/components/CheckoutForm.tsx`
- Modify: `src/lib/server/ratelimit.ts` (export `__resetRateLimits`)
- Create: `tests/app/shop/checkout-action.test.ts`

- [ ] **Step 1: `__resetRateLimits` export + mock idiom**

Add to `src/lib/server/ratelimit.ts`:

```ts
/** Test-only: clear the in-memory windows. Never call from application code. */
export function __resetRateLimits(): void { windows.clear() }
```

Add a test asserting rate-limit isolation using the reset in `beforeEach`.

Copy the mock idiom from `tests/app/admin/events-action.test.ts`, with two
changes:

```ts
let currentIp = '127.0.0.1'
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => void 0, delete: () => void 0 }),
  headers: async () => ({ get: () => currentIp }),
}))

import { __resetRateLimits } from '@/lib/server/ratelimit'

beforeEach(async () => {
  __resetRateLimits()
  currentIp = '127.0.0.1'
  await db.$executeRawUnsafe(/* TRUNCATE …, plus ALTER SEQUENCE order_reference_seq RESTART */)
})
```

- [ ] **Step 2: Write the tests first**

| Case | Expected |
|---|---|
| Valid submission | Action throws `Error('REDIRECT:/pl/order/KM-YYYY-NNNNNN?t=<token>')`; `Order` in `PENDING`; `TicketType.heldCount` incremented |
| Validation error (missing email) | Returns `{ errors: { email: ['email'] } }`; **no `Order`, no `heldCount` change** |
| Concert sold out mid-checkout (mock `holdCapacity` to throw) | Returns `{ errors: { _form: ['soldOut'] } }`; no `Order` row |
| Rate-limited by IP: submit 10 times from `currentIp = '1.2.3.4'`, then 11th | 11th returns `{ errors: { _form: ['rateLimited'] } }`; `heldCount` unchanged; a different IP still works |
| Currency freeze (Option B): form says `EUR`, no cookie | `Order.currency === 'EUR'` (form wins) |
| Double-submit dedupe: submit twice with same `email + ticketTypeId + quantity` back-to-back | Both throw `REDIRECT:` to the SAME `reference` and SAME `?t=<token>`; only one `Order` row exists; `heldCount` incremented once |
| Attendee-names index gap: submit with `attendeeNames.0` and `attendeeNames.2` but not `1` | Returns `{ errors: { attendeeNames: ['incomplete'] } }`; no `Order` row |

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/app/shop/checkout-action.test.ts
```

Expected: failures.

- [ ] **Step 3: Implement the action**

```ts
'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { checkoutSchema } from '@/lib/shared/checkout'
import { createOrder, EventNotPurchasableError, QuantityAboveMaxPerOrderError } from '@/lib/server/orders'
import { InsufficientCapacityError } from '@/lib/server/holds'
import { rateLimit } from '@/lib/server/ratelimit'

const CHECKOUT_RPM = 10  // per IP per minute

export type SubmitState =
  | Record<string, never>
  | { errors: Record<string, string[]> }

export async function submitCheckout(_prev: SubmitState, form: FormData): Promise<SubmitState> {
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0].trim() ?? '0.0.0.0'
  if (!rateLimit(`checkout:${ip}`, CHECKOUT_RPM, 60_000)) {
    return { errors: { _form: ['rateLimited'] } }
  }

  // Assemble attendeeNames by explicit index. A missing index fails loudly
  // rather than silently shifting later names onto the wrong ticket.
  const quantity = Number(form.get('quantity'))
  const attendeeNames: string[] = []
  for (let i = 0; i < quantity; i++) {
    const v = form.get(`attendeeNames.${i}`)
    if (typeof v !== 'string' || v.trim() === '') {
      return { errors: { attendeeNames: ['incomplete'] } }
    }
    attendeeNames.push(v)
  }

  const parsed = checkoutSchema.safeParse({
    ticketTypeId: form.get('ticketTypeId'),
    quantity,
    locale: form.get('locale'),
    currency: form.get('currency'),
    email: form.get('email'),
    firstName: form.get('firstName'),
    lastName: form.get('lastName'),
    phone: (form.get('phone') as string) || undefined,
    attendeeNames,
    needsInvoice: form.get('needsInvoice') === 'on',
    companyName: (form.get('companyName') as string) || undefined,
    nip: (form.get('nip') as string) || undefined,
    invoiceAddress: (form.get('invoiceAddress') as string) || undefined,
    acceptedTerms: form.get('acceptedTerms') === 'on' ? true : false,
  })
  if (!parsed.success) {
    // Zod 4: z.flattenError; ZodError.flatten() was removed.
    return { errors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> }
  }

  let result
  try {
    result = await createOrder(parsed.data)
  } catch (e) {
    if (e instanceof InsufficientCapacityError) return { errors: { _form: ['soldOut'] } }
    if (e instanceof QuantityAboveMaxPerOrderError) return { errors: { _form: ['aboveMax'] } }
    if (e instanceof EventNotPurchasableError) return { errors: { _form: ['notPurchasable'] } }
    throw e
  }

  // Redirect throws; the caller never sees a success return.
  redirect(`/${parsed.data.locale}/order/${result.reference}?t=${result.accessToken}`)
}
```

- [ ] **Step 4: Rewire the form**

`CheckoutForm.tsx:58-68` currently logs and shows a stub. Replace with:

```tsx
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { submitCheckout, type SubmitState } from '@/app/(shop)/[locale]/koncert/[slug]/zamowienie/actions'

// inside CheckoutForm:
const [state, action] = useActionState<SubmitState, FormData>(submitCheckout, {})
```

`useActionState` and `useFormStatus` are imported by name — the component does
not import a `React` binding.

Change the `<form>` element to `<form action={action} noValidate>`. Drop
`handleSubmit(onValid)`, drop the `submitted` local state, drop the "stub"
success branch (redirect leaves the page). Keep react-hook-form for
client-side validation UX before submit, but the final validation is Zod on
the server via the schema.

Render `state.errors?._form?.[0]` as a page-level error banner. The
`soldOut`, `aboveMax`, `notPurchasable`, `rateLimited` keys all need copy in
Task 8.

- [ ] **Step 5: Verify — twice**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/app/shop/checkout-action.test.ts
pnpm test && pnpm test
```

Expected: both runs green.

- [ ] **Step 6: Manual smoke**

```bash
pnpm dev
```

Open `/pl/koncert/wieczor-bachowski/zamowienie?q=2`. Fill everything, submit.
Expected: browser lands on `/pl/order/KM-YYYY-NNNNNN?t=<token>`. Query
`TicketType.heldCount` through Prisma — it is `2`. Submit an identical form
from a second tab: it redirects to the SAME reference (dedupe), `heldCount`
still `2`.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/app/shop tests/lib
```

---

## Task 7: The order confirmation page

Somewhere for the redirect from Task 6 to land, and where Plan 05 will attach
Stripe. Guarded by `?t=<accessToken>` — anyone with the URL can view and
cancel, so the URL has to be unguessable by design.

**Files:**
- Create: `src/app/(shop)/[locale]/order/[reference]/page.tsx`
- Create: `src/app/(shop)/[locale]/order/[reference]/actions.ts` (Cancel)
- Create: `src/lib/server/order-lookup.ts` (guarded read)
- Modify: `src/app/robots.ts` (disallow `/*/order/`)
- Create: `tests/lib/server/order-lookup.test.ts`
- Create: `tests/app/shop/cancel-order-action.test.ts`

- [ ] **Step 1: The token-guarded lookup**

```ts
// src/lib/server/order-lookup.ts
export async function getOrderForConfirmation(
  reference: string, token: string,
): Promise<{ order: ..., event: ..., band: 'holding' | 'expired' | 'cancelled' | 'paid' } | null> {
  const order = await db.order.findUnique({
    where: { reference },
    select: { …, accessToken: true },
  })
  if (!order) return null
  // Constant-time compare guards against timing side channels on the token
  // even though the reference is enumerable and only the pair matters.
  if (!timingSafeEqual(Buffer.from(order.accessToken), Buffer.from(token))) return null
  // …compute band
}
```

Tests:

- Returns `{ ... }` for correct `reference + accessToken`.
- Returns `null` for correct reference, wrong token.
- Returns `null` for unknown reference (regardless of token).
- `holdExpiresAt < now()` on a `PENDING` order → band `expired`; the caller
  (page) is responsible for calling `expireOrder` before rendering.
- Constant-time compare: verified only structurally (unit-testing the
  timing is out of scope).

- [ ] **Step 2: The page**

Server Component. `setRequestLocale(locale)` before `getTranslations`. Page
export config:

```ts
export const dynamic = 'force-dynamic'
export const fetchCache = 'default-no-store'
```

Because the page carries buyer PII and live hold state — Next's default
static rendering would cache buyer names between requests, which is a leak
even without indexing.

Renders:

| Band | Copy | Actions |
|---|---|---|
| `holding` (PENDING, not expired) | "Your seats are held until HH:MM. Payment integration coming in the next release." | Cancel-and-release button (Step 3) |
| `expired` (PENDING, past `holdExpiresAt`) | "Your hold has expired. The seats are back on sale." | "Start over" link back to the concert page |
| `cancelled` (CANCELLED / EXPIRED / FAILED) | "This order is no longer active." | Back to programme |
| `paid` (PAID / REFUNDED) | Placeholder — Plan 05 renders tickets here | — |

**Before rendering `expired`**, call `expireOrder(order.id)`. It is
idempotent, races safely, and without it the buyer is told seats are
released and offered "Start over" while their own stale hold still counts —
the concert appears sold-out to the very buyer trying to get back into it.

Show `reference`, buyer's name, concert title/date/venue, quantity, total
in `Order.currency`. **No attendee names on this page** — even guarded by a
token they are PII the confirmation flow does not need to show.

- [ ] **Step 3: The Cancel action**

```ts
'use server'
export async function cancelOrderAction(_prev: unknown, form: FormData) {
  const reference = String(form.get('reference'))
  const token = String(form.get('accessToken'))
  const order = await db.order.findUnique({
    where: { reference },
    select: { id: true, accessToken: true, locale: true },
  })
  if (!order) return { errors: { _form: ['notFound'] } }
  if (!timingSafeEqual(Buffer.from(order.accessToken), Buffer.from(token))) {
    return { errors: { _form: ['notFound'] } }  // same message as unknown
  }
  await cancelOrder(order.id, 'buyer_cancelled')
  redirect(`/${order.locale}/order/${reference}?t=${token}`)  // re-renders as cancelled
}
```

Tests:

- Cancel with correct token → `Order.status === 'CANCELLED'`, `heldCount`
  decremented once, action throws `REDIRECT:`
- Cancel with wrong token → returns `{ errors: { _form: ['notFound'] } }`,
  no state change
- Cancel with unknown reference → same `notFound` shape, no state change
- Submit Cancel twice in a row (same token) → second submission returns the
  `alreadyTerminal` shape wired to the `notFound` copy, `heldCount`
  decremented exactly once (idempotency from Task 5)

- [ ] **Step 4: `robots.ts` disallow `/*/order/`**

`src/app/robots.ts` currently disallows everything until launch. When Plan
02 Task 9 flips this to allow indexing, `/order/` must stay disallowed:
tokens in query strings are still reachable through referrer leaks and
proxy logs. Add an explicit `disallow: '/*/order/'` alongside whatever the
launch state ends up being. Comment it so nobody deletes it during the flip.

- [ ] **Step 5: Manual smoke**

```bash
pnpm dev
```

Complete a checkout (Task 6 Step 6). Copy the URL from the address bar and
try opening it with a mangled `?t=`. Expected: page renders as "order not
found" (constant-time compare fails). With the correct token, refresh —
copy is consistent, hold-until time visible. Click Cancel — page re-renders
as `cancelled`, `heldCount` back to what it was.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/order-lookup.test.ts tests/app/shop
```

---

## Task 8: Message catalogues

Two locales have to say new things: hold status, expiry, cancellation,
sold-out banner, rate limit, above-max, generic error. `tests/i18n/messages.test.ts`
fails on any key missing from any locale, so this blocks Tasks 6 and 7 at
once if deferred.

**Files:** `src/messages/pl.json`, `src/messages/en.json`, `src/messages/de.json`.

- [ ] **Step 1: Add every key in all three locales**

Namespaces to extend or add:

```
checkout.errors.soldOut          "The concert sold out while you were filling in the form."
checkout.errors.notPurchasable   "This concert is no longer on sale."
checkout.errors.aboveMax         "You can order at most {max} tickets in one purchase."
checkout.errors.rateLimited      "Too many attempts — try again in a minute."
checkout.errors.generic          "Something went wrong. Please try again."
checkout.errors.attendeesIncomplete "Please provide a name for every ticket."

order.holdingHeading             "Seats held for you"
order.holdingBody                "We are holding {quantity} seat(s) until {holdTime}. Payment will be enabled in the next release."
order.expiredHeading             "Your hold has expired"
order.expiredBody                "The seats have been released. You can start over."
order.cancelledHeading           "Order cancelled"
order.cancelHold                 "Release these seats"
order.startOver                  "Back to the concert"
order.reference                  "Reference"
order.total                      "Total"
order.notFound                   "No order with this reference exists."
```

Polish needs an ICU `few` plural for `order.holdingBody`. English and German
use `one`/`other`.

**`holdTime` is passed pre-formatted**, not as a raw Date. `src/i18n/request.ts`
sets no `timeZone` for next-intl, so `{holdExpiresAt, time, short}` would
render in the server's zone (UTC on Vercel) — the trap `src/lib/shared/format.ts`
documents. Format with `formatConcertTime(holdExpiresAt, locale)` in the
Server Component and pass the string in.

- [ ] **Step 2: Native-speaker note**

Polish is the source language and the team's own. German and English
placeholder translations are fine to ship the demo; note in
`plan/09-open-questions.md` the DE/EN copy on `order.*` and
`checkout.errors.*` that a native speaker still has to pass.

- [ ] **Step 3: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/i18n/messages.test.ts
```

Expected: pass.

---

## Task 9: The expired-hold sweep and the drift check

Runs every 5 minutes in production (Plan 05 owns the cron config). Plan 04
ships the callable function, a CLI, and a reconciliation script — counter
drift is the one failure that does not self-heal within 30 minutes.

**Files:**
- Create: `src/lib/shared/holds-sweep.ts` (pure — takes a client)
- Create: `src/lib/server/sweep-holds.ts` (`server-only` wrapper binding `db`)
- Create: `scripts/sweep-holds.ts`
- Create: `scripts/verify-holds.ts`
- Modify: `package.json` (add `holds:sweep` and `holds:verify`)
- Create: `tests/lib/server/sweep-holds.test.ts`
- Create: `tests/lib/server/verify-holds.test.ts`

- [ ] **Step 1: Write the tests first — sweep**

| Case | Expected |
|---|---|
| One expired `PENDING` order, no PaymentIntent → one `EXPIRED`, `heldCount` decremented | `{ expired: 1, released: N }` |
| One `PENDING` order still within its hold window | Untouched |
| One `PENDING` order past expiry BUT with `stripePaymentIntentId != null` | **Untouched** — this is a P24/Klarna/SEPA order in `processing` |
| One `PAID` order with a past `holdExpiresAt` (shouldn't happen but must be safe) | Ignored |
| Batching: 550 expired orders across 3 concerts | All expired (loop continues past `take: 500`); ordering by `holdExpiresAt asc` so oldest go first |
| Concurrency: sweep + a buyer's `cancelOrder` on the same PENDING order → exactly one wins | `heldCount` decrements once |
| Audit | One `order.expire` per expired order, actorId null, meta `{ reference }` |
| Empty database | `{ expired: 0, released: 0 }` |

- [ ] **Step 2: Implement**

```ts
// src/lib/shared/holds-sweep.ts — pure, no server-only import
import type { PrismaClient } from '@/generated/prisma/client'
import type { Prisma } from '@/generated/prisma/client'

export async function sweepExpiredHoldsWith(
  client: PrismaClient,
  expireOne: (client: PrismaClient, orderId: string) => Promise<{ released: number } | { alreadyTerminal: true }>,
  now = new Date(),
): Promise<{ expired: number; released: number }> {
  let expired = 0
  let released = 0
  const take = 500

  for (;;) {
    const candidates = await client.order.findMany({
      where: {
        status: 'PENDING',
        holdExpiresAt: { lt: now },
        // Do NOT expire orders that are mid-payment via an async method.
        // Once Plan 05 sets this at hold time, the sweep leaves them alone.
        stripePaymentIntentId: null,
      },
      orderBy: { holdExpiresAt: 'asc' },
      select: { id: true },
      take,
    })

    if (candidates.length === 0) break

    for (const { id } of candidates) {
      const result = await expireOne(client, id)
      if ('released' in result) { expired++; released += result.released }
    }

    // A partial page means we caught up; a full page means keep going.
    if (candidates.length < take) break
  }

  return { expired, released }
}
```

```ts
// src/lib/server/sweep-holds.ts — server-only wrapper
import 'server-only'
import { db } from './db'
import { expireOrder } from './orders'
import { sweepExpiredHoldsWith } from '@/lib/shared/holds-sweep'

export function sweepExpiredHolds(now?: Date) {
  return sweepExpiredHoldsWith(db, (_client, id) => expireOrder(id), now)
}
```

The `_client` parameter is unused in the server binding (it uses `db` via
`expireOrder`), but the shared function's contract accepts one so the CLI can
pass its own.

- [ ] **Step 3: The sweep CLI**

```ts
// scripts/sweep-holds.ts — imports NOTHING from src/lib/server/*
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { sweepExpiredHoldsWith } from '../src/lib/shared/holds-sweep'
import { formatOrderReference } from '../src/lib/shared/order-reference'

const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! }),
  transactionOptions: { maxWait: 15_000, timeout: 30_000 },
})

// The CLI needs its own expireOne that inlines the transition, because it
// cannot import expireOrder from server/. About 40 lines duplicating the
// transaction body — write it as a helper `expireOrderWith(client, id)` in
// src/lib/shared/holds-sweep.ts and both the CLI and the server wrapper
// call it.

async function main() {
  const result = await sweepExpiredHoldsWith(client, expireOrderWith)
  console.log(JSON.stringify(result))
}
main().finally(() => client.$disconnect())
```

Add `expireOrderWith(client, id)` to `src/lib/shared/holds-sweep.ts` so
there is exactly one implementation of the transition. The server-side
`expireOrder` (Task 5) becomes a thin wrapper: `expireOrderWith(db, id,
opts?)`. This is the anti-duplication pattern.

Add to `package.json`:

```json
"holds:sweep": "dotenv -e .env -- tsx scripts/sweep-holds.ts",
"holds:verify": "dotenv -e .env -- tsx scripts/verify-holds.ts"
```

- [ ] **Step 4: Write the tests first — verify**

`pnpm holds:verify` reports per `TicketType`:

- `expected = SUM(oi.quantity) FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId" WHERE o.status = 'PENDING' AND oi."ticketTypeId" = tt.id`
- `actual = tt.heldCount`
- `drift = actual - expected`

Report a summary line per drifted `TicketType`. Exit code 0 if all drifts
are 0; exit 1 if any nonzero. With `--fix`, correct `heldCount = expected`,
write an `AuditLog` entry `holds.reconcile` with meta `{ ticketTypeId,
before, after, drift }`.

Tests:

- No drift → clean report, exit 0.
- Manually poke `heldCount = heldCount + 3`, run without `--fix` → reports
  drift 3, exit 1.
- Same, run with `--fix` → corrects, one audit entry, second run reports 0.

- [ ] **Step 5: Implement `scripts/verify-holds.ts`**

Follows the sweep CLI's structure — its own `PrismaClient`, imports
nothing from `server/`.

- [ ] **Step 6: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/sweep-holds.test.ts tests/lib/server/verify-holds.test.ts
pnpm db:seed
pnpm holds:sweep
```

Expected: tests pass; CLI prints `{"expired":1,"released":5}` against the
freshly seeded database (Task 0 Step 4 seeded a concert with a stale
PENDING order); a second run prints `{"expired":0,"released":0}`.

```bash
pnpm holds:verify
```

Expected: after a run of the seed + sweep, `heldCount` matches the
sum-of-PENDING calculation for every ticket type.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && \
  pnpm exec dotenv -e .env.test -- vitest run tests/lib/server
```

---

## Task 10: The concurrency oversell test

The reason this plan exists. Made explicit and separate rather than folded
into Task 3, because the failure mode this catches — a race between "count
sold" and "insert order" — is not what row-level locking prevents on `holds.ts`
in isolation. The setup here writes through `createOrder`, so the whole
`Order`-plus-hold transaction is under contention.

**Files:**
- Create: `tests/lib/server/oversell.test.ts`

- [ ] **Step 1: The `makeEvent` helper — written out in full**

Task 10 calls `makeEvent` with an event id assumption `createOrder` will
respect. `createOrder` routes through `getPublicEvent`, which returns `null`
without an `EventTranslation` for the requested locale — a naive helper
would surface as `EventNotPurchasableError('unknown')` on all 1000 attempts,
green tests, zero coverage.

Specify:

```ts
async function makeEvent(opts: { capacity: number; venueId: string }) {
  return db.event.create({
    data: {
      slug: `oversell-${Math.random().toString(36).slice(2)}`,
      venueId: opts.venueId,
      startsAt: new Date(Date.now() + 30 * 86400_000),
      capacity: opts.capacity,
      status: 'ON_SALE',
      translations: {
        create: [
          { locale: 'pl', title: 'T', description: 'D', performers: 'P' },
          { locale: 'en', title: 'T', description: 'D', performers: 'P' },
          { locale: 'de', title: 'T', description: 'D', performers: 'P' },
        ],
      },
      ticketTypes: {
        create: [{ pricePln: 5000, priceEur: 1200, maxPerOrder: 5000, active: true }],
      },
    },
    include: { ticketTypes: true },
  })
}
```

`maxPerOrder: 5000` deliberately unlocks the server-side guard for this
test — the concurrency test wants to prove capacity is the binding
constraint, not `maxPerOrder`.

- [ ] **Step 2: The `beforeEach`, written out in full**

```ts
beforeEach(async () => {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "OrderItem", "Order", "TicketType",
                   "EventTranslation", "Event", "Venue"
    RESTART IDENTITY CASCADE
  `)
  await db.$executeRawUnsafe(`ALTER SEQUENCE "order_reference_seq" RESTART`)
  const v = await db.venue.create({
    data: { name: 'V', address: 'A', city: 'C', defaultCapacity: 900 },
  })
  venueId = v.id
})
```

The `ALTER SEQUENCE` matters: without it, an earlier file's writes leave
the counter high, references still work but every assertion of
`{ expired: 1, released: 5 }` shape becomes flaky as ordering shifts.

- [ ] **Step 3: The dedicated Prisma client**

`db` uses Task 0 Step 6's tuned pool + `transactionOptions`, and those are
enough for Tasks 3–7. But 1000 concurrent transactions against a pool of 10
would still deadlock. Task 10 opens its own client:

```ts
import { PrismaClient } from '@/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const oversellClient = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 20 }),
  transactionOptions: { maxWait: 60_000, timeout: 60_000 },
})
```

Why these numbers, in one sentence each:

- `max: 20` — 20 concurrent physical connections; a smaller pool serialises
  the 1000 transactions to the point of `P2028` timeouts before the race
  itself is exercised. Larger changes nothing (Postgres will still
  serialise on the row lock).
- `maxWait: 60_000` — a queued transaction waits up to 60s for a connection;
  under 1000-at-once, tail transactions genuinely wait tens of seconds.
- `timeout: 60_000` — each transaction body has 60s to run; the outer
  SELECT + UPDATE + INSERT + audit chain is well under 100ms per, but
  serialisation on the row lock stacks the wait.

Task 4's `createOrder` uses `db`, not `oversellClient`. To point it at the
oversell client, either export a `createOrderWith(client, input)` variant
(preferred — mirrors Task 9's shape), or set `oversellClient` as a global
`db` override just for this file (fragile). Pick the `createOrderWith`
route; the `createOrder` in Task 4 becomes a `(input) =>
createOrderWith(db, input)` thin wrapper.

- [ ] **Step 4: NEGATIVE CONTROL — verify the harness distinguishes real from fake**

**Before running the positive test, prove it can fail.** Temporarily edit
`src/lib/server/holds.ts` and delete the capacity predicate:

```
// AND tt."soldCount" + tt."heldCount" + $1 <= e.capacity   <-- COMMENTED OUT
```

Run Task 10's Test 1:

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/oversell.test.ts -t 'cannot be oversold'
```

**Record in the Findings log** the observed numbers. Under the fixed
harness with the predicate deleted, the critique measured 1000 succeeded /
`heldCount === 1000` on a `capacity: 900` event — the assertion fails
loudly and specifically, proving the harness distinguishes real from fake.

Restore the predicate. Re-run — 900 succeed, `heldCount === 900`.

**Do not skip this step.** A test that fails identically whether the
protection exists or not proves nothing, and the executor's natural
response is to tune numbers until it passes. This step is what promotes the
oversell test from "green in CI" to "verified evidence".

- [ ] **Step 5: The three tests**

**Test 1 — the headline. 900 seats, 1000 concurrent one-ticket holds.
Exactly 900 succeed.**

```ts
it('a 900-seat concert cannot be oversold under 1000 concurrent buyers', async () => {
  const event = await makeEvent({ capacity: 900, venueId })
  const ticketType = event.ticketTypes[0]

  const results = await Promise.allSettled(
    Array.from({ length: 1000 }, (_, i) => createOrderWith(oversellClient, {
      ticketTypeId: ticketType.id,
      quantity: 1,
      locale: 'pl', currency: 'PLN',
      email: `buyer${i}@example.com`, firstName: 'A', lastName: 'B',
      attendeeNames: ['Test'],
      needsInvoice: false, acceptedTerms: true,
    })),
  )

  const succeeded = results.filter((r) => r.status === 'fulfilled').length
  const failed = results.filter((r) => r.status === 'rejected')

  expect(succeeded).toBe(900)
  expect(failed).toHaveLength(100)
  for (const f of failed) {
    expect((f as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCapacityError)
  }

  const after = await db.ticketType.findUniqueOrThrow({ where: { id: ticketType.id } })
  expect(after.heldCount).toBe(900)
  expect(after.soldCount).toBe(0)

  const pendingForThisEvent = await db.order.count({
    where: {
      status: 'PENDING',
      items: { some: { ticketTypeId: ticketType.id } },
    },
  })
  expect(pendingForThisEvent).toBe(900)
}, 120_000)
```

Two things about this test are load-bearing:

**Why the race is real.** `pg`'s pool is 20 connections. 1000 async tasks
race for 20 physical connections, each transaction physically racing for
the row lock on `TicketType`. Postgres serialises via row lock; the
second-to-arrive re-reads the freshly-locked row, sees the updated
`heldCount`, and evaluates its WHERE clause against the new value.

**Why the assertion is deterministic despite the race.** Which 900 buyers
succeed is nondeterministic. The COUNT of successes and the final
`heldCount` are deterministic — the atomic UPDATE guarantees
`soldCount + heldCount + quantity <= capacity` on every commit, so 100
attempts CANNOT succeed and there is no arithmetic producing any answer
other than 900. The negative control (Step 4) proves this claim is
non-vacuous.

**Timeout raised to 120s** — the original 60s was measured to be too tight
once `createOrder` did its two outer-pool reads plus the transaction; 1000
of these serialising on the row lock plus 20-way parallelism runs 40–80s in
practice.

**Test 2 — mixed quantities. 900 seats, 200 buyers each holding 5 tickets.**

```ts
it('mixed-quantity holds respect capacity exactly', async () => {
  const event = await makeEvent({ capacity: 900, venueId })
  const ticketType = event.ticketTypes[0]

  const results = await Promise.allSettled(
    Array.from({ length: 200 }, (_, i) => createOrderWith(oversellClient, {
      ticketTypeId: ticketType.id, quantity: 5,
      locale: 'pl', currency: 'PLN',
      email: `buyer${i}@example.com`, firstName: 'A', lastName: 'B',
      attendeeNames: ['A','B','C','D','E'],
      needsInvoice: false, acceptedTerms: true,
    })),
  )
  const succeeded = results.filter((r) => r.status === 'fulfilled').length
  expect(succeeded).toBe(180)  // 900 / 5

  const after = await db.ticketType.findUniqueOrThrow({ where: { id: ticketType.id } })
  expect(after.heldCount).toBe(900)  // exactly, not "at most"
}, 120_000)
```

The interesting case: the last buyer to succeed sees `heldCount = 895`
and holds the final 5; the one after them sees `heldCount = 900` and
correctly fails. Without the row-level re-check, the second could pass a
pre-locking WHERE evaluation and oversell by 5.

**Test 3 — hold + release under contention. Never lose a released seat.**

```ts
it('release + hold contention preserves the counter invariant', async () => {
  const event = await makeEvent({ capacity: 100, venueId })
  const ticketType = event.ticketTypes[0]

  const first = await Promise.all(Array.from({ length: 100 }, (_, i) => createOrderWith(oversellClient, {
    ticketTypeId: ticketType.id, quantity: 1,
    locale: 'pl', currency: 'PLN',
    email: `first${i}@example.com`, firstName: 'A', lastName: 'B',
    attendeeNames: ['Test'],
    needsInvoice: false, acceptedTerms: true,
  })))

  // Cancel every other one WHILE a second round of 100 is trying to hold.
  const toCancel = first.filter((_, i) => i % 2 === 0).map((r) => r.orderId)

  const [secondRound, cancellations] = await Promise.all([
    Promise.allSettled(Array.from({ length: 100 }, (_, i) => createOrderWith(oversellClient, {
      ticketTypeId: ticketType.id, quantity: 1,
      locale: 'pl', currency: 'PLN',
      email: `second${i}@example.com`, firstName: 'A', lastName: 'B',
      attendeeNames: ['Test'],
      needsInvoice: false, acceptedTerms: true,
    }))),
    Promise.all(toCancel.map((id) => cancelOrder(id, 'test'))),
  ])

  const after = await db.ticketType.findUniqueOrThrow({ where: { id: ticketType.id } })
  const pendingForThisEvent = await db.order.count({
    where: {
      status: 'PENDING',
      items: { some: { ticketTypeId: ticketType.id } },
    },
  })
  expect(after.heldCount).toBe(pendingForThisEvent)  // invariant 2 — no slack
  expect(after.heldCount).toBeLessThanOrEqual(100)   // invariant 1
}, 120_000)
```

The invariant is `heldCount === sum(PENDING orders' quantities)` for this
ticket type — the strongest form of the counter contract. If either the
release or the hold lost a decrement/increment, the two numbers diverge.
Assertions scoped by `ticketTypeId` so a stray row from an earlier test
does not corrupt the count.

- [ ] **Step 6: Run — and run twice**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/oversell.test.ts
pnpm test && pnpm test
```

Expected: green both times. If the second run is red, the `TRUNCATE +
ALTER SEQUENCE` in `beforeEach` is missing a table an earlier file writes
to.

- [ ] **Per-task verification gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

---

## Task 11: Full verification and handoff

- [ ] **Step 1: Docker Postgres and migrations current**

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

`pnpm lint` catches a component importing from `@/lib/server/*` — exactly
the shape a mistake in Task 6 would take. `pnpm build` catches
`import 'server-only'` reaching a client bundle.

- [ ] **Step 3: Twice**

```bash
pnpm test && pnpm test
```

- [ ] **Step 4: The negative control has been recorded**

Confirm the Findings log has the entry for Task 10 Step 4: measured
success count and measured `heldCount` with the predicate neutered.
Without that entry the concurrency test is not evidence.

- [ ] **Step 5: Reconciliation clean**

```bash
pnpm holds:sweep
pnpm holds:verify
```

Expected: sweep prints `{"expired":0,"released":0}` (the seeded stale
PENDING was already cleared by the manual smoke or an earlier sweep);
verify reports drift 0 on every ticket type.

- [ ] **Step 6: Manual end-to-end walk**

```bash
pnpm dev
```

- Open `/pl/koncert/wieczor-bachowski/zamowienie?q=2`.
- Verify the currency switcher is HIDDEN on this route (Task 0 Step 3).
- Fill everything, submit. Land on `/pl/order/KM-YYYY-NNNNNN?t=<token>`.
- In another tab, mangle the `?t=` — page renders "not found".
- Restore the token — page renders the holding state, time visible.
- Click Cancel → `cancelled` state; `heldCount` back to 0 (verify through
  Prisma).
- Open a stale tab and submit the same form again — expect a REDIRECT to
  the SAME reference (dedupe from Task 4 Step 3).
- In psql-through-Prisma, set one seeded concert to `CANCELLED`, keep its
  checkout URL open, submit → server rejects with `notPurchasable`; no
  `Order` row.

- [ ] **Step 7: Update `plan/STATUS.md`**

Move the Plan 04 bullet from "Next" into "Done", copying Plan 03's shape.
Include:

- The measured test count (`pnpm test` output).
- The concurrency-test result: `900 held / 100 rejected / heldCount === 900`.
- The negative-control record from Task 10 Step 4.
- The currency-freeze decision (Option B, decided 2 Sep 2026 — no longer
  a loose end).
- The dedupe behaviour: second submission from the same email returns the
  same reference.

Under "Next", change the demo-scope bullet from "Plan 04 + the payment
half of Plan 05" to "the payment half of Plan 05".

- [ ] **Step 8: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: inventory holds, orders and oversell protection (Plan 04)"
```

---

## Definition of done

- [ ] `Order` rows created only through `createOrder` / `createOrderWith` —
      never from client input, never with a client-supplied `total`
- [ ] `Order.reference` matches `/^KM-\d{4}-\d{6}$/`, from a Postgres sequence,
      unique under contention
- [ ] `Order.currency` and `Order.attendeeNames` set at creation and never
      changed; `attendeeNames` stored as `[{index, name}]`
- [ ] `Order.accessToken` required for every order-page and cancel-action
      lookup (compared with constant-time equality)
- [ ] `TicketType.heldCount` equals `sum(PENDING orders' quantities)` for its
      concert at all times (invariant 2) — verified by `pnpm holds:verify`
      and by Task 10 Test 3
- [ ] `TicketType.soldCount + heldCount <= capacity` at all times
      (invariant 1) — verified by Task 10 Test 1 with a recorded negative
      control that shows the harness distinguishes real from fake
- [ ] Hold lifecycle: `PENDING` releases via `cancelOrder`, `expireOrder`,
      `failOrder`, all idempotent, discriminated result
- [ ] Holds released on failure, cancellation and expiry; abandonment
      reduces to expiry, mitigated by same-buyer dedupe
- [ ] Admin cancelling an event releases every PENDING hold on it
- [ ] `expireOrder`'s `beforeRelease` hook allows Plan 05 to cancel the
      Stripe PaymentIntent before releasing
- [ ] `reclaimCapacityForOrder(orderId, tx)` exported for Plan 05's late-
      succeed path — `EXPIRED → PENDING → PAID`
- [ ] Sweep expires `PENDING` orders past `holdExpiresAt` AND
      `stripePaymentIntentId IS NULL`, decrements `heldCount`, writes audit
- [ ] `holds:sweep` and `holds:verify` CLIs work, safe to re-run,
      `--fix` for verify writes audit entries
- [ ] Checkout form submits through a server action, replacing the
      `PLAN-04:` stub at `CheckoutForm.tsx:59`
- [ ] `maxPerOrder` enforced server-side in `createOrder`;
      `checkoutSchema.quantity` capped at `.max(50)`
- [ ] `soldOut`, `notPurchasable`, `aboveMax`, `rateLimited`,
      `attendeesIncomplete` errors render in the buyer's language
- [ ] Order confirmation page renders `holding`/`expired`/`cancelled` bands
      with correct copy in three languages; token required
- [ ] Page is `dynamic = 'force-dynamic'`, `fetchCache = 'default-no-store'`,
      `robots.ts` disallows `/*/order/`
- [ ] `expireOrder` called on page render when the hold is past its expiry,
      so "start over" is honest
- [ ] Cancel-and-release works; second click no-ops without error
- [ ] Currency-switcher hidden on `/koncert/*/zamowienie`
- [ ] `db.ts` sets `transactionOptions` and `max: 10` with justifying
      comments
- [ ] Task 10 uses a dedicated client with `maxWait: 60_000`, `timeout:
      60_000`, `max: 20`
- [ ] Task 10 Step 4's negative control was run and recorded
- [ ] Findings log carries every discovery from the critique pass and any
      new discoveries from execution
- [ ] `03-purchase-flow.md` reflects the flat payload, server-action
      transport, and Plan 04/05/06 sweep split
- [ ] `STATUS.md` reflects Plan 04 done; currency-freeze decision recorded
- [ ] Clean-tree gate green; suite green twice
- [ ] **No `Ticket` rows created anywhere in this plan** — invariant 3, Plan 05's
- [ ] **No Stripe code anywhere in this plan** — the seam for Plan 05 is
      `createOrder` returning `{ orderId, reference, accessToken,
      holdExpiresAt }`, `expireOrder({ beforeRelease })`, and
      `reclaimCapacityForOrder`

---

## What this plan does not cover

- **Stripe, PaymentIntents, webhooks, `Ticket` creation, ticket codes, PDF,
  email** — Plan 05. `Ticket.code` (Crockford base32) and its collision
  strategy belong there because a ticket only exists after fulfilment.
- **The `held → sold` conversion at fulfilment.** Plan 05 must do it as a
  single `UPDATE "TicketType" SET "heldCount" = "heldCount" - $1, "soldCount"
  = "soldCount" + $1, "updatedAt" = now() WHERE id = $2 AND "heldCount" >=
  $1 RETURNING id` — atomic on the row, with the same JOIN-and-lock pattern
  as `holdCapacity` if capacity may have changed since the hold. Splitting
  the decrement and increment is where the counters actually drift. Not
  Plan 04's implementation, but if Plan 04's Definition of Done accepts a
  design that permits the split, Plan 05 will inherit the bug — so this is
  called out here.
- **`vercel.json` cron schedule for `/api/cron/release-holds`** — Plan 05.
  Plan 04 ships the function and a `pnpm holds:sweep` CLI; Plan 05 wires it
  to a route handler and a Vercel cron entry.
- **Cancelling the Stripe PaymentIntent on hold expiry** — Plan 05, via
  `expireOrder({ beforeRelease })`.
- **Signed order-lookup token replacing `accessToken`** — Plan 05, if a
  stronger scheme is needed (e.g. HMAC over `reference + createdAt`). Plan
  04's random UUID column is sufficient for the demo and eliminates the
  enumeration attack.
- **Promo codes, invitations, refunds** — Plan 06. `promoCodeId` is left
  null on every `Order` this plan creates. Plan 06 also owns
  promo-`usedCount` decrement on expiry.
- **Shared rate limiting across Vercel instances** — Plan 08. The per-
  instance limiter from Plan 01 is reused; on Vercel the effective checkout
  limit is looser than the number in the code, and that is accepted for the
  demo.
- **RODO retention job** that anonymises `Order.attendeeNames` alongside
  buyer PII and `Ticket.holderName` — Plan 08.
- **`experimental.serverActions.allowedOrigins`** for the checkout action —
  Plan 08, once the production domain is known.
- **Multi-`TicketType` per event.** `createEvent` (Plan 01) creates exactly
  one; `holdCapacity` predicates on that one active row. Multi-type events
  would need the SUM-across-types predicate and a per-type hold loop.
  Flagged as a known limitation, not a fix; will be re-opened when a
  reduced/student price is added.
