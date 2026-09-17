# Handoff

For whoever takes over this project — a new developer, or the person who has to
keep it running when the current one is unavailable. It records the things that
are **not** in the code: which accounts exist, who holds them, what is deployed
where, and what breaks if nobody knows.

Three documents, three jobs:

| Document | Answers |
|---|---|
| [`README.md`](README.md) | What the system is, how it works, how to run it |
| [`plan/STATUS.md`](plan/STATUS.md) | Which task is next, and what is half-finished |
| **This file** | Who has access to what, and how to operate it |

Last updated: **7 September 2026.**

---

## The project in one paragraph

Ticket sales for the Krzyżowa Music festival — roughly ten general-admission
concerts each August, sold in three languages (PL / EN / DE) and two currencies
(PLN / EUR), taking payment through Stripe with local methods (BLIK, Przelewy24,
cards). It replaces the Wix ticketing the festival used previously, and will
live at `bilety.krzyzowa-music.eu`, linked from the main Wix marketing site.
The admin back-office, the public storefront and **payments** all work today
and have been walked through by hand. Email, PDF tickets and the door scanner
are not built yet.

---

## Access and accounts

Everything below is held under the owner's personal accounts. Nothing is on a
shared festival account, and there is no second person with access to any of it.
That is a deliberate choice for now — spreading access while the app is still
being built adds coordination cost and buys little. Revisit it once the build is
finished; see [Once the app is done](#once-the-app-is-done).

| Service | What | Who holds it | Notes |
|---|---|---|---|
| **GitHub** | `github.com/mateuszrusowicz/ticketsKM` (private) | Mateusz Rusowicz | CI runs here |
| **Vercel** | project serving `tickets-km.vercel.app` | Mateusz Rusowicz | region `fra1` |
| **Neon** | project `krzyzowa-tickets`, `eu-central-1` | Mateusz Rusowicz | branches `production`, `development` |
| **DNS** for `krzyzowa-music.eu` | needed for `bilety.` + email records | **unconfirmed — possibly Wix** | see Risks |
| **Stripe** | test-mode account `acct_1UBpQ6GVCpToPFr7`, country PL | Mateusz Rusowicz | created 4 Sep 2026. Test mode only — no business verification, no bank account. The live account for the Polish entity is a separate, still-open question |
| **Resend** | not yet created | — | needed for Plan 05 |
| **Uptime monitoring** | not yet configured | — | Plan 02 Task 8 |

---

## Credentials

**No credential is stored in this repository.** Every `.env*` file is
git-ignored, and secrets must never enter a commit message, an issue, or a chat
transcript. That last one has been violated once already — see Risks.

| What | Where it lives |
|---|---|
| Production admin passwords | the festival password manager |
| Neon connection strings | Vercel environment variables. Locally, `.env.neon` is the **`production`** branch (verified 7 Sep 2026 — it holds the two real admin accounts and no content). The `development` branch string, which is what the deployed site reads until launch, exists **only** in Vercel; copy it to `.env.neon-dev` if a script needs it |
| `SESSION_SECRET` (prod, preview) | Vercel environment variables — different value per environment |
| Local dev credentials | `.env`, from `.env.example` |

### Production accounts

| Email | Role | Can |
|---|---|---|
| `mateusz.rusowicz@krzyzowa-music.eu` | ADMIN | everything |
| `mde@krzyzowa-music.eu` | SCANNER | door check-in only |

Passwords are stored only as argon2 hashes and cannot be read back. If one is
lost:

```bash
pnpm exec dotenv -e .env.neon -- \
  pnpm exec tsx scripts/reset-admin-password.ts <email>
```

This sets a new password, clears any lockout, and signs out that account's
existing sessions. Add further staff with `pnpm admin:create`.

**`pnpm db:seed` now refuses to run against any non-local database.** Its two
accounts share the published password `DevPassword123!`, so this used to be a
rule you had to remember; since 7 Sep 2026 it is enforced in
`src/lib/shared/seed-guard.ts` and the seed throws before writing anything.
Content-only seeding of a remote database is `SEED_SKIP_ADMINS=1`, or
`pnpm db:seed:remote` (which reads `.env.neon-dev`).

---

## Environments

| | URL | Database — **until launch** | Database — after cutover |
|---|---|---|---|
| Production | <https://tickets-km.vercel.app> | Neon `development` | Neon `production` |
| Preview (per PR) | Vercel-generated | Neon `development` | Neon `development` |
| Local | <http://localhost:3000> | Docker Postgres `km_dev` | unchanged |

**The whole app is built and tested against dummy data on Neon
`development`.** The real database is connected once, at the end, by Plan 02
Task 9 — a change to two Vercel Production variables and a redeploy. Until then
Neon `production` sits dormant, holding the three migrations from Task 2 and the
two real admin accounts from Task 6.

One consequence: pre-launch, Production and Preview share a database, so a
migration on any feature branch reaches the live site too.

**Never seed admin accounts, even on `development`** — the seed password is
published in this repository and the site is on a public URL. Seed content;
create accounts with `pnpm admin:create`. The seed enforces this itself now: it
refuses a non-local target unless `SEED_SKIP_ADMINS=1` says content-only.

**As of 7 Sep 2026 Neon `development` holds no content at all** — 0 venues,
0 concerts, 0 ticket types — which is why the deployed shop shows "no concerts
on sale". The demo walkthrough cannot run until it is seeded:

```bash
# 1. Vercel → Settings → Environment Variables → reveal DATABASE_URL and
#    DIRECT_URL (Production) and paste both into .env.neon-dev — git-ignored,
#    and it must live inside the repo, never /tmp.
# 2. Content only, no admin accounts:
pnpm db:seed:remote
# 3. A real admin account, with a password you choose:
pnpm exec dotenv -e .env.neon-dev -- pnpm exec tsx scripts/create-admin.ts <email> <name> ADMIN
```

`bilety.krzyzowa-music.eu` is **not connected yet** — that is Plan 02, Task 7.

Four environment variables, set separately for Production and Preview:
`DATABASE_URL` (Neon pooled), `DIRECT_URL` (Neon direct), `SESSION_SECRET`,
`NEXT_PUBLIC_SITE_URL`.

`NEXT_PUBLIC_SITE_URL` is baked in at build time. Changing it requires a
redeploy; editing the variable alone does nothing.

---

## Repository

### Branching model

| Branch | Holds | Deploys to |
|---|---|---|
| `main` | production code — what is live | Vercel Production → Neon `production` |
| `development` | finished, accepted features awaiting release | Vercel Preview → Neon `development` |
| `feat/*`, `fix/*` | work in progress | Vercel Preview → Neon `development` |

Work flows `feature → development → main`. Only `main` reaches production data.

> **"development" means three different things.** They are unrelated objects
> that happen to share a name:
>
> | | What it is |
> |---|---|
> | git `development` | branch where finished features integrate |
> | Neon `development` | the database every non-production deploy talks to |
> | Vercel **Development** | local `vercel dev` environment — ignore it |
>
> A feature branch and the git `development` branch share the one Neon
> `development` database, so a migration on either is visible to both.

**Set up 27 Aug 2026.** `main` and `development` were branched from
`feat/plan-01-foundations`, and Vercel's Production environment now tracks
`main`. Preview tracks all other branches. `feat/plan-01-foundations` is
redundant — its commits are `main` — and can be deleted locally and on the
remote.

CI runs `typecheck`, `lint` and `test` on Node 24 for every push.

### Where the branch settings live

Vercel's production branch is **not** under Settings → Git, where it used to be.
It is **Settings → Environments → Production → Branch Tracking**. The Preview
environment on the same screen tracks "All unassigned git branches", which is
what routes `development` and every feature branch to the Neon `development`
database.

GitHub's default branch is Settings → General → Default branch.

**Commits are made by the repository owner**, not by tooling or agents.

---

## Getting productive

[`README.md`](README.md) has the full setup: install, Docker Postgres, migrate,
seed, log in. Roughly five commands and you have the admin working locally with
sample concerts.

Before believing anything passes, verify from a clean tree — a warm tree hides
the Next 16 generated-type failures that only appear in CI:

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Read [`plan/00-decisions.md`](plan/00-decisions.md) before proposing changes.
Most things that look odd were decided deliberately, and the reasoning is
recorded there.

---

## Operating it

### Which branch Vercel deploys

**`development`**, changed 4 Sep 2026. It had been building
`feat/plan-03-public-programme` and failing for days: `vercel-build` runs
`prisma migrate deploy` before `next build`, so a commit predating Plan 04's
migration can never deploy against a database that already has it. Retrying
such a deployment re-runs the same stale commit and fails identically every
time — redeploy from a current branch instead.

`main` is now 10 commits behind and is no longer what Vercel serves. Decide
whether it still has a role.

### Operations — payments

**How to spot payment ALERTs.** All three payment-related cron jobs write
fixed-format strings to stderr, which Vercel captures into runtime logs alongside
stdout. Response bodies never reach logs — the grep must target the stderr string:

```
SWEEP-PRIMARY expired=<e> released=<r> failed=<f>
SWEEP-ASYNC expired=<e> released=<r> failed=<f>
RECONCILE recovered=<r> stuckWebhooks=<w> ticketGaps=<g> alerts=<a>
```

In the Vercel dashboard: **Project → Logs → Runtime** (filter by Function if
needed). Search for `failed=[1-9]`, `alerts=[1-9]`, `stuckWebhooks=[1-9]` or
`ticketGaps=[1-9]`. Any non-zero value warrants investigation. A cron returning
**207** instead of 200 means at least one order failed inside an otherwise
successful sweep.

**Where the crons run.** Three routes, all in `vercel.json`, all Vercel Pro
(5-minute schedule requires Pro — Hobby silently downgrades to daily):

| Route | Schedule | Does |
|---|---|---|
| `/api/cron/release-holds` | Every 5 min | Expires holds where PI is not in-flight; no Stripe call |
| `/api/cron/async-release-holds` | Every 30 min | Expires async-method holds past their timeout (6 h / 5 days SEPA) |
| `/api/cron/reconcile` | Every 10 min | Finds PAID orders missing tickets, stuck refunds, un-reprocessed webhook events |

*(Corrected 7 Sep 2026 against `vercel.json`, `src/app/api/cron/*/route.ts` and
`src/lib/server/reconcile.ts:164`. The earlier table named `sweep-primary` /
`sweep-async` — routes that do not exist — gave the wrong schedules for two of
the three, and printed a `RECONCILE` format with `deadlettered=`, a field the
code never emits, so that grep could never have matched.)*

All cron routes require the `Authorization: Bearer <CRON_SECRET>` header.
Vercel sets this automatically when the cron fires; the value in production must
differ from the local `.env` value.

**This alerting is an explicit stopgap** (acknowledged 4 Sep 2026) until Plan 07
ships an admin dashboard that surfaces ALERT-severity audit log entries. Until
then, the recommendation on a sale day is to keep a Vercel log stream open in
a browser tab. Automated notification (Sentry, Slack) is Plan 08 scope.

### Rolling back a bad deploy

Vercel → Deployments → pick the last good one → **Promote to Production**.
Seconds, no rebuild.

**A rollback does not undo a database migration.** If the bad deploy applied a
destructive migration, promoting the old build leaves the new schema in place.
This is why migrations must be additive — add columns, do not drop them in the
same release that stops using them.

### Backups

Neon provides point-in-time restore within the plan's retention window. **This
has never been tested** — Plan 02, Task 8. The first attempt at a restore should
not happen during an incident.

There is also **no off-platform dump yet**, which means a problem with the Neon
account is currently a total data loss. Taking one requires
`sudo apt install postgresql-client-16` first, because `pg_dump` is not
installed on the development machine.

### Monitoring

**None.** Nothing will tell anyone if the site goes down. The failure mode is
not "the site went down" but "the site went down and nobody noticed for six
hours", on the one evening of the year that matters.

---

## Risks and loose ends

Ordered by what would hurt most.

1. **No monitoring, no tested restore, no off-platform backup.** All three are
   Plan 02 Task 8, all three are the things you need at 20:00 on sale night.
2. **The Neon database password was pasted into a chat transcript.** It should
   be rotated: Neon → Roles → Reset password, then update the Vercel variables,
   which change with it.
3. **DNS control is unconfirmed.** This gates both `bilety.krzyzowa-music.eu`
   and Resend's SPF/DKIM records. Ticket emails landing in spam is a
   project-ending failure, and this item has the longest lead time of anything
   outstanding. Confirm it now, not in Plan 05.
4. **No `main` branch.** See Repository above.
5. **Vercel billing tier must be Pro.** Hobby forbids commercial use; selling
   tickets on it is a terms violation.
6. **GitHub Actions warns that Node 20 actions are deprecated.** Cosmetic — it
   refers to `checkout@v4` / `setup-node@v4`, not our `node-version: 24`.

Access concentration is deliberately **not** on this list while the app is being
built — see [Once the app is done](#once-the-app-is-done).

---

## Decisions the owner still owes

Blocking, with the plan each one holds up. Full detail in
[`plan/09-open-questions.md`](plan/09-open-questions.md).

**Still open:**

| | Question | Blocks |
|---|---|---|
| 1 | **Who controls DNS for `krzyzowa-music.eu`?** Longest lead time of anything outstanding — it gates both the subdomain and Resend's SPF/DKIM records, and ticket email landing in spam is a project-ending failure. | Launch. **Not the demo** (2 Sep 2026) — it connects no domain and sends no email. Still answer it early; nothing shortens a DNS lead time. |
| 2 | Does the Stripe account exist for the Polish entity, and is Klarna actually available to it? | Launch. **Not the demo** — test mode needs no verified entity. Klarna on a *live* PL account stays unverified, and a test account offering it proves nothing. |
| 3 | Refund policy — and note that under art. 38 of the Polish consumer-rights act, dated leisure events are **exempt from the 14-day right of withdrawal**, so whatever is offered is a policy choice, not a legal minimum. | Plan 06 |

**Settled since (27–30 Aug 2026):**

- **One concert per order.** No cart.
- **A name per ticket**, against the plan's own recommendation. Widens the RODO
  retention job, since personal data now sits on every `Ticket`.
- **Holds last 30 minutes, flat across venues** — safe only if released on
  failure and abandonment, not merely on expiry.
- **Stay on `tickets-km.vercel.app`** until the team agrees to go live.

Still needed before launch, non-blocking: maximum tickets per order, whether
there is an announced on-sale moment, and logo files in a vector format.

---

## Operations — payments, what a human must know

**Manual testing is not optional here.** The test suite is 427 tests strong but
runs in Node **with no DOM** (`vitest.config.mts`: `environment: 'node'`,
`include: ['tests/**/*.test.ts']`). Forms, the Stripe Payment Element and the
currency dropdown therefore have **no automated coverage at all**. On 7 Sep 2026
a hand walkthrough found four real defects that all 400+ tests had passed over:

| Found by clicking | What it was |
|---|---|
| Webhooks never fired | Stripe CLI on a sandbox account, app on another |
| `paymentIntentStatus` stuck, `paymentMethodType` always null for cards | the `succeeded` branch never recorded the attempt |
| Checkout form wiped itself on a bad e-mail | the action returned errors but not the submitted values |
| "Pay" button still shown after paying | the redirect beat the webhook; band came from the stale stored mirror |

Run [`plan/DEPLOY-PLAN-05.md`](plan/DEPLOY-PLAN-05.md) Part 3 before every
release that touches checkout. It is the only layer that catches this class.

**Payment methods are driven by currency, not language.** PLN gives card, BLIK
and Przelewy24; EUR gives card, Klarna, SEPA and PayPal. The buyer picks the
currency in a dropdown in the buy box, and the line beneath it names the methods
that follow. Currency is then **frozen at the order page** so the summary and
the charge cannot diverge.

**PayPal is deliberately exempt from the SEPA guardrails** (cap on concurrent
holds, hide near sellout). Those exist because SEPA holds seats for days; PayPal
settles in seconds. Do not "fix" this by making it consistent.

**Klarna is still unverified.** It needs a real phone number to complete, so it
was never exercised. Whether it is available to a *live* Polish account remains
an open question — a test account offering it proves nothing.

**Alerts are a stopgap.** Anything needing a human is `console.error` on
**stderr** — Vercel captures stderr, not response bodies. Grep the runtime logs
for `alerts=[1-9]` and `RECONCILE`. There is no notification of any kind until
Plan 07's admin dashboard, so nobody learns about a stuck refund unless somebody
looks.

---

## What happens next

**The milestone is a Stripe test-mode demo** (decided 2 Sep 2026): a product
that takes dummy payments and creates real orders for Polish and German buyers,
on `tickets-km.vercel.app`. The domain and the link from the Wix site follow
only once that demo is accepted.

1. ~~Merge Plan 03~~ — done. ~~Plan 04 — inventory~~ — **done 3 Sep 2026**, the
   risky core. A 900-seat concert provably cannot be oversold: 1000 concurrent
   buyers, 900 held, 100 rejected, with a recorded negative control showing the
   test reports 1000/1000 when the protection is removed.
2. **Plan 05 — payments, checkout half.** Written, critiqued twice, verified,
   **not started**. Blocked on four owner items (below).
3. **Demo, then decide.** Email, PDF tickets, QR codes and the scanner are the
   other half of Plan 05 and Plan 07 — deliberately after the demo.
4. Plan 02's tasks 7–9 (domain, backups, database cutover) land at launch, as
   does the Wix link-through.

### Blocking Plan 05 — **all local work done; only deployment remains**

**Plan 05's code is complete and the local walkthrough has passed** (7 Sep
2026). What is left is Task 15 — Vercel and the Stripe dashboard — and it is
written out step by step in [`plan/DEPLOY-PLAN-05.md`](plan/DEPLOY-PLAN-05.md).
Use that file, not this table, to actually do it.

| | What | State |
|---|---|---|
| 1 | **Stripe keys** in `.env`, all test-mode | ✅ done. They arrived misnamed and swapped — the secret sat in `STRIPE_API_KEY` and the publishable in `STRIPE_SECRET_KEY`. **Verify the prefix, never the name.** |
| 2 | **Local webhook secret** | ✅ from `stripe listen`. Production needs a **different** `whsec_` from registering the endpoint in the dashboard. |
| 3 | **Vercel Pro** | ✅ done 4 Sep 2026. |
| 4 | **Four env vars on Vercel** — `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET` | ⬜ **the deploy fails without them.** Measured 6 Sep: the build died at page-data collection with `Invalid environment configuration:` naming exactly these four. The six numeric config vars are optional — every one has a schema default equal to the value you would type. |
| 5 | **`NEXT_PUBLIC_SITE_URL` on Vercel** = `https://tickets-km.vercel.app` | ⬜ The payment `return_url` is built from it. If it reads `localhost:3000`, every BLIK / P24 / Klarna / PayPal buyer is redirected to their own machine — and it fails **only in production**, so the local walkthrough will not catch it. Baked in at build time: editing it does nothing without a redeploy. |

**A failed build still applies migrations.** `vercel-build` is
`prisma migrate deploy && prisma generate && next build`, so when the 6 Sep
build failed on env vars, the Plan 05 migration had *already* landed on Neon.
After such a failure the database is ahead of the deployed code — do not try to
re-apply it.

**Local Stripe setup, for whoever rebuilds it.** All Stripe variables live in
`.env` (not `.env.local` — the plan's original wording was wrong and is
corrected). The Stripe CLI is **not in Ubuntu's apt repos**; it installs as a
binary into `~/.local/bin`.

> **The sandbox trap — this cost a full debugging session on 7 Sep 2026.**
> At `stripe login` it is possible to authorise a **sandbox**, which is a
> *separate account* that also issues `sk_test_` keys. Nothing in the key
> prefix reveals the mismatch. The app then creates PaymentIntents on one
> account while `stripe listen` subscribes to events on the other, so **real
> payments produce no webhooks at all** — orders sit at `PENDING` forever while
> Stripe's own dashboard shows success. `stripe trigger` still works, because
> it creates its PaymentIntent on the CLI's account, which makes the setup look
> healthy.
>
> The CLI is currently logged into a sandbox (`acct_1UBpPOGTx5eWuMMc`), while
> the app uses `acct_1UBpQ6GVCpToPFr7`. **Always start the listener pinned to
> the app's account:**
>
> ```bash
> set -a; . ./.env; set +a
> stripe listen --api-key "$STRIPE_SECRET_KEY" \
>   --forward-to localhost:3000/api/webhooks/stripe
> ```
>
> Note that `stripe config --list` reflects the stored *login*, not the account
> a single command used, so it is **not** a valid check when `--api-key` is in
> play. To verify, look at the PaymentIntent id in the event: it embeds the
> account (`pi_…GVCpToPFr7…` is the app's). Alternatively run `stripe login`
> again and pick the non-sandbox account, after which the flag is unnecessary.

**`.env` must contain `CRON_SECRET`.** The env schema requires it with no
default, and `.env` is git-ignored, so no test or gate will catch its absence —
`pnpm dev` simply refuses to boot. Generate with `openssl rand -base64 32`.
Vercel needs a **different** value.

Every plan is written just before it is executed, so it describes the code that
actually exists. **Have each one critiqued by subagents before executing it** —
that pass found three blockers in Plan 01, five in Plan 03, nine in Plan 04, and
nine in Plan 05's first draft. On Plan 05 it went further: a second pass found
the *revision* still not executable, which is what prompted the design
simplification now recorded in `plan/00-decisions.md`.

---

---

## Once the app is done

Not now. These are worth doing when the build is finished and the system is
about to carry real money — raising them mid-build costs time and money for a
risk that only becomes real at launch.

### Spread access beyond one person

Today one person can log into GitHub, Vercel and Neon, and nobody else can. That
is fine while the app is being written; it stops being fine the evening tickets
go on sale. If the only key-holder is on a train, ill, or asleep when something
breaks, nobody else can roll back a deploy, restore the database, or reset a
locked admin account — everyone else can only watch it stay broken.

Three ways to fix it, cheapest first:

1. **A break-glass envelope.** Put the Vercel and Neon logins in the festival's
   password manager, in a vault at least one trusted non-technical person can
   open, next to a one-page sheet: how to roll back, who to call, what "the site
   is down" looks like. Costs nothing. Weaker than a real second account,
   because it means sharing personal logins — but far better than nothing.
2. **A second member on Neon.** Neon holds the data that cannot be recreated, so
   if only one service gets a second pair of hands, make it this one. Project
   Settings → Members → Invite; they accept by email and get their own login.
3. **A second member on Vercel.** Same idea, but Vercel bills per seat — roughly
   $20/month — and needs a Team rather than a personal account, so the project
   would move to one. Optional if someone else can already reach Neon and
   somebody knows how to contact the owner.

The person does not have to be a developer. Someone who can follow written
instructions and click **Promote to Production** covers the rollback case, which
is the most likely emergency.

The open question is whether such a person exists around the festival. If not,
option 1 is the whole answer and the other two are moot.

### Also worth revisiting then

- Confirm who controls DNS for `krzyzowa-music.eu`, and record it here.
- Decide whether the festival should own the Vercel, Neon and Stripe accounts
  rather than an individual — this is easier to do before Stripe is connected to
  a bank account than after.
