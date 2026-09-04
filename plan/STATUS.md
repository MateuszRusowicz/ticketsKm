# Status — 4 September 2026

Where the project stands, for whoever picks it up next. Update this at the end
of a working session; it is the fastest way back into context.

## Done

**Plan 01 — Foundations: complete.** All 16 tasks. (114 tests at the time; the
suite is now 185 across 24 files after Plan 03.)

The application runs locally in full: `pnpm dev`, then log in at
`/admin/login` as `admin@krzyzowa-music.eu` / `DevPassword123!` and create a
concert with Polish, English and German content, prices in PLN and EUR, and a
capacity that cannot be lowered below tickets already sold.

**Plan 03 — Public programme: complete.** All 13 tasks, definition of done
fully ticked, manual pass accepted by the owner 30 Aug 2026. 185 tests across
24 files, green twice from a clean tree.

The demo walks end to end: programme listing → concert page → buy box → order
form, in three languages and two currencies, on `feat/plan-03-public-programme`.

- Public queries filter by status, sales window, past dates and `TicketType.active`
- Currency defaults from locale, switchable, cookie-persisted, never converted
- Concert pages 404 for unknown, `DRAFT`, `CANCELLED` and past slugs
- Checkout form collects one name per ticket; `?q=` re-clamped server-side
- Terms and privacy pages in three languages, linked from a footer
- `robots.txt` blocks indexing until launch
- **No `Order` is created anywhere** — that is Plan 04

**Plan 04 — Inventory: complete.** All 12 tasks. 34 test files, **290 tests**,
green twice from a clean tree. Two manual smokes confirmed by the owner.

The risky core is built and, more importantly, *proven*:

- **A 900-seat concert cannot be oversold.** 1000 concurrent buyers → exactly
  **900 succeeded, 100 rejected** with `InsufficientCapacityError`,
  `heldCount === 900`, `soldCount === 0`, 900 `PENDING` orders.
- **Negative control recorded** (the step that makes the above evidence rather
  than decoration): with the capacity predicate commented out of
  `holdCapacity`, the same test reported **1000 of 1000 succeeded** and failed
  loudly. Restored, it passes. A test that fails identically either way proves
  nothing.
- **Capacity is JOINed from `Event` inside the UPDATE**, never passed in as a
  caller value — an admin lowering capacity mid-checkout can no longer let a
  hold through against a stale number. Preceded by `SELECT … FOR UPDATE` on
  the Event row, which also serialises against `updateEvent`.
- **Same-buyer dedupe**: a second submit for the same email and concert
  returns the *same* reference and token instead of stranding a second
  30-minute hold. This is what makes "holds are released on abandonment" true
  rather than aspirational.
- **`maxPerOrder` is enforced server-side**, so one crafted POST can no longer
  hold an entire venue.
- **The confirmation page and Cancel action require `?t=<accessToken>`.**
  References come from a monotonic sequence and are enumerable by design, so
  the token is the guard. A wrong token is indistinguishable from an unknown
  reference.
- **The sweep skips orders with a `stripePaymentIntentId`**, so Plan 05's
  Przelewy24 / Klarna / SEPA orders — which sit in `processing` for minutes to
  days — are never expired out from under a paying buyer.
- **`pnpm holds:verify`** reconciles `heldCount` against the orders justifying
  it, with `--fix`. Counter drift is the one failure that does not heal when a
  hold lapses. It found a real seed bug on its first serious use.
- **Currency freeze settled (Option B, 2 Sep 2026):** pinned at the order page,
  switcher hidden on that route, so the summary and the charge cannot diverge.

`plan/steps/04-inventory.md` carries a **Findings log with 40+ entries** —
about a dozen from executing it, including two defects that would have stopped
execution outright and three tests that passed for the wrong reason.

**Plan 02 — Deployment: tasks 1–6 done, including 6a.**

- Neon project in `eu-central-1`, branches `production` and `development`
- All 3 migrations applied to production; 13 tables; **2 admin accounts**, neither seeded
- Pooled reads and interactive transactions verified through `PrismaPg`
- Vercel project building with `pnpm vercel-build`, functions region `fra1`
- Deployed successfully — all routes present, all three locales prerendered
  *(superseded 30 Aug by Plan 03 Task 3: the shop reads a currency cookie and
  live availability, so `/[locale]` is now server-rendered on demand — `ƒ`, not
  `●`. Intended; build-time-frozen availability would be worse than useless.)*

