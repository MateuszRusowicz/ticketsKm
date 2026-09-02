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

Last updated: **30 August 2026.**

---

## The project in one paragraph

Ticket sales for the Krzyżowa Music festival — roughly ten general-admission
concerts each August, sold in three languages (PL / EN / DE) and two currencies
(PLN / EUR), taking payment through Stripe with local methods (BLIK, Przelewy24,
cards). It replaces the Wix ticketing the festival used previously, and will
live at `bilety.krzyzowa-music.eu`, linked from the main Wix marketing site.
The admin back-office is real and working today; the public storefront, payments,
email, PDF tickets and the door scanner are not built yet.

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
| **Stripe** | not yet created | — | needed for Plan 05 |
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
| Neon connection strings | Vercel environment variables, and `.env.neon` locally |
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

**Never run `pnpm db:seed` against production** — the seed creates accounts with
the published password `DevPassword123!`.

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
create accounts with `pnpm admin:create`.

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

## What happens next

**The milestone is a test-mode demo (decided 2 Sep 2026).** A product that
takes dummy payments and creates real orders for Polish and German buyers, in
Stripe test mode, on `tickets-km.vercel.app`. The domain and the link from the
existing Wix site follow only once that demo is accepted.

1. **Merge `feat/plan-03-public-programme` into `development`.** Plan 03 is
   complete and accepted; the branch is the only thing holding it.
2. **Plan 04 — inventory.** The risky core: transactional capacity holds, the
   `heldCount` lifecycle, order creation, and concurrency tests proving a
   900-seat venue cannot oversell. Unblocked as of 30 Aug.
3. **Plan 05 — payments, the checkout half only.** Stripe Payment Element in
   test mode with BLIK, Przelewy24, Klarna, SEPA and cards, plus the webhook
   that confirms an order. **Unblocked as of 2 Sep** by using a fresh test-mode
   account with country PL; keys are environment variables, so the real account
   swaps in at launch with no code change.
4. **Demo, then decide.** Email, PDF tickets, QR codes and the scanner are the
   other half of Plan 05 and Plan 07 — deliberately after the demo.
5. Plan 02's tasks 7–9 (domain, backups, database cutover) all land at launch,
   as does the Wix link-through.

Every plan is written just before it is executed, so it describes the code that
actually exists rather than the code imagined eight weeks earlier. **Have each
one critiqued by subagents before executing it** — that pass found three
blockers in Plan 01 and five in Plan 03, all visible in the repository and none
visible in the design documents.

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
