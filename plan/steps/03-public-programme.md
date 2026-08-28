# Plan 03 — Public programme

**Goal:** a visitor browses the concert programme in Polish, English and German,
in either currency, sees honest availability, and reaches a validated checkout
form. **Nothing is charged and no order is created** — that is Plan 04.

**Architecture:** the shop pages read through a new
`src/lib/server/public-events.ts`. Three pieces are Client Components — the
currency switcher, the quantity selector and the buyer form — and everything
else is a Server Component.

> **The shop renders dynamically, not statically.** Plan 02 verified that
> `/pl`, `/en`, `/de` were prerendered, which was true only because no page
> touched the database. From this plan on they query live availability and read
> the currency cookie, both of which opt a route out of static rendering. That
> is the correct trade: build-time-frozen availability on a ticketing site would
> be worse than useless. **Task 12 changes the expectation accordingly, and
> `STATUS.md` must be updated to match.**

**Spec:** [`../08-implementation-phases.md`](../08-implementation-phases.md)
Phase 2, [`../03-purchase-flow.md`](../03-purchase-flow.md),
[`../10-design-system.md`](../10-design-system.md).

**Depends on:** Plan 01 (schema, i18n, design tokens). Plan 02 is **not** a
dependency — this is built and tested entirely locally.

> **Revised 27 Aug 2026 after a critique pass**, which found two blockers (the
> test setup cannot render components; `react-hook-form` is not installed), an
> internal contradiction (a currency cookie versus a prerender assertion), and a
> checkout schema whose field names did not match the `Order` table it feeds.
> All are fixed below.

---

## Findings log

Appended **as things are discovered**, not at the end. Each entry says what the
plan assumed, what was actually true, and which step was corrected. If you learn
something here that outlives this plan, also add it to the traps list in
`/CLAUDE.md` — that file is loaded automatically every session; this one is not.

| Date | Finding | Action |
|---|---|---|
| 27 Aug | Critique pass: the test setup cannot render components — `vitest.config.mts` is `environment: 'node'`, `include: ['tests/**/*.test.ts']`, no jsdom or `@testing-library/react`. | Tasks 5–7 rewritten to test pure functions in `src/lib/shared/`. Added to CLAUDE.md traps. |
| 27 Aug | Critique pass: `eslint.config.mjs` bans `@/lib/server/*` from `src/components/**` with no `allowTypeImports` escape. | `PublicEvent` moved to `src/lib/shared/public-event.ts`. Added to CLAUDE.md traps. |
| 27 Aug | Critique pass: `react-hook-form` and `@hookform/resolvers` were never installed. | Added Task 0 Step 1. |
| 27 Aug | Critique pass: currency cookie read server-side contradicts the plan's own prerender assertion. | Shop declared dynamic; Task 12 Step 4 updated; `STATUS.md` must change too. |
| 27 Aug | Critique pass: checkout field names (`buyerName`, `wantsInvoice`, `address`) do not match `Order` (`firstName`, `lastName`, `needsInvoice`, `invoiceAddress`). | Task 9 Step 2 corrected before Plan 04 inherits the mismatch. |
| 27 Aug | Critique pass: prices/`maxPerOrder`/`soldCount`/`heldCount` are on `TicketType`, capacity on `Event`; `TicketType.active` was ignored entirely. | Task 2 corrected. Added to CLAUDE.md traps. |
| 27 Aug | Critique pass: no past-date filter and `CLOSED` unhandled — concerts would stay listed and purchasable forever. | Added both to Task 2's filter table. |
| 27 Aug | Task 0: `pnpm db:reset` is refused by Prisma 7 without `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`, even against local Postgres. | Task 0 Step 3 switched to `pnpm db:seed` twice. Added to CLAUDE.md traps. |
| 27 Aug | Task 0: every seeded concert was dated August 2026 — already past, so the programme would render empty the moment the past-date filter landed. | Seed dates made relative to seed time; upsert refreshes them. |

---

## Global Constraints

