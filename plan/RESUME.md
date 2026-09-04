# Resumption prompt

Paste the block below into a fresh session. It points at documents rather than
restating them, so it cannot go stale the way a summary would.

---

```
We're building the ticket-sales app for the Krzyżowa Music festival in
/home/mateusz/Documents/Kodowanie/KM.

CLAUDE.md is loaded automatically and holds the operating rules and the trap
list — read it. Then, in order:
  plan/STATUS.md              — what's done, what's next, what's blocked on me
  plan/00-decisions.md        — settled decisions + the "Versions as built" table
  plan/steps/05-payments.md   — the plan to execute, and its Findings log

Plans 01 (foundations), 02 (deployment, tasks 1-6), 03 (public programme) and
04 (inventory) are complete and merged into `development`. 290 tests across 34
files, green twice from a clean tree. A 900-seat concert provably cannot be
oversold — 1000 concurrent buyers gives exactly 900 held, 100 rejected, with a
recorded negative control proving the test can fail.

Plan 05 (payments) is WRITTEN AND VERIFIED but NOT STARTED. It took three
drafts and two critique rounds; read its Findings log before touching it,
especially the entries about what the earlier drafts got wrong. Do not "improve"
the design without reading why it is shaped this way — in particular, Plan 05
deliberately does NOT cancel PaymentIntents on expiry, which overrides
03-purchase-flow.md.

Start with: read plan/STATUS.md and tell me what Task 0 needs from me.

How I want you to work:

- Verify against the codebase, not the plan. Open the files a step touches
  before writing or executing it. Every critique pass on this project has found
  blockers that were plainly visible in the repo and invisible in the docs.
- Follow the plan step by step. Each step has a command and an expected result
  — run it and show me the output. Don't batch steps and report at the end.
- Update the plan at the moment of discovery, not at the end. Append to the
  Findings log and correct the affected step in the same turn. Plan 04
  accumulated ~45 findings during execution and two of them would otherwise
  have stopped it dead.
- A green test is not evidence until you have seen it fail. Plan 04 had three
  tests that passed for the wrong reason — a pool-tuning test that passed with
  the tuning removed, an audit test whose mock ignored its arguments, and a
  seed test that could not reach the state it claimed to check. Run the
  negative control.
- Verify from a CLEAN tree before claiming anything passes:
      rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
      pnpm typecheck && pnpm lint && pnpm test && pnpm build
  Run the suite twice when a change adds tests asserting exact row counts.
- Never run git commit. Stop at each boundary, say what changed, give me the
  command. Keep commit messages short.
- Secrets never enter a transcript. Not keys, not connection strings. Redirect
  script output to a git-ignored file inside the repo, never /tmp — that has
  already destroyed a set of production passwords.
```

---

## What a fresh session should know that isn't in the prompt

**State at handoff (4 Sep 2026):** branch `development`, clean tree, everything
merged. Vercel builds `development` and deploys green.

**Plan 05 is the whole job.** It is written, critiqued twice, independently
verified, and blocked only on the owner. Its Findings log has 103 entries; the
ones that explain the design are the 4 Sep rows.

**Four things are blocked on the owner** — see STATUS.md's table for detail:
Stripe key *names* (`.env` has `STRIPE_API_KEY`, the plan wants
`STRIPE_PUBLISHABLE_KEY`), the webhook secret (which cannot exist until
`stripe listen` runs), Vercel Pro (without it the sweeps never run at all), and
`NEXT_PUBLIC_SITE_URL` on Vercel (wrong value silently breaks four of six demo
flows, in production only).

**Tasks 0–4 can run today** without any of that.

**Three design decisions that will look wrong without their reasoning:**

1. **Plan 05 never cancels PaymentIntents.** This contradicts
   `03-purchase-flow.md` on purpose. An abandoned checkout charges nobody, and
   the two-transaction machinery built to cancel safely produced four blockers
   of its own. The trade: a live PaymentIntent can succeed after its seats are
   released, so **reclaim-or-refund is the primary safety net** and deserves
   the most testing.
2. **SEPA is enabled with seats held**, against advice, with three guardrails
   (10% capacity cap, hidden near sellout, 5-day ceiling). Removing a guardrail
   without replacing it re-opens a venue-scale capacity leak.
3. **Alerting is a stopgap**, not a system: `console.error` on stderr, read by
   a human looking at Vercel logs. Documented as such. Plan 07's dashboard
   replaces it.

**What is deliberately not built**, so it is not mistaken for a bug: payments,
ticket email, PDF tickets, QR codes, the door scanner, promo codes, refunds,
invitations, and real legal text. `plan/03-manual-test.md` lists them with the
plan that owns each.

**Two loose ends the owner has been reminded of repeatedly:**

1. `.env.admin-credentials.txt` still sits in the repo root with both
   production admin passwords in plaintext. Git-ignored, but it belongs in a
   password manager and then deleted.
2. The Neon database password was once pasted into a chat transcript and should
   be rotated (Neon → Roles → Reset password, then update Vercel).

**Housekeeping:** `feat/plan-01-foundations` is fully merged and still on the
remote — `git push origin --delete feat/plan-01-foundations`. `main` is 10
commits behind `development` and is no longer what Vercel deploys; decide
whether it still means anything or should simply track `development`.
