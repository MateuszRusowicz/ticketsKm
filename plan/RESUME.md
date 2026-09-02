# Resumption prompt

Paste the block below into a fresh session. It points at documents rather than
restating them, so it cannot go stale the way a summary would.

---

```
We're building the ticket-sales app for the Krzyżowa Music festival in
/home/mateusz/Documents/Kodowanie/KM.

CLAUDE.md is loaded automatically and holds the operating rules and the trap
list — read it. Then, in order:
  plan/STATUS.md              — what's done, what's next, loose ends
  plan/00-decisions.md        — settled decisions + the "Versions as built" table
  plan/steps/03-public-programme.md — the last completed plan, and its Findings log

Plans 01 (foundations), 02 (deployment, tasks 1-6) and 03 (public programme)
are complete. 185 tests across 24 files, green twice from a clean tree. The
storefront works end to end: programme -> concert -> buy box -> validated order
form, in PL/EN/DE and PLN/EUR. No order is created and Stripe is not connected —
those are Plans 04 and 05.

How I want you to work:

- Verify against the codebase, not the plan. Open the files a step touches
  before writing or executing it. Two critique passes on Plan 03 found five
  blockers that were visible in the repo and invisible in the design docs.
- Follow the plan step by step. Each step has a command and an expected result
  — run it and show me the output. Don't batch steps and report at the end.
- Update the plan at the moment of discovery, not at the end. Every executable
  plan has a Findings log; append to it and correct the affected step in the
  same turn. Anything that outlives one plan goes in CLAUDE.md's trap list.
- Verify from a CLEAN tree before claiming anything passes:
      rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
      pnpm typecheck && pnpm lint && pnpm test && pnpm build
  Run the suite twice when a change adds tests asserting exact row counts.
- Never run git commit. Stop at each boundary, say what changed, give me the
  command.
- Secrets never enter a transcript. Redirect script output to a git-ignored
  file inside the repo, never /tmp or a scratchpad — that has already destroyed
  a set of production passwords.

Start with: read plan/STATUS.md and tell me what the next task is and what it
needs from me.
```

---

## What a fresh session should know that isn't in the prompt

**State at handoff (30 Aug 2026):** branch `feat/plan-03-public-programme`,
Plan 03 complete and accepted by the owner after a manual pass. 185 tests.
`main` is production and is what Vercel deploys; `development` integrates
finished features.

**The branch is not merged yet.** Merging it into `development` is the first
housekeeping step:

```bash
git checkout development
git merge feat/plan-03-public-programme
git push origin development
```

**Plan 04 (inventory) is next and is unblocked.** It is the risky core:
transactional capacity holds, the `heldCount` lifecycle, order creation, and
concurrency tests proving a 900-seat venue cannot oversell. Write it with the
`writing-plans` skill in the format of `steps/03-public-programme.md`, then
**have subagents critique it before executing** — that pass found five blockers
in Plan 03 and three in Plan 01, each of which would have surfaced far later
and more expensively.

Two constraints Plan 04 inherits, both settled and both load-bearing:

- **Holds last 30 minutes, flat across venues** (30 Aug 2026). Safe only if
  holds are released on payment failure, abandonment and cancellation — not
  merely on expiry. The 5-minute sweep is the backstop, not the mechanism.
- **One concert per order, one name per ticket.** The checkout schema in
  `src/lib/shared/checkout.ts` already has the exact field names of the `Order`
  columns, so Plan 04 needs no mapping layer. There is a `// PLAN-04:` marker
  in `src/components/CheckoutForm.tsx` where `createOrder()` goes.

**What is deliberately not built**, so it is not mistaken for a bug: orders,
holds, Stripe, email, PDF tickets, the door scanner, promo codes, refunds, and
real legal text. `plan/03-manual-test.md` lists them with the plan that owns
each.

**Two loose ends the owner has been reminded of:**

1. `.env.admin-credentials.txt` still sits in the repo root with both production
   passwords in plaintext. Git-ignored, but it should be in the password
   manager and deleted.
2. The Neon database password was once pasted into a chat transcript and should
   be rotated (Neon → Roles → Reset password, then update the Vercel variables).