- **One concert per order.** Decided 27 Aug 2026. No cart, no cross-event
  availability check, no cart page. A buyer wanting three concerts goes through
  this flow three times. Do not build cart state "just in case".
- **A name per ticket.** Decided 27 Aug 2026, against the recommendation on
  file. Quantity drives the number of name fields.
- **The form does not submit anywhere yet.** Plan 03 ends at a *validated* form.
  Order creation is Plan 04. There is a `// PLAN-04:` marker where the call
  goes.
- **Money is integer minor units.** `pricePln` and `priceEur` are grosze and
  cents. Format only at the edge, with `formatMoney`.
- **Prices and counters live on `TicketType`; capacity lives on `Event`.**
  Availability is `event.capacity − ticketType.soldCount − ticketType.heldCount`.
  Read it here; never write it. `heldCount` is Plan 04's.
- **Nothing under `src/components/` may import from `@/lib/server/*`.**
  `eslint.config.mjs` enforces this with `no-restricted-imports`, and there is
  no `allowTypeImports` escape — even `import type` fails. **Shared types go in
  `src/lib/shared/`.**
- **Tests run in a Node environment with no DOM.** `vitest.config.mts` sets
  `environment: 'node'` and `include: ['tests/**/*.test.ts']` — no `.tsx`, no
  jsdom, no `@testing-library/react`. Test **pure functions**, not rendered
  components. See Task 0.
- **Commits are made by the human operator.**

---

## Task 0: Make the ground ready

Three things the rest of the plan assumes and the repository does not yet have.

**Files:**
- Modify: `package.json`, `prisma/seed.ts`

- [ ] **Step 1: Install the form dependencies**

```bash
pnpm add react-hook-form @hookform/resolvers
```

Expected: both added. **Check the resolver supports Zod 4** — this project runs
Zod 4.4.3, and resolvers older than v4 predate Zod 4's standard-schema
interface:

```bash
pnpm list @hookform/resolvers zod
```

- [ ] **Step 2: Decide the component-testing question**

The plan tests **pure functions**, not rendered components: availability bands,
quantity bounds, date formatting and the checkout schema all become plain
functions in `src/lib/shared/`, tested as ordinary `.test.ts`.

This matches the repository — every existing test under `tests/app/` exercises
server actions with `vi.mock`, never a rendered tree.

Adding jsdom and `@testing-library/react` is a legitimate alternative, but it is
a change to the test architecture and should be its own decision, not a
side-effect of this plan. If you want it, do it here and widen the glob to
`.test.tsx` — otherwise keep the logic extractable and out of the JSX.

- [ ] **Step 3: Extend the seed with the states the plan verifies**

The current seed creates three concerts, all `ON_SALE`, all with dates in
**August 2026 — already in the past** — with no `salesOpenAt`/`salesCloseAt` and
`soldCount = 0`. Several verification steps below need states that do not exist.

Add, as events only (**never seed admin accounts** — the seed password is
published):

| Concert | Purpose |
|---|---|
| future, `ON_SALE`, no window | the normal case |
| future, `ON_SALE`, `salesOpenAt` ahead | "sales not yet open" |
| future, `ON_SALE`, `salesCloseAt` past | "sales closed" |
| future, `SOLD_OUT`, `soldCount = capacity` | "sold out" |
| future, `DRAFT` | must 404 |
| future, `CANCELLED` | must 404 |
| future, `CLOSED` | listed, not purchasable |
| past, `ON_SALE` | must not be listed |

Move the three existing concerts to future dates too, or the programme is empty
the moment Task 2's past-date filter lands.

```bash
pnpm db:seed && pnpm db:seed
```

Expected: `Seeded 2 venues, 10 concerts, 2 admin accounts.` both times — the
seed upserts, so a second run changes no counts. Then update
`tests/prisma/seed.test.ts`, which asserts `event.count() === 3`.

**Seeding is enough; do not reach for `pnpm db:reset`.** Prisma 7 refuses
`migrate reset` without consent passed through
`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`, even against a local database,
and the upsert path achieves the same result without dropping anything.

