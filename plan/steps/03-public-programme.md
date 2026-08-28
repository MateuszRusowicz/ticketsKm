# Plan 03 — Public programme

**Goal:** a visitor browses the concert programme in Polish, English and German,
in either currency, sees honest availability, and reaches a validated checkout
form. **Nothing is charged and no order is created** — that is Plan 04.

**Architecture:** everything here is a Server Component reading through a new
`src/lib/server/public-events.ts`, except the three genuinely interactive
pieces — the currency switcher, the quantity selector and the buyer form —
which are Client Components. Public pages must stay statically renderable per
locale where possible, so `setRequestLocale` is called before any translation
lookup.

**Spec:** [`../08-implementation-phases.md`](../08-implementation-phases.md)
Phase 2, [`../03-purchase-flow.md`](../03-purchase-flow.md),
[`../10-design-system.md`](../10-design-system.md).

**Depends on:** Plan 01 (schema, i18n, design tokens). Plan 02 is **not** a
dependency — this can be built and tested entirely locally.

---

## Global Constraints

- **One concert per order.** Decided 27 Aug 2026. There is no cart, no
  cross-event availability check and no cart page. A buyer wanting three
  concerts goes through this flow three times. Do not build cart state "just in
  case" — the schema already supports multi-item orders if the decision is ever
  revisited.
- **A name per ticket.** Decided 27 Aug 2026, against the recommendation on
  file. The form collects one name per admission, so quantity drives the number
  of name fields. `Ticket.holderName` already exists as a nullable column.
- **The form does not submit anywhere yet.** Plan 03 ends at a *validated* form.
  Wiring it to order creation is Plan 04, and doing it early means writing the
  capacity-holding logic without the transactional tests that make it safe.
- **Money is integer minor units everywhere.** `pricePln` and `priceEur` are
  grosze and cents. Never store or compute in decimals; format only at the edge
  with `formatMoney`.
- **Availability is `capacity − soldCount − heldCount`.** Read it, never write
  it here. `heldCount` is maintained by Plan 04.
- **Public pages must not import from `src/lib/server/` into client code.**
  Every server module starts with `import 'server-only'`; a stray import in a
  `"use client"` file fails the build, which is the point.
- **Commits are made by the human operator.**

---

## Task 1: Public event queries

The admin already has `src/lib/server/events.ts` for writes. Reads for the
public side are a different shape — filtered by status and sales window, joined
to one locale's translation, and never exposing draft or cancelled concerts.

**Files:**
- Create: `src/lib/server/public-events.ts`
- Create: `tests/lib/server/public-events.test.ts`

- [ ] **Step 1: Write the tests first**

Cover the filtering rules, because these are the ones that leak data if wrong:

| Case | Expected |
|---|---|
| `status: DRAFT` | not listed, not reachable by slug |
| `status: CANCELLED` | not listed |
| `status: ON_SALE`, `salesOpenAt` in the future | listed, but not purchasable |
| `salesCloseAt` in the past | listed, not purchasable |
| `status: SOLD_OUT` | listed, shown as sold out |
| ordering | ascending by `startsAt` |
| translations | only the requested locale is returned |
| availability | `capacity − soldCount − heldCount`, never negative |

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/public-events.test.ts
```

Expected: failures — the module does not exist yet.

- [ ] **Step 2: Implement the module**

Two exports and one derived type:

```ts
export type PublicEvent = { /* id, slug, startsAt, venue, translation, price, availability, purchasable */ }

export async function listPublicEvents(locale: Locale): Promise<PublicEvent[]>
export async function getPublicEvent(slug: string, locale: Locale): Promise<PublicEvent | null>
```

`purchasable` is computed once, server-side, and is the single thing the UI
checks. Deriving it in the component instead means three pages each getting the
sales-window logic slightly differently.

```
purchasable =
  status === 'ON_SALE'
  && (salesOpenAt === null || salesOpenAt <= now)
  && (salesCloseAt === null || salesCloseAt > now)
  && available > 0
```

- [ ] **Step 3: Green**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/server/public-events.test.ts
```

Expected: all passing.

---

## Task 2: Currency selection

Currency defaults from locale and is overridable. It is **not** stored in the
database at this stage — Plan 04 freezes it onto the order.

**Files:**
- Create: `src/lib/shared/currency.ts`, `src/components/CurrencySwitcher.tsx`
- Create: `tests/lib/shared/currency.test.ts`

- [ ] **Step 1: Test the mapping**

| Locale | Default currency |
|---|---|
| `pl` | PLN |
| `en` | EUR |
| `de` | EUR |

Also test that an unknown or absent stored preference falls back to the locale
default rather than throwing.

- [ ] **Step 2: Implement**

`currencyForLocale(locale): Currency` in `shared/` — it is needed by both server
components and the client switcher, so it cannot live in `server/`.

The switcher is a Client Component holding the choice in a cookie
(`km_currency`), read server-side so the first paint is already correct. A
`useState`-only switcher flashes the wrong price on every navigation.

