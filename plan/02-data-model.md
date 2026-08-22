# 02 — Data model

PostgreSQL via Prisma. All money is stored as **integers in minor units**
(grosze / eurocents). Floating-point money is how you end up three groszy short
at year end.

## Entities

Two enumerated types are used throughout rather than free-form strings:
`Locale` (`pl` | `en` | `de`) and `Currency` (`PLN` | `EUR`). The design fixes
both sets exactly, and a stray `"eur"` reaching the database would surface much
later as a rendering crash.

```
Venue
  id, name, address, city, defaultCapacity, mapUrl?

Event
  id, slug (unique)
  venueId → Venue
  startsAt, doorsAt?
  capacity                             ← the real limit for the room
  status: DRAFT | ON_SALE | SOLD_OUT | CLOSED | CANCELLED
  salesOpenAt?, salesCloseAt?
  imageUrl?
  createdAt, updatedAt

EventTranslation
  eventId, locale: Locale              ← unique together
  title, description, performers, note?

TicketType
  id, eventId → Event
  pricePln, priceEur                   ← two explicit prices, minor units
  maxPerOrder (default 10)
  soldCount, heldCount                 ← denormalised; the concurrency guard
  active

Order
  id (uuid)
  reference                            ← human-readable, e.g. "KM-2026-000137"
  kind: PURCHASE | INVITATION
  email, firstName, lastName, phone?
  locale: Locale, currency: Currency   ← frozen at creation
  subtotal, discount, total            ← minor units, server-computed
  status: PENDING | PAID | FAILED | EXPIRED | CANCELLED
        | REFUNDED | PARTIALLY_REFUNDED
  stripePaymentIntentId (unique, nullable)
  promoCodeId? → PromoCode
  needsInvoice, companyName?, nip?, invoiceAddress?
  issuedByAdminId?                     ← set for invitations
  createdAt, holdExpiresAt?, paidAt?, emailSentAt?, cancelledAt?

OrderItem
  id, orderId → Order, ticketTypeId → TicketType
  quantity
  unitPrice, currency: Currency        ← PRICE SNAPSHOT at purchase time

Ticket
  id (uuid)
  code (unique)                        ← 128-bit random; this is the QR payload
  orderId → Order, eventId → Event, ticketTypeId → TicketType
  holderName?
  status: VALID | USED | REVOKED
  usedAt?, usedByAdminId?
  createdAt

PromoCode
  id, code (unique, stored uppercase)
  kind: PERCENT | FIXED
  value                                ← percent 1–100, or minor units if FIXED
  currency: Currency?                  ← required when kind = FIXED
  maxUses?, usedCount
  validFrom?, validUntil?
  eventId?                             ← null means "all events"
  active

AdminUser
  id, email (unique, stored lowercase), passwordHash, name
  role: ADMIN | SCANNER
  active, lastLoginAt?
  failedLoginCount, lockedUntil?      ← per-account lockout

AdminSession
  id, tokenHash (unique)               ← SHA-256 of an opaque random token
  adminUserId → AdminUser
  expiresAt, createdAt

StripeWebhookEvent
  stripeEventId (primary key)          ← the idempotency ledger
  type, receivedAt, processedAt?, error?

AuditLog
  id, actorId? → AdminUser, action, entityType, entityId, meta (json), createdAt
```

## Decisions embedded in this schema

**There is no `User` table.** The original `plan.md` had one. With guest
checkout the buyer *is* the order: email and name live on `Order`. A user table
we never authenticate against is dead weight and a GDPR liability.

**Invitations reuse `Order`** with `kind = INVITATION` and `total = 0`. This is
the single most load-bearing modelling decision in the document: it means there
is *one* ticket-generation path, *one* revocation path, *one* CSV export and
*one* email pipeline. A parallel "Invitation" system would drift from the
purchase system within weeks.

**`TicketType` exists even though there is one price per concert.** It starts
with exactly one row per event, named "Normal". Adding a reduced/student price
later then becomes a configuration change rather than a migration that has to
touch completed orders. The cost today is one join.

**Sessions are stored in the database, not in a JWT.** `AdminSession` holds
the SHA-256 hash of an opaque random token — so a database leak does not hand
the attacker working sessions — and a session can be revoked instantly. That
last property is the deciding one: a phone handed to a door volunteer must be
revocable the moment it goes missing, and a stateless JWT cannot be withdrawn
before it expires.

**Prices are snapshotted onto `OrderItem`.** Editing a concert's price must
never retroactively change what a completed order says it cost. The `Order`
totals are also stored, so a historical order can be rendered without
recomputing anything.

**`soldCount` and `heldCount` are denormalised onto `TicketType`.** They could
be derived by counting rows, but the atomic capacity check in
[03](03-purchase-flow.md) depends on updating a single row conditionally. This
is the mechanism that prevents overselling a 900-seat venue.

## Invariants

These are enforced in code and asserted in tests. Violations are bugs, not edge
cases.

1. `soldCount + heldCount <= capacity` for every `TicketType`, always.
2. An `Order` in `PENDING` holds `sum(items.quantity)` against `heldCount`.
   An `Order` in `PAID` holds the same quantity against `soldCount`. It is never
   counted in both.
3. `Ticket` rows exist **only** for orders in `PAID`, `REFUNDED` or
   `PARTIALLY_REFUNDED`. A pending order has no tickets.
4. `stripePaymentIntentId` is unique and never reused across orders.
5. A `Ticket` transitions `VALID → USED` exactly once. The transition is atomic.
6. `Order.currency` never changes after creation. Refunds use it.
7. Every `PromoCode` use is counted at hold time and released if the hold
   expires — otherwise a code with `maxUses = 50` can be redeemed 200 times by
   50 people opening checkout simultaneously.

## Indexes worth having from the start

```
Event(status, startsAt)             — the program listing
Event(slug)                         — unique, concert page lookup
EventTranslation(eventId, locale)   — unique
Order(reference)                    — unique, order status page
Order(email)                        — admin search
Order(status, holdExpiresAt)        — the hold-expiry cron
Ticket(code)                        — unique, the scan hot path
Ticket(eventId, status)             — check-in statistics
PromoCode(code)                     — unique
AdminSession(tokenHash)             — unique, every authenticated request
AdminSession(expiresAt)             — the session cleanup job
```

`Ticket(code)` is the only index in the hot path during check-in — a queue of
900 people scanning is the highest-throughput moment the system ever sees, and
it is a single indexed lookup plus a conditional update.

## Retention

Buyer PII (`email`, names, phone, invoice details) is anonymised on `Order` a
configurable period after the last concert of an edition — see
[07](07-security-and-testing.md). Ticket and financial records are retained, so
accounting and attendance statistics survive anonymisation.