**Make the dates relative to seed time**, not literal. The original seed
hardcoded August 2026 and every concert was already in the past by the time this
plan started — which is precisely the failure the past-date filter would then
have exposed as an empty programme.

---

## Task 1: Propagate the naming decision through the design documents

The 27 Aug decision to put a name on every ticket contradicts four documents
that still describe anonymous tickets. Fix them now, while the reasoning is
fresh — an executor in Plan 05 reading the old text will build the wrong thing.

**Files:** `../03-purchase-flow.md`, `../05-admin-and-scanner.md`,
`../06-i18n-email-pdf.md`, `../07-security-and-testing.md`, `../01-architecture.md`

- [ ] **Step 1: The checkout payload**

`03-purchase-flow.md` describes the pre-decision payload. Add `attendeeNames`,
and state the invariant: **non-null for every ticket of a `PURCHASE` order,
optional for `INVITATION`**, which is why `Ticket.holderName` stays nullable.

- [ ] **Step 2: The PDF**

`06-i18n-email-pdf.md` says the ticket shows the holder's name "when supplied".
It is now always supplied for purchases. Note the layout consequence: the name
goes into a fixed-width `pdf-lib` layout, so it needs a length cap and must
survive latin-ext characters.

- [ ] **Step 3: The scanner**

`05-admin-and-scanner.md` lists five scan states, none showing a name — yet
"the door scanner can show a name to check against" is the justification for the
whole decision. Add the name to the success state.

- [ ] **Step 4: Retention**

`07-security-and-testing.md` describes the personal data held as buyer details
only, and its retention job anonymises "buyer PII on orders". `Ticket.holderName`
is **not** on an order and would survive that job. Correct both.

- [ ] **Step 5: The checkout URL**

`01-architecture.md` specifies `[locale]/checkout/`. This plan uses
`[locale]/koncert/[slug]/zamowienie/`, because with one concert per order the
form belongs under the concert. Amend the architecture document so Plans 04–05
are written against the real path.

- [ ] **Step 6: Note the numbering trap**

`01-foundations.md`'s closing notes were written under the old plan numbering:
its "Plan 03" means the inventory plan, now **Plan 04**. So `updateEvent`
refusing price changes while `heldCount > 0`, and the `Order.reference` regex,
are *not* this plan's job. Say so in one line so the next reader does not
re-derive it.

Also hand forward the still-open question of **hold duration by venue size**
(`09-open-questions.md`), which Plan 04 cannot start without.

---

## Task 2: Public event queries

**Files:**
- Create: `src/lib/shared/public-event.ts` (types), `src/lib/server/public-events.ts`
- Create: `tests/lib/server/public-events.test.ts`

- [ ] **Step 1: Types in `shared/`, not `server/`**

`PublicEvent` and `AvailabilityBand` are needed by components, which may not
import from `@/lib/server/*`. Putting them in `server/` fails `pnpm lint`.

The shape must carry everything downstream needs:

```
id, slug, startsAt, venue, translation, imageUrl,
ticketTypeId,          // Plan 04's hold targets it
pricePln, priceEur,
maxPerOrder,           // Task 7 bounds the selector with it
available,             // capacity − soldCount − heldCount, floored at 0
band,                  // 'available' | 'few' | 'soldOut'
purchasable,
notPurchasableReason   // 'notYetOpen' | 'closed' | 'soldOut' | 'past' | null
```

`notPurchasableReason` is computed server-side so each of the four states gets
its own message without three pages re-deriving the rules.

- [ ] **Step 2: Write the tests first**

| Case | Expected |
|---|---|
| `DRAFT` | not listed, 404 by slug |
| `CANCELLED` | not listed, 404 by slug |
| `CLOSED` | **listed**, not purchasable — the concert still happens |
| `SOLD_OUT` | listed, not purchasable |
| `startsAt` in the past | **not listed** |
| `salesOpenAt` in the future | listed, not purchasable, reason `notYetOpen` |
| `salesCloseAt` in the past | listed, not purchasable, reason `closed` |
| `TicketType.active = false` | not purchasable |
| `available` | never negative |
| ordering | ascending by `startsAt` |
| translations | only the requested locale |

