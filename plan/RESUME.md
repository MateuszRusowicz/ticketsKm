# Resumption prompt

Paste the block below into a fresh session to pick up where the last one
stopped. Keep it short on purpose — it points at documents rather than
restating them, so it cannot go stale the way a summary would.

---

```
We're building the ticket-sales app for the Krzyżowa Music festival in
/home/mateusz/Documents/Kodowanie/KM.

Read these first, in order:
  plan/STATUS.md            — what's done, what's next, loose ends
  plan/00-decisions.md      — settled decisions + the "Versions as built" table
  plan/steps/02-deployment.md — the plan currently in progress

Plan 01 (foundations) is complete: 106 tests, CI green, deployed to Vercel with
Neon Postgres in Frankfurt. Plan 02 (deployment) is at task 6 of 8.

How I want you to work:

- Follow the plan step by step. Each step has a command and an expected result
  — run it and show me the output. Don't batch steps and report at the end.
- Verify from a CLEAN tree before claiming anything passes:
      rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
      pnpm typecheck && pnpm lint && pnpm test && pnpm build
  A warm tree hides the Next 16 generated-type failures that only appear in CI.
- Never run git commit. Stop at each commit boundary, tell me what changed, and
  give me the command.
- This project runs on Prisma 7, Next 16, Tailwind 4, Vitest 4, Zod 4 — newer
  than most guidance assumes. Check plan/00-decisions.md before writing code
  against a remembered API. Prisma 7 needs a driver adapter and imports from
  @/generated/prisma/client; `import 'server-only'` throws under Vitest and tsx.
- When a plan step turns out to be wrong, fix the plan too, not just the code.
  That has happened about a dozen times and the plan is only useful if it stays
  true.

Start with: read plan/STATUS.md and tell me what the next task is and what it
needs from me.
```

---

## What the next session should know that isn't in the prompt

**State at handoff (23 Aug 2026):** branch `feat/plan-01-foundations`, 18
commits, never merged to `main`. 106 tests passing. Uncommitted: `plan/STATUS.md`,
a `plan/README.md` edit, and an untracked `.vscode/`.

**Tasks 6–8 of Plan 02 all need the owner's accounts** — creating the production
admin, pointing `bilety.krzyzowa-music.eu` at Vercel, and verifying a Neon
restore. An agent can prepare and verify, but cannot do them.

**Three things the owner still owes the project**, from
[`09-open-questions.md`](09-open-questions.md):

1. Whether a buyer can put several concerts in one order (blocks Plan 03's UI)
2. Whether tickets carry attendee names or are anonymous (blocks Plan 03)
3. Confirmation that a CNAME can be added for `krzyzowa-music.eu` — this also
   gates Resend's SPF/DKIM in Plan 05, so it has the longest lead time

**Plan 03 has not been written.** Write it with the `writing-plans` skill in the
format of `steps/01-foundations.md`, and have a subagent critique it before
executing — that pass caught three blockers in Plan 01, including a route-group
conflict that would have failed the build at the very last task.
