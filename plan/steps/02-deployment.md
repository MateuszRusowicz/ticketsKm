# Plan 02 — Deployment

> **For agentic workers:** most of this plan cannot be executed by an agent. It
> requires signing into Neon, Vercel and a DNS provider under the owner's
> accounts. An agent can prepare the repository changes (Tasks 3 and 8) and run
> every verification command, but the account steps are the human's.

**Goal:** the application from Plan 01 running at `bilety.krzyzowa-music.eu`, backed by a Neon Postgres database in Frankfurt, with a real administrator account and a verified backup.

**Architecture:** Vercel (region `fra1`) serves the Next.js app. Neon (`eu-central-1`) holds the database. The application talks to Neon's **pooled** endpoint through the `PrismaPg` driver adapter; the Prisma CLI runs migrations against the **direct** endpoint, because a connection pooler cannot execute them. Every push to `main` deploys to production; every branch gets a preview.

**Spec:** [`../01-architecture.md`](../01-architecture.md), [`../07-security-and-testing.md`](../07-security-and-testing.md), and the versions table in [`../00-decisions.md`](../00-decisions.md).

**Supersedes:** Task 16 of [`01-foundations.md`](01-foundations.md), which was written before Prisma 7 removed `directUrl` and is too thin for the account work involved.

---

## Findings log

Appended as things are discovered, not at the end. Anything that outlives this
plan also goes in the traps list in `/CLAUDE.md`, which loads automatically
every session.

| Date | Finding | Action |
|---|---|---|
| 25 Aug | `psql` appears installed (`pg_wrapper` shim on `PATH`) but no client package is present; every invocation fails. | Task 6 Step 4 rewritten to query through Prisma. `pg_dump` in Task 8 has no substitute. |
| 25 Aug | Admin passwords written to an agent scratchpad were destroyed when the directory was cleared, before reaching the password manager. | Task 6 Step 1 now says a git-ignored file **inside the repo**, never `/tmp`. Added Task 6a (password reset), which did not exist. |
| 25 Aug | `create-admin.ts` only inserts — a lost password was unrecoverable. | Task 6a added: `scripts/reset-admin-password.ts`, 8 tests. |
| 27 Aug | Plan numbers had drifted: design docs and executable plans number differently, and the scanner was cited as "Plan 06" in two files. | Corrected; the deferred list now states which scheme it uses. |
| 27 Aug | CSP, shared rate limiting and the RODO job were deferred to "Plan 07" — the Scanner — so nobody would have picked them up. | Reassigned to Plan 08 and added to its row in `../README.md`. |
| 27 Aug | Vercel moved the production branch setting out of Settings → Git. | It is Settings → Environments → Production → Branch Tracking. Recorded in `HANDOFF.md`. |
| 27 Aug | Definition of done said "all 12 tables"; there are 12 application tables plus `_prisma_migrations`. | Corrected. |

---

## Global Constraints

- **Never run `pnpm db:seed` against production.** The seed creates two accounts with the password `DevPassword123!`. Production admins come from `pnpm admin:create` only.
- **`SESSION_SECRET` in production must be a fresh value**, not the one in your local `.env`.
- **Migrations run against `DIRECT_URL`; the app runs against `DATABASE_URL`.** Prisma 7 removed `directUrl` from the schema, so this split lives in `prisma.config.ts` and `src/lib/server/db.ts` respectively.
- **All infrastructure in the EU.** Vercel `fra1`, Neon `eu-central-1`. Required by [`07-security-and-testing.md`](../07-security-and-testing.md) and by the festival being a Polish entity handling buyer data.
- **Vercel's Hobby tier forbids commercial use.** Selling tickets requires Pro (~$20/month). You can deploy on Hobby to test, but not to sell.
- **Commits are made by the human operator.**
- **Until launch, every environment runs on the Neon `development` branch.**
  Decided 27 Aug 2026: the whole app is built and tested against dummy data, and
  the real database is connected once at the end (Task 9). Neon `production`
  keeps the three applied migrations and the two real admin accounts from Task
  6, dormant, until then.
