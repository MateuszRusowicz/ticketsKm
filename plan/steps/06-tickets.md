# Plan 06 — Tickets (issuance, PDF, QR, web page)

**Goal:** every `PAID` order carries scannable tickets. A buyer sees "Pobierz
bilety" on the paid confirmation page and receives a single PDF with one page
per ticket, each page carrying a QR code that resolves to a public web ticket
at `https://<host>/t/<code>`. The public page shows the ticket's state (VALID /
USED / REVOKED) and the same QR, so the ticket survives a lost attachment and
reads correctly on a cracked phone screen in a dark foyer. **Opening the public
page NEVER marks the ticket used** — only the authenticated scan endpoint
does, and that endpoint is Plan 07.

**What this plan does NOT ship** (explicitly):
- The door scanner (`/admin/scan`, `/api/admin/scan`) — Plan 07.
- Ticket email through Resend. Delivery goes through "download from the order
  confirmation page" instead. The code path has a clearly-marked seam
  (`emailFulfilledOrder(orderId)`) that stays a no-op until Plan 08 wires
  Resend and DNS. See [Design decision — no email yet](#design-decision--no-email-yet).
- Invitations, promo codes, staff-initiated refunds — Plan 08.
- Apple/Google Wallet passes — future.

**Architecture:**

- **Ticket rows are already created inside `fulfilOrder`** (`src/lib/server/orders.ts:632`),
  with a 128-bit random `code` in Crockford base32 (`src/lib/server/orders.ts:400`).
  Nothing in this plan touches the fulfilment transaction — all PDF/QR work
  happens AFTER the transaction commits, on-demand when the buyer requests the
  download, and the generated artefact is never stored.
- **One PDF per ticket**, not one PDF per order (owner decision, 26 Oct 2026).
  A buyer attending with three people must be able to forward one ticket to
  one person. The order confirmation page lists every ticket with its own
  "Pobierz PDF" and "Otwórz w przeglądarce" links.
- **The ticket code is a bearer credential.** The `/t/<code>` page already
  shows the QR and holder name; the per-ticket PDF uses the same credential,
  reachable at `/t/<code>/pdf`. Anyone with the code can view and download
  the ticket, by design — that is the forwarding story. The 128 bits of
  randomness make the code impossible to guess at any realistic rate.
- **PDF generation is pure JavaScript** via `pdf-lib` + `@pdf-lib/fontkit` with
  an embedded TTF carrying latin-ext. Headless Chrome is explicitly ruled out
  by `plan/00-decisions.md` ("Docker portability implies no headless Chrome").
- **QR generation is pure JavaScript** via `qrcode` — produces a PNG buffer
  (for the PDF) and an SVG string (for the web ticket). High error correction
  (`correctLevel: 'H'`), generous `margin: 4`, no background image behind it
  (`06-i18n-email-pdf.md` constraints).
- **Public ticket page `/t/<code>`** is a Server Component outside the locale
  group. `proxy.ts:12` already excludes `/t` from locale rewrites (the first-
  segment exclusion covers everything under `/t/…`, including `/t/<code>/pdf`),
  so the URL stays stable forever — a QR printed today must scan tomorrow
  regardless of future routing changes. Rendered with `dynamic =
  'force-dynamic'` and `Cache-Control: private, no-store` so a REVOKED ticket
  cannot be served from a CDN edge after refund.
- **The PDF download URL is `/t/<code>/pdf`** (same bearer credential as the
  web view). The Route Handler at `src/app/t/[code]/pdf/route.ts` streams the
  PDF with `Content-Disposition: attachment; filename="ticket-<code6>.pdf"`
  and the same `Cache-Control: private, no-store` as the public page.
  Rate-limited per IP identically to the public page.
- **Pure-function split for the Node test environment.** Vitest is
  `environment: 'node'`, no DOM, so **nothing is tested through a rendered
  component.** PDF content, QR encoding, holder-name truncation and the public
  ticket's state mapping are all written as pure functions in
  `src/lib/shared/` or `src/lib/server/` and tested as `.test.ts`.

**Spec:** [`../06-i18n-email-pdf.md`](../06-i18n-email-pdf.md) (§ "The PDF
ticket", § "The web ticket"); [`../05-admin-and-scanner.md`](../05-admin-and-scanner.md)
(§ "The door scanner" — QR payload URL only; scan handling is Plan 07);
[`../00-decisions.md`](../00-decisions.md) (versions table — pdf-lib + QR
versions are set here).

**Depends on:** Plan 05 in full. `Ticket` rows and codes already come out of
`fulfilOrder`; the schema fields (`emailSentAt`, `Order.accessToken`,
`Ticket.code`, `Ticket.status`, `Ticket.holderName`) all exist (verified
against `prisma/schema.prisma`). No migration is needed.

**Verification gate** (from `/CLAUDE.md`), from a **clean tree**:

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Every task ends with it. Run `pnpm test` **twice** when a task adds a test
asserting an exact row or `Ticket` count — files share one Postgres and run
sequentially.

> **Written 26 October 2026** against the repo as it stood that day
> (commit `a2aa23a`, suite 48 files / 445 tests from `plan/STATUS.md`). Every
> claim about `src/`, `prisma/`, `tests/`, `package.json`, `vitest.config.mts`,
> `eslint.config.mjs` and `proxy.ts` was verified by reading the file. The
> Findings log below is empty **by design** — executors append to it when
> reality disagrees with the plan, in the same turn the discovery is made.

---

## Findings log

Appended **as things are discovered**, not at the end. Each row says what the
plan assumed, what was actually true, and which task was corrected. Add
anything that outlives this plan to the traps list in `/CLAUDE.md` — this file
is only read when someone remembers to.

| Date | Finding | Action |
|---|---|---|
| 26 Oct 2026 (owner decision) | **Per-ticket PDFs, not one-per-order.** Owner: "osobny kod na każdy bilet" — each ticket is independently downloadable so a buyer can forward one ticket to one person. The all-in-one order PDF is dropped unless it falls out for free (it does not — generating N tickets as separate PDFs is strictly less code than generating one PDF with N pages and keeping the single-PDF code path too). | Architecture rewritten (per-ticket PDFs). Task 5 renamed `renderTicketsPdf` → `renderTicketPdf` (singular). Task 7's download route moved from `/{locale}/order/<ref>/tickets.pdf?t=…` to `/t/<code>/pdf` — the code is the bearer credential, same as the `/t/<code>` web page. Task 8's paid-band UI lists every ticket with its own "Pobierz PDF" + "Bilet w przeglądarce" links. |
| 26 Oct 2026 (owner decision) | **Email seam stays no-op in Plan 06.** Resend + DNS are still blocked (`STATUS.md`); the download button on the confirmation page is the delivery path until Plan 08 wires email. | Confirmed; Task 9 unchanged. |
| 26 Oct 2026 (verified) | **`proxy.ts:12` matcher** `/((?!api|admin|t|_next|_vercel|.*\\..*).*)` excludes anything whose first segment is `t`, so `/t/<code>/pdf` is excluded from locale rewriting without needing the dot-rule. Keeps the URL stable forever and leaves room for future `/t/<code>/<action>` paths. | Chose `/t/<code>/pdf` over `/t/<code>.pdf`. Written into Task 7. |
| 27 Oct 2026 | **`subset: true` is essential for the size constraint.** Without it `pdf-lib` embeds the entire Noto Sans font (~950KB per weight) into the PDF — a 500KB+ output that blows the 200KB target. With `subset: true`, only the glyphs actually drawn are embedded; the result is ~50KB. Set on both `embedFont` calls in `ticket-pdf.ts`. | Added `{ subset: true }` to both `doc.embedFont(...)` calls. |
| 27 Oct 2026 | **`/t/*` subtree needs its own root layout.** Next.js App Router requires a `layout.tsx` at each new layout boundary. The `/t` path is outside both the `(shop)` and `(admin)` route-group layouts; without its own layout the build fails with "No root layout found". | Added `src/app/t/layout.tsx` with `<html lang="pl">` and the app's global CSS and font variables. |
| 27 Oct 2026 | **Inline i18n on the `/t/<code>` page, not next-intl.** The page is outside the locale route group and has no locale URL segment; the display language must come from the ticket's `orderLocale`, not the URL. next-intl's `useTranslations` hooks are unavailable here. | Used an inline `LABELS` record keyed by locale (`pl`/`en`/`de`) inside the server component and in `ticket-pdf.ts`. |
| 27 Oct 2026 | **`QRCodeRenderersOptions` not `QRCodeOptions`.** TypeScript error: `margin` and `color` are not in `QRCodeOptions`; they live in `QRCodeRenderersOptions`, which is the type for `toBuffer` / `toString`. | Changed the type annotation in `qr.ts` to `QRCode.QRCodeRenderersOptions`. |
| 27 Oct 2026 | **`new Uint8Array(pdfBuffer)` in Route Handler body.** Next.js 16 accepts `BodyInit` as the `Response` body; `Buffer<ArrayBufferLike>` is not assignable because `Buffer` extends `Uint8Array` but TypeScript does not widen the type automatically in this context. | Wrapped the buffer: `new Response(new Uint8Array(pdfBuffer), ...)`. |
| 27 Oct 2026 | **`'fulfilled' in result && result.fulfilled` for discriminated-union narrowing.** `FulfilResult` is a union where only some arms carry `fulfilled: true`; plain `result.fulfilled` is a TypeScript error because the property does not exist on all union members. The `in` guard narrows the type first. | Applied in `webhook-dispatch.ts` success path. |
| 27 Oct 2026 | **Font download URL.** GitHub raw redirect for individual TTF files returns 9 bytes (an HTML redirect page), not the font. Must download the release zip and extract. Used `NotoSans-v2.015.zip` from the notofonts/latin-greek-cyrillic GitHub release. | Documented; fonts are in `src/assets/fonts/` at ~431KB each. |
| 27 Oct 2026 | **Rate-limit test timeout.** Generating 20 PDFs sequentially at ~300ms each exceeds Vitest's 5s default timeout. | Added `{ timeout: 60_000 }` to the rate-limit test case in `ticket-pdf-route.test.ts`. |
| 27 Oct 2026 | **Final gate:** 489 tests + 2 todo across 55 files, exit 0 twice from a clean tree (`rm -rf .next next-env.d.ts tsconfig.tsbuildinfo; pnpm typecheck && pnpm lint && pnpm test && pnpm build`). Build shows `/t/[code]` (ƒ) and `/t/[code]/pdf` (ƒ). | Plan 06 complete. |
| 27 Oct 2026 | **Order-dependent test failure (pre-existing, Plan 04).** A cold-cache run (`node_modules/.vite` removed) failed 4 `orders.test.ts` dedupe cases with `Unique constraint failed on (reference)`. `order-reference.test.ts` restarts `order_reference_seq` without truncating `Order`, and `orders.test.ts` never truncated, so leftover orders collided with new references whenever Vitest scheduled the two files in that order. Plan 06's new test files changed the cold-cache schedule and exposed it; warm runs passed. | `orders.test.ts` gained a `beforeAll` that truncates the order tables and restarts the sequence, matching the other DB-backed files. Verified with three cold-cache runs. |

*(Executors: append rows here in the same turn a discovery is made, not at the end of the task.)*

---

## Global Constraints

- **Opening `/t/<code>` never mutates ticket state.** Only Plan 07's scan
  endpoint does. This is a product invariant, not a code smell — a buyer who
  opens their own QR on the way to the venue must not burn their own ticket.
- **Ticket codes are already 128-bit random Crockford base32 (26 characters)**,
  generated inside `fulfilOrder` by `ticketCode()` at `orders.ts:400`. Do not
  re-roll the format. The alphabet omits I, L, O, U so a human reading one off
  a damaged QR into the manual-entry field is less likely to transpose.
- **The QR payload is a URL to the public page**
  (`https://<host>/t/<code>`), never a bare code. Rationale from
  `05-admin-and-scanner.md`: a buyer's own camera opens the page; the scanner
  is a separate authenticated path.
- **PDFs are generated on demand, never stored.** They can always be
  regenerated from `Order` + `Ticket` rows, so persistence is pure cost. This
  also means `Order.emailSentAt` is reserved for the real email flow (Plan 08);
  do not repurpose it for "download count".
- **Money is integer minor units.** Already-formatted strings go through
  `formatMoney` at the edge; the PDF never calls Prisma itself.
- **PDF fonts must carry latin-ext.** `pdf-lib`'s StandardFonts (Helvetica,
  Times) do NOT — a name like `Małgorzata Świętosławska` renders as mojibake,
  and a wrong name at the door is worse than no name because staff trust it.
  Embed Noto Sans (regular + bold) via `@pdf-lib/fontkit` and keep the file
  under `src/assets/fonts/`.
- **The holder name needs trim + length cap + ellipsis truncation**, per
  `06-i18n-email-pdf.md`. Pure function; test the layout rule without
  rendering a PDF.
- **The public ticket page is `dynamic = 'force-dynamic'`,
  `Cache-Control: private, no-store`.** State can change (REVOKED after a
  refund), and the page carries holder name — never cache at the edge.
- **The PDF route is `Content-Disposition: attachment` with a stable
  filename:** `tickets-<reference>.pdf`. Not inline — some mobile browsers
  render PDFs in-browser with no download affordance, which defeats the point
  of "a PDF the buyer can keep".
- **Nothing under `src/components/` may import from `@/lib/server/*`.**
  Already enforced by `eslint.config.mjs` with no `allowTypeImports` escape.
  Shared types go in `src/lib/shared/`.
- **Tests are Node-environment with no DOM.** Nothing in this plan tests a
  rendered page. Where UI exists (the download button on the order
  confirmation, the public ticket page), its logic lives in a pure function
  and that function is tested.
- **Commits are made by the human operator.**

---

## Design decision — no email yet

Plan 05 deliberately deferred ticket email, PDF and QR codes
([`STATUS.md`](../STATUS.md), "Deliberately outside the demo"). The reason
email is still deferred here, even though PDF+QR arrive now, is operational:

- **Resend requires SPF/DKIM/DMARC on the sending domain**, which requires
  DNS access, which is the longest-lead-time outstanding item (`00-decisions.md`
  § "Open questions carried over"). Until DNS lands, sending anything to real
  buyer inboxes risks landing in spam under an unverified domain — a ticket
  that lands in spam is a ticket that doesn't exist.
- **The order confirmation page carries the download button**, so the buyer
  reaches a working PDF before leaving `tickets-km.vercel.app`. This is a
  deliberate downgrade from the design document's "PDF *and* a web link" email,
  not a bug — the web link is still there (`/t/<code>` per ticket, printed on
  the PDF and shown on the confirmation page).

**The seam this leaves:** `emailFulfilledOrder(orderId)` is a server-only
function with the signature email will eventually need. It currently returns
`{ sent: false, reason: 'disabled' }` and writes nothing. It is called from
`fulfilOrder` immediately after the Prisma transaction commits (not inside it
— no Resend-network-inside-DB-transaction) and guarded by
`Order.emailSentAt IS NULL`. When Plan 08 wires Resend, only this one function
changes.

**Open question for the owner, flagged in Task 10:** whether to also expose
the download link from a plain-text "we have your order" email through
Resend's transactional domain *before* DNS lands. Recommendation: no, because
even unverified transactional email trains Gmail's reputation on the wrong
From-address.

---

## Task 0: Baseline gate

Verify Plan 05's landing state before touching anything.

> **Every command in this plan needs Node on the PATH.** `~/.bashrc` returns
> early for non-interactive shells, so nvm never runs and `pnpm` is not found
> (exit 127). Prefix each shell session:
>
> ```bash
> export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
> ```

- [ ] **Step 1: Clean tree on a fresh branch cut from `development`**

```bash
git status && git branch --show-current
git checkout development && git pull --ff-only
git checkout -b feat/plan-06-tickets
```

Expected: `development` fast-forwarded to `origin/development`, new branch
created, `git status` reports clean.

- [ ] **Step 2: Docker Postgres up, migrations applied, seed**

```bash
docker compose up -d
pnpm exec dotenv -e .env -- prisma migrate deploy
pnpm db:seed
```

Expected: `Seeded 2 venues, 11 concerts, 2 admin accounts.` and
`Orders in database: N.` for some `N >= 0`.

- [ ] **Step 3: Clean-tree gate green as Plan 05 landed**

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: `Test Files 48 passed (48)`, `Tests 445 passed (445)` (from
`STATUS.md`). Record the number in a Findings-log row — later tasks assert on
*delta*, not absolute, so a drift here is interesting.

- [ ] **Step 4: Confirm `fulfilOrder` is already creating `Ticket` rows end to end**

Not a code change — a sanity check against a real order so the executor is not
designing against a mental model.

```bash
pnpm db:seed
pnpm exec tsx -e "import('./src/lib/server/db').then(async ({db})=>{const t=await db.ticket.count();const o=await db.order.count({where:{status:'PAID'}});console.log(JSON.stringify({tickets:t,paidOrders:o}));process.exit(0)})"
```

Expected: `{"tickets": N, "paidOrders": M}` for some `N >= 0, M >= 0`. If `N > 0`,
also check one row has `code`, `holderName`, `status: 'VALID'`:

```bash
pnpm exec tsx -e "import('./src/lib/server/db').then(async ({db})=>{const t=await db.ticket.findFirst();console.log(JSON.stringify(t));process.exit(0)})"
```

Record what you see (code length, alphabet, holderName presence). This is the
input for every later task in the plan.

---

## Task 1: Install dependencies

Four new packages, pinned.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install `pdf-lib`, `@pdf-lib/fontkit`, `qrcode`**

```bash
pnpm add pdf-lib @pdf-lib/fontkit qrcode
pnpm add -D @types/qrcode
```

Expected: all four added to `package.json`, exact versions written to
`pnpm-lock.yaml`. Record the resolved versions in `00-decisions.md`'s versions
table in the same step — the table is the source of truth, and Plan 05's
findings log has multiple entries where a plan assumed a version that was not
what pnpm actually installed.

- [ ] **Step 2: Verify no transitive native dependency**

The project is Docker-portable; a build that pulls in `canvas`, `sharp` or a
`node-gyp`-compiled native module breaks Vercel's `nodejs` runtime assumption
and the Docker image.

```bash
pnpm why canvas sharp node-gyp 2>&1 | head -40
```

Expected: all three print "canvas (not found)" (or similar) or report only as
dev-only transitive dependencies of other dev-only packages. If any of them
is a runtime dependency of `pdf-lib` or `qrcode`, stop and record which — the
plan picked these libraries specifically because they are pure JavaScript.

- [ ] **Step 3: Add Noto Sans TTF (regular + bold) under `src/assets/fonts/`**

Required for latin-ext. Download from Google Fonts' GitHub mirror
(`https://github.com/notofonts/latin-greek-cyrillic/releases/`), subset to
latin + latin-ext (Polish) and keep only the two weights the PDF needs:

```bash
mkdir -p src/assets/fonts
# Owner or executor downloads NotoSans-Regular.ttf and NotoSans-Bold.ttf
# into src/assets/fonts/. Record SHA256 of each file in this step for
# reproducibility.
sha256sum src/assets/fonts/NotoSans-Regular.ttf src/assets/fonts/NotoSans-Bold.ttf
```

Expected: both files exist, each < 500KB after subsetting, SHA256 recorded.

**Trap:** Vercel's bundle size limit for a Serverless Function is 50 MB (uncompressed);
two full Noto Sans TTFs are ~500KB each unsubsetted. Keep them subset.

**Alternative, flagged:** use `fontkit`'s dynamic font load from a CDN at
request time — rejected because Docker portability requires no runtime
network dependency for a core feature.

- [ ] **Step 4: Gate**

Same as Task 0 Step 3. No code change should make tests fail yet.

Expected: 445 tests still green.

---

## Task 2: Ticket-code uniqueness guarantees

`ticketCode()` already exists at `orders.ts:400` and generates 128 bits of
randomness. It is called inside the fulfilment transaction, so the one risk
is a collision across concurrent fulfilments — unlikely at 2^-128 per code,
but worth belt-and-braces because `Ticket.code` is `@unique` and a collision
would throw inside the transaction and roll back a legitimate fulfilment.

**Files:**
- New: `tests/lib/server/ticket-code.test.ts`
- No code changes expected.

- [ ] **Step 1: Write collision and alphabet tests**

```bash
mkdir -p tests/lib/server
# write tests/lib/server/ticket-code.test.ts
```

Three cases:

1. **Alphabet** — `ticketCode()` returns only characters from
   `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no `I`, `L`, `O`, `U`).
2. **Length** — exactly 26 characters.
3. **Collision-free at scale** — 100 000 codes, `new Set().size === 100000`
   (passes with astronomical probability; a repeat here is a seeding bug in
   `randomBytes`).

Export `ticketCode` from `orders.ts` for the test if it is not already (verify
the export; the function is `function ticketCode()` at `:400` with no `export`
keyword — add `export`).

```bash
pnpm test ticket-code
```

Expected: 3 tests pass.

**Negative control:** mutate the alphabet to include `I`, re-run — alphabet
test fails. Restore.

- [ ] **Step 2: Document the collision contract in a header comment**

In `orders.ts`, over `ticketCode()`:

> 128-bit random Crockford base32 (26 chars). Collision probability at 10M
> codes is ~1.5 × 10^-26 — negligible, but if `Ticket.code`'s unique
> constraint ever throws inside `fulfilOrder` the transaction rolls back and
> Stripe retries, so even then the outcome is a one-second delay, not lost
> money.

Verify the comment reads correctly by eye.

- [ ] **Step 3: Gate**

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: pass with 448 tests (3 added).

---

## Task 3: QR encoder — pure function

Produce two shapes: a PNG `Buffer` (for `pdf-lib` embedding) and an SVG
`string` (for the public web page). Both from one source function.

**Files:**
- New: `src/lib/shared/qr.ts`
- New: `tests/lib/shared/qr.test.ts`

- [ ] **Step 1: Write `src/lib/shared/qr.ts`**

Two exports:

```ts
export async function qrPngBuffer(url: string): Promise<Buffer>
export async function qrSvgString(url: string): Promise<string>
```

Both call the same `qrcode` library with the same options:

- `errorCorrectionLevel: 'H'` (30% damage recovery — needed for a cracked
  phone screen in a dark foyer, per `06-i18n-email-pdf.md`).
- `margin: 4` (minimum quiet zone from the QR spec).
- `color: { dark: '#000000', light: '#FFFFFF' }`.
- PNG `width: 512` (square; shrink to the PDF cell when embedded).
- SVG uses the library's `toString(url, { type: 'svg' })`.

**No side effects, no state, no filesystem writes.** This is tested as a
pure function.

- [ ] **Step 2: Write `tests/lib/shared/qr.test.ts`**

Five cases:

1. `qrPngBuffer` returns a `Buffer` starting with the PNG magic bytes
   `89 50 4E 47 0D 0A 1A 0A`.
2. `qrSvgString` returns an SVG string containing `<svg` and the input URL in
   a comment or data payload (prove the input influenced the output).
3. Same URL → identical PNG bytes (determinism — the library produces the
   same output for the same input with the same options). This matters for
   test stability.
4. Different URL → different PNG bytes (non-degenerate — the URL is actually
   encoded).
5. **Decode round-trip.** Install `jsqr` as a `devDependency` and decode the
   `qrPngBuffer` output back to the original URL. Without a decode step the
   first four tests pass vacuously if the library ever starts emitting valid-
   looking but unreadable PNGs. Alternative: skip this one if `jsqr` is
   itself a native dependency (verify in Step 1 of Task 1).

```bash
pnpm test qr
```

Expected: 5 tests pass (or 4 if the decode step is skipped — record why).

**Negative control:** force `qrcode` to use `errorCorrectionLevel: 'L'`, run
the decode test with corruption added — fewer decodes succeed. Restore.

- [ ] **Step 3: Gate**

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: pass with 453 tests (5 added).

---

## Task 4: Holder-name layout rule — pure function

`06-i18n-email-pdf.md` mandates trim + length cap + ellipsis for buyer-supplied
names dropped onto a fixed-width PDF page.

**Files:**
- New: `src/lib/shared/ticket-layout.ts`
- New: `tests/lib/shared/ticket-layout.test.ts`

- [ ] **Step 1: Write `fitHolderName(raw: string, maxChars: number): string`**

Rules:

- `null`/`undefined`/`""` → return `""` (caller shows "–" or hides the field).
- Trim whitespace.
- Normalize internal runs of whitespace to single spaces.
- If `.length > maxChars` after trim/normalize, truncate to `maxChars - 1`
  and append `…` (Unicode horizontal ellipsis U+2026). Default `maxChars = 32`,
  configurable per call.

**Why `…` not `...`:** three ASCII dots count as three characters and widen the
line; the glyph is one.

- [ ] **Step 2: Write `tests/lib/shared/ticket-layout.test.ts`**

Six cases:

1. `null` → `""`.
2. `"  Jan   Kowalski  "` → `"Jan Kowalski"`.
3. `"a".repeat(100)` with `maxChars: 32` → length 32, ends `"…"`.
4. `"Małgorzata Świętosławska"` (24 chars) at default → unchanged (does not
   trigger truncation).
5. `"Małgorzata Świętosławska i Rodzina"` (35 chars) at default → length 32,
   ends `"…"`, latin-ext characters preserved intact (regression — surrogate-
   pair truncation inside a diacritic would corrupt).
6. Length-counting unit test: `"…"` is one character, not three.

```bash
pnpm test ticket-layout
```

Expected: 6 tests pass.

- [ ] **Step 3: Gate**

Expected: 459 tests.

---

## Task 5: PDF generator — pure function (single ticket)

Builds a one-page `Buffer` for a single ticket. The all-in-one order PDF
was dropped (owner decision 26 Oct 2026 — see Findings log). A buyer with
three tickets downloads three PDFs, one per ticket, each independently
forwardable.

**Files:**
- New: `src/lib/server/ticket-pdf.ts` (server-only; it reads font files from
  disk at module load).
- New: `tests/lib/server/ticket-pdf.test.ts`

- [ ] **Step 1: Write `src/lib/server/ticket-pdf.ts`**

Signature:

```ts
export type TicketPdfInput = {
  code: string
  holderName: string | null
  order: {
    reference: string
    locale: Locale
  }
  event: {
    title: string            // in order.locale
    startsAt: Date           // UTC
    venue: string
    address: string
    city: string
  }
  publicBaseUrl: string      // env.NEXT_PUBLIC_SITE_URL
}

export async function renderTicketPdf(input: TicketPdfInput): Promise<Buffer>
```

Rules:

- Load Noto Sans Regular + Bold once at module scope, from
  `src/assets/fonts/`. Register the fontkit module on the PDFDocument once per
  render (`doc.registerFontkit(fontkit)`).
- A4 portrait, one page.
- Layout (top → bottom, left-aligned text block, right-aligned QR block):
  - Festival logo (fallback: text "Krzyżowa-Music" in Noto Sans Bold).
  - Event title in `order.locale`, 20pt Bold.
  - Date and time in `Europe/Warsaw` formatted via `formatConcertDate` +
    `formatConcertTime` in the buyer's locale.
  - Venue name + address.
  - Holder name block: `fitHolderName(holderName, 32)`; label from i18n
    ("Imię i nazwisko" / "Name" / "Name"). If the fit returns `""`, render
    `"–"` and continue — invitations have null holder names.
  - QR code: `qrPngBuffer(\`${publicBaseUrl}/t/${code}\`)`, embedded at 60mm
    square in the top-right.
  - Ticket code in plain text underneath the QR (fallback for a crumpled QR).
  - Order reference in a 6pt footer (so staff can group forwarded tickets
    back to one buyer at the door), with a terms line and a contact address
    (from a module constant, filled in later by the owner).
- Return the result of `doc.save()` as a `Buffer` (not a `Uint8Array`).

**No DB access.** The function is given the data; the caller is a Route
Handler that reads it.

- [ ] **Step 2: Write `tests/lib/server/ticket-pdf.test.ts`**

Eight cases, each exercising a specific layout property. **Do not render the
image and inspect it visually** — tests must be headless and reproducible.
Use `pdf-lib`'s loader to read the generated buffer back and inspect:

1. **Page count** — exactly 1 page. (Primary case; the function renders one
   ticket by design.) A separate test invokes the function three times for
   three different codes and asserts three distinct one-page PDFs — the
   per-ticket contract — and that identical input produces identical bytes
   (determinism, verified in case 8).
2. **Font with latin-ext loads** — rendering a holder name with Polish
   diacritics does not throw. The failure mode without a latin-ext font is a
   loud `WinAnsiEncoding` throw at render time, so this is a load-bearing
   test, not a vanity one.
3. **Metadata** — `doc.getTitle()` reads back as `"Krzyżowa-Music ticket
   <reference>-<code6>"` (or the equivalent, pinned here).
4. **File size sanity** — single-ticket PDF is < 200KB (QR + fonts +
   skeleton). Prevents an accidental image embed from bloating the download.
5. **Null holder name** — renders `"–"`, not `"null"` or an empty gap.
6. **QR URL round-trip** — using the Task 3 decoder, read the page's QR and
   assert it equals `${publicBaseUrl}/t/${code}`.
7. **Locale propagates** — a Polish order sees Polish labels; a German order
   sees German. Does not need rendering — assert on the raw PDF stream (which
   contains the text as a glyph sequence) using `pdf-parse` or by searching
   the uncompressed stream. Alternative: build the PDF with
   `useCompression: false` for the test only.
8. **Deterministic file bytes** — identical input → identical bytes, when
   `pdf-lib` is given a fixed `creationDate`/`modificationDate`. Needed for
   a stable Content-Length and hashing later.

**Negative controls:**

- Remove the font registration → test 2 throws. Restore.
- Hard-code a wrong public base URL → test 6 fails with the expected URL.
  Restore.

```bash
pnpm test ticket-pdf
```

Expected: 8 tests pass. Record the file size numbers in the Findings log.

- [ ] **Step 3: Gate**

Expected: 467 tests.

---

## Task 6: Public ticket page `/t/<code>`

Server Component outside the locale group. `proxy.ts:12` already excludes
`/t` from locale rewrites.

**Files:**
- New: `src/app/t/[code]/page.tsx`
- New: `src/app/t/[code]/not-found.tsx`
- New: `src/lib/server/ticket-lookup.ts`
- New: `tests/lib/server/ticket-lookup.test.ts`

- [ ] **Step 1: Write `src/lib/server/ticket-lookup.ts`**

Signature:

```ts
export type PublicTicketView =
  | { kind: 'valid'; ticket: PublicTicket }
  | { kind: 'used'; ticket: PublicTicket; usedAt: Date }
  | { kind: 'revoked'; ticket: PublicTicket }

export type PublicTicket = {
  code: string
  holderName: string | null
  event: { title: string; startsAt: Date; venue: string; city: string; address: string }
  orderLocale: Locale
}

export async function getPublicTicket(code: string): Promise<PublicTicketView | null>
```

- Validates `code` with the Crockford base32 alphabet before hitting the DB
  (saves one DB round-trip on garbage input).
- Loads `Ticket` + `Event.translations` (buyer locale, not request locale —
  the ticket was issued in `order.locale`, so the printed language and the
  web page must match or they will look like two tickets).
- **If `Ticket.status === 'REVOKED'`** OR `Order.status IN ('REFUNDED',
  'PARTIALLY_REFUNDED', 'CANCELLED')` → return `kind: 'revoked'`.
- **If `Ticket.status === 'USED'`** → return `kind: 'used'` with `usedAt`.
  Deliberately does **not** reveal `usedByAdmin` — that is internal.
- Else → return `kind: 'valid'`.
- Does **not** mutate anything. No `UPDATE`, no audit row.

- [ ] **Step 2: Write `tests/lib/server/ticket-lookup.test.ts`**

Six cases, each builds a `Ticket` row directly in the DB (no `fulfilOrder`
plumbing needed — the schema allows it):

1. Valid, unused → `kind: 'valid'`.
2. `status: 'USED'` with `usedAt` set → `kind: 'used'`, `usedAt` matches.
3. `status: 'REVOKED'` → `kind: 'revoked'`.
4. Order `status: 'REFUNDED'`, ticket still `VALID` → `kind: 'revoked'` (the
   refund is the source of truth).
5. Unknown code → `null`.
6. Malformed code (lower case, `I`/`L`/`O`/`U`, length ≠ 26) → `null` and
   **no DB query** (verify with `vi.spyOn(db.ticket, 'findUnique')`).

Begin the test with `TRUNCATE "Ticket","Order","OrderItem","TicketType","Event","Venue" RESTART IDENTITY CASCADE` — see `tests/lib/server/orders.test.ts` for the pattern. Also `ALTER SEQUENCE "order_reference_seq" RESTART`.

```bash
pnpm test ticket-lookup && pnpm test ticket-lookup
```

Expected: 6 tests pass **twice** (shared-DB discipline).

- [ ] **Step 3: Write `src/app/t/[code]/page.tsx`**

Server Component. No `use client`. Uses `getPublicTicket`. Renders:

- Header: concert title + date (buyer's locale from `ticket.orderLocale`).
- Venue block.
- Holder name block (fallback `"–"` for invitations).
- **State banner, large and coloured, same colours as the scanner spec**
  (`05-admin-and-scanner.md` five-state table — green/amber/red):
  - `valid` → green "Bilet ważny / Valid ticket / Gültige Eintrittskarte".
  - `used` → amber "Już wykorzystany o {time}" (localised).
  - `revoked` → red "Bilet nieważny" (localised).
- QR SVG from `qrSvgString(ticket URL)`, inline. Below the QR, the code in
  plain text, large and legible, for manual entry at the door.
- `<link rel="canonical">` points at `${env.NEXT_PUBLIC_SITE_URL}/t/<code>`.
- `<meta name="robots" content="noindex, nofollow">`.
- Response headers: `dynamic = 'force-dynamic'`, no caching
  (`fetchCache = 'default-no-store'`).

**No form, no action, no mutation.** Any `use client` interaction is forbidden
on this page.

- [ ] **Step 4: Write `src/app/t/[code]/not-found.tsx`**

Localised to Polish by default (the proxy excludes `/t` from the locale
prefix, so there is no `locale` segment). Shows a short "Nie znaleziono biletu
/ Ticket not found / Eintrittskarte nicht gefunden" in all three languages,
and a link back to the festival page. No stack trace, no reference echo.

- [ ] **Step 5: Add i18n keys**

In `src/messages/pl.json`, `en.json`, `de.json`, under a new `"ticket"` root:

```json
{
  "ticket": {
    "valid": { "heading": "Bilet ważny", "body": "Pokaż ten kod przy wejściu." },
    "used": { "heading": "Bilet wykorzystany", "body": "Wejście zarejestrowano {time}." },
    "revoked": { "heading": "Bilet nieważny", "body": "Ten bilet został anulowany lub zwrócony." },
    "notFound": { "heading": "Nie znaleziono biletu", "body": "Sprawdź adres z biletu lub skontaktuj się z organizatorem." },
    "codeLabel": "Kod biletu",
    "concert": "Koncert",
    "venue": "Miejsce",
    "holder": "Imię i nazwisko"
  }
}
```

Translate for `en` and `de`. **next-intl throws on missing keys** — a page
load in any locale with any key missing fails hard, so every key goes into
all three JSON files in this step.

- [ ] **Step 6: Rate-limit `/t/<code>` by IP**

Codes are unguessable (128 bits), so this is defence-in-depth: a scraper
can still thrash the DB with the Crockford alphabet. Use the existing
`src/lib/server/ratelimit.ts` helper with key `t:<ip>`, limit 60, window
60_000 (1 req/sec sustained). The limiter is in-memory and per-instance —
same trade-off as elsewhere in Plan 01.

A 429 renders the `not-found` page body (deliberately indistinguishable from
"no such code") to avoid turning rate-limiting into a code-existence oracle.

- [ ] **Step 7: Manual check**

```bash
pnpm dev
# then: open https://localhost:3000/t/<a real code from a seeded order>
```

Expected: page renders green with the concert title, holder name, QR, and
ticket code. Open the same URL on your phone, scan with the camera: it opens
the same page.

Also open `https://localhost:3000/t/ZZZZZZZZZZZZZZZZZZZZZZZZZZ`
→ not-found page. And `https://localhost:3000/t/i-am-lowercase-123` → not-
found page (invalid code), **and verify in `pnpm dev` logs that no DB query
ran** (confirms Task 6 Step 2 case 6 is wired through).

- [ ] **Step 8: Gate**

Expected: 473 tests (6 added).

---

## Task 7: Per-ticket PDF download endpoint

Route Handler that returns the PDF for one ticket, keyed by the ticket's
own 128-bit code. The code IS the bearer credential — the same credential
the public `/t/<code>` page uses to render the QR and holder name. Owner
decision 26 Oct 2026: a buyer must be able to forward one ticket to one
person, which requires a stable per-ticket URL that works without the
order's access token.

**Files:**
- New: `src/app/t/[code]/pdf/route.ts`
- New: `tests/app/t/ticket-pdf-route.test.ts`

- [ ] **Step 1: Write the Route Handler**

Signature:

```ts
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
): Promise<Response>
```

Steps:

1. `code = (await params).code`. If `!isValidTicketCode(code)` → 404 with
   `Cache-Control: private, no-store`. Same 404-for-garbage behaviour as
   `/t/<code>` so the URL is not an existence oracle.
2. Rate limit by IP: `rateLimit(\`pdf:\${ip}\`, 20, 60_000)` → 429 on breach.
   Returns 429 with a plain-text "Too many requests" body — no PDF, no
   cached asset.
3. `getPublicTicket(code)` from Task 6 (shared with `/t/<code>`).
   - Returns `null` → 404.
   - Returns `kind: 'revoked'` → 404 (a REVOKED ticket's PDF is withdrawn;
     the web page is the source of truth and tells the buyer why).
   - Returns `kind: 'used'` → 200 (same PDF; "already used" is a door-staff
     signal, not a buyer-facing one, and the buyer may legitimately re-print
     a ticket between venue entries).
   - Returns `kind: 'valid'` → 200.
4. Call `renderTicketPdf({ code, holderName, order: { reference,
   locale }, event: {...}, publicBaseUrl: env.NEXT_PUBLIC_SITE_URL })`.
   `order.reference` and `order.locale` are pulled by a lightweight extra
   SELECT (not already in `PublicTicketView`); add them to the view in Task 6
   or expose a dedicated `getTicketForPdf(code)` with the extra fields —
   either is fine, record which in Findings.
5. Return the buffer with:
   - `Content-Type: application/pdf`
   - `Content-Disposition: attachment; filename="ticket-<code6>.pdf"` where
     `<code6>` is the first six characters of the code. Using the full
     26-character code in the filename makes the attachment unwieldy; six
     characters are enough to differentiate forwarded tickets in a buyer's
     Downloads folder and still fit a mobile e-mail client's attachment
     label.
   - `Cache-Control: private, no-store` (matches the public page's headers
     exactly — a REVOKED ticket must not persist at an edge).
   - `Content-Length: String(buffer.length)`.

**Explicit non-feature:** there is NO `?t=<token>` guard on this route. The
code is the credential; the `/t/<code>` web page already serves the holder
name and QR to anyone with the code, by design, so withholding only the PDF
would be security-theatre. State this plainly in a route-header comment so
a future reviewer does not add a token guard "to be safe" and break
forwarding.

- [ ] **Step 2: Write `tests/app/t/ticket-pdf-route.test.ts`**

**No HTTP — call the exported `GET` handler directly** (same pattern as
Plan 05's tests). Seven cases:

1. Malformed code (lower case / wrong length / contains `I`/`L`/`O`/`U`) →
   404 with no DB query (spy on `db.ticket.findUnique`).
2. Unknown but well-formed code → 404.
3. Ticket of a REVOKED order → 404.
4. VALID ticket → 200, `Content-Type: application/pdf`, body starts with
   `%PDF-`.
5. Already USED ticket → 200 (buyer can still fetch; door staff see the
   state via the scanner).
6. Filename matches `ticket-<first-six-chars>.pdf` for a known fixture code.
7. Rate limiting fires on the 21st request within 60s per IP (clear with
   `__resetRateLimits()` after).

Begin the file with `TRUNCATE "Ticket","Order","OrderItem","TicketType",
"Event","Venue" RESTART IDENTITY CASCADE` + `ALTER SEQUENCE
"order_reference_seq" RESTART`.

```bash
pnpm test ticket-pdf-route && pnpm test ticket-pdf-route
```

Expected: 7 tests pass **twice**.

- [ ] **Step 3: Manual check**

```bash
pnpm dev
# make a Stripe test payment on a seeded concert, complete it, land on
# /pl/order/<ref>?t=<token> showing "paid"
# find a ticket code from the DB (`SELECT code FROM "Ticket" WHERE "orderId" IN (SELECT id FROM "Order" WHERE reference = 'KM-...')`)
# open /t/<code>/pdf
```

Expected: browser downloads `ticket-<code6>.pdf`. Open it: one page, QR
present and scannable with a phone (points back at `/t/<code>`), holder
name present with latin-ext characters rendered correctly, order reference
in the footer.

Then open the SAME URL in a browser that does NOT have the order's
access token (e.g. a private window). It must still download — the code
is the credential. If a 401 or 403 appears, something added a token
guard; remove it.

- [ ] **Step 4: Gate**

Expected: 480 tests.

---

## Task 8: Per-ticket links on the order confirmation page

Add a list of all tickets to the `paid` band, each with its own
"Pobierz PDF" and "Bilet w przeglądarce" link. No single all-order PDF
button (dropped per owner decision 26 Oct 2026).

**Files:**
- Modify: `src/app/(shop)/[locale]/order/[reference]/page.tsx`
- Modify: `src/lib/server/order-lookup.ts`
- Modify: `src/messages/{pl,en,de}.json`
- No new client components — plain `<a href>` elements are enough; the
  ticket code in each URL is the bearer credential.

- [ ] **Step 1: Replace the current `paid` body with:**

```tsx
{band === 'paid' && (
  <>
    <p className="prose-serif mt-4 text-text-secondary">{t('paid.body')}</p>
    <p className="prose-serif mt-2 text-sm text-text-secondary">
      {t('paid.perTicketNote')}
    </p>
    <ul className="mt-8 panel grid gap-4 p-5 sm:p-6">
      {paidTickets.map((ticket, idx) => (
        <li
          key={ticket.code}
          className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <div className="font-medium">
              {t('paid.ticketLabel', { number: idx + 1 })}
            </div>
            <div className="text-sm text-text-secondary">
              {ticket.holderName ?? '–'}
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <a className="btn btn-primary" href={`/t/${ticket.code}/pdf`}>
              {t('paid.downloadPdf')}
            </a>
            <a className="btn btn-secondary" href={`/t/${ticket.code}`}>
              {t('paid.webTicket')}
            </a>
          </div>
        </li>
      ))}
    </ul>
  </>
)}
```

`paidTickets` comes from `getOrderForConfirmation`'s return shape (Step 3).

**No order-wide "download all" button.** A buyer with three tickets forwards
them individually, which is the whole point of the per-ticket split.

- [ ] **Step 2: Add i18n keys**

In each `messages/*.json`, under `"order.paid"`:

```json
"downloadPdf": "Pobierz PDF",
"webTicket": "Bilet w przeglądarce",
"ticketLabel": "Bilet {number}",
"perTicketNote": "Każdy bilet ma własny kod. Możesz przesłać osobny bilet osobnej osobie."
```

Translate for `en` and `de`. **next-intl throws on missing keys** — add all
three languages in this step. The `perTicketNote` copy exists precisely
because the per-ticket forwardability is a feature the buyer has to
discover; left unexplained, the buyer may screenshot the whole page.

- [ ] **Step 3: Modify `getOrderForConfirmation` to return tickets when paid**

In `src/lib/server/order-lookup.ts`, extend the `OrderConfirmation` type:

```ts
export type OrderConfirmation = {
  order: {...}  // unchanged
  event: {...}  // unchanged
  band: OrderBand
  tickets: Array<{ code: string; holderName: string | null }>  // [] unless paid
}
```

Populate from `db.ticket.findMany({ where: { orderId: order.id },
select: { code: true, holderName: true }, orderBy: { createdAt: 'asc' } })`
only when the computed band is `paid`. `orderBy: createdAt` keeps the UI
listing stable across page loads.

**Trap:** the function already queries Prisma; add the ticket query only on
the `paid` path to avoid an extra round-trip on every holding/processing
poll.

- [ ] **Step 4: Update the test file**

In `tests/lib/server/order-lookup.test.ts` (or `order-lookup-stripe.test.ts`):

- Add a case: `paid` band → `tickets.length === order.items[0].quantity`,
  each ticket has a code matching the Crockford alphabet, ordered by
  `createdAt ASC`.
- Add a case: `holding` band → `tickets.length === 0`.
- Add a case: `refunded` band → `tickets.length === 0` (do not leak codes
  for a refunded order through the confirmation page).

```bash
pnpm test order-lookup && pnpm test order-lookup
```

Expected: pass **twice**.

- [ ] **Step 5: Manual check**

Make a Stripe test payment for a 3-ticket order. On the confirmation page's
paid band:

- Expect three rows, "Bilet 1 / 2 / 3", each with its own download + web
  links.
- Click `Pobierz PDF` on ticket 1 — single-page PDF downloads with ticket 1's
  QR and holder name.
- Click `Bilet w przeglądarce` on ticket 2 — opens `/t/<code>` showing
  ticket 2's holder name.
- Copy ticket 3's PDF URL (`/t/<code>/pdf`), open it in a new private window
  — PDF downloads without login or token. **This is the forwarding story
  working.**

- [ ] **Step 6: Gate**

Expected: 483 tests (3 added in Step 4).

---

## Task 9: Email seam

Make the email handoff explicit but unwired. Plan 08 fills in the body.

**Files:**
- New: `src/lib/server/email.ts`
- Modify: `src/lib/server/webhook-dispatch.ts` (the success path)
- New: `tests/lib/server/email.test.ts`

- [ ] **Step 1: Write `src/lib/server/email.ts`**

```ts
import 'server-only'

export type EmailResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: 'disabled' | 'alreadySent' | 'orderNotFound' | 'notPaid' }

/**
 * Sends the ticket-delivery email for a fulfilled order.
 *
 * Plan 06 ships this as a no-op (`EMAIL_ENABLED = false`); Plan 08 wires
 * Resend. The call site, the idempotency guard (`Order.emailSentAt IS NULL`),
 * the result shape and the "called AFTER the DB transaction" rule are fixed
 * here so Plan 08 is a drop-in.
 *
 * Must never run inside a Prisma transaction — the real implementation
 * will call Resend, which is network and can hang; the right place is
 * `webhook-dispatch.ts` after `fulfilOrder` returns.
 */
export async function emailFulfilledOrder(orderId: string): Promise<EmailResult>
```

Implementation:

- Short-circuit on `process.env.EMAIL_ENABLED !== 'true'` → return
  `{ sent: false, reason: 'disabled' }`. Does NOT read the DB. (Measuring the
  gate from env rather than a schema flag means switching it on in production
  is a Vercel env change, not a migration.)
- Beyond that, implementation stays empty for Plan 06. Add a `// PLAN-08:`
  marker where the Resend call will go.

- [ ] **Step 2: Call it from the webhook dispatch**

In `src/lib/server/webhook-dispatch.ts`, inside `case 'payment_intent.succeeded'`:

```ts
const result = await fulfilOrder(orderId, refundHook, pi)
if (result.fulfilled) {
  // Plan 06 seam. No-op until EMAIL_ENABLED=true (Plan 08).
  // AFTER fulfilOrder returns — never inside its transaction.
  const emailed = await emailFulfilledOrder(orderId)
  // Not fatal: a failed email must not re-fire a Stripe retry. The
  // reconciliation cron (Plan 05 Task 14) is the retry mechanism.
  if (emailed.sent === false && emailed.reason !== 'disabled') {
    console.error(`EMAIL alert=1 orderId=${orderId} reason=${emailed.reason}`)
  }
}
```

- [ ] **Step 3: Write `tests/lib/server/email.test.ts`**

Three cases:

1. `EMAIL_ENABLED` unset → returns `{ sent: false, reason: 'disabled' }`,
   no DB access (spy on `db.order.findUnique`, expect 0 calls).
2. `EMAIL_ENABLED=true` → **TODO for Plan 08** (today returns `disabled`;
   the test is `expect.todo` with a comment pointing at Plan 08).
3. Idempotency gate exists (visible as a `TODO` string check); when wired,
   `emailSentAt != null` → returns `{ sent: false, reason: 'alreadySent' }`.
   Written as a pending test today, enforcing it is reserved for Plan 08.

```bash
pnpm test email
```

Expected: 1 pass, 2 todo.

- [ ] **Step 4: Verify no email code reaches a client bundle**

```bash
pnpm build
grep -rn "emailFulfilledOrder" .next/server 2>/dev/null | head
grep -rn "emailFulfilledOrder" .next/static 2>/dev/null && echo "LEAK" || echo "ok, server only"
```

Expected: `.next/static` finds no references. The function has `'server-only'`;
if this grep ever hits, something imported it from a client component.

- [ ] **Step 5: Gate**

Expected: 483 tests, 2 todo.

---

## Task 10: Documentation and manual walkthrough

**Files:**
- Modify: `plan/STATUS.md`
- Modify: `plan/README.md`
- Modify: `/CLAUDE.md` (traps, if the executor hit any new ones)
- New: `plan/06-manual-test.md`

- [ ] **Step 1: Write `plan/06-manual-test.md`**

A buyer-flow checklist in the shape of `plan/05-manual-test.md`:

| Flow | Steps | Expected |
|---|---|---|
| A — happy path (PLN, card, 1 ticket) | Buy → pay → confirmation → `Pobierz PDF` → open `Bilet w przeglądarce` | PDF is one page, QR scans with phone camera into `/t/<code>`, web page says "Bilet ważny". |
| B — forwarding (PLN, card, 3 tickets) | Buy 3 → pay → confirmation lists three rows | Each row downloads its own single-page PDF with its own QR. Opening ticket 2's PDF URL in a private window (no cookies, no token) still works — the code is the credential. |
| C — happy path (EUR, SEPA) | Same, SEPA-DD test IBAN | Confirmation shows `processing` band, then polls to `paid`, per-ticket PDFs generate once paid. |
| D — refund path | Admin refunds order (Plan 08-manual; use `prisma` CLI for now, or mark one ticket `REVOKED` directly) | `/t/<code>` renders "Bilet nieważny". `/t/<code>/pdf` returns 404 (REVOKED tickets have no PDF; a copy already in the buyer's hands keeps rendering, but the live web view tells the truth). |
| E — expired hold | Create order, let 30 min pass | Confirmation shows `expired`; the paid band's ticket list is empty (band != paid returns `tickets: []`). |
| F — tampered code | Change one character in `/t/<code>/pdf` | 404 (invalid Crockford alphabet → immediate 404 with no DB query; valid-shape unknown code → 404 after a lookup — same body in both cases). |
| G — stale PDF | Download PDF, refund order, open the already-downloaded PDF | PDF still readable visually, but the QR resolves to a REVOKED web page. **Intentional** — the web page is the source of truth; the PDF is a shortcut. |
| H — rate limit | Hit `/t/<code>/pdf` 21 times in 60s from one IP | 21st call returns 429 with plain-text body. The public `/t/<code>` page has an independent 60/min limit — fire that too if the IP is shared with a scraping tool. |

Reference `05-manual-test.md`'s format exactly. Include Stripe's test card
numbers (already captured there) and the exact URLs to open.

- [ ] **Step 2: Update `plan/STATUS.md` → "Next" section**

Replace the current "Plan 05 execution" details with a short "Plan 05 done /
Plan 06 complete" summary and point "Next" at Plan 07 (Scanner).

- [ ] **Step 3: Update `plan/README.md` executable plans table**

Reflect the plan reshuffle (described in that file) — `06 — Tickets`,
`07 — Scanner`, `08 — Money out`, `09 — Launch`.

- [ ] **Step 4: Full gate from a clean tree**

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm test
```

Expected: exit 0 on both test runs. Record the final test count in the
Findings log.

---

## Definition of done

- A buyer who completes a Stripe test payment on `tickets-km.vercel.app` sees
  a list of their tickets on the confirmation page, each with its own
  "Pobierz PDF" and "Bilet w przeglądarce" buttons.
- Clicking "Pobierz PDF" on one ticket downloads a single-page PDF for that
  one ticket.
- Copying one ticket's `/t/<code>/pdf` URL into a browser with no cookies
  still downloads that PDF — the ticket code is a bearer credential, so a
  buyer can forward it to one guest.
- Every QR on a PDF, scanned by a phone camera, opens `/t/<code>` and
  renders green with the holder name, concert, date and venue.
- A ticket that is REVOKED (by refund) renders red on `/t/<code>` within one
  page load, and `/t/<code>/pdf` returns 404. The PDF already in the buyer's
  hands keeps working visually, but the live web view tells the truth.
- The `fulfilOrder` path calls `emailFulfilledOrder(orderId)` outside the
  transaction, which no-ops until Plan 08.
- Gate green from a clean tree **twice**.
- `plan/STATUS.md`, `plan/README.md` and `/CLAUDE.md` (traps) updated.
- **No commits by the executor.** The owner commits.

---

## Risks and traps the executor should expect

- **Noto Sans TTF is ~500KB subsetted**, over 1MB unsubsetted. If the Vercel
  bundle ever approaches the 50MB limit, the fonts are the first thing to
  inspect. Record the final `.next/server` size per function in Findings.
- **`pdf-lib` is slow in cold-start.** First PDF render on a serverless
  instance can take 2–4s because of fontkit's font-table parsing. The
  Route Handler has `maxDuration = 30`; keep an eye on it under load. If
  it bites, cache the loaded `PDFFont` objects at module scope (they are
  bound to one `PDFDocument`, so this needs a wrapper that clones).
- **`qrcode` emits a `Uint8Array`, not a `Buffer`, in some Node versions.**
  `pdf-lib`'s `embedPng` takes either, but tests asserting
  `instanceof Buffer` will trip. Normalise with `Buffer.from(result)` on the
  way out of `qrPngBuffer`.
- **`proxy.ts` already excludes `/t`** (verified `src/proxy.ts:12`). Do not
  touch its matcher. Any change here breaks the published QR URLs.
- **`src/components/**` cannot import `@/lib/server/*`** (verified
  `eslint.config.mjs:40–55`). The order confirmation page is in
  `src/app/`, which is allowed — the download link is a plain `<a>`, no
  component. Keep it that way.
- **Tests are Node-env, no DOM.** The public ticket page and the order-page
  download button are untested through rendering. Every pure function they
  depend on is tested instead. Test coverage of the actual pages is manual
  (Task 6 Step 7, Task 7 Step 3).
- **`import 'server-only'` throws under Vitest and tsx.** Aliased in
  `vitest.config.mts`. Tests import `ticket-pdf.ts` directly and this works
  because of the alias.
- **Opening `/t/<code>` must not mutate.** If the executor is tempted to
  "stamp a last-opened-at timestamp" for metrics — don't. Plan 07's scan
  endpoint is the only mutation path, and conflating "scanned" with "opened
  by any passer-by with the URL" breaks the product.
- **PDF generation is CPU-bound.** The handler is a single Node function,
  not a worker. Under heavy load (hundreds of concurrent downloads during
  the on-sale minute), this will be a bottleneck. Plan 07/08 should
  consider pre-generating and storing on first fulfilment if the sale pacing
  shows up as a problem.
- **The `.env` file is git-ignored.** Any new env var mentioned here must
  also be written into `.env.example` and `.env.test` **in the same task
  that adds it to the schema** — Plan 05 made this mistake with
  `CRON_SECRET` and local dev broke silently.

---

## Appendix — files touched

Created:

- `src/lib/shared/qr.ts`
- `src/lib/shared/ticket-layout.ts`
- `src/lib/server/ticket-pdf.ts`
- `src/lib/server/ticket-lookup.ts`
- `src/lib/server/email.ts`
- `src/app/t/[code]/page.tsx`
- `src/app/t/[code]/not-found.tsx`
- `src/app/t/[code]/pdf/route.ts`
- `src/assets/fonts/NotoSans-Regular.ttf`
- `src/assets/fonts/NotoSans-Bold.ttf`
- `tests/lib/shared/qr.test.ts`
- `tests/lib/shared/ticket-layout.test.ts`
- `tests/lib/server/ticket-pdf.test.ts`
- `tests/lib/server/ticket-lookup.test.ts`
- `tests/lib/server/ticket-code.test.ts`
- `tests/lib/server/email.test.ts`
- `tests/app/t/ticket-pdf-route.test.ts`
- `plan/06-manual-test.md`

Modified:

- `package.json` (deps + lockfile)
- `src/lib/server/orders.ts` (export `ticketCode`, comment update)
- `src/lib/server/order-lookup.ts` (return `tickets[]` on paid, ordered by `createdAt`)
- `src/lib/server/webhook-dispatch.ts` (call `emailFulfilledOrder` after fulfil)
- `src/app/(shop)/[locale]/order/[reference]/page.tsx` (per-ticket list on paid band)
- `src/messages/pl.json`, `en.json`, `de.json` (new `ticket` + `order.paid` keys)
- `plan/STATUS.md`
- `plan/README.md`
- `plan/00-decisions.md` (versions table entries for pdf-lib, qrcode)
- `/CLAUDE.md` (append any new recurring trap found during execution)

No migration. No change to `prisma/schema.prisma`.
