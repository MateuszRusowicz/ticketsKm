# 03 — Purchase flow

This is the critical path. Everything here is designed around two failure modes
that matter more than all others: **overselling a concert**, and **taking money
without delivering a ticket**.

## The happy path

```
1. Buyer browses /pl/koncert/kwartet-slaski
2. Picks quantity (1..maxPerOrder), enters email + name,
   optionally a promo code and invoice details
3. POST /api/checkout
     └─ server: validate → HOLD capacity → create PENDING order
                → compute total FROM THE DATABASE
                → create Stripe PaymentIntent
                → return { clientSecret, reference }
4. Client renders Stripe Payment Element
     └─ methods offered are decided by Stripe from currency + buyer country
5. Buyer confirms (card / BLIK / Przelewy24 / Klarna)
     └─ return_url = /pl/order/KM-2026-000137
6. Order page shows PENDING → polls until PAID
     (fulfilment NEVER happens from the client)
7. Stripe → POST /api/webhooks/stripe  payment_intent.succeeded
     └─ verify signature → record event id → FULFIL
8. Fulfilment: PAID, held→sold, generate tickets, render PDF, send email
```

Step 6 deserves emphasis: **the browser never triggers fulfilment.** A buyer who
closes the tab, loses signal, or has their bank redirect fail still gets their
ticket, because the webhook is the only thing that grants it.

## Preventing oversell

The naive approach — count sold tickets, compare to capacity, then insert — has
a race window between the count and the insert. With a 900-seat venue and a
publicised on-sale time, that window *will* be hit.

Instead, capacity is claimed with a **single conditional UPDATE** that is atomic
by definition:

```sql
UPDATE ticket_type
   SET held_count = held_count + $qty
 WHERE id = $ticketTypeId
   AND active = true
   AND sold_count + held_count + $qty <= $capacity
RETURNING *;
```

If it returns zero rows, there was not enough capacity, and the checkout is
rejected with "only N tickets left". No explicit locking, no transaction
isolation tuning, no retry loop. The database decides, once.

The hold and the order creation happen in one Prisma transaction, so a failure
after the hold cannot leak capacity.

### Lifecycle of held capacity

```
        checkout            payment succeeded
  free ──────────► held ──────────────────────► sold
                    │                             │
                    │ hold expires (30 min)       │ refund
                    │ or payment fails            │
                    ▼                             ▼
                   free ◄────────────────────── free
```

**Hold duration: 30 minutes.** It must comfortably exceed the slowest payment
method. BLIK codes have a short confirmation window, Przelewy24 involves a bank
redirect, and Klarna can take longer still. Thirty minutes is safe; ten is not.

**Expiry** is handled by a sweep every 5 minutes. Responsibilities are split
across three plans — do not implement a later plan's step early:

> **Plan 04's sweep** finds `PENDING` orders where `holdExpiresAt < now()`
> **AND `stripePaymentIntentId IS NULL`**, decrements `heldCount`, marks the
> order `EXPIRED`, and writes an audit entry. Plan 04 ships the callable
> function plus a `pnpm holds:sweep` script; it wires no schedule.
>
> **Plan 05's sweep** wraps Plan 04's through the `beforeRelease` hook and
> cancels the Stripe `PaymentIntent` **before** the hold is released, so a late
> confirmation cannot succeed against seats already resold. Plan 05 also owns
> the route handler and the `vercel.json` schedule. The `IS NULL` clause above
> is what keeps Plan 04's sweep from expiring Przelewy24 / Klarna / SEPA
> orders, which legitimately sit in `processing` for minutes to days.
>
> **Plan 06's sweep** additionally decrements a promo code's `usedCount` when
> the expired order carried one. No `Order` created by Plan 04 has a
> `promoCodeId`, so this is inert until then.

The original five-step list follows, and describes the **fully assembled**
sweep once all three plans have landed:

1. Find orders where `status = PENDING AND holdExpiresAt < now()`.
2. Decrement `heldCount` by the order quantity.
3. Decrement the promo code's `usedCount` if one was applied.
4. Set the order to `EXPIRED`.
5. **Cancel the Stripe PaymentIntent** so a late confirmation cannot succeed.

Step 5 is easy to forget and causes the nastiest bug in the system: a buyer pays
15 seconds after their hold expired, on a concert that has since sold out.

### The oversell race, handled explicitly

Even with cancellation there is a window where a payment succeeds for an expired
hold. The webhook handler therefore re-checks capacity before fulfilling:

