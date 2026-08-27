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

Last updated: **27 August 2026.**

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

**This is the section that matters most.** Everything below is held under the
owner's personal accounts. Nothing is on a shared festival account, and there is
no second person with access to any of it.

| Service | What | Who holds it | Notes |
|---|---|---|---|
| **GitHub** | `github.com/mateuszrusowicz/ticketsKM` (private) | Mateusz Rusowicz | CI runs here |
| **Vercel** | project serving `tickets-km.vercel.app` | Mateusz Rusowicz | region `fra1` |
| **Neon** | project `krzyzowa-tickets`, `eu-central-1` | Mateusz Rusowicz | branches `production`, `development` |
| **DNS** for `krzyzowa-music.eu` | needed for `bilety.` + email records | **unconfirmed — possibly Wix** | see Risks |
| **Stripe** | not yet created | — | needed for Plan 05 |
| **Resend** | not yet created | — | needed for Plan 05 |
| **Uptime monitoring** | not yet configured | — | Plan 02 Task 8 |

### What to do about it

Two people should be able to reach production before tickets go on sale. Right
now the project has a bus factor of one, and the failure mode is not abstract:
if the owner is unreachable on the evening of the sale, nobody can roll back a
bad deploy, restore a database, or reset a locked admin account.

At minimum, add a second member to the Vercel and Neon projects, and confirm who
can change DNS.

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

| | URL | Database |
|---|---|---|
| Production | <https://tickets-km.vercel.app> | Neon branch `production` |
| Preview (per PR) | Vercel-generated | Neon branch `development` |
| Local | <http://localhost:3000> | Docker Postgres `km_dev` |

`bilety.krzyzowa-music.eu` is **not connected yet** — that is Plan 02, Task 7.

Four environment variables, set separately for Production and Preview:
`DATABASE_URL` (Neon pooled), `DIRECT_URL` (Neon direct), `SESSION_SECRET`,
`NEXT_PUBLIC_SITE_URL`.

`NEXT_PUBLIC_SITE_URL` is baked in at build time. Changing it requires a
redeploy; editing the variable alone does nothing.

---

## Repository

**There is no `main` branch.** All 23 commits are on
`feat/plan-01-foundations`, which has never been merged and has no target to
merge into. Someone needs to decide whether that branch becomes `main` or
whether `main` is created from it. Until then, "deploy to production" and "push
to the feature branch" are the same action, which is not a safe long-term
arrangement.

CI runs `typecheck`, `lint` and `test` on Node 24 for every push.

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

1. **Bus factor of one.** One person holds every account. Fix before the sale.
2. **No monitoring, no tested restore, no off-platform backup.** All three are
   Plan 02 Task 8, all three are the things you need at 20:00 on sale night.
3. **The Neon database password was pasted into a chat transcript.** It should
   be rotated: Neon → Roles → Reset password, then update the Vercel variables,
   which change with it.
4. **DNS control is unconfirmed.** This gates both `bilety.krzyzowa-music.eu`
   and Resend's SPF/DKIM records. Ticket emails landing in spam is a
   project-ending failure, and this item has the longest lead time of anything
   outstanding. Confirm it now, not in Plan 05.
5. **No `main` branch.** See Repository above.
6. **Vercel billing tier must be Pro.** Hobby forbids commercial use; selling
   tickets on it is a terms violation.
7. **GitHub Actions warns that Node 20 actions are deprecated.** Cosmetic — it
   refers to `checkout@v4` / `setup-node@v4`, not our `node-version: 24`.

---

## Decisions the owner still owes

Blocking, with the plan each one holds up. Full detail in
[`plan/09-open-questions.md`](plan/09-open-questions.md).

| | Question | Blocks |
|---|---|---|
| 1 | Can a buyer put several concerts in one order, or one concert per payment? | Plan 03 |
| 2 | Who controls DNS for `krzyzowa-music.eu`? | Plans 02, 05 |
| 3 | Does the Stripe account exist, and is Klarna available to it? | Plan 05 |
| 4 | Do tickets carry attendee names, or are they anonymous? | Plan 03 |

Question 4 has a recommendation on file: anonymous. The QR is the control, and
making a buyer name four attendees costs sales.

Non-blocking but needed before launch: refund policy, maximum tickets per order,
hold duration, whether there is an announced on-sale moment, and logo files in a
vector format.

---

## What happens next

1. Finish Plan 02 — tasks 7 (domain) and 8 (backups, monitoring, rollback).
2. Answer the four blocking questions above.
3. Write Plan 03 (public programme) and have it critiqued before executing. That
   critique pass caught three blockers in Plan 01, including one that would have
   failed the build at the last task.

Plans 03–08 are written just before each is executed, so they describe the code
that actually exists rather than the code imagined eight weeks earlier.
