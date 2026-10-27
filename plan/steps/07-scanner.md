# Plan 07 — Door scanner

**Goal:** staff open `/admin/scan` on a phone, log in once, pick tonight's
concert, and scan tickets. Each scan posts the code to `/api/admin/scan`,
which atomically transitions one `Ticket` row from `VALID` to `USED` and
returns one of five states. **First scan wins**: two staff members scanning
the same code within milliseconds see exactly one green and one amber. The
page shows the result full-screen in colour with a sound and a short
vibration, prominently displays the holder's name so staff can check it
against the person at the door (**advisory, not a gate** — buyers routinely
pass tickets to family with different surnames), and offers a manual-entry
fallback for damaged QRs.

**What this plan does NOT ship** (explicitly):

- Any mutation of tickets through the public `/t/<code>` page — that path
  stays read-only forever (Plan 06 invariant).
- Ticket email delivery — Plan 08.
- Invitations, promo codes, staff-initiated refunds — Plan 08.
- Offline mode (pre-downloaded codes, local validation, later sync). Listed
  as deferred in `05-admin-and-scanner.md` and `09-open-questions.md`;
  keep deferred.
- Any change to how codes are generated, how tickets are issued, or how
  PDFs are rendered — all Plan 06.

**Architecture:**

- **One mutation path.** `scanTicket({ code, eventId, adminId })` in
  `src/lib/server/scanner.ts` is the only function that transitions
  `VALID → USED`. It runs a single `UPDATE ... WHERE code = $1 AND status =
  'VALID' RETURNING ...` — zero rows returned means someone else got there
  first, and the current state is looked up with a second `SELECT` and
  returned as `ALREADY_USED`. There is no read-then-write window.
- **Discriminated-union result type** so the UI and the audit log consume
  the same shape:
  ```ts
  type ScanResult =
    | { state: 'VALID'; ticket: { code, holderName, concertTitle, eventId } }
    | { state: 'ALREADY_USED'; ticket: {...}; usedAt: Date; usedByName: string | null }
    | { state: 'REVOKED'; ticket: {...} }
    | { state: 'WRONG_EVENT'; ticket: {...}; correctEvent: { title, startsAt, slug } }
    | { state: 'NOT_FOUND' }
    | { state: 'MALFORMED' }
  ```
- **The server function is pure of its UI**. The React page passes POSTed
  JSON `{ code, eventId }`, gets back the discriminated union, and renders.
  The function itself is unit-tested against the database — no HTTP, no
  mocks. See `tests/lib/server/orders.test.ts` for the shape.
- **Camera + QR decoding is client-side**, through `@zxing/browser`. The
  page is a Client Component (`'use client'`) that calls
  `navigator.mediaDevices.getUserMedia` with the rear camera, decodes with
  zxing, extracts the trailing `/t/<code>` segment, and POSTs. The decoder
  is replaced by a plain `<input>` when the camera is denied or unavailable.
- **Rate limit per admin and per IP**, keyed on both. A compromised phone
  must not be able to brute-force the Crockford alphabet; a shared office IP
  must not shut out a legitimate volunteer scanning real codes.
- **Every scan goes to the audit log**, success or failure. A `WRONG_EVENT`
  pattern on one admin account is a signal; a `NOT_FOUND` spike is a signal.
  The audit log is Plan 05's `AuditLog` table — no new schema.

**Spec:** [`../05-admin-and-scanner.md`](../05-admin-and-scanner.md) (§ "The
door scanner" — the five-state table and the atomic SQL are the normative
spec); [`../07-security-and-testing.md`](../07-security-and-testing.md)
(authorisation on every endpoint; rate-limit discipline);
[`../00-decisions.md`](../00-decisions.md) (versions table — zxing version
set here).

**Depends on:** Plan 06. The scanner has nothing to scan without
`Ticket` rows carrying codes and a public `/t/<code>` page. Specifically it
depends on:

- `Ticket.code`, `Ticket.status`, `Ticket.usedAt`, `Ticket.usedByAdminId`
  (all present in `prisma/schema.prisma`).
- `AdminSession` + `getCurrentAdmin()` + `requireStaff()` from
  `src/lib/server/auth.ts`.
- `AuditLog` + `recordAudit()` from `src/lib/server/audit.ts`.
- `AdminRole = SCANNER | ADMIN` — both can scan; both already redirect to
  `/admin/scan` by default (`login/actions.ts:32`, `auth.ts:52`).

**No migration.** Every column needed already exists.

**Verification gate** (from `/CLAUDE.md`), from a **clean tree**:

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Every task ends with it. Run `pnpm test` **twice** when a task adds a test
asserting an exact `AuditLog` or `Ticket` row count.

> **Written 26 October 2026** against the repo as it stood that day. Every
> claim about `src/`, `prisma/`, `tests/`, `package.json` and `proxy.ts` was
> verified by reading the file. The Findings log below is empty — executors
> append to it when reality disagrees with the plan.

---

## Findings log

Appended **as things are discovered**, not at the end.

| Date | Finding | Action |
|---|---|---|
| 26 Oct 2026 (owner decision) | **SCANNER role sees the admitted-tickets list.** Original plan drafted Task 6 as `requireAdmin`; owner: a volunteer at the door legitimately needs to see which tickets have already been admitted (duplicate detection, re-entry judgement, "did my colleague scan this?"). Fields exposed must stay door-staff-only: holder name, ticket type, `usedAt`, `scannedBy` (admin name). Fields hidden: buyer e-mail, phone, order total, invoice data, order reference tail, buyer-side notes. | Task 6 rewritten with `requireStaff()` and an explicit allow-list of fields. Added a link from `/admin/scan` to `/admin/events/[id]/scans` so SCANNER accounts can reach the page (SCANNER never has nav back to `/admin/events/[id]` because that uses `requireAdmin()` — the only scanner-reachable path to the list is the scanner page itself). |
| 26 Oct 2026 (verified) | **SCANNER session cookie reaches `/admin/events/[id]/scans`.** `src/lib/server/auth.ts:12` scopes the cookie to `COOKIE_PATH = '/admin'`, which prefixes every page in this plan including the scans list. Node's `cookies().get()` reads it regardless of request subpath. The regression test described in Plan 07 Task 2 Step 1 (`/api/admin/scan` cookie reach) is extended to cover the scans page. | Confirmed; Task 6 Step 1 notes the invariant. |
| 26 Oct 2026 (verified) | **Audit-log scope for `AuditLog`-based scans view.** `scanTicket` writes `AuditLog` rows with `entityType = 'Ticket'`, `entityId = ticket.id` (or `entityId = code` for malformed scans). The scans view joins AuditLog → Ticket → Event, so NOT_FOUND/MALFORMED rows (no Ticket) are excluded by default — the list is "who was admitted and when", not "every scan attempt". A separate "scan attempts (incl. failures)" view is ADMIN-only and lives on the event's admin page; this keeps door staff from seeing an unredacted attack-attempt log. | Task 6 split: the SCANNER-reachable list shows admissions only; a separate ADMIN-only tab shows every attempt. |

