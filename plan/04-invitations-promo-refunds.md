# 04 — Invitations, promo codes and refunds

Three flows that all move tickets or money outside the normal purchase path.
All three reuse the `Order` entity, so there is one fulfilment pipeline, one
revocation pipeline and one export.

## Staff-issued invitations

For VIPs, press, artists' guests and sponsors.

**Admin form** (`/admin/invitations/new`): event, quantity, recipient name,
recipient email, recipient language, optional internal note.

**On submit:**

1. Claim capacity exactly as a purchase does — the same conditional UPDATE.
2. Create an `Order` with `kind = INVITATION`, `total = 0`,
   `status = PAID`, `issuedByAdminId = <current admin>`.
3. Generate tickets, render the PDF, send the email — the same code path as a
   purchase, with an invitation-flavoured subject and intro.
4. Write an `AuditLog` entry recording who issued it and to whom.

**Invitations count against venue capacity.** This is not negotiable: the fire
regulations do not care that a ticket was free. If 900 is the limit, 900 is the
limit including invitations. An explicit override exists but requires an ADMIN
role and is audit-logged.

Invitations are revocable from the admin (tickets → `REVOKED`, capacity
returned) with no Stripe involvement, since no money moved.

## Promo codes

**Admin CRUD** (`/admin/promo-codes`): code, kind (`PERCENT` or `FIXED`), value,
currency (for `FIXED`), max uses, validity window, event scope, active flag.

Codes are stored uppercase and matched case-insensitively — buyers will type
`wiosna2026` regardless of what is printed on the poster.

**Validation is server-side only.** The client posts a code string; the server
returns the resulting total. A discount calculated in the browser is a discount
an attacker controls.

Validation rules, checked in order:

1. The code exists and `active = true`.
2. `now()` is within `validFrom`..`validUntil`.
3. `usedCount < maxUses` (when `maxUses` is set).
4. `eventId` is null, or matches every event in the order.
5. For `FIXED`, the code's currency matches the order's currency. A 20 PLN
   discount cannot be applied to a EUR order.

**Counting uses.** `usedCount` is incremented **at hold time**, inside the same
transaction as the capacity claim, and decremented when the hold expires. If it
were only incremented on payment, fifty people opening checkout simultaneously
with a `maxUses = 50` code could all be admitted, and the code would be redeemed
far beyond its limit.

**Discount arithmetic** happens in integer minor units, with the discount capped
at the subtotal so a total can never go negative:

```ts
const discount = code.kind === 'PERCENT'
  ? Math.floor(subtotal * code.value / 100)
  : Math.min(code.value, subtotal)
const total = Math.max(0, subtotal - discount)
```

**100% discounts** produce `total === 0`, which Stripe cannot charge. The
checkout endpoint detects this and fulfils immediately without a PaymentIntent.
The order is still `kind = PURCHASE` — it was a sale that happened to cost
nothing — with `promoCodeId` recording why.

**Brute-force protection.** Promo code validation is rate-limited per IP, and
failed attempts are counted. Without it, a short code space is trivially
enumerable.

## Refunds

Staff refund from `/admin/orders/[reference]`, choosing a full refund or
selecting individual tickets for a partial one.

**Full refund:**

1. `stripe.refunds.create({ payment_intent, reason: 'requested_by_customer' })`
   with `idempotencyKey = 'refund_' + orderId`.
2. Set the order to `REFUNDED`.
3. Set every ticket to `REVOKED`.
4. Decrement `soldCount` — the seats go back on sale.
5. Send a refund confirmation email in the buyer's language.
6. `AuditLog`: who refunded, when, how much, and any note.

**Partial refund:** the same, with `amount` set to the sum of the selected
tickets' snapshotted unit prices, only those tickets revoked, `soldCount`
decremented by that count, and the order set to `PARTIALLY_REFUNDED`.

**The refund is confirmed by the `charge.refunded` webhook**, not by the API
response. The admin UI shows "refund initiated" until the webhook lands. Stripe
is the source of truth about money; our database is a cache of it.

**Refunding an invitation** skips Stripe entirely — no money moved. Tickets are
revoked and capacity returned.

**Revoked tickets fail at the door.** The scanner shows a distinct red
"REFUNDED / CANCELLED" state rather than a generic "invalid", so staff can tell
a refunded attendee apart from a forgery and respond appropriately.

## Cancelling a whole concert

A concert can be cancelled — an artist falls ill, a venue becomes unavailable.
This needs to be one action, not 200 manual refunds.

`/admin/events/[id]` → **Cancel event**, with a confirmation dialog stating the
number of orders and total amount affected:

1. Set the event to `CANCELLED` and remove it from the public program.
2. Queue a full refund for every `PAID` order containing that event.
3. Revoke all tickets for the event.
4. Email every affected buyer in their language, explaining the cancellation and
   confirming the refund.
5. `AuditLog` the whole operation.

Because refunds run through Stripe one at a time, this is processed in batches
with progress shown in the admin, and is safe to re-run — already-refunded
orders are skipped.

## Money-handling rules that apply everywhere

1. **All arithmetic in integer minor units.** No floats, ever.
2. **Refunds are issued in the order's original currency**, using the stored
   `Order.currency`.
3. **Never refund more than was captured.** Partial refunds are summed against
   the stored total before the Stripe call.
4. **Every Stripe write carries an idempotency key** derived from our own
   identifiers, so a retry can never double-charge or double-refund.
5. **Every money-moving action is audit-logged** with the acting admin.