- **Capacity available** → re-claim it and fulfil normally. The buyer never knows.
- **No capacity** → automatically refund the PaymentIntent in full, set the
  order to `CANCELLED`, email the buyer an apology in their language, and write
  an `AuditLog` entry. Staff see it on the dashboard.

Automatically refunding is the right behaviour: the alternative is a person
standing at the door of a full room holding a ticket the system sold them.

## The checkout submission

**A server action, not an HTTP endpoint.** The application uses server actions
everywhere — login, admin CRUD — and has no `src/app/api/` directory at all.
Checkout is colocated with the order page at
`src/app/(shop)/[locale]/koncert/[slug]/zamowienie/actions.ts`:

```ts
submitCheckout(prev, formData) → { errors }
```

The success path does not return; it throws through `redirect(...)`. Tests
therefore assert on the thrown `REDIRECT:…` string — see
`tests/app/admin/events-action.test.ts` for the idiom, and
`src/app/(admin)/admin/events/actions.ts` for the shape to copy.

`experimental.serverActions.allowedOrigins` still has to be set before launch.
That remains a Plan 08 item.

The payload is validated with Zod by `src/lib/shared/checkout.ts` — **not**
`src/lib/shared/schemas.ts`, which is the admin event schema:

```ts
// validated with zod — src/lib/shared/checkout.ts
{
  // Flat, not an array. One concert per order, decided 27 Aug 2026.
  ticketTypeId: string,   // z.uuid() — checks RFC 4122 version/variant bits
  quantity: number,       // int, positive, .max(50); server re-clamps to maxPerOrder
  email: string,
  firstName: string, lastName: string,
  phone?: string,
  // One name per admission. Length MUST equal quantity (enforced in superRefine).
  attendeeNames: string[],
  locale: 'pl' | 'en' | 'de',
  currency: 'PLN' | 'EUR',
  needsInvoice: boolean,
  companyName?: string, nip?: string, invoiceAddress?: string,
  acceptedTerms: true,    // form-only; no column. The order existing records it.
}
```

**Why the payload is flat rather than an array.** The 27 Aug 2026 decision made
one concert per order settled, so the array shape earns nothing at the boundary
and costs a level of nesting in every error path. The *database* still models
many `OrderItem` rows per `Order`, so reversing the decision would not need a
data migration for the items themselves. Note one caveat: `Order.attendeeNames`
(Task 2) is order-scoped, not item-scoped, so a genuine multi-concert order
would need those names moved to `OrderItem`.

`promoCode` and an `invoice` sub-object appeared in an earlier draft of this
block. Promo codes are Plan 06; invoice details are flat fields, as above.

**`attendeeNames` was added 27 Aug 2026**, when the festival chose a name per
ticket over anonymous admission. The invariant that follows:

> **Every `Ticket` belonging to a `PURCHASE` order has a non-null `holderName`.
> For an `INVITATION` order it stays optional.**

That asymmetry is why `Ticket.holderName` remains nullable in the schema —
invitations reuse the same fulfilment path and have no checkout form to collect
names from. Enforce the rule in the checkout validator, not in the column.

Names are trimmed and length-capped on the way in. They land in a fixed-width
`pdf-lib` layout (see [`06-i18n-email-pdf.md`](06-i18n-email-pdf.md)) and must
survive latin-ext characters, so a 200-character name is a rendering bug waiting
to happen rather than a harmless input.

Note `invoiceAddress`, not `address` — the field names here match the `Order`
columns they populate, so no mapping layer is needed.

Server-side, in order:

1. **Rate limit** by IP. On-sale moments attract scripts.
2. **Validate** the payload. Reject anything malformed before touching the DB.
3. **Load the ticket types from the database** and verify the event is
   `ON_SALE` and within its sales window.
4. **Compute the total from database prices.** Prices in the request body are
   ignored entirely — the request does not even carry them. This is the single
   most important line in the whole endpoint.
5. **Validate and apply the promo code** (see [04](04-invitations-promo-refunds.md)).
6. **Claim capacity** with the conditional UPDATE, and create the `PENDING`
   order plus `OrderItem` rows with price snapshots — in one transaction.
7. **If `total === 0`** (a 100% promo code): skip Stripe entirely, fulfil
   immediately, return the order reference. Stripe cannot process a zero-amount
   charge, so this path must exist.
8. **Otherwise create the PaymentIntent:**
   ```ts
   stripe.paymentIntents.create({
     amount: order.total,
     currency: order.currency.toLowerCase(),
     automatic_payment_methods: { enabled: true },
     metadata: { orderId: order.id, reference: order.reference },
     receipt_email: order.email,
   }, { idempotencyKey: `pi_${order.id}` })
   ```
   The idempotency key means a retried request never creates a second charge.