The past-date and `CLOSED` rows are new — the first draft of this plan had
neither, so concerts would have stayed listed and purchasable forever.

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/public-events.test.ts
```

Expected: failures. The module does not exist.

- [ ] **Step 3: Implement**

```
purchasable =
  status === 'ON_SALE'
  && startsAt > now
  && ticketType.active
  && (salesOpenAt === null || salesOpenAt <= now)
  && (salesCloseAt === null || salesCloseAt > now)
  && available > 0
```

`createEvent` always creates exactly one ticket type, and `updateEvent` uses
`updateMany`, so in practice there is one. Take the single **active** type; if a
future event has several, sum `soldCount`/`heldCount` and take the lowest
`maxPerOrder`. Ignoring `active` would render a working buy box that always
fails at checkout.

- [ ] **Step 4: Green**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/public-events.test.ts
```

---

## Task 3: Currency selection

**Files:**
- Modify: `src/lib/shared/money.ts`, `tests/lib/shared/money.test.ts`
- Create: `src/components/CurrencySwitcher.tsx`

- [ ] **Step 1: Extend `money.ts` — do not create `currency.ts`**

`money.ts` already exports `CURRENCIES` and `type Currency`, and already imports
`Locale`. A second module would create a structurally identical but distinct
`Currency` type, which then needs casting at every boundary.

Add `currencyForLocale(locale): Currency` — `pl → PLN`, `en → EUR`, `de → EUR`,
with an unknown or absent preference falling back to the locale default rather
than throwing.

- [ ] **Step 2: The switcher**

A Client Component writing a `km_currency` cookie, read server-side so the first
paint is correct.

This is what makes the shop dynamic, and that is accepted deliberately — see the
architecture note at the top. Do not try to keep both the cookie and static
prerendering; they are mutually exclusive.

- [ ] **Step 3: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/shared/money.test.ts
pnpm dev
```

Switch currency on `/pl` and `/en`. Prices change and survive navigation to a
concert page. **No FX conversion anywhere** — each concert carries two explicit
prices, and showing 11.37 EUR is exactly what that design prevents.

---

## Task 4: Message catalogues

`src/messages/{pl,en,de}.json` currently hold two namespaces and four strings.
Tasks 5–9 need programme copy, three availability bands, four not-purchasable
messages, roughly twelve form labels, every validation error, an empty state and
placeholder legal copy — in three languages.

`tests/i18n/messages.test.ts` fails on any key missing from any locale, so this
blocks four tasks at once if left implicit.

- [ ] **Step 1: Add every key, in all three locales, before building the UI**

- [ ] **Step 2: Decide who writes DE and EN**

Polish is the source language and the team's own. German and English placeholder
copy is fine for the build, but note where a native speaker still has to pass.

- [ ] **Step 3: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/i18n/messages.test.ts
```

---

## Task 5: Programme listing

**Files:**
- Modify: `src/app/(shop)/[locale]/page.tsx`
- Create: `src/components/EventCard.tsx`
- Create: `src/lib/shared/format.ts` + `tests/lib/shared/format.test.ts`

- [ ] **Step 1: Extract date formatting into a pure function**

`formatConcertDate(date, locale)` in `shared/`, using `BCP47[locale]` and
`TIMEZONE` from `src/lib/shared/locale.ts`. Formatting with the server's zone
rather than `Europe/Warsaw` is an hour out for half the year and correct for the
other half — the worst kind of bug, and the reason this is unit-tested rather
than eyeballed.

- [ ] **Step 2: Render the list**

Server Component. `setRequestLocale(locale)` **before** `getTranslations`.

Each card: date and time, venue, title, performers, price in the active
currency, availability band.

- [ ] **Step 3: Empty state**