*(Executors: append rows here in the same turn a discovery is made, not at the end of the task.)*

---

## Global Constraints

- **The atomic UPDATE is the sole lock.** No `SELECT ... FOR UPDATE` first.
  No read-then-write pattern. Two staff members scanning simultaneously must
  not both see green, and the ONLY mechanism that prevents it is the
  conditional UPDATE's `WHERE status = 'VALID'`.
- **`UPDATE` returns `RETURNING id` or empty.** If empty, do a second
  `SELECT` to classify (USED / REVOKED / WRONG_EVENT / NOT_FOUND). The
  classification SELECT is NEVER followed by another UPDATE.
- **`WRONG_EVENT` returns the correct event's slug and title** so staff can
  redirect the buyer, but the ticket is **not** admitted and the mutation
  is **not** attempted — a ticket for tomorrow night is valid, just not
  for tonight.
- **`NOT_FOUND` is returned for both unknown codes and malformed codes**
  that would never pass the Crockford validator. The scanner UI can
  distinguish `MALFORMED` client-side without a round trip; the server
  returns `NOT_FOUND` either way to avoid a code-existence oracle.
- **Opening `/t/<code>` NEVER touches the DB mutation path.** This is a
  Plan 06 invariant, reasserted here because the scanner is the one path
  that mutates and it must not accidentally share plumbing with the public
  page.
- **Authorisation on EVERY endpoint**, not in middleware. Call
  `requireStaff()` (which allows both ADMIN and SCANNER) at the top of the
  POST handler and at the top of the page component.
- **Session cookie is `/admin`-scoped.** `src/lib/server/auth.ts:12`
  pins `COOKIE_PATH = '/admin'`. `/api/admin/scan` is under `/api`, which
  does not share the path. **The route handler reads the cookie
  explicitly via `getCurrentAdmin()`**, which calls `cookies().get(...)`
  with no path filter — a cookie set at `/admin` is still readable at
  `/api/admin/scan`. Confirmed by reading the Next.js cookie API: `cookies()`
  returns all cookies regardless of their Path attribute. Task 2 Step 1
  includes a regression test for this because it is the exact kind of
  invariant a well-meaning refactor can break.
- **Rate limit on the mutation endpoint.** Key format: `scan:<adminId>` and
  `scan:ip:<ip>`, both checked. Admin limit 300/min (five per second —
  faster than human scanning), IP limit 600/min. A 429 renders amber and
  tells staff to wait a second.
- **UI runs in the browser; tests do not render it.** Vitest is
  Node-environment. Scanner-state logic lives in
  `src/lib/shared/scan-view.ts` as a pure function (map `ScanResult` →
  render properties: colour, headline, subtitle, sound tone). The UI
  consumes it and is verified manually (Task 5).
- **`navigator.mediaDevices.getUserMedia` requires HTTPS.** Production is
  HTTPS; `localhost` is treated as secure by Chrome/Firefox/Safari so dev
  works. No code to write — but add it to the manual-test note.
- **Camera denial / unavailability falls back to manual entry.** The
  manual-entry input is **always present**, not conditional — a damaged QR
  is one of the use cases listed in the design doc and will happen on live
  nights. Hiding it saves zero pixels and loses one of the two intended
  paths through the page.
- **Commits are made by the human operator.**

---

## Task 0: Baseline gate

- [ ] **Step 1: Clean tree on a fresh branch cut from `development`**

```bash
git status && git branch --show-current
git checkout development && git pull --ff-only
git checkout -b feat/plan-07-scanner
```

Expected: clean tree, branch created.

**Dependency check:** Plan 06 must be merged into `development` before this
plan runs. If `development`'s `src/app/t/` directory does not exist, stop —
`feat/plan-06-tickets` is not yet merged.

```bash
test -d src/app/t && echo "plan 06 merged" || { echo "STOP: plan 06 not merged"; exit 1; }
```

- [ ] **Step 2: Postgres + migrations + seed**

```bash
docker compose up -d
pnpm exec dotenv -e .env -- prisma migrate deploy
pnpm db:seed
```

- [ ] **Step 3: Clean-tree gate green as Plan 06 landed**

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all green at Plan 06's final test count (record it; later tasks
assert delta).

- [ ] **Step 4: Confirm there is a paid order with tickets to test against**

```bash
pnpm exec tsx -e "import('./src/lib/server/db').then(async ({db})=>{const o=await db.order.findFirst({where:{status:'PAID'},select:{reference:true,tickets:{select:{code:true,status:true,event:{select:{slug:true}}}}}});console.log(JSON.stringify(o,null,2));process.exit(0)})"
```

Expected: an order with ≥ 1 ticket in `status: 'VALID'`. If none, make a
test-mode payment first (see `plan/05-manual-test.md`).

---

## Task 1: Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install `@zxing/browser` + `@zxing/library`**

```bash
pnpm add @zxing/browser @zxing/library
```

Record resolved versions in `plan/00-decisions.md`'s versions table.

**Rejected alternative:** `html5-qrcode`. zxing is more actively maintained,
smaller when tree-shaken (only the QR decoder is imported), and has no
peer-dep on jQuery. Record the choice in Findings on first execution.

- [ ] **Step 2: Verify no transitive native dependency**

```bash
pnpm why canvas sharp node-gyp 2>&1 | head -20
```

Expected: none of the three are runtime deps of the added packages.

- [ ] **Step 3: Gate**

Expected: tests still green at their Plan 06 count.

---

## Task 2: `scanTicket` — the atomic mutation path

