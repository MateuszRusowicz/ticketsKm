# Krzyżowa Music — Ticketing System

Design & implementation plan for the ticket sales application hosted at
`bilety.krzyzowa-music.eu`, linked from the main Wix site.

**Status:** design in progress. Sections 1–2 reviewed with the product owner;
sections 3–8 drafted and awaiting review.

**Current state: [STATUS.md](STATUS.md)** — read this first if you are returning
to the project. To resume in a fresh session, [RESUME.md](RESUME.md) has a
paste-able prompt.

## Documents

| # | Document | What it covers |
|---|---|---|
| 00 | [Decisions](00-decisions.md) | Every settled decision + the reasoning. Read this first. |
| 01 | [Architecture](01-architecture.md) | Stack, repo layout, server/client boundary |
| 02 | [Data model](02-data-model.md) | Prisma schema, entities, invariants |
| 03 | [Purchase flow](03-purchase-flow.md) | Checkout, Stripe, capacity concurrency, webhooks, fulfilment |
| 04 | [Invitations, promo codes, refunds](04-invitations-promo-refunds.md) | Free tickets and money going back out |
| 05 | [Admin & scanner](05-admin-and-scanner.md) | Back-office and door check-in |
| 06 | [i18n, email, PDF](06-i18n-email-pdf.md) | 3 languages, 2 currencies, ticket delivery |
| 07 | [Security & testing](07-security-and-testing.md) | Threat model, checklist, test strategy |
| 08 | [Implementation phases](08-implementation-phases.md) | Step-by-step build order with acceptance criteria |
| 09 | [Open questions](09-open-questions.md) | Blocking and non-blocking decisions still needed |
| 10 | [Design system](10-design-system.md) | Colour, typography, spacing, components, Stripe theming |

## Executable plans

The documents above are the design. [`steps/`](steps/) holds the step-by-step
implementation plans derived from them — each step has a command to run and an
expected result, so progress is verified rather than assumed.

| Plan | Covers | Done when |
|---|---|---|
| [01 — Foundations](steps/01-foundations.md) ✅ | Phases 0–1 | An admin logs in and creates a concert in three languages |
| [02 — Deployment](steps/02-deployment.md) | Phase 0 infra | The app runs at `bilety.krzyzowa-music.eu` with a verified backup |
| [03 — Public programme](steps/03-public-programme.md) | Phase 2 | A visitor browses in 3 languages and reaches a validated form |
| 04 — Inventory | Phase 3 | Concurrency tests prove the system cannot oversell |
| 05 — Payments | Phases 4–5 | A real test payment produces a ticket email with a scannable QR |
| 06 — Money out | Phase 6 | Invitations, promo codes and refunds work without the Stripe dashboard |
| 07 — Scanner | Phase 7 | Two phones scan one ticket; exactly one shows green |
| 08 — Launch | Phase 8 | A live transaction succeeds and is refunded. Also the only slot for CSP, shared rate limiting and the RODO retention job |

Plan 02 can run at any point after Plan 01 — nothing later depends on it, so
deploy when you want a preview URL rather than because the sequence says so.

Plans 02–07 are written just before each is executed, so they reflect the code
that actually exists rather than the code that was imagined eight weeks earlier.

[plan.md](plan.md) is the original Polish sketch that started this. It is kept for
reference; where it disagrees with these documents, these documents win. The
notable divergences are listed in [00-decisions.md](00-decisions.md).

## The system in one paragraph

A single Next.js application sells general-admission tickets to roughly 10
concerts held every August, in three languages (PL/EN/DE) and two currencies
(PLN/EUR), taking payment through Stripe with local payment methods (BLIK,
Przelewy24, Klarna, cards). On successful payment it generates tickets with
unguessable QR codes, emails them as a PDF plus a web link, and lets festival
staff scan them at the door from a phone. Staff also issue free invitations,
manage promo codes, and refund orders from an authenticated admin area.

## Constraints that shaped everything

- **Seasonal load.** All sales concentrate around August; ~9 months of near-zero
  traffic. Drove the choice of managed hosting over a VPS.
- **Venue capacities of 300 and 900.** Real concurrent buying near sellout, so
  capacity enforcement must be transactional from day one.
- **90% of buyers are in Poland and Germany.** Local payment methods are not
  optional, and they constrain the currency design.
- **Timeline: 2–3 months** to live ticket sales.