No concerts on sale is the normal state for eleven months a year, not an error.
Real copy, all three languages.

- [ ] **Step 4: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/shared/format.test.ts
```

Then open `/pl`, `/en`, `/de` — translated titles, correct dates, past and
`DRAFT` concerts absent, `CLOSED` present but not purchasable.

---

## Task 6: Concert detail page

**Files:**
- Create: `src/app/(shop)/[locale]/koncert/[slug]/page.tsx`
- Create: `src/app/(shop)/[locale]/not-found.tsx`
- Create: `tests/app/shop/concert-detail.test.ts` *(server-side logic only)*

- [ ] **Step 1: The route**

The segment stays Polish (`/koncert/`) in all three locales. Translating route
segments triples the routing surface and breaks any link the Wix site has
already published.

- [ ] **Step 2: A localised 404**

There is **no `not-found.tsx` anywhere in the app**, and `(shop)` and `(admin)`
are two separate root layouts — so an unhandled 404 renders Next's built-in
untranslated page. Task 6 makes three 404 paths load-bearing, so add
`(shop)/[locale]/not-found.tsx` with copy in all three locales.

Unknown slug, `DRAFT` and `CANCELLED` must all `notFound()`. A draft concert
reachable by guessing its slug is a real leak — programme changes are sometimes
embargoed.

- [ ] **Step 3: Metadata**

`generateMetadata` with the translated title and description, and
`alternates.languages` for the other two locales.

This needs `metadataBase` to emit absolute URLs. Set it from
`NEXT_PUBLIC_SITE_URL`, which is `https://tickets-km.vercel.app` until launch —
**not** `bilety.krzyzowa-music.eu`, which `README.md` still advertises.

- [ ] **Step 4: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/app/shop/concert-detail.test.ts
```

---

## Task 7: Availability and the buy box

**Files:**
- Create: `src/components/AvailabilityBadge.tsx`, `src/components/BuyBox.tsx`
- Modify: `src/lib/shared/public-event.ts`
- Create: `tests/lib/shared/availability.test.ts`

- [ ] **Step 1: Bands as a pure function**

`availabilityBand(available, capacity)`:

| Remaining | Band |
|---|---|
| `0` | sold out |
| `≤ 10%` of capacity | few remaining |
| otherwise | available |

**Never display the exact number remaining.** It publishes your sales figures,
and "3 left" invites a stampede for a concert that then oversells under
contention.

- [ ] **Step 2: Quantity bounds as a pure function**

`quantityBounds(maxPerOrder, available)` → `min` of the two. `maxPerOrder` is
policy; `available` is physics.

The bound is a UI convenience. Plan 04 re-checks transactionally at order
creation, because between render and submit the concert can sell out. **Never
treat a client-side bound as an inventory guarantee.**

- [ ] **Step 3: The four not-purchasable states**

Each gets its own message from `notPurchasableReason`, not a disabled button:
not yet open (with the date), closed, sold out, past.

- [ ] **Step 4: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/shared/availability.test.ts
```

---

## Task 8: Terms and privacy pages

**Built before the form**, because the form's terms checkbox links to them. An
unlinked "I accept the terms" checkbox is worth nothing.

**Files:**
- Create: `src/app/(shop)/[locale]/regulamin/page.tsx`,
  `src/app/(shop)/[locale]/prywatnosc/page.tsx`

- [ ] **Step 1: Structure now, final text later**

The wording is the festival's lawyer's job. Build the pages with placeholder
copy clearly marked as such.

Stripe onboarding asks for these URLs, and selling to Polish consumers without a
`regulamin` is a legal problem — so the pages existing matters before the text
is final.

- [ ] **Step 2: Record what the privacy policy must eventually cover**

Given name-per-ticket, it now covers personal data of people who are **not** the
buyer. Task 1 Step 4 corrects `07-security-and-testing.md`; this is where the
user-facing consequence gets written down.

---

## Task 9: Buyer details form

The largest task, and the one the naming decision reshaped.