The only function in the codebase that transitions a `Ticket` from `VALID`
to `USED`.

**Files:**
- New: `src/lib/server/scanner.ts`
- New: `tests/lib/server/scanner.test.ts`

- [ ] **Step 1: Write `src/lib/server/scanner.ts`**

```ts
import 'server-only'
import { db } from './db'
import { recordAudit } from './audit'
import { isValidTicketCode } from '@/lib/shared/ticket-code'  // Plan 06 Task 2

export type ScanResult =
  | { state: 'VALID'; ticket: ScannedTicket }
  | { state: 'ALREADY_USED'; ticket: ScannedTicket; usedAt: Date; usedByName: string | null }
  | { state: 'REVOKED'; ticket: ScannedTicket }
  | { state: 'WRONG_EVENT'; ticket: ScannedTicket; correctEvent: { title: string; slug: string; startsAt: Date } }
  | { state: 'NOT_FOUND' }

export type ScannedTicket = {
  code: string
  holderName: string | null
  concertTitle: string
  eventId: string
}

export async function scanTicket(args: {
  code: string
  eventId: string
  adminId: string
  locale?: 'pl' | 'en' | 'de'  // for the concert title in `ScannedTicket` and `correctEvent`
}): Promise<ScanResult>
```

Implementation:

1. **Shape check.** If `isValidTicketCode(code)` is false → return
   `{ state: 'NOT_FOUND' }`, write an audit row at severity NOTICE
   (`action: 'ticket.scan.malformed'`, `entityType: 'Ticket'`, `entityId: code`,
   `meta: { eventId: args.eventId, codeSuffix: code.slice(-6) }`),
   and **do not touch the Ticket table**.
2. **Attempt the UPDATE.** Single raw SQL:
   ```sql
   UPDATE "Ticket"
      SET status = 'USED',
          "usedAt" = now(),
          "usedByAdminId" = $3
    WHERE code = $1
      AND "eventId" = $2
      AND status = 'VALID'
   RETURNING id, "holderName", "eventId"
   ```
3. If the UPDATE returns a row:
   - Load `event.translations[locale].title` + `event.slug` for the response.
   - Write an audit row (`action: 'ticket.scan.valid'`,
     `meta: { eventId: args.eventId, codeSuffix: code.slice(-6),
     holderName: ticket.holderName }`).
   - Return `{ state: 'VALID', ticket: {...} }`.
4. If the UPDATE returns zero rows:
   - `SELECT` the ticket by `code` alone (no `eventId` constraint, no
     `status` constraint). Every classify branch writes an audit row with
     `meta.eventId = args.eventId` (so Task 6's event-scoped list filters
     catch it) and `meta.codeSuffix = code.slice(-6)` (never the full
     code — Task 6 trims to 6 and the audit log must never leak a
     working credential):
     - **Row absent** → `NOT_FOUND`. Audit (`ticket.scan.notFound`,
       no `holderName`).
     - **Row present, `status = 'USED'`** → `ALREADY_USED` with
       `usedAt` and `usedByAdmin.name`. Audit (`ticket.scan.alreadyUsed`,
       `meta.holderName` from the existing row).
     - **Row present, `status = 'REVOKED'`** → `REVOKED`. Audit
       (`ticket.scan.revoked`, `meta.holderName`).
     - **Row present, `status = 'VALID'` but `eventId != args.eventId`** →
       `WRONG_EVENT`. Fetch the correct event's title/slug/startsAt.
       Audit (`ticket.scan.wrongEvent`, `meta.holderName` AND
       `meta.correctEventId` so an admin reading the attempts tab sees
       which concert the ticket was really for).
     - **Row present, `status = 'VALID'` and `eventId = args.eventId`** →
       **impossible under the atomic UPDATE's semantics**. Treat as an
       internal error, log at ERROR severity, return `NOT_FOUND` to the UI
       (fail closed).

**Why not two SELECTs then one UPDATE:** that is the exact race the design
doc forbids. The UPDATE's `WHERE status = 'VALID'` IS the lock — no read
precedes it. The second `SELECT` happens only when the UPDATE already
confirmed we did not win, and it only classifies, never mutates.

**Why `AND eventId = $2` in the UPDATE:** a scanner at the wrong concert
must not accidentally admit a ticket for tomorrow. The second SELECT
(without that constraint) is what detects `WRONG_EVENT`.

- [ ] **Step 2: Write `isValidTicketCode` and move `ticketCode` into
      `src/lib/shared/ticket-code.ts`** (Plan 06 Task 2 added the export in
      `orders.ts`; this is the natural move but may already be done).

Pure functions:

```ts
export function ticketCode(): string                      // existing logic
export function isValidTicketCode(s: string): boolean     // length 26, Crockford alphabet
```

Update `orders.ts` to import from the new location. If Plan 06 already moved
it, verify and skip.

- [ ] **Step 3: Write `tests/lib/server/scanner.test.ts`**

**Nine cases.** Each case begins with a `TRUNCATE "AuditLog","Ticket","Order",
"OrderItem","TicketType","Event","Venue","AdminUser","AdminSession"
RESTART IDENTITY CASCADE` (follow `tests/lib/server/orders.test.ts`'s
preamble pattern).

1. **Happy path:** `VALID` ticket, correct event → `{ state: 'VALID' }`;
   DB row now `status: 'USED'`, `usedAt` within the last second,
   `usedByAdminId` matches input.
2. **Already used:** ticket already `USED` with a prior `usedAt` and
   `usedByAdminId` → `{ state: 'ALREADY_USED' }` with the ORIGINAL `usedAt`
   and the ORIGINAL admin name. **The second scan does not overwrite them**
   (verify by reading the row post-scan — `usedAt` unchanged).
3. **Revoked:** `status = 'REVOKED'` → `{ state: 'REVOKED' }`. No DB
   write.
4. **Wrong event:** `VALID` ticket, scanned under a different event's id →
   `{ state: 'WRONG_EVENT' }` with `correctEvent.slug` matching the ticket's
   actual event. Ticket row unchanged.
5. **Not found — unknown code:** 26-char Crockford string that is not in the
   DB → `{ state: 'NOT_FOUND' }`. No DB write.