## Next

**The milestone is a test-mode demo, decided 2 September 2026.** A working
product that takes dummy payments and creates real orders for both Polish and
German buyers, in Stripe **test mode**, on `tickets-km.vercel.app`. The domain
and the link from the existing Wix site are connected only **after** that demo
is accepted. Full reasoning in
[`00-decisions.md`](00-decisions.md#delivery-sequence-a-test-mode-demo-before-the-domain).

Demo scope is now **the payment half of Plan 05** — Plan 04 landed 3 Sep 2026:

> buyer picks a concert → seats are held → pays with test BLIK / P24 / Klarna /
> card → sees a confirmed order → capacity has decremented.

**Deliberately outside the demo:** ticket email, PDF, QR codes, the door
scanner, promo codes and refunds. They stay in Plans 05–07.

### Plan 05 execution started 4 Sep 2026 — Tasks 0–4 done

On branch **`feat/plan-05-payments`** (cut from `development`; Plan 04's branch
is merged and deleted). **Nothing is committed** — the whole of the below sits
in the working tree awaiting the owner.

| Task | What | State |
|---|---|---|
| 0 | Baseline gate | ✅ green on re-run, 290 tests |
| 1 | Stripe account, keys, CLI, Vercel Pro | ✅ complete |
| 2 | `stripe@19.3.1` + env schema + `.env.test` | ✅ 8 new tests |
| 3 | Migration — 4 `Order` cols, 2 ledger cols, 3 indexes | ✅ applied to `km_dev` + `km_test` |
| 4 | Design-doc corrections | ✅ docs only |
| **5** | **Stripe wrapper + allowed-methods** | **next** |

**Baseline is now 300 tests** (290 + 8 env-schema + 2 schema-column), green
**twice** from a clean tree, `✓ Compiled successfully`, exit 0 both runs.

Three traps found and fixed during execution, all now in
[`/CLAUDE.md`](../CLAUDE.md) because they recur:

- **`pnpm` is not on a non-interactive shell's PATH.** `~/.bashrc` returns at
  line 8 before nvm loads. `~/.local/bin` *is* present (Ubuntu's `~/.profile`),
  so the shell looks healthy until the first `pnpm` call fails with exit 127.
- **Every `prisma migrate dev` emits `DROP INDEX
  "OrderItem_ticketTypeId_orderId_idx"`** and the line must be deleted by hand
  each time. It is a covering index (`INCLUDE ("orderId")`) that Prisma's
  schema language cannot express, so it reads as permanent drift. Applying it
  silently removes the index behind Plan 04's same-buyer dedupe. Verified
  against both databases.
- **`prisma migrate diff --from-schema-datasource` was removed in Prisma 7** —
  it is `--from-config-datasource`.

Two defects fixed that no gate would have caught:

- **`verify-holds.test.ts` timed out at 5000ms** and failed the baseline. A
  pre-existing marginal timeout, not a Plan 04 regression: each `runVerify()`
  spawns `pnpm exec tsx` at ~2.6s and that test spawns two, against Vitest's
  5s default. `reset-admin-password.test.ts:24-28` had diagnosed the same
  defect, fixed only itself, and predicted this in writing. Same
  `SPAWN_TIMEOUT = 30_000` applied.
- **`CRON_SECRET` was missing from `.env`**, so `pnpm dev` would not boot. The
  plan extended `.env.test` and `.env.example` but never `.env` — which is
  git-ignored, so no test or gate reads it. Generated; Task 2 gained the step.

**Research settled:** Stripe does **not** auto-cancel abandoned PaymentIntents.
`cancellation_reason: 'abandoned'` is user-provided, and the 7-day figure
applies only to uncaptured `requires_capture` PIs (manual capture, which Plan 05
does not use). Abandoned PIs linger indefinitely — harmless, since an
unconfirmed PI cannot charge, but the clean-up is a **Plan 06** item. Recorded
in [`00-decisions.md`](00-decisions.md#hold-expiry-does-not-call-stripe).

**`03-purchase-flow.md`'s cancel-before-release mandate is now superseded** —
the passage calling it "the nastiest bug in the system" is gone, replaced by a
dated supersession notice pointing at `00-decisions.md`. Deliberate, per the
4 Sep owner decision.

**Still outstanding for the owner:** `NEXT_PUBLIC_SITE_URL` on Vercel must be
`https://tickets-km.vercel.app` (Task 15) — a wrong value breaks four of the six
demo flows, and only in production.

**Next up: EXECUTE Plan 05 (payments), checkout half only.**
[`steps/05-payments.md`](steps/05-payments.md) — **written, critiqued twice,
verified, and ready.** 17 tasks (0–16), 2391 lines, 103 findings entries.

It took three drafts. That history matters, because it explains the shape:

- **Draft 1** (13 tasks) — three independent critique agents found **nine
  blockers**, six of them convergent. Two ran code: the test suite would have
  died at Task 2, and the plan did not deploy anything, so it could not have
  produced the demo it was written for.
- **Draft 2** (18 tasks) — a verification pass found the revision **still not
  executable**. Of seven claimed fixes only one was fully closed, and the
  largest redesign — a two-transaction "cancel the PaymentIntent, then release
  the seats" primitive — introduced **four new blockers of its own**, one of
  which violated the exact invariant it existed to guarantee.
- **Draft 3** (17 tasks) — after an owner decision to **simplify** (below), the
  machinery generating those bugs was deleted outright.

**Verified by hand on the final draft**, because two earlier self-audits
claimed to be clean and were not:

| Check | Result |
|---|---|
| Every Stripe call and `PaymentIntent` field, compiled against `stripe@19.3.1` under `--strict` | **exit 0** |
| Cross-references across 17 tasks | clean — the one `Task 17` hit is the plan's own audit grep |
| Deleted machinery (`expiringLockedAt`, `cancelPaymentIntentThenRelease`) | only in the findings entry recording removal and the DoD forbidding it |
| The six proposed migration columns | genuinely new against the live schema |

### Three owner decisions settled 4 Sep 2026

**1. No PaymentIntent cancellation on expiry.** When a hold lapses, release the
seats and do not call Stripe. An abandoned card checkout charges nobody — the
buyer never confirmed — so cancelling is hygiene, not safety. This **overrides**
[`03-purchase-flow.md`](03-purchase-flow.md)'s cancel-then-release mandate,
which called the reverse "the nastiest bug in the system"; that guidance is
deliberately superseded and the doc is corrected in Plan 05 Task 4.

> **The consequence, which is now load-bearing:** a live PaymentIntent can still
> succeed after its seats are released. The **reclaim-or-refund path is
> therefore the primary safety net, not an edge case.** If anything in Plan 05
> deserves paranoid testing, it is that path.

**2. SEPA Direct Debit is enabled, and seats are held for it** — chosen against
a recommendation, with the arithmetic understood. SEPA is the one method that
genuinely sits in Stripe's `processing` state for days. Three guardrails make it
survivable, all env-tunable:

- concurrent SEPA holds capped at **10% of a concert's capacity**
- SEPA hidden once a concert is within **20% of selling out**
- a hard **5-day** ceiling on any SEPA hold

Without these the arithmetic is stark: at 25% payment-step abandonment on a
900-seat concert, a 6.5-hour hold strands ~975 seats — **more than the venue** —
so the concert reads sold out while seats remain unsold.

**3. Auto-refund on a capacity-lost late success ships, with an operational
alert.** A buyer whose payment cleared after the concert sold out is refunded
automatically, and a human is told so they can make contact. The buyer *email*
is Plan 06; shipping a silent debit-then-credit for a one-shot event was
rejected. The alert is `console.error('RECONCILE alerts=…')` on **stderr**
(Vercel captures stderr, not response bodies) and is documented as a **stopgap
until Plan 07's admin dashboard** — not a real alerting system.

### Blocked on the owner before Task 5 — **cleared 4 Sep 2026, except Vercel Pro**

Plan 05 **Task 1 is done bar Step 7.** The local Stripe environment is complete
and verified; nothing now blocks Tasks 0–14.

| # | What | State |
|---|---|---|
| 1 | Stripe test account, country **PL** | ✅ `acct_1UBpQ6GVCpToPFr7`, `livemode: false` — verified against `GET /v1/account`, not the dashboard |
| 2 | `STRIPE_PUBLISHABLE_KEY` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` in `.env` | ✅ all three present, prefixes match names, no placeholder |
| 3 | Payment methods enabled in test mode | ✅ owner-reported (Card, BLIK, P24, Klarna, SEPA) — first actually exercised by Task 5 |
| 4 | Stripe CLI | ✅ v1.50.10 in `~/.local/bin` |
| 5 | **Vercel Pro** | ⬜ **still outstanding.** Blocks **Task 13 only.** On Hobby, cron is once-daily at best, so **both sweeps silently never run** and abandoned holds are never released. |
| 6 | **`NEXT_PUBLIC_SITE_URL` on Vercel** must be `https://tickets-km.vercel.app`. Locally it is `http://localhost:3000`. | ⬜ Task 15. Plan 05 builds the payment `return_url` from it — a wrong value **breaks four of the six demo flows**, and only in production. |

**All Stripe variables live in `.env`, not `.env.local`** (owner decision, 4 Sep
2026). There is no `.env.local` in this repo; the plan's ten references to one
were rewritten.

Three traps found while doing this, all now in Plan 05's Findings log:

- The keys arrived **misnamed and swapped** — `STRIPE_API_KEY` held the secret,
  `STRIPE_SECRET_KEY` held the publishable. **Check the prefix, not the name.**
- The **Stripe CLI is not in Ubuntu's apt repos**; `sudo apt install stripe`
  fails. It is a binary drop or Stripe's own apt repo.
- `stripe login` offers **sandbox or test mode**. A sandbox is a *separate
  account* that also issues `sk_test_` keys, so choosing wrong is invisible in
  the prefix and shows up only as every webhook failing signature verification.
  `stripe config --list` → `account_id` is the check.

Tasks 0–4 (baseline, design-doc corrections, the migration) never needed any of
this. Everything from Task 5 needs the keys, which are now in place.

### Deployment fixed 4 Sep 2026

Vercel had been failing for days. Cause: it was building **commit `c926ef2` on
`feat/plan-03-public-programme`** — 13 commits stale — and `vercel-build` runs
`prisma migrate deploy` *before* `next build`, so a commit predating Plan 04's
migration could never deploy against a database that already had it. Retrying
re-ran the same dead commit, which is why it never recovered.

Fixed by pointing Vercel's build branch at **`development`**. `feat/plan-03-public-programme`
is merged and deleted. `feat/plan-01-foundations` is still on the remote and can
go the same way.

**Historical context — Plan 04's hold rules.** Hold duration settled 30 Aug
2026: **30 minutes, flat across all venues.** The accompanying requirement is that Plan 04 releases
holds on payment failure, abandonment and cancellation — not only on expiry.
The 5-minute sweep is the backstop, not the mechanism.

**Test mode needs no verified Polish entity**, so the demo runs on a test-mode
account and the real one swaps in at launch with no code change. Test mode needs no
verified Polish entity, so a fresh test-mode Stripe account with country PL is
created now and its keys go in as environment variables — the real account swaps
in at launch with no code change. Two caveats that survive this:

- **Klarna's availability to a real Polish Stripe account is still unverified.**
  A test-mode account offering it proves nothing about the live one.
- **DNS control is still the longest-lead-time item outstanding.** It no longer
  blocks the demo (no domain, no email), but it blocks launch, and it gates
  Resend's SPF/DKIM records when Plan 05's fulfilment half is built.

Plan 02's remaining tasks are all deferred to launch. For reference, the two
production accounts are:

| Email | Role |
|---|---|
| `mateusz.rusowicz@krzyzowa-music.eu` | ADMIN |
| `mde@krzyzowa-music.eu` | SCANNER |

Created 25 Aug 2026; `AdminUser` holds exactly these two, nothing seeded.
Session cookie flags verified in production (`HttpOnly`, `Secure`,
`SameSite=Lax`, `Path=/admin`), and the SCANNER account is correctly refused
`/admin/events` and sent to `/admin/scan` — which 404s, because the scanner
itself is Plan 07. The redirect is the check; the 404 is expected.

**The production URL is `https://tickets-km.vercel.app`.** Record it somewhere
durable; it was very nearly lost with `.env.vercel-values.txt` and had to be
recovered from old session transcripts.

**Passwords live in `.env.admin-credentials.txt`** (git-ignored, repo root).
Move them into the password manager and delete the file. If they are lost,
`pnpm admin:reset-password <email>` — see Task 6a.

**Decided 27 Aug 2026: the app is built entirely against the Neon
`development` branch.** Vercel Production moves to the development connection
strings, dummy data is seeded there, and the real database is connected once at
the end by the new Plan 02 **Task 9**. Neon `production` stays dormant with its
migrations and the two real admin accounts.

Do not seed admin accounts even on `development` — the seed password is public
and the site is on a public URL. Use `pnpm admin:create`.

| Task | What | When |
|---|---|---|
| 7 | Point `bilety.krzyzowa-music.eu` at Vercel via CNAME, and link it from the existing Wix site. | **Deferred until the test-mode demo is accepted** — reaffirmed 2 Sep 2026. Confirm *who controls DNS* now regardless: it is the longest-lead-time item outstanding and Plan 05's email half needs the same access for Resend's SPF/DKIM. |
| 8 | Verify a Neon point-in-time restore by performing one; take an off-platform `pg_dump`; add uptime monitoring. | Restore drill worth rehearsing now; dump at cutover. Needs `sudo apt install postgresql-client-16`. |
| 9 | Cut over to the real database and connect the domain. | **Last**, once the app is finished. |

**Three product decisions settled 27 Aug 2026** (see
[`00-decisions.md`](00-decisions.md)):

- **One concert per order.** No cart. A buyer attending three concerts pays
  three times.
- **A name per ticket**, against the plan's own recommendation of anonymous
  tickets. Lengthens checkout and puts personal data on every `Ticket`, which
  widens the RODO retention job.
- **Stay on `tickets-km.vercel.app`** until launch.

**[Plan 03](steps/03-public-programme.md) was written, critiqued, rewritten and
executed between 27 and 30 Aug 2026.** Two independent critique passes found two
blockers, an internal contradiction and a schema mismatch *before* any code was
written; the plan grew from 9 tasks to 13 as a result. Its **Findings log**
records nineteen discoveries made during execution.

The findings worth carrying forward:

- **The test setup cannot render components** — `vitest.config.mts` is
  `environment: 'node'` with `include: ['tests/**/*.test.ts']`, and there is no
  jsdom or `@testing-library/react`. The plan now tests pure functions instead.
- **`eslint.config.mjs` bans `@/lib/server/*` from `src/components/**`** with no
  `allowTypeImports` escape, so shared types must live in `src/lib/shared/`.
- **The shop stops being statically prerendered** once it queries availability
  and reads a currency cookie. That is correct for a ticketing site, but it
  changes the Plan 02 result recorded above.
- **next-intl's `t.rich` uses tag syntax (`<terms>…</terms>`), not
  `{placeholders}`.** Written the wrong way it fails silently — the terms
  checkbox rendered with no links at all, and typecheck, lint and tests all
  passed. Only reading the served HTML caught it.
- **Zod 4's `z.uuid()` checks the RFC 4122 version and variant bits**, so a
  hand-written `1111-1111-…` fixture is rejected.
- **`react-hook-form`'s `watch()` blocks React Compiler.** Use
  `useWatch({ control, name })`.

## Loose ends

- **Branching is set up (27 Aug 2026):** `main` is production and is what Vercel
  Production tracks; `development` integrates finished features; feature
  branches are work in progress. `feat/plan-01-foundations` is now redundant and
  can be deleted locally and on the remote.
- **Rotate the Neon password.** The connection strings were pasted into a chat
  transcript. Neon → Roles → Reset password, then update the Vercel variables.
- **`.env.vercel-values.txt` is deleted.** Done 25 Aug 2026. Note that it was
  the only local record of the Vercel deployment URL, which is now nowhere in
  the repository — write the domain into this file once Task 7 lands.
- **GitHub Actions warns that Node 20 actions are deprecated.** Cosmetic; it is
  about `checkout@v4` / `setup-node@v4` themselves, not our `node-version: 24`.
  Bump the action versions when convenient.
- **`.vscode/` is untracked.** Commit or ignore it.

## Things that will bite you if you forget them

**The canonical list now lives in [`/CLAUDE.md`](../CLAUDE.md)**, which is loaded
automatically at the start of every session — unlike this file, which is only
read when someone remembers to. Keeping two copies guarantees drift, so add new
traps there, not here.

That file covers: the Prisma 7 driver adapter and generated-client import path,
the gated `pnpm db:reset`, `server-only` throwing under Vitest and tsx, the
ESLint ban on `@/lib/server/*` in components, the Node-environment test setup
with no DOM, `next typegen` before `tsc`, `proxy.ts` versus `middleware.ts`,
route groups in import paths, minor-unit money, prices on `TicketType` versus
capacity on `Event`, the Warsaw double-cast, the unusable `psql`/`pg_dump`, and
the two plan-numbering schemes.

## Verification gate

Every task ends with this, from a clean tree:

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Run the test suite **twice** when a task adds tests that assert exact row
counts — files share one database and run sequentially, so ordering matters.