- **Do not seed admin accounts, even on `development`.** The seed's
  `DevPassword123!` is published in this repository, and `tickets-km.vercel.app`
  is a public URL. Seed content; create accounts with `pnpm admin:create`.
- **`psql` and `pg_dump` are not usable on this machine.** The Debian
  `pg_wrapper` shim is on `PATH`, so `command -v psql` succeeds, but no
  `postgresql-client-<version>` package is installed and every invocation fails
  with "You must install at least one postgresql-client package". Every `psql`
  step in this plan therefore needs the Prisma equivalent from Task 6 Step 4.
  **Task 8 Step 3 has no equivalent** — `pg_dump` is genuinely required for the
  off-platform backup, so install it first:
  `sudo apt install postgresql-client-16`.

---

## Prerequisites

| | Needed for |
|---|---|
| Neon account | the database |
| Vercel account, connected to GitHub | hosting |
| DNS access for `krzyzowa-music.eu` | the `bilety.` subdomain |
| Plan 01 complete, pushed, CI green | there is something to deploy |

**Check DNS access now, before anything else.** If the domain is managed inside Wix, confirm you can add a CNAME record. This is the single item with real lead time, and it also blocks Resend's SPF/DKIM records in Plan 05 — see [`../09-open-questions.md`](../09-open-questions.md).

---

## Task 1: Create the Neon database

**Human steps.** No repository changes.

- [ ] **Step 1: Create the project**

At [console.neon.tech](https://console.neon.tech), create a project:

- Name: `krzyzowa-tickets`
- Postgres version: 16 (matches local Docker and CI)
- Region: **Europe (Frankfurt) — `eu-central-1`**

- [ ] **Step 2: Verify the region before going further**

The project's region is fixed at creation and cannot be changed afterwards —
moving it means creating a new project and migrating. Confirm the dashboard
reads `eu-central-1` now.

- [ ] **Step 3: Create a development branch**

Neon's default branch is usually `main` or `production`. Add a second branch
named `development`. Preview deployments will use it, so a broken migration on
a feature branch cannot damage production data.

- [ ] **Step 4: Collect four connection strings**

For **each** branch, copy both forms from the dashboard's connection widget:

| Form | Recognisable by | Used by |
|---|---|---|
| Pooled | host contains `-pooler` | the application (`DATABASE_URL`) |
| Direct | no `-pooler` | migrations (`DIRECT_URL`) |

**Check each string actually differs.** Neon's dashboard has a pooled/direct
toggle that is easy to miss, and copying the same string twice produces a
"direct" URL that still points at the pooler — which then fails at
`migrate deploy` with a confusing error. The only difference is the `-pooler`
suffix on the host:

```
pooled:  ep-summer-hall-b1vdfmpi-pooler.c-5.eu-central-1.aws.neon.tech
direct:  ep-summer-hall-b1vdfmpi.c-5.eu-central-1.aws.neon.tech
```

**Change `sslmode=require` to `sslmode=verify-full`** in all four. Neon accepts
it, and `node-postgres` warns that `require` will adopt weaker libpq semantics
in a future major — under which it would encrypt without verifying the server
certificate. `verify-full` is strictly stronger and costs nothing:

```
?sslmode=verify-full&channel_binding=require
```

Keep all four somewhere safe for Task 4. They contain the database password.

**Treat them as secrets from the moment you copy them.** Do not paste them into
chat, tickets or commit messages. If they end up somewhere they should not,
reset the role password in Neon (Roles → Reset password) and update the Vercel
environment variables — the connection strings change with it.

- [ ] **Step 5: Confirm you can actually reach it**

```bash
psql '<production DIRECT connection string>' -c 'SELECT version();'
```

Expected: a PostgreSQL 16 version string. If `psql` is not installed, skip —
Task 2 verifies the same thing through Prisma.

---

## Task 2: Verify against Neon locally, before involving Vercel

Migrating from a laptop against the real database first means a failure here is
a one-line fix rather than a red deployment with three variables to blame.

- [ ] **Step 1: Point a scratch env file at the Neon production branch**

```bash
cd /home/mateusz/Documents/Kodowanie/KM
cat > .env.neon <<'EOF'
DATABASE_URL=<production POOLED string>
DIRECT_URL=<production DIRECT string>
SESSION_SECRET=<any 32+ chars — not used by migrations>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
EOF
```

- [ ] **Step 2: Confirm it is git-ignored**

```bash
git check-ignore -v .env.neon
```

Expected: a line naming `.gitignore` (the blanket `.env*` rule covers it). If
it prints nothing, **stop** — this file holds your production database
password.

- [ ] **Step 3: Apply the migrations**

```bash
pnpm exec dotenv -e .env.neon -- prisma migrate deploy
```

Expected: all migrations from `prisma/migrations/` applied. This is the first
real test of the Prisma 7 split — the CLI must pick up `DIRECT_URL` from
`prisma.config.ts`. If it hangs or reports a pooler error, `DIRECT_URL` is
wrong or points at the `-pooler` host.

- [ ] **Step 4: Verify the schema landed**

```bash
psql '<production DIRECT string>' -c '\dt'
```

Expected: `Venue`, `Event`, `EventTranslation`, `TicketType`, `Order`,
`OrderItem`, `Ticket`, `PromoCode`, `AdminUser`, `AdminSession`,
`StripeWebhookEvent`, `AuditLog`, `_prisma_migrations`.

- [ ] **Step 5: Verify the application path — pooled, through the adapter**

Migrations use the direct endpoint; the app uses the pooled one. They are
different code paths and only one has been exercised so far. Confirm the
adapter works against the pooler, including an **interactive transaction** —
`updateEvent` uses one, and transaction-mode poolers are where those
historically break:

```bash
cat > /tmp/km-neon-check.mts <<'EOF'
import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './src/generated/prisma/client.js'

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

const venues = await db.venue.count()
console.log('pooled read OK, venues =', venues)

await db.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT 1`
})
console.log('interactive transaction over the pooler OK')