6. **Not found — malformed code:** `"not-a-code"` → `{ state: 'NOT_FOUND' }`.
   Verify with a spy on `db.$queryRawUnsafe` that **no query ran** against
   `"Ticket"` (the malformed check short-circuits).
7. **Audit rows written:** for each of cases 1–5, assert the matching
   `AuditLog` row exists with the expected action string.
8. **Race — two parallel scans of the same code:**
   ```ts
   const results = await Promise.all([
     scanTicket({ code, eventId, adminId: a1 }),
     scanTicket({ code, eventId, adminId: a2 }),
   ])
   const valid = results.filter((r) => r.state === 'VALID')
   const alreadyUsed = results.filter((r) => r.state === 'ALREADY_USED')
   expect(valid.length).toBe(1)
   expect(alreadyUsed.length).toBe(1)
   ```
   Exactly one green, exactly one amber. **Negative control:** replace the
   atomic UPDATE with a read-then-write pattern and re-run — the test should
   produce `{ VALID: 2, ALREADY_USED: 0 }` sometimes. **Record the negative
   control's observed outcome**, then restore. A test that passes identically
   with and without the lock proves nothing.
9. **100-parallel race:** 100 `scanTicket` calls on the same code
   `Promise.all`. Exactly one `VALID`, 99 `ALREADY_USED`. This case has a
   `testTimeout: 30_000` because Postgres contention on 100 concurrent
   transactions takes seconds. Follow the pattern of
   `tests/lib/server/oversell.test.ts`'s 1000-order case.

```bash
pnpm test scanner && pnpm test scanner
```

Expected: 9 tests pass **twice**.

- [ ] **Step 4: Gate**

Expected: Plan 06 count + 9 scanner tests.

---

## Task 3: `/api/admin/scan` POST endpoint

The HTTP seam between the client page and `scanTicket`.

**Files:**
- New: `src/app/api/admin/scan/route.ts`
- New: `tests/app/api/admin-scan.test.ts`

- [ ] **Step 1: Write the Route Handler**

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/server/auth'  // throws / redirects for the page; here we need a non-throwing variant
import { getCurrentAdmin } from '@/lib/server/auth'
import { scanTicket } from '@/lib/server/scanner'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

const bodySchema = z.object({
  code: z.string().min(1).max(64),  // scan input, not the ticket code's shape
  eventId: z.uuid(),
})

export async function POST(request: Request): Promise<Response> {
  const admin = await getCurrentAdmin()
  if (!admin) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  if (admin.role !== 'ADMIN' && admin.role !== 'SCANNER') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
  if (!rateLimit(`scan:${admin.id}`, 300, 60_000)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 })
  }
  if (!rateLimit(`scan:ip:${ip}`, 600, 60_000)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 })
  }

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await request.json())
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const result = await scanTicket({
    code: body.code,
    eventId: body.eventId,
    adminId: admin.id,
  })

  // 200 always, with the discriminated union in the body. HTTP-status-coded
  // results would collapse NOT_FOUND and REVOKED into 404 and lose the
  // distinction the UI needs.
  return NextResponse.json(result, { status: 200 })
}
```

**Why 200 for every ScanResult:** the UI needs to render different colours
and different copy for VALID / ALREADY_USED / REVOKED / WRONG_EVENT /
NOT_FOUND. Collapsing them into HTTP status codes loses information at the
one layer that cannot preserve it. See the five-state table in
`05-admin-and-scanner.md`.

- [ ] **Step 2: Write `tests/app/api/admin-scan.test.ts`**

**Seven cases**, each calls the exported `POST` directly (same pattern as
`tests/app/api/cron-release-holds.test.ts`):

1. No session cookie → 401 `unauthenticated`.
2. Non-staff session (none — all admins are staff) — covered by case 1.
3. ADMIN role scans a VALID ticket → 200 `{ state: 'VALID', ... }`.
4. SCANNER role scans a VALID ticket → 200 `{ state: 'VALID', ... }`.
5. Rate limit: 301 scans by the same admin in 60s → the 301st returns 429
   `rate_limited`. Clear `__resetRateLimits()` after.
6. Bad JSON body → 400 `bad_request`.
7. Malformed `eventId` (not a UUID) → 400 `bad_request`.

```bash
pnpm test admin-scan && pnpm test admin-scan
```

Expected: 7 tests pass **twice**.

- [ ] **Step 3: Gate**

---

## Task 4: `scan-view` — pure UI mapping

Centralise the ScanResult → UI props mapping so it is testable and so the
page component stays mechanical.

**Files:**
- New: `src/lib/shared/scan-view.ts`
- New: `tests/lib/shared/scan-view.test.ts`

- [ ] **Step 1: Write `src/lib/shared/scan-view.ts`**

```ts
import type { ScanResult } from '@/lib/shared/scan-result'  // move the type to shared/

export type ScanView = {
  colour: 'green' | 'amber' | 'red'
  tone: 'ok' | 'warn' | 'error'           // for the sound/vibration pattern
  headline: string                         // i18n key
  subtitle: string | null                  // i18n key with interpolations, or raw
  holderName: string | null                // from the ticket, if present
  context: {
    code: string | null
    usedAt: Date | null
    usedByName: string | null
    correctEventSlug: string | null
  }
}

