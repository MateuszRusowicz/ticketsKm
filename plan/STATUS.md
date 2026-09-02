# Status — 30 August 2026

Where the project stands, for whoever picks it up next. Update this at the end
of a working session; it is the fastest way back into context.

## Done

**Plan 01 — Foundations: complete.** All 16 tasks. (114 tests at the time; the
suite is now 185 across 24 files after Plan 03.)

The application runs locally in full: `pnpm dev`, then log in at
`/admin/login` as `admin@krzyzowa-music.eu` / `DevPassword123!` and create a
concert with Polish, English and German content, prices in PLN and EUR, and a
capacity that cannot be lowered below tickets already sold.

**Plan 03 — Public programme: tasks 0–12 done**, pending the owner's visual
acceptance. 185 tests across 24 files, green twice from a clean tree.

The demo walks end to end: programme listing → concert page → buy box → order
form, in three languages and two currencies, on `feat/plan-03-public-programme`.

- Public queries filter by status, sales window, past dates and `TicketType.active`
- Currency defaults from locale, switchable, cookie-persisted, never converted
- Concert pages 404 for unknown, `DRAFT`, `CANCELLED` and past slugs
- Checkout form collects one name per ticket; `?q=` re-clamped server-side
- Terms and privacy pages in three languages, linked from a footer
- `robots.txt` blocks indexing until launch
- **No `Order` is created anywhere** — that is Plan 04

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

**Next up: the owner's look at the demo, then Plan 04 (inventory).**

Run `pnpm dev` and open <http://localhost:3000/pl>. Two things need a human:
the 320px rendering (the mechanisms are verified, the appearance is not) and
whether the design is what the festival wants. Everything else in Plan 03's
definition of done is ticked and evidenced.

**Plan 04 is blocked** on one unanswered question: hold duration by venue size
(see [`09-open-questions.md`](09-open-questions.md)). A flat 30 minutes lets 300
people hold every seat of a 300-seat concert while everyone else sees "sold
out".

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
| 7 | Point `bilety.krzyzowa-music.eu` at Vercel via CNAME. | **Deferred to launch** — decided 27 Aug 2026 to stay on `tickets-km.vercel.app` until the app is tested and the team agrees. Confirm *who controls DNS* now regardless; Plan 05 needs the same access for Resend. |
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
