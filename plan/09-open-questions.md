# 09 — Open questions

## Blocking — needed before the affected phase starts

### 1. Multi-concert cart — one order for several concerts?

**Why it matters:** with ~10 concerts, a buyer will want two or three in one
payment. The data model already supports it (`Order` has many `OrderItem` rows,
each pointing at a different `TicketType`). The cost is entirely in the UI and
in phase 2/3 scope: a persistent cart, a cart page, per-event availability
checks across the whole order, and partial-failure handling when one concert
sells out while another is still in the cart.

**Options:**
- **Single-concert orders.** Buy tickets for one concert, pay, repeat. Simplest;
  means a buyer attending three concerts pays three times and receives three
  emails. Acceptable, and how many small festivals operate.
- **Multi-concert cart.** One payment, one email, all tickets. Better for the
  buyer and reduces Stripe fees per transaction. Adds roughly a week.

**Needed before:** phase 2. **Decided 27 Aug 2026: single-concert orders.**
No cart. See [00-decisions.md](00-decisions.md).

### 2. DNS control for `krzyzowa-music.eu`

Needed for the `bilety.` subdomain **and** for Resend's SPF/DKIM/DMARC records.
If DNS is managed inside Wix, confirm what records can be added there. Ticket
emails landing in spam is a project-ending failure and this has lead time.

**Needed before:** phase 5 (email) and phase 8 (launch).

**Decided 27 Aug 2026:** the app stays on `tickets-km.vercel.app` for the whole
build. The festival subdomain is connected only once the app is tested and the
team agrees — so Plan 02 Task 7 is deferred rather than done next. DNS access
still has to be confirmed before Plan 05, because Resend's SPF/DKIM records need
it and that is the item with the longest lead time.

### 3. Stripe account and Klarna availability

Is the Stripe account created for the Polish entity? Once it exists, confirm
**which payment methods are actually enabled and available** — specifically
whether Klarna is offered to Polish accounts. Klarna in Germany is part of the
argument for EUR support; if unavailable, PayPal or SEPA substitutes and the
German checkout experience changes.

**Needed before:** phase 4.

### 4. Do buyers name each attendee?

Currently the design issues N anonymous tickets to one buyer. The alternative is
collecting a name per ticket, which enables name-checking at the door and
reduces resale, at the cost of a longer checkout form.

**Needed before:** phase 2. Recommendation was anonymous tickets.

**Decided 27 Aug 2026: a name per ticket**, against that recommendation. The
checkout form collects one name per admission. Consequences to carry forward:
a longer form, per-ticket validation, personal data on every `Ticket` rather
than only on the `Order` — which widens the RODO retention job — and the door
scanner can show a name to check against.

---

## Non-blocking — decide before launch

### 5. Refund policy

> **Related, and load-bearing (noted 30 Aug 2026):** under art. 38 of the Polish
> consumer-rights act, services tied to a leisure event on a specified date are
> **exempt from the 14-day right of withdrawal**. So there is no automatic
> statutory return for a concert ticket, and whatever the festival offers is a
> policy choice rather than a legal minimum. The terms page carries a
> placeholder saying exactly this, marked for a lawyer to confirm. Decide the
> policy and the clause together — the admin refund UI in Plan 06 has to reflect
> whichever answer wins.

Until when can a buyer request a refund — 24 hours before the concert, 7 days,
never? Is there a fee? This is a `regulamin` question more than a code question,
but the admin UI should reflect the policy, and the terms page must state it.

### 6. Maximum tickets per order

Default `maxPerOrder = 10`. Confirm, and whether it differs for a 300-seat venue
versus a 900-seat one.

### 7. Hold duration — and whether it should vary by venue

Default 30 minutes. Long enough for a Przelewy24 bank transfer; short enough
that abandoned checkouts do not hoard a sold-out concert.

Raised during plan review: a flat 30 minutes across every venue means that on a
**300-seat** concert, 300 people can be mid-checkout while everyone else sees
"sold out" — and an abandoned checkout keeps its seat for the full half hour.
On a 900-seat room this is harmless. Consider a shorter window for the smaller
venues, plus an explicit hold release when a payment redirect fails rather than
waiting for expiry.

**Needed before:** Plan 03 (inventory).

### 8. Sale opening — is there an announced on-sale moment?

If tickets go on sale at a publicised time, the load profile is a spike rather
than a trickle and the phase 8 load test must reflect it. If sales simply open
quietly, the risk is much lower.

### 9. Branding assets

Colour, typography and layout are settled — see
[10-design-system.md](10-design-system.md). Still outstanding: **logo files** in
a vector format (SVG for the web, and something embeddable in the PDF ticket),
and confirmation that the shop's look is close enough to the Wix site that a
buyer crossing from one to the other does not think they have left the festival.

### 10. Offline scanning

Deferred from v1. Revisit after testing mobile signal at each venue. If any
venue has poor coverage, this moves from "nice to have" to "required", and it
needs a phase of its own.

### 11. Analytics

Currently: none, which avoids a cookie consent banner entirely. If the festival
wants sales analytics, use a cookieless product rather than adding a consent
banner to a checkout flow — banners measurably cost conversions.

### 12. Who receives operational alerts?

Sentry alerts on fulfilment failures, and uptime alerts, need to reach a person
with a phone. Which person, and what is the escalation if they do not answer on
the evening sales open?

---

## Answered — recorded for traceability

| Question | Answer |
|---|---|
| Monolith or split front/back? | Monolith, with `server-only` enforcement |
| Seating? | General admission, no seats |
| How many concerts? | ~10, every August, then a year's break |
| Venue capacities? | 300 and 900 |
| Ticket types per concert? | One price per concert |
| Full program or one event at a time? | Full program |
| Buyer accounts? | Guest checkout only |
| Free tickets? | Staff invitations **and** 100% promo codes |
| Refunds in scope? | Yes, in-app |
| Languages? | PL, EN, DE |
| Currencies? | PLN **and** EUR — required for BLIK and Klarna respectively |
| Legal seller? | Polish entity |
| Invoices? | On request — capture details only, no document generation |
| Event administration? | Full CRUD in the app |
| Ticket delivery? | PDF attachment **and** web link |
| Email provider? | Resend |
| Hosting? | Vercel Pro + Neon, both Frankfurt |
| Scanning hardware? | Staff smartphones, browser-based |
| Deadline? | 2–3 months to live sales |