export function viewForResult(r: ScanResult, locale: 'pl' | 'en' | 'de'): ScanView
```

Mapping:

| ScanResult.state | colour | tone | headline key | subtitle |
|---|---|---|---|---|
| VALID | green | ok | `scan.state.valid.heading` | `scan.state.valid.body` |
| ALREADY_USED | amber | warn | `scan.state.alreadyUsed.heading` | `scan.state.alreadyUsed.body` with `{time}` and `{by}` |
| REVOKED | red | error | `scan.state.revoked.heading` | `scan.state.revoked.body` |
| WRONG_EVENT | red | error | `scan.state.wrongEvent.heading` | `scan.state.wrongEvent.body` with `{concert}` |
| NOT_FOUND | red | error | `scan.state.notFound.heading` | `scan.state.notFound.body` |

For the ALREADY_USED subtitle, format `usedAt` in `Europe/Warsaw` via
`formatConcertTime(usedAt, locale)`.

- [ ] **Step 2: Move `ScanResult` type to `src/lib/shared/scan-result.ts`**

The server's `scanner.ts` imports from the shared file; the client component
also imports from it (allowed — ESLint's `no-restricted-imports` only bans
`@/lib/server/*`). This is the same pattern Plan 03 established.

- [ ] **Step 3: Write `tests/lib/shared/scan-view.test.ts`**

Five cases, one per state. For each:

- Correct colour and tone.
- Correct i18n keys.
- Holder name appears in `view.holderName` when the ScanResult carries one,
  otherwise `null`.
- For `WRONG_EVENT`: the subtitle interpolation includes the correct
  concert's slug/title.

```bash
pnpm test scan-view
```

Expected: 5 tests pass.

- [ ] **Step 4: Gate**

---

## Task 5: `/admin/scan` page

Client Component rendering the camera, result banner, counter and manual
entry.

**Files:**
- New: `src/app/(admin)/admin/scan/page.tsx`
- New: `src/app/(admin)/admin/scan/ScannerClient.tsx`
- New: `src/app/(admin)/admin/scan/EventPicker.tsx`
- No tests. Manual verification only (Vitest has no DOM).

- [ ] **Step 1: Write the Server Component `page.tsx`**

Server-side:

- `requireStaff()`.
- List tonight's concerts: `Event` where `startsAt BETWEEN now()-interval '2 hours' AND now()+interval '12 hours'`,
  status `IN ('ON_SALE', 'SOLD_OUT')`. In August they overlap, so the picker
  cannot assume one — show them as a list ordered by `startsAt ASC`. Outside
  festival dates, fall back to all concerts in the next 14 days.
- Render `<ScannerClient events={...}>`.

- [ ] **Step 2: Write `ScannerClient.tsx` as `'use client'`**

State:
- `selectedEventId: string | null` — persisted in `localStorage` (keyed on
  admin id) so a reload during a shift does not demand re-picking the
  concert.
- `lastResult: ScanResult | null`.
- `counter: { scanned: number; admitted: number }` — admitted increments on
  VALID only; scanned on any state.
- `cameraState: 'off' | 'starting' | 'running' | 'denied' | 'noCamera'`.
- `manualInput: string`.

Behaviour:

1. **Camera section** — one button "Włącz skaner / Start scanner / Scanner
   starten" that calls `getUserMedia({ video: { facingMode: 'environment' } })`
   and streams into zxing's `BrowserMultiFormatReader`. On a QR decode:
   - If it looks like a URL, extract the last path segment (`/t/<code>`).
   - If it looks like a bare code, use as-is.
   - POST to `/api/admin/scan` with `{ code, eventId: selectedEventId }`.
   - Render the `ScanView` full-screen with the appropriate colour, play
     a short tone, trigger `navigator.vibrate(100)`.
   - On a VALID: increment `admitted`.
   - After 2.5 seconds, dismiss the result and resume scanning.
2. **Manual-entry section** — always visible underneath. A single `<input>`
   with the Crockford alphabet pre-sanitised (upper-case, strip
   `I`/`L`/`O`/`U`), plus a submit button. Same POST path.
3. **Running counter** displayed in the header.
4. **Hard rule:** before any decode, the component asserts
   `selectedEventId !== null`. If no event is picked, the camera button is
   disabled and a "Wybierz koncert" banner is rendered.

**Audio:** three short synthesized tones (ok/warn/error) via WebAudio,
written once in a small helper. No audio file bundled — the Vercel bundle
stays lean, and WebAudio is universally supported on mobile.

**Styling:** the result banner is `position: fixed`, full-viewport, high
contrast. The design-system tokens in `globals.css` carry the three colours
already (`#CC1216` for red; add amber `#F2A900` and green `#2F8F32` as
new tokens if not present).

- [ ] **Step 3: Add i18n keys**

In each `messages/*.json`, under new `"scan"` root:

```json
{
  "scan": {
    "title": "Skaner biletów",
    "pickEvent": "Wybierz koncert",
    "startCamera": "Włącz skaner",
    "cameraDenied": "Brak dostępu do kamery. Użyj wpisu ręcznego.",
    "noCamera": "Nie znaleziono kamery. Użyj wpisu ręcznego.",
    "manualPrompt": "Wpisz kod ręcznie",
    "manualSubmit": "Sprawdź",
    "counter": "Zeskanowane: {scanned} · Wpuszczone: {admitted}",
    "state": {
      "valid": { "heading": "Wejście OK", "body": "Wpuść." },
      "alreadyUsed": { "heading": "Już wykorzystany", "body": "Zeskanowano {time} przez {by}." },
      "revoked": { "heading": "Bilet nieważny", "body": "Zwrócony lub anulowany." },
      "wrongEvent": { "heading": "Nie na ten koncert", "body": "Bilet jest na: {concert}." },
      "notFound": { "heading": "Nie znaleziono", "body": "Spróbuj jeszcze raz lub użyj kodu obok QR." }
    }
  }
}
```

Translate for `en` and `de`. All three in this step.

- [ ] **Step 4: Manual check — the one that catches the bugs tests cannot**

```bash
pnpm dev
```

In three browser profiles / tabs:

1. Log in as the ADMIN account. Navigate to `/admin/scan`.
2. Pick a concert.
3. Click "Włącz skaner". Grant camera permission. Point the camera at a QR
   printed from a Plan 06 PDF.

Expected: green banner, holder name visible, counter increments.

Then:

- Scan the same QR a second time → amber "Już wykorzystany" with the
  original time and admin name.
- Open a second scanner tab in a different browser profile. Point both at
  the same QR of a NEW ticket. Expected: exactly one green, one amber. (This
  is the live concurrency test; the automated version is Task 2 Step 3 case
  8.)
- Scan a QR from a ticket for a different concert → red "Nie na ten koncert"
  with the correct concert title.
- Scan a QR from a REFUNDED order's ticket → red "Bilet nieważny".
- Type garbage into the manual entry → red "Nie znaleziono".
- Deny camera permission → the manual-entry section stays usable; the
  camera button shows "Brak dostępu do kamery".

**Document the results in `plan/07-manual-test.md`** (Task 7 writes the file).

- [ ] **Step 5: Gate**

Expected: typecheck/lint/build/test all green. The new page compiles but has
no automated test coverage of its own.

---

## Task 6: Admitted-tickets list (scanner-reachable)

Owner decision 26 Oct 2026: SCANNER role **must** be able to see which
tickets have already been admitted for the event they are working. Needed
for duplicate detection, re-entry decisions, and the plain operational
question "did my colleague already let this group in?". **Guarded by
`requireStaff()`, not `requireAdmin()`**, with a strict allow-list of
door-staff-only fields.

The page has two tabs. Only the first is scanner-visible:

- **Wejścia (admissions)** — the list of USED tickets, ordered by `usedAt`
  DESC. `requireStaff()`. Reads from the `Ticket` table joined to its
  event, with the scanning admin's name joined via `usedByAdminId`.
  **No `AuditLog` query here** — using the Ticket table keeps the data
  shape tight, and admissions are already the Ticket rows with
  `status = 'USED'`.
- **Próby (all scan attempts, incl. failures)** — the full audit stream
  including NOT_FOUND, MALFORMED, WRONG_EVENT, REVOKED. `requireAdmin()`.
  Reads from `AuditLog`. ADMIN-only because an unredacted attempt log
  would show door staff every malformed/guessed code tried against the
  system — one of the few places a code-existence oracle risk resurfaces.

Separation makes the privacy boundary mechanical: a SCANNER session
never queries `AuditLog`.

**Files:**
- New: `src/app/(admin)/admin/events/[id]/scans/page.tsx`
- New: `src/lib/server/scan-list.ts` (two query functions)
- Modify: `src/app/(admin)/admin/scan/page.tsx` (link from the scanner UI)
- Possible modify: `src/app/(admin)/admin/events/[id]/page.tsx` (admin-side
  nav link; this page is `requireAdmin` so the link is naturally hidden
  from scanners)
- New: `tests/lib/server/scan-list.test.ts`

- [ ] **Step 1: Write `src/lib/server/scan-list.ts`**

Two separate functions so authorisation branches at the call site, not
inside a parameter:

```ts
import 'server-only'

export type AdmittedTicketRow = {
  code: string            // last 6 chars only — see note
  holderName: string | null
  ticketTypeLabel: string // "Bilet normalny" / "Bilet ulgowy" — Plan 08 adds
                          // the label; today render `""` and show nothing
  usedAt: Date
  usedByName: string | null
}

export async function listAdmittedTickets(eventId: string): Promise<AdmittedTicketRow[]>

export type ScanAttemptRow = {
  at: Date
  action: string          // 'ticket.scan.valid' | '.alreadyUsed' | '.revoked' | '.wrongEvent' | '.notFound' | '.malformed'
  actorName: string | null
  codeSuffix: string | null  // from meta.codeSuffix (Task 2's audit)
  holderName: string | null  // only present for actions that found a ticket
}

export async function listScanAttempts(eventId: string): Promise<ScanAttemptRow[]>
```

Rules:

- `listAdmittedTickets`: `db.ticket.findMany({ where: { eventId, status: 'USED' },
  select: { code: true, holderName: true, usedAt: true,
  usedByAdmin: { select: { name: true } } }, orderBy: { usedAt: 'desc' },
  take: 500 })`. **Trim `code` to its last 6 characters** before returning
  — door staff do not need a working credential, and a page viewed over a
  volunteer's shoulder must not leak one. The code's full form stays
  inside the DB and the scanner's own flow.
- `listScanAttempts`: `db.auditLog.findMany({ where: { entityType: 'Ticket',
  action: { in: ['ticket.scan.valid', '.alreadyUsed', '.revoked',
  '.wrongEvent', '.notFound', '.malformed'] }, meta: { path: ['eventId'],
  equals: eventId } }, select: { createdAt, action, actor: { select: { name } },
  meta: true }, orderBy: { createdAt: 'desc' }, take: 500 })`. Reads
  `codeSuffix` and `holderName` out of `meta` (Task 2 writes them). To
  make the `meta.eventId` lookup work, Task 2 Step 1 must include
  `eventId` in the audit `meta` — add that to the audit spec there if it
  is not already present.

**Never leak buyer PII.** Neither function selects:
- `Order.email`
- `Order.phone`
- `Order.firstName` / `Order.lastName` (the buyer; `Ticket.holderName` is
  the per-ticket attendee and is intentionally shown)
- `Order.total`, `Order.subtotal`, `Order.companyName`, `Order.nip`,
  `Order.invoiceAddress`
- `Order.reference` (knowing the reference and an access token would be a
  path to the order page, so withholding the reference from door staff
  is defence-in-depth — admins reach it from the orders list in Plan 08)

- [ ] **Step 2: Write the Server Component page**

```ts
// src/app/(admin)/admin/events/[id]/scans/page.tsx
import { requireStaff, requireAdmin, getCurrentAdmin } from '@/lib/server/auth'
```

Flow:

1. `const admin = await requireStaff()` — redirects to login if no
   session; passes for both ADMIN and SCANNER.
2. Load the event by id (title + startsAt only).
3. Load `listAdmittedTickets(eventId)` — always.
4. If `admin.role === 'ADMIN'`: also load `listScanAttempts(eventId)` and
   render a second "Próby" tab. **If `admin.role === 'SCANNER'`, do NOT
   call `listScanAttempts`** — the function is `requireAdmin`-gated at
   the call site by this exact branch, so a SCANNER session cannot
   trigger the query under any execution path.
5. Render the admissions tab for everyone:
   - Columns: `usedAt (HH:mm:ss)` · `holderName` · `ticketType` ·
     `code (last 6)` · `scannedBy`.
   - A running count in the header: "Wpuszczonych: {n} / {capacity}".
   - A text filter that narrows client-side on `holderName` substring
     (no server round-trip; the list is already capped at 500).
   - Mobile-first styling — a scanner on a phone opens this between
     scans.

- [ ] **Step 3: Add i18n keys** (Polish-only; `/admin` is Polish per Plan 01)

The admin area has no next-intl at all — the pages render Polish strings
inline. Follow the pattern of `src/app/(admin)/admin/events/[id]/page.tsx`.
Hard-code: "Wejścia", "Próby", "Wpuszczonych", "Filtruj", "Wpuścił",
"Imię i nazwisko", "Kod", "Czas", "Typ biletu", "Brak wejść — jeszcze
nikt nie zeskanował biletu na ten koncert." Short glossary at the top of
the file for the executor to reuse.

- [ ] **Step 4: Link from `/admin/scan`**

In `src/app/(admin)/admin/scan/page.tsx` (Task 5), add a header link
"Zobacz wpuszczone" that points at `/admin/events/<selectedEventId>/scans`.
Only visible after the scanner has picked an event — before that there
is no sensible target.

- [ ] **Step 5: Admin-side nav link**

In `src/app/(admin)/admin/events/[id]/page.tsx` (which is `requireAdmin`),
add a nav link "Wejścia i próby" to the same page. ADMIN sees both tabs;
SCANNER never reaches this page (it is admin-only), so the link's
visibility is naturally correct.

- [ ] **Step 6: Write `tests/lib/server/scan-list.test.ts`**

Eight cases:

1. `listAdmittedTickets` on an event with 3 USED tickets → 3 rows,
   ordered by `usedAt` DESC.
2. Row's `code` field is exactly 6 characters (regression against a
   future refactor adding the full code back).
3. VALID or REVOKED tickets do NOT appear in the admitted list.
4. `listAdmittedTickets` does not query `Order` (spy on
   `db.order.findMany` and friends — expect 0 calls). The buyer-PII
   containment is a property of the query, not of the view.
5. `listScanAttempts` returns audit rows for all six actions, filtered
   to the event via `meta.eventId`.
6. `listScanAttempts` on a different event's id returns zero rows (the
   `meta.eventId` filter is load-bearing — a bug there would reveal
   cross-event scan data).
7. A SCANNER-role call pathway (simulated by directly importing
   `listAdmittedTickets` and asserting it never selects the fields in
   the forbidden list). Done by inspecting the generated SQL via a
   `$queryRaw` interception — or more simply, by reading the function's
   `select` object at runtime (it's a Prisma object, inspectable).
8. Rows capped at 500 even when 1000 USED tickets exist.

```bash
pnpm test scan-list && pnpm test scan-list
```

Expected: 8 tests pass **twice**.

- [ ] **Step 7: Manual check (two accounts)**

```bash
pnpm dev
```

As the ADMIN account:
- Navigate to `/admin/events/<some-event-id>/scans` → both tabs render.
- The "Próby" tab shows failed scans from Task 5's manual tests.

As the SCANNER account:
- Log in; land on `/admin/scan`.
- Pick an event, scan a ticket → counter updates.
- Click "Zobacz wpuszczone" in the scanner header →
  `/admin/events/<id>/scans` renders. **Only the admissions tab is
  present** — the "Próby" tab is absent from the DOM.
- Attempt `/admin/events/<id>` directly as the SCANNER →
  redirect to `/admin/scan` (the existing `requireAdmin` behaviour at
  `src/lib/server/auth.ts:52`).
- Open DevTools, inspect the admissions table: no `Order.email`,
  `total`, `reference` fields present. Only the allow-list.

- [ ] **Step 8: Gate**

---

## Task 7: Documentation and manual walkthrough

**Files:**
- New: `plan/07-manual-test.md`
- Modify: `plan/STATUS.md`
- Modify: `plan/README.md`
- Modify: `/CLAUDE.md` traps (if new ones found)

- [ ] **Step 1: Write `plan/07-manual-test.md`**

Checklist in the shape of `plan/05-manual-test.md`:

| # | Scenario | Steps | Expected |
|---|---|---|---|
| A | Happy scan | Scan a valid QR | Green banner, counter admitted +=1 |
| B | Double scan | Scan A again | Amber with original time |
| C | Concurrent double scan | Two devices, same QR | Exactly one green |
| D | Wrong concert | Scan tomorrow's QR tonight | Red "Nie na ten koncert" |
| E | Revoked | Refund order, scan | Red "Bilet nieważny" |
| F | Not found | Type random Crockford into manual entry | Red "Nie znaleziono" |
| G | Malformed | Type `i-am-not-a-code` | Red "Nie znaleziono" (same copy, no server round-trip) |
| H | Camera denied | Deny permission | Manual entry still works |
| I | Rate limit | 301 scans in a minute | 429 banner |
| J | SCANNER sees admissions | Log in as SCANNER → scan a few → tap "Zobacz wpuszczone" | `/admin/events/<id>/scans` renders the admissions tab only; no "Próby" tab in the DOM; holder names present; no email, no total, no reference. |
| K | ADMIN sees both tabs | Log in as ADMIN → `/admin/events/<id>/scans` | Admissions + Próby tabs both render. Próby includes NOT_FOUND / MALFORMED / WRONG_EVENT entries from this walkthrough. |
| L | SCANNER cannot reach the attempts tab by URL | While logged in as SCANNER, try `/admin/events/<id>/scans?tab=attempts` (or whatever querystring the page uses) | The admissions tab renders; the attempts data is not in the response (the SCANNER branch never calls `listScanAttempts`). Verify in DevTools Network that the response is scanner-sized, not attempt-sized. |
| M | SCANNER cannot reach `/admin/events/<id>` | While logged in as SCANNER, open the URL directly | Redirect to `/admin/scan` — unchanged `requireAdmin` behaviour. |

- [ ] **Step 2: Update `plan/STATUS.md` → "Next"**

Replace Plan 06 completion details with a short "Plan 06 + 07 complete"
summary and point "Next" at Plan 08 (Money out) or Plan 09 (Launch).

- [ ] **Step 3: Update `plan/README.md`**

Mark Plan 07 complete.

- [ ] **Step 4: Full gate from a clean tree**

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm test
```

Expected: exit 0 both runs.

---

## Definition of done

- A staff member logs into `/admin/scan` on a phone, picks a concert, scans
  a QR, and sees green with the holder name.
- A second scan of the same QR shows amber with the original scan time and
  the admin who scanned first.
- Two devices scanning the same QR within one second each show exactly one
  green and one amber, in any ordering of the two reports.
- A QR for a different concert shows red "Nie na ten koncert" with the
  correct concert title.
- A QR for a REFUNDED order shows red "Bilet nieważny".
- An unknown code and a malformed code both show the same red "Nie znaleziono"
  banner, with no code-existence oracle.
- Opening `/t/<code>` as any visitor (including the buyer) never changes
  the ticket's state — Plan 06 invariant preserved; add a regression test
  in `tests/lib/server/ticket-lookup.test.ts` if one is missing (Plan 06
  Task 6 Step 2 covered this; verify).
- All scans — successful or not — generate an `AuditLog` row with
  `meta.eventId` and `meta.codeSuffix` (last 6 chars only; never the full
  code).
- A SCANNER logs into `/admin/scan`, picks an event, scans a few tickets,
  taps "Zobacz wpuszczone", and sees the admissions list for that event
  with holder names and admission times — but no buyer e-mails, totals or
  references. The attempts tab is absent for that role.
- An ADMIN visits `/admin/events/[id]/scans` and sees both the admissions
  tab and an attempts tab with NOT_FOUND / MALFORMED / WRONG_EVENT /
  REVOKED entries.
- Rate limit of 300/admin/min and 600/ip/min enforced.
- Gate green from a clean tree **twice**.
- `plan/STATUS.md`, `plan/README.md`, `plan/07-manual-test.md` updated.
- **No commits by the executor.**

---

## Risks and traps the executor should expect

- **The atomic UPDATE is the only lock.** Resist the urge to prefix a
  `SELECT ... FOR UPDATE`. The `WHERE status = 'VALID'` IS the race
  arbiter, and adding a prior SELECT widens the window.
- **The second SELECT must not UPDATE.** If a well-meaning refactor merges
  the classify-and-mutate into one path, re-add the ABBA-style
  WRONG_EVENT race. Keep classification purely read-only.
- **Camera needs HTTPS.** Localhost is treated as secure; Vercel is HTTPS.
  A deploy preview that somehow resolves over HTTP breaks the scanner —
  verify Vercel preview URLs are `https://` before accepting the demo.
- **`navigator.vibrate` is unsupported on iOS Safari** at the time of
  writing. Guard with `if ('vibrate' in navigator) navigator.vibrate(...)`.
  Not fatal — the audio tone still fires.
- **WebAudio needs a user gesture to start on iOS.** The AudioContext must
  be created inside the camera-start button's click handler, not at module
  scope. If it is created too early, the first tone silently never plays
  and staff think the scanner is broken.
- **Session cookie is `/admin`-scoped.** Verified above that
  `cookies().get()` reads it regardless of request path, so
  `/api/admin/scan` works, but the exact invariant is non-obvious — the
  regression test added in Task 2 Step 1 is load-bearing.
- **Tests are Node-env, no DOM.** The page, the camera handling, and the
  WebAudio tones have NO automated test coverage. Every pure function they
  depend on (`scanTicket`, `viewForResult`, the atomic SQL) IS tested, and
  the UI itself is verified manually (Task 5 Step 4 and Task 7).
- **`import 'server-only'` throws under Vitest and tsx.** The scanner page
  is a Client Component so it imports `ScanResult` from the shared file,
  not from `scanner.ts`.
- **A SCANNER account can see `/admin/scan` AND `/admin/events/[id]/scans`,
  nothing else.** The former is the camera; the latter is the admissions
  list (admissions only — not every attempt). `login/actions.ts:32` and
  `auth.ts:52` still redirect SCANNER sessions away from
  `/admin/events/[id]` itself, and Task 6's split means the attempts tab
  is `requireAdmin`. Owner decision 26 Oct 2026: a volunteer legitimately
  needs the admissions list for duplicate detection and re-entry judgement;
  withholding it reinvents walkie-talkies.
- **The scanner's admissions list exposes `holderName`, nothing more
  sensitive.** No `Order.email`, no `Order.total`, no `Order.reference`.
  Task 6 Step 1 enumerates the allow-list; a future `select` extension that
  adds a buyer field must be caught by Task 6 Step 6 case 4 (which
  explicitly asserts those queries never run).
- **`meta.codeSuffix`, never `code` in full.** Audit log and admissions
  view both show the last six characters. The full code lives only in the
  Ticket table and the scanner's live POST; a leaked audit log must not
  be a leaked bearer credential.
- **`AuditLog.meta` is `Json?`.** Store the scanned code's **last 6
  characters** in `meta.codeSuffix`, not the full code. The full code appears
  in `entityId` (unique) but keeping the audit log privacy-tight means
  grepping it does not leak a working ticket.
- **Rate limiting is in-memory and per-instance.** On Vercel, two
  simultaneous requests can land on two instances and effectively double
  the limit. Plan 08 is the right place to introduce a shared store if the
  concert sees enough traffic to matter — note it in Findings if it does.
- **The `.env` file is git-ignored.** No new env var is introduced in this
  plan, but if the executor introduces one (e.g. to turn on a staging
  scanner mode), it must land in `.env.example` and `.env.test` in the
  same task — Plan 05's `CRON_SECRET` miss is the precedent.
- **Camera selection on dual-camera phones.** The design doc specifies
  `facingMode: 'environment'`. Some Android phones expose two environment
  cameras (standard + wide/telephoto); zxing picks one and the user cannot
  swap. If this bites in Task 5 Step 4, add a camera-picker dropdown
  (`enumerateDevices` → `videoinput` list) — one of the known camera traps
  from the design doc.

---

## Appendix — files touched

Created:

- `src/lib/server/scanner.ts`
- `src/lib/server/scan-list.ts`
- `src/lib/shared/scan-result.ts`
- `src/lib/shared/scan-view.ts`
- `src/lib/shared/ticket-code.ts` (if Plan 06 did not already move it)
- `src/app/api/admin/scan/route.ts`
- `src/app/(admin)/admin/scan/page.tsx`
- `src/app/(admin)/admin/scan/ScannerClient.tsx`
- `src/app/(admin)/admin/scan/EventPicker.tsx`
- `src/app/(admin)/admin/events/[id]/scans/page.tsx`
- `tests/lib/server/scanner.test.ts`
- `tests/lib/server/scan-list.test.ts`
- `tests/app/api/admin-scan.test.ts`
- `tests/lib/shared/scan-view.test.ts`
- `plan/07-manual-test.md`

Modified:

- `package.json` (deps + lockfile)
- `src/app/(admin)/admin/events/[id]/page.tsx` (link to scans)
- `src/messages/pl.json`, `en.json`, `de.json` (new `scan` keys)
- `plan/STATUS.md`
- `plan/README.md`
- `plan/00-decisions.md` (versions table entry for `@zxing/*`)
- `/CLAUDE.md` (append new recurring trap, if any)

No migration. No change to `prisma/schema.prisma`.