9. Return `{ clientSecret, reference }`.

Payment methods are **not** listed in code. `automatic_payment_methods` lets
Stripe decide from currency, amount and buyer country, using what is enabled in
the dashboard. Adding PayPal later is a dashboard toggle, not a deploy.

## The webhook

`POST /api/webhooks/stripe` — `runtime = 'nodejs'`, raw body preserved.

```ts
const sig = request.headers.get('stripe-signature')
const raw = await request.text()          // NOT request.json()
const event = stripe.webhooks.constructEvent(raw, sig, env.STRIPE_WEBHOOK_SECRET)
```

Signature verification is non-negotiable. An unverified webhook endpoint lets
anyone on the internet mint themselves free tickets by POSTing a fake
`payment_intent.succeeded`. This is the highest-severity item in the system.

**Idempotency.** Stripe retries webhooks — on timeout, on 500, and sometimes
just because. Duplicate delivery must not produce duplicate tickets or duplicate
emails:

```ts
try {
  await db.stripeWebhookEvent.create({ data: { stripeEventId: event.id, type: event.type } })
} catch (e) {
  if (isUniqueViolation(e)) return new Response('ok', { status: 200 })  // already handled
  throw e
}
```

The unique primary key *is* the lock. Fulfilment is additionally written to be
idempotent on its own (it no-ops if the order is already `PAID`), so the system
is correct even if both guards were bypassed.

**Events handled:**

| Event | Action |
|---|---|
| `payment_intent.succeeded` | Fulfil the order |
| `payment_intent.payment_failed` | Release the hold, mark `FAILED` |
| `payment_intent.canceled` | Release the hold, mark `CANCELLED` |
| `charge.refunded` | Mark refunded, revoke tickets, return capacity |
| `charge.dispute.created` | Flag the order, alert staff — do not auto-revoke |

Anything else is acknowledged with 200 and ignored. Unknown events must not 500,
or Stripe will retry them forever and eventually disable the endpoint.

## Fulfilment

Split deliberately into two parts, because they have different failure
characteristics.

**Part 1 — transactional, must not fail:**

1. If the order is already `PAID`, stop. (Idempotence.)
2. Set `status = PAID`, `paidAt = now()`.
3. Move the quantity from `heldCount` to `soldCount`.
4. Create `Ticket` rows — one per ticket, each with
   `code = base32(crypto.randomBytes(16))`.
5. If `soldCount === capacity`, set the event to `SOLD_OUT`.

**Part 2 — best-effort, retryable:**

6. Render the PDF (`pdf-lib`), embedding a QR per ticket.
7. Send the email via Resend.
8. Set `emailSentAt`.

If part 2 fails, the buyer still owns valid tickets — they exist in the database
and are visible on the order page. `/api/cron/retry-emails` finds paid orders
with no `emailSentAt` and retries. Staff can also resend from the admin.

The ordering matters: **grant the ticket first, deliver it second.** The reverse
ordering loses tickets whenever Resend has a bad minute.

## Order status page

`/[locale]/order/[reference]?t=<accessToken>` is public but guarded.

**The reference alone is guessable and must never be the only guard.** It is
`KM-{YYYY}-{NNNNNN}`, drawn from a Postgres sequence (`order_reference_seq`),
so it is monotonic and trivially enumerable — `KM-2026-000001`, `000002`, and
so on. What protects the page is the `accessToken` on the `Order` (a v4 UUID,
Plan 04 Task 2), required as `?t=` by both the page lookup and the Cancel
action, compared in constant time. Plan 05 may replace it with a signed token;
until then the column is the mechanism. Without it, enumeration would expose
buyer names and email — and, worse, let anyone cancel a stranger's order and
release their seats.

Server code never accepts a reference from user input as an authorisation:
references are generated only inside `createOrder`, and read only as a lookup
key from a URL the fulfilment flow itself produced.

The page shows:

- `PENDING` → "Payment in progress" with polling every 3 s, and a note that
  bank transfers may take a few minutes.
- `PAID` → tickets, a download link for the PDF, and the web-ticket links.
- `FAILED` / `EXPIRED` → an explanation and a link to start over.
- `CANCELLED` (oversell auto-refund) → an apology and refund confirmation.

Polling stops after 5 minutes and switches to "we'll email you when it
completes", because Przelewy24 transfers can legitimately take longer.