- [ ] **Step 3: Verify both currencies render**

```bash
pnpm dev
```

Open `/pl` and switch to EUR; open `/en` and switch to PLN. Prices must change
without a full reload and survive navigation to a concert page.

**Do not** convert between currencies anywhere. Each concert carries two
explicit prices; showing 11.37 EUR because someone divided by 4.3 is precisely
what the two-price design exists to prevent.

---

## Task 3: Programme listing page

**Files:**
- Modify: `src/app/(shop)/[locale]/page.tsx`
- Create: `src/components/EventCard.tsx`
- Create: `tests/app/shop/programme.test.ts`

- [ ] **Step 1: Render the list**

Server Component. `setRequestLocale(locale)` **before** `getTranslations`, or
the page opts out of static rendering silently.

Each card shows: date and time in Warsaw local time, venue, title, performers,
price in the active currency, and an availability badge.

- [ ] **Step 2: Dates in the right language and zone**

Use `BCP47[locale]` and `TIMEZONE` from `src/lib/shared/locale.ts`. A date
formatted with the server's zone rather than `Europe/Warsaw` will be an hour out
for half the year and look correct for the other half — the worst kind of bug.

- [ ] **Step 3: Empty state**

No concerts on sale is a normal state for eleven months of the year, not an
error. It needs real copy in all three languages, not a blank page.

- [ ] **Step 4: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/app/shop/programme.test.ts
```

Then open `/pl`, `/en`, `/de` and confirm each lists the seeded concerts with
translated titles and correctly formatted dates.

---

## Task 4: Concert detail page

**Files:**
- Create: `src/app/(shop)/[locale]/koncert/[slug]/page.tsx`
- Create: `tests/app/shop/concert-detail.test.ts`

- [ ] **Step 1: The route**

The URL segment stays Polish (`/koncert/`) in all three locales. Translating
route segments per locale triples the routing surface and breaks any link the
Wix site has already published.

- [ ] **Step 2: 404 correctly**

An unknown slug, a `DRAFT` concert and a `CANCELLED` concert must all produce
`notFound()`. A draft concert reachable by guessing its slug is a real leak —
programme changes are sometimes embargoed.

- [ ] **Step 3: Metadata**

`generateMetadata` with the translated title and description, and
`alternates.languages` pointing at the other two locales. This is most of the
SEO value of having localised URLs at all.

- [ ] **Step 4: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/app/shop/concert-detail.test.ts
```

Expected: passing, including the three 404 cases.

---

## Task 5: Availability and the buy box

**Files:**
- Create: `src/components/AvailabilityBadge.tsx`, `src/components/BuyBox.tsx`
- Create: `tests/components/availability.test.ts`

- [ ] **Step 1: Availability thresholds**

| Remaining | Shown as |
|---|---|
| `0` | sold out |
| `≤ 10%` of capacity | few remaining |
| otherwise | available |

**Never display the exact number remaining.** It tells a competitor your sales
figures, and "3 left" invites a stampede for a concert that then oversells
under contention.

- [ ] **Step 2: The quantity selector**

Bounded by `min(ticketType.maxPerOrder, available)`. Both bounds matter:
`maxPerOrder` is policy, `available` is physics.

The bound is a UI convenience only. Plan 04 re-checks it transactionally at
order creation, because between render and submit the concert can sell out.
Never treat a client-side bound as an inventory guarantee.

- [ ] **Step 3: Not-purchasable states**

Each needs its own message, not a disabled button: sales not yet open (with the
opening date), sales closed, sold out, cancelled.