**Files:**
- Modify: `src/lib/shared/schemas.ts`
- Create: `src/app/(shop)/[locale]/koncert/[slug]/zamowienie/page.tsx`,
  `src/components/CheckoutForm.tsx`
- Create: `tests/lib/shared/checkout-schema.test.ts`

- [ ] **Step 1: Define how quantity reaches this route**

The buy box is on the concert page; the form is on a child route. The contract:
**`?q=N` in the URL**.

`q` is user-controlled, so the page **re-validates and re-clamps it server-side**
against `min(maxPerOrder, available)` — never trusting the query string. Handle
missing, non-numeric, zero, negative, and larger-than-available (clamp and say
so, rather than erroring).

Without this, `attendeeNames.length === quantity` has no server-side referent.

- [ ] **Step 2: The schema — field names must match `Order`**

In `shared/`, because Plan 04's server action validates with the same schema.
The first draft used names that did not exist on the table; these do:

| Field | Rule |
|---|---|
| `email` | required, `z.email()` — Zod 4, not `z.string().email()` |
| `firstName`, `lastName` | required |
| `phone` | optional |
| `attendeeNames` | array, length **exactly** `quantity`, each non-empty, trimmed, length-capped |
| `needsInvoice` | boolean |
| `companyName`, `nip`, `invoiceAddress` | required **only when** `needsInvoice` |
| `acceptedTerms` | must be `true` (form-only, no column) |
| `ticketTypeId`, `quantity`, `locale`, `currency` | carried for Plan 04 |

The length cap on names is not cosmetic: the name lands in a fixed-width
`pdf-lib` layout in Plan 05 and must survive latin-ext characters.

Conditional invoice fields use `superRefine` or a discriminated union — optional
fields that become required are a classic source of forms that silently accept
nothing.

- [ ] **Step 3: The form**

`react-hook-form` with the zod resolver. Changing quantity adds or removes name
fields; **existing entries must survive the change.** A buyer who types four
names, corrects the quantity to five and loses all four will not try again.

- [ ] **Step 4: Errors in the buyer's language**

Messages come from the catalogues added in Task 4, not hardcoded English.

- [ ] **Step 5: Submission is a stub**

On valid submit, log and show a placeholder. **Do not create an `Order`.**

```ts
// PLAN-04: replace with createOrder() — see steps/04-inventory.md
```