await db.$disconnect()
EOF
cp /tmp/km-neon-check.mts ./km-neon-check.mts
pnpm exec dotenv -e .env.neon -- tsx km-neon-check.mts
rm km-neon-check.mts
```

Expected: both lines print. A failure here means the app cannot use the pooled
endpoint, and you would use the direct string for `DATABASE_URL` too —
accepting fewer available connections — rather than discovering it under load
on sale day.

- [ ] **Step 6: Confirm production is still empty of accounts**

```bash
psql '<production DIRECT string>' -c 'SELECT count(*) FROM "AdminUser";'
```

Expected: `0`. If it is not, the seed was run against production — delete
those rows before continuing. They have a published password.

---

## Task 3: Prepare the repository for Vercel

The only task in this plan an agent can do unaided.

**Files:**
- Create: `vercel.json`
- Modify: `package.json`

- [ ] **Step 1: Add the production build command**

In `package.json` scripts:

```json
"vercel-build": "prisma migrate deploy && prisma generate && next build"
```

Three commands, three different reasons:

- `prisma migrate deploy` — applies pending migrations, reading `DIRECT_URL` via `prisma.config.ts`.
- `prisma generate` — the client is git-ignored build output. `postinstall` already runs this, but repeating it costs a second and removes a dependency on install-hook ordering.
- `next build` — which also typechecks, so `next typegen` is not needed separately here.

- [ ] **Step 2: Pin the function region**

`vercel.json`:

```json
{
  "regions": ["fra1"]
}
```

Frankfurt: nearest to both the audience and the Neon database. A function in
Washington talking to a database in Frankfurt adds ~100ms to every query.

- [ ] **Step 3: Verify the build command works locally**

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm exec dotenv -e .env.neon -- pnpm vercel-build
```