- [ ] **Step 4: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/components/availability.test.ts
```

---

## Task 6: Buyer details form

The largest task, and the one the attendee-name decision changed.

**Files:**
- Create: `src/app/(shop)/[locale]/koncert/[slug]/zamowienie/page.tsx`
- Create: `src/components/CheckoutForm.tsx`
- Modify: `src/lib/shared/schemas.ts`
- Create: `tests/lib/shared/checkout-schema.test.ts`

- [ ] **Step 1: The schema first**

In `shared/`, because Plan 04's server action will validate with the same
schema. Zod 4 — `z.email()`, not the deprecated `z.string().email()`.

| Field | Rule |
|---|---|
| `email` | required, `z.email()` |
| `buyerName` | required |
| `phone` | optional |
| `attendeeNames` | array, length **exactly** equals quantity, each non-empty |
| `wantsInvoice` | boolean |
| `companyName`, `nip`, `address` | required **only when** `wantsInvoice` |
| `acceptsTerms` | must be `true` |

`attendeeNames` length tied to quantity is the rule most likely to be got wrong,
because quantity lives in a different component. Test it directly.

Invoice fields use a discriminated union or `superRefine` — optional fields that
become required are a common source of forms that silently accept nothing.

- [ ] **Step 2: The form**

`react-hook-form` with the zod resolver. Changing quantity adds or removes name
fields; **existing entries must survive the change**. A buyer who types four
names, corrects the quantity to five and loses all four will not try again.

- [ ] **Step 3: Errors in the buyer's language**

Zod messages come from the message catalogues, not hardcoded English. Every new
key needs all three locales — `tests/i18n/messages.test.ts` already fails on a
missing key, which is the point of it.

- [ ] **Step 4: Submission is a stub**

On valid submit, log the payload and show a placeholder. **Do not create an
Order.** Leave an explicit marker:

```ts
// PLAN-04: replace with createOrder() — see steps/04-inventory.md
```

- [ ] **Step 5: Verify**

```bash
pnpm exec dotenv -e .env.test -- vitest run tests/lib/shared/checkout-schema.test.ts
```

Then in the browser: submit empty (all errors, in the right language), submit
with three of four names filled (rejected), tick "invoice" (fields appear and
are required), fill correctly (accepted, stub message).

---

## Task 7: Terms and privacy pages

Not optional and not cosmetic: Stripe onboarding asks for these URLs, and
selling to consumers in Poland without a `regulamin` is a legal problem.

**Files:**
- Create: `src/app/(shop)/[locale]/regulamin/page.tsx`,
  `src/app/(shop)/[locale]/prywatnosc/page.tsx`

- [ ] **Step 1: Structure now, final text later**

The final wording is the festival's lawyer's job, not the developer's. Build the
pages with placeholder copy clearly marked as such, so the structure and links
exist and the text can be dropped in.

- [ ] **Step 2: Link them from the checkout form**

The terms checkbox must link to the actual page. An unlinked "I accept the
terms" checkbox is worth nothing.

- [ ] **Step 3: Note what the privacy policy must eventually say**

Given the name-per-ticket decision, it now covers personal data of people who
are **not** the buyer. Record this for Plan 08's RODO work rather than
discovering it during a launch review.

---

## Task 8: Responsive and accessibility pass

Most buyers arrive from a phone, often from a link in the Wix site on mobile.

- [ ] **Step 1: Three widths**

360px, 768px, 1280px. The quantity selector and the name fields are where a
narrow layout breaks first.

- [ ] **Step 2: Keyboard and screen reader**

Tab through the whole flow. Every field labelled; errors linked with
`aria-describedby`; the availability badge not colour-only — "sold out" must
survive being read aloud or seen by someone colour-blind.

- [ ] **Step 3: Polish diacritics**

Confirm `ł ą ę ś ć ż ź ó ń` render in every weight used. Plan 01 verified the
`latin-ext` subset is present; this is the check that it is actually applied.

---

## Task 9: Full verification

- [ ] **Step 1: Clean-tree gate**

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all green. A warm tree hides the Next 16 generated-type failures that
only appear in CI.

- [ ] **Step 2: Run the tests twice**

```bash
pnpm test && pnpm test
```

This plan adds tests that assert exact row counts against a shared database.
Ordering bugs only appear on the second run.

- [ ] **Step 3: Confirm the build output**

Expected in the route table: `/[locale]` and `/[locale]/koncert/[slug]` present,
`/pl`, `/en`, `/de` prerendered, and the admin routes unchanged.

- [ ] **Step 4: Commit** *(human operator)*

```bash
git add -A
git commit -m "feat: public programme, concert pages and checkout form"
```

---

## Definition of done

- [ ] Programme lists only `ON_SALE` and `SOLD_OUT` concerts, ordered by date
- [ ] `DRAFT` and `CANCELLED` concerts 404 by direct slug
- [ ] All three locales render with translated content and correct `lang`
- [ ] Dates display in Warsaw local time in the locale's format
- [ ] Both currencies display, defaulting from locale, switchable, persisted
- [ ] No FX conversion anywhere
- [ ] Availability shows as a band, never an exact count
- [ ] Quantity is bounded by both `maxPerOrder` and remaining capacity
- [ ] Every not-purchasable state has its own message
- [ ] The form collects exactly one name per ticket, and quantity changes do not
      destroy entries already typed
- [ ] Invoice fields are required only when invoicing is requested
- [ ] Validation errors appear in the buyer's language
- [ ] Terms and privacy pages exist in all three languages and are linked
- [ ] Usable at 360px and by keyboard
- [ ] Clean-tree gate green; test suite green twice
- [ ] **No `Order` row is created anywhere in this plan**

---

## What this plan does not cover

- **Order creation, capacity holds and the `heldCount` lifecycle** — Plan 04.
  This is the risky, transactional core and needs its own concurrency tests.
- **Stripe and payment** — Plan 05.
- **Promo codes at checkout** — Plan 06. The field can be added to the form
  later without reshaping it.
- **Final legal text** for the terms and privacy pages.
- **Concert images.** `Event.imageUrl` exists but no upload path does. Decide in
  Plan 04 whether images are URLs pasted by an admin or uploaded files.