- [ ] **Step 6: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/shared/checkout-schema.test.ts
```

Then in the browser: submit empty (all errors, right language); three of four
names filled (rejected); tick invoice (fields appear, required); tamper with
`?q=99` (clamped, not accepted); fill correctly (stub message).

---

## Task 10: Site chrome

The terms and privacy pages currently have no route into them except a checkout
checkbox, and the shop should read as continuous with the Wix site.

- [ ] **Step 1: A footer** on every shop page, linking terms, privacy and back
  to `krzyzowa-music.eu`.
- [ ] **Step 2: `robots.txt`** — decide whether to allow indexing before launch.
  A test catalogue with placeholder legal text on a public URL probably should
  not be indexed yet.
- [ ] **Step 3: Concert images.** `Event.imageUrl` exists with no upload path.
  Render it when present with a sensible fallback; decide in Plan 04 whether
  admins paste URLs or upload files. This is the release people actually look
  at, so it should not ship with empty cards.

---

## Task 11: Responsive and accessibility pass

Most buyers arrive from a phone, often from a link on the Wix site.

- [ ] **Step 1: Widths — including 320px**

`10-design-system.md` names the real failure case: the word
`Kammermusikfestival` at **320px**. Check 320, 360, 768 and 1280.

Apply the documented tokens rather than inventing values: `--measure-page`
(1200px) for the listing, `--measure-prose` (65ch) for descriptions,
`--measure-form` (800px) for checkout. The listing goes from a grid to a
**stacked list** — explicitly not a horizontally scrolling carousel. No shadows.

- [ ] **Step 2: Touch and iOS**

48px minimum touch targets; inputs at `font-size: 1rem` or iOS zooms on focus.
The quantity selector and the name fields break first at narrow widths.

- [ ] **Step 3: Keyboard and screen reader**

Tab the whole flow. Every field labelled; errors wired with `aria-describedby`
and `aria-invalid`; the availability badge not colour-only — "sold out" must
survive being read aloud or seen by someone colour-blind.

- [ ] **Step 4: Polish diacritics**

`ł ą ę ś ć ż ź ó ń` in every weight used. Plan 01 verified the `latin-ext`
subset is present; this checks it is actually applied.

---

## Task 12: Full verification

- [ ] **Step 1: The database must be running**

```bash
docker compose up -d
```

New in this plan: `next build` now prerenders pages that query the database, so
the build fails without one. It did not before, because no page touched it.

- [ ] **Step 2: Clean-tree gate**

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

`pnpm lint` matters more than usual here — it is what catches a component
importing from `@/lib/server/*`.

- [ ] **Step 3: Twice**

```bash
pnpm test && pnpm test
```

This plan adds tests asserting exact row counts against a shared database.
Ordering bugs appear only on the second run.

- [ ] **Step 4: Confirm the build output — and the changed expectation**

The shop routes now render **dynamically (`ƒ`)**, not as static/SSG. That is the
intended consequence of live availability and the currency cookie.

**Update `plan/STATUS.md`**, which currently records "all three locales
prerendered" as a Plan 02 result. It was true then and is not now.

- [ ] **Step 5: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: public programme, concert pages and checkout form"
```

---

## Definition of done

- [ ] Programme lists `ON_SALE`, `SOLD_OUT` and `CLOSED` concerts, future only, by date
- [ ] `DRAFT` and `CANCELLED` 404 by direct slug, via a localised `not-found`
- [ ] Past concerts disappear from the listing
- [ ] All three locales render with translated content and correct `lang`
- [ ] Dates display in Warsaw local time, in the locale's format, unit-tested
- [ ] Both currencies display, defaulting from locale, switchable, persisted
- [ ] No FX conversion anywhere
- [ ] Availability shows as a band, never an exact count
- [ ] Quantity bounded by `maxPerOrder` **and** remaining capacity
- [ ] `?q=` re-validated and clamped server-side
- [ ] All four not-purchasable states have their own message
- [ ] An inactive `TicketType` never renders a working buy box
- [ ] Exactly one name field per ticket; quantity changes preserve typed entries
- [ ] Schema field names match the `Order` columns they will populate
- [ ] Invoice fields required only when invoicing is requested
- [ ] Validation errors in the buyer's language
- [ ] Terms and privacy pages exist in three languages, linked from footer and form
- [ ] Usable at 320px and by keyboard
- [ ] Design-system measures and touch targets applied
- [ ] `pnpm lint` green — no component imports `@/lib/server/*`
- [ ] Clean-tree gate green; suite green twice
- [ ] Design documents corrected for name-per-ticket (Task 1)
- [ ] `STATUS.md` updated: the shop is dynamic, not prerendered
- [ ] **No `Order` row is created anywhere in this plan**

---

## What this plan does not cover

- **Order creation, capacity holds, the `heldCount` lifecycle** — Plan 04, the
  transactional core, with its own concurrency tests.
- **Hold duration by venue size** — still open in `09-open-questions.md` and
  **Plan 04 cannot start without it.** A flat 30 minutes means 300 people can
  hold every seat of a 300-seat concert while everyone else sees "sold out".
- **`Order.reference` format** and **`updateEvent` refusing price changes while
  `heldCount > 0`** — flagged in `01-foundations.md`'s closing notes under the
  *old* numbering, where "Plan 03" meant the inventory plan. Both are Plan 04.
- **Stripe and payment** — Plan 05.
- **Promo codes at checkout** — Plan 06. The field slots into the form later.
- **Final legal text** for terms and privacy.
- **An image upload path** — Plan 04 decides pasted URLs versus uploads.