Expected: migrations report "No pending migrations", the client generates, and
the build completes. This is exactly what Vercel will run.

- [ ] **Step 4: Commit** *(human operator)*

```bash
git add vercel.json package.json
git commit -m "chore: add Vercel build configuration"
git push
```

---

## Task 4: Create the Vercel project

**Human steps.**

- [ ] **Step 1: Import the repository**

At [vercel.com/new](https://vercel.com/new), import `MateuszRusowicz/ticketsKM`.

- Framework preset: **Next.js** (should be detected)
- Root directory: `./`
- Build command: **override** to `pnpm vercel-build`
- Install command: leave default (`pnpm install`)

**Do not deploy yet** — the environment variables are not set, so the build
would fail on `prisma migrate deploy`. If Vercel deploys automatically on
import, expect that first build to fail and continue.

- [ ] **Step 2: Set the production environment variables**

In Settings → Environment Variables, scoped to **Production**:

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon **production POOLED** string |
| `DIRECT_URL` | Neon **production DIRECT** string |
| `SESSION_SECRET` | output of `openssl rand -base64 32` — **a new value** |
| `NEXT_PUBLIC_SITE_URL` | `https://bilety.krzyzowa-music.eu` |

Generate the secret with:

```bash
openssl rand -base64 32
```

`NEXT_PUBLIC_SITE_URL` is the one variable that reaches the browser. That is
correct — it is a public URL — but it is also why nothing sensitive may ever be
given a `NEXT_PUBLIC_` name.

- [ ] **Step 3: Set the preview environment variables**

Same four names, scoped to **Preview**, but pointing at the Neon
**`development`** branch and using a different `SESSION_SECRET`. Set
`NEXT_PUBLIC_SITE_URL` to `https://ticketskm.vercel.app` or leave it as the
production value — previews only use it for absolute links.

Preview deployments must never touch production data: they run
`prisma migrate deploy`, and an in-progress migration on a feature branch would
otherwise be applied to the live database.

- [ ] **Step 4: Pin the region**

Settings → Functions → Region: **Frankfurt, `fra1`**. `vercel.json` already
declares this; setting it in the dashboard makes it visible to anyone looking.

- [ ] **Step 5: Confirm the billing plan**

If this project will sell tickets, it must be on **Pro**. Hobby prohibits
commercial use. Deploying on Hobby to test is fine; selling on it is a terms
violation.

---

## Task 5: First deploy

- [ ] **Step 1: Trigger a deployment**

Push to `main`, or use Deployments → Redeploy in the dashboard.

- [ ] **Step 2: Read the build log for three specific lines**

Not just "did it go green" — confirm each stage did what it should:

1. `Running "pnpm install"` followed by the `postinstall` hook generating the Prisma client.
2. `prisma migrate deploy` reporting either applied migrations or "No pending migrations to apply".
3. `✓ Compiled successfully` from `next build`.

If the build fails at `migrate deploy` with a connection error, `DIRECT_URL` is
missing or points at the `-pooler` host.

- [ ] **Step 3: Verify the public side**

```bash
DOMAIN=<your-project>.vercel.app
curl -s -o /dev/null -w "/      -> %{http_code} %{redirect_url}\n" "https://$DOMAIN/"
for l in pl en de; do
  printf '%s: ' "$l"; curl -s "https://$DOMAIN/$l" | grep -o '<html lang="[a-z]*"' | head -1
done
```

Expected: `/` redirects to `/pl`; each locale reports its own `lang`.

- [ ] **Step 4: Verify the admin side is locked**

```bash
curl -s -o /dev/null -w "/admin -> %{http_code} %{redirect_url}\n" "https://$DOMAIN/admin"
```

Expected: `307` to `/admin/login`. A `200` means the guards are not running —
stop and investigate before creating any account.

- [ ] **Step 5: Verify no secret reached the browser**

```bash
curl -s "https://$DOMAIN/pl" | grep -Eo 'postgresql://|SESSION_SECRET|neon\.tech' || echo "clean"
```

Expected: `clean`.

---

## Task 6: Create the production administrator

- [ ] **Step 1: Create the account against the direct endpoint**

```bash
cd /home/mateusz/Documents/Kodowanie/KM
pnpm exec dotenv -e .env.neon -- \
  pnpm exec tsx scripts/create-admin.ts mateusz.rusowicz@krzyzowa-music.eu "Mateusz Rusowicz" ADMIN
```

`.env.neon` (written in Task 2) already holds both strings, and
`create-admin.ts` reads `DIRECT_URL ?? DATABASE_URL` — so it goes through the
direct endpoint on its own. This is a one-off CLI run, not the application, so
there is no reason to go through the pooler.

**The script prints the generated password to stdout.** If an agent runs it,
that password lands in the session transcript — the same mistake that put the
Neon connection strings into a chat log. Either run it yourself, or redirect
stdout to a git-ignored file **inside the repository**:

```bash
… >> .env.admin-credentials.txt   # covered by the blanket .env* rule
```

**Do not redirect it to an agent scratchpad or anywhere under `/tmp`.** That
was tried on 25 Aug 2026 and the directory was cleared before the passwords
were moved to the password manager, losing both. Recovering from that needs
Task 6a below.

Run it once per person to add further administrators later; the script only
inserts a row, so there is nothing special about the first account.

- [ ] **Step 2: Record the password immediately**

It is printed once and stored only as an argon2 hash. Put it in the festival's
password manager now, and delete `.env.admin-credentials.txt` once you have.

If it is lost anyway, `pnpm admin:reset-password <email>` sets a new one
(Task 6a). That is a recovery path, not a reason to be casual — the reset has
to be run from a machine with the production connection strings.

- [ ] **Step 3: Create the scanner account**

```bash
pnpm exec dotenv -e .env.neon -- \
  pnpm exec tsx scripts/create-admin.ts mde@krzyzowa-music.eu "Obsługa wejścia" SCANNER
```

- [ ] **Step 4: Verify both, and that no seeded account exists**

`psql` is **not usable on this machine** — the Debian `pg_wrapper` is installed
but no `postgresql-client-<version>` package is, so every `psql` line in this
plan fails with "You must install at least one postgresql-client package".
Verify through Prisma instead, the way Task 2 Step 5 does:

```bash
cat > km-admin-check.mts <<'EOF'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './src/generated/prisma/client.js'

const db = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  }),
})

const admins = await db.adminUser.findMany({
  select: { email: true, role: true, failedLoginCount: true, createdAt: true },
  orderBy: { email: 'asc' },
})

console.log(`AdminUser rows: ${admins.length}`)
for (const a of admins) {
  console.log(`  ${a.email}\t${a.role}\tfailed=${a.failedLoginCount}`)
}

await db.$disconnect()
EOF
pnpm exec dotenv -e .env.neon -- tsx km-admin-check.mts
rm km-admin-check.mts
```

Expected: exactly the two accounts you just made, and `AdminUser rows: 2`. If
any account you did not create is listed, the seed reached production — delete
the extras.

Run this **before** Step 1 as well: it should report `0` on a fresh database,
which is Task 2 Step 6's invariant.

- [ ] **Step 5: Log in**

Open `https://<domain>/admin/login` and sign in as the ADMIN account.

Expected: the dashboard renders. Then in DevTools → Application → Cookies,
confirm `km_session` shows **`HttpOnly`**, **`Secure`**, `SameSite=Lax`,
`Path=/admin`.

The flags can also be read straight off the login response, which is scriptable
and does not depend on reading a DevTools panel correctly:

```bash
curl -si "https://$DOMAIN/admin/login" -X POST \
  --data-urlencode "email=$EMAIL" --data-urlencode "password=$PASSWORD" \
  | grep -i '^set-cookie:.*km_session'
```

Expected: one line containing `HttpOnly`, `Secure`, `SameSite=Lax` and
`Path=/admin`. Keep the password in a variable read from a file rather than
typing it inline, so it does not enter shell history.

`Secure` is the one to check carefully: if it is absent, `NODE_ENV` is not
`production` in the deployment and the session cookie can travel over plain
HTTP.

- [ ] **Step 6: Verify the scanner restriction in production**

Log out, log in as the SCANNER account, and open `/admin/events`.

Expected: redirected to `/admin/scan` (which 404s until Plan 07 — correct).

---

## Task 6a: Password recovery

Added after Task 6, when both production passwords were lost to a cleared
temporary directory and the project turned out to have no way to set a new one
— `create-admin.ts` only inserts. An admin account whose password is gone was
unrecoverable, which is a poor position to be in on sale day.

**Files:**
- Create: `scripts/reset-admin-password.ts`, `tests/scripts/reset-admin-password.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Reset a password**

```bash
pnpm admin:reset-password <email>
```

Against production, supply the connection strings the same way Task 6 does:

```bash
pnpm exec dotenv -e .env.neon -- \
  pnpm exec tsx scripts/reset-admin-password.ts <email>
```

Expected: `Reset <ROLE> <email>` and a new `Password:` line. The same stdout
warning as Task 6 applies — redirect it to `.env.admin-credentials.txt` rather
than letting it reach a transcript.

The script does four things, and three of them are the reason it exists rather
than being a one-line `prisma update`:

- Sets a fresh argon2 hash using the shared `ARGON2_OPTIONS`, so a password set
  here is indistinguishable from one set through the app.
- Clears `failedLoginCount` **and** `lockedUntil`. Clearing the counter alone
  leaves the lockout in place, so the account stays locked with a password the
  operator has just been told is valid.
- Deletes that account's `AdminSession` rows. A reset is what you do when a
  credential may be compromised; leaving live sessions alone would let whoever
  holds a stolen cookie keep the access the reset was meant to remove.
- Warns if the account is `active: false`, where the new password cannot log in
  regardless.

Both writes are in one transaction, so a failure cannot leave the password
changed with the lockout still standing.

- [ ] **Step 2: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/scripts/reset-admin-password.test.ts
```

Expected: 8 passing. The suite covers the new password authenticating, the old
one no longer working, a different password each run, the lockout clearing,
sessions being revoked, case-insensitive address matching, and clean failures
for an unknown address and a missing argument.

- [ ] **Step 3: Commit** *(human operator)*

```bash
git add scripts/reset-admin-password.ts tests/scripts/reset-admin-password.test.ts package.json
git commit -m "feat: add admin password reset script"
```

---

## Task 7: Connect the subdomain

> **Deferred — do this at launch, not now.** Decided 27 Aug 2026: the app stays
> on `tickets-km.vercel.app` for the whole build. The festival subdomain is
> connected only once the app has been tested and the team agrees to go live.
> That puts this task alongside Task 9 (database cutover) at the end, not next.
>
> **One thing still has lead time.** Confirm *who controls DNS* now, even though
> you will not change it for months — Resend's SPF/DKIM records in Plan 05 need
> the same access, and finding out that nobody can add records is the kind of
> discovery that should not happen in the final week. `dig NS krzyzowa-music.eu`
> names the DNS host in one command.


- [ ] **Step 1: Add the domain in Vercel**

Settings → Domains → Add `bilety.krzyzowa-music.eu`. Vercel will show the DNS
record it expects — normally a `CNAME` to `cname.vercel-dns.com`.

- [ ] **Step 2: Add the DNS record**

At whoever hosts DNS for `krzyzowa-music.eu` — **check whether this is Wix**:

```
Type:  CNAME
Name:  bilety
Value: cname.vercel-dns.com
TTL:   3600 (or automatic)
```

The apex domain is untouched. The Wix marketing site keeps serving
`krzyzowa-music.eu`; only `bilety.` points here.

- [ ] **Step 3: Wait for propagation and verify**

```bash
dig +short bilety.krzyzowa-music.eu
curl -s -o /dev/null -w "%{http_code}  cert: %{ssl_verify_result}\n" https://bilety.krzyzowa-music.eu/pl
```

Expected: the CNAME resolves, HTTP `200`, and `ssl_verify_result: 0` (valid
certificate). Vercel issues the certificate automatically once DNS resolves;
this can take a few minutes.

- [ ] **Step 4: Update `NEXT_PUBLIC_SITE_URL`**

Set it to `https://bilety.krzyzowa-music.eu` in Production and redeploy. It is
baked into the build, so changing it requires a new deployment — an env var
edit alone does nothing.

- [ ] **Step 5: Re-verify on the real domain**

Repeat Task 5 steps 3–5 against `bilety.krzyzowa-music.eu`.

---

## Task 8: Backups, monitoring and rollback

The part that gets skipped, and the part you need at 20:00 on the evening
tickets go on sale.

Worth doing **now** as a rehearsal, even though production holds no real data
yet — the point of a restore drill is that the first attempt is not during an
incident. The dump in Step 3 only becomes meaningful at cutover (Task 9), so
repeat it then.

- [ ] **Step 1: Confirm Neon's retention window**

Neon dashboard → Branches → Restore. Note the history window your plan
provides. The free tier is short — if it is under 7 days, the scheduled dump
below is not optional.

- [ ] **Step 2: Verify point-in-time recovery by actually doing it**

Reading the documentation is not verification. Create a restore branch from a
timestamp a few minutes ago, connect to it, and confirm your admin accounts are
present:

```bash
psql '<restore branch DIRECT string>' -c 'SELECT email FROM "AdminUser";'
```

Expected: the accounts from Task 6. Delete the restore branch afterwards.

The first time anyone tries a restore should not be during an incident.

- [ ] **Step 3: Take an off-platform dump**

Neon holding your only backup means a Neon account problem is a total loss:

```bash
pg_dump '<production DIRECT string>' -Fc -f "km-$(date +%Y%m%d).dump"
```

Store it somewhere unrelated to Neon and Vercel. Repeat before each sale opens,
and after the festival. Automate it later if you like; doing it manually
matters more than doing it elegantly.

- [ ] **Step 4: Add uptime monitoring**

Point a free monitor (UptimeRobot, BetterStack) at
`https://bilety.krzyzowa-music.eu/pl`, checking every 5 minutes, alerting to a
phone someone actually carries.

The failure mode is not "the site went down" — it is "the site went down and
nobody noticed for six hours", on the one evening of the year that matters.

- [ ] **Step 5: Know how to roll back**

Vercel → Deployments → pick the last good one → **Promote to Production**.
Takes seconds and needs no rebuild.

**A rollback does not undo a database migration.** If a deployment applied a
destructive migration, promoting the old build leaves the new schema in place.
This is why migrations should be additive — add columns, do not drop them in
the same release that stops using them.

Write the rollback steps into the staff runbook, not just this document.

---

## Task 9: Cut over to the production database

**Do this last**, when the app is finished and tested against dummy data. Until
then every environment runs on Neon `development` — see Global Constraints.

The cutover is deliberately one small, reversible change: the Vercel Production
connection strings. Nothing in the code knows which database it is talking to.

- [ ] **Step 0: Connect the domain**

Task 7 is deferred to this point. Do it now, before switching the database, so
that the certificate has propagated by the time real data is behind it.

- [ ] **Step 1: Apply any new migrations to production**

Neon `production` has only the migrations that existed at Task 2. Everything
added while building ran against `development` only.

```bash
pnpm exec dotenv -e .env.neon -- prisma migrate deploy
```

Expected: the migrations added since Task 2 apply cleanly. `.env.neon` points at
production — confirm that before running it.

- [ ] **Step 2: Confirm production holds no dummy data**

```bash
pnpm exec dotenv -e .env.neon -- tsx km-admin-check.mts   # script in Task 6 Step 4
```

Expected: the two real accounts from Task 6 and nothing else. Then check the
content tables are empty — no seeded venues or concerts should ever have reached
production.

- [ ] **Step 3: Switch the Vercel Production variables**

Settings → Environment Variables, **Production scope only**:

| Name | From | To |
|---|---|---|
| `DATABASE_URL` | Neon `development` pooled | Neon **`production` pooled** |
| `DIRECT_URL` | Neon `development` direct | Neon **`production` direct** |

Leave Preview alone — previews stay on `development` permanently. That is the
arrangement Task 4 Step 3 describes, and from here on it is load-bearing rather
than a formality.

- [ ] **Step 4: Redeploy and verify against the real database**

An environment variable change alone does nothing until a new deployment.

Repeat Task 5 Steps 3–5 and Task 6 Steps 5–6 against the live domain. The admin
login is the important one: it proves the real accounts, on the real database,
work through the deployed app.

- [ ] **Step 5: Verify the backup path now, not later**

Task 8's restore drill is only meaningful against the database that holds real
data. Run it now if it was deferred, and take the first off-platform dump.

- [ ] **Step 6: Re-check that no dummy data is reachable**

Open the public site and the admin event list. Any test concert visible here
means a variable is still pointing at `development`.

---

## Definition of done

- [ ] Neon project in `eu-central-1` with `production` and `development` branches
- [ ] Migrations applied to production; all 13 tables present (12 application
      tables plus `_prisma_migrations` — Task 2 Step 4 lists them)
- [ ] Pooled reads **and** an interactive transaction verified through the adapter
- [ ] Vercel project on `fra1`, building with `pnpm vercel-build`
- [ ] Production and Preview env vars set, with different `SESSION_SECRET`s
- [ ] Preview points at the `development` Neon branch, not production
- [ ] `/` redirects to `/pl`; all three locales serve with the right `lang`
- [ ] `/admin` redirects to `/admin/login`
- [ ] No secret appears in the client bundle
- [ ] Exactly two admin accounts, neither from the seed
- [ ] Both passwords are in the password manager, and
      `.env.admin-credentials.txt` has been deleted
- [ ] A lost password can be reset — `pnpm admin:reset-password`
- [ ] Session cookie is `HttpOnly` + `Secure` in production
- [ ] SCANNER cannot reach `/admin/events` in production
- [ ] `bilety.krzyzowa-music.eu` resolves and serves with a valid certificate
- [ ] Point-in-time restore performed successfully at least once
- [ ] An off-platform dump exists
- [ ] Uptime monitoring alerts a phone someone carries
- [ ] Someone other than the developer knows how to roll back
- [ ] **At cutover (Task 9):** Production variables point at Neon `production`,
      Preview still points at `development`, migrations are applied, and no
      dummy content is reachable from the live site

---

## What this plan does not cover

Deliberately deferred, each to the plan that introduces it. Plan numbers below
are **executable** plans, per the table in [`../README.md`](../README.md) — not
the design documents, which use a separate numbering where `07` is security.

- **Stripe keys and webhook endpoint** — Plan 05 (Payments). The webhook secret differs between test and live mode, and the endpoint must be registered against the production URL.
- **Resend domain verification (SPF/DKIM/DMARC)** — Plan 05 (Payments). Needs the same DNS access as Task 7, so confirm that access now.
- **Vercel Cron**, with `CRON_SECRET` — hold expiry in Plan 04 (Inventory), email retries in Plan 05 (Payments).
- **Rate limiting shared across instances** — Plan 08 (Launch). The current limiter is per-instance in memory.
- **Security headers and CSP** — Plan 08 (Launch).
- **RODO retention job** — Plan 08 (Launch).

The last three have no plan of their own. They are pre-launch hardening drawn
from [`../07-security-and-testing.md`](../07-security-and-testing.md), and Plan
08 is the only slot before tickets go on sale — so they are listed in its
acceptance criteria rather than left to be remembered.
