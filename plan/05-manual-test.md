# Manual test — Plan 05 payments

What to click, what to type, and what should happen. Written 17 Sep 2026
against `development` at PR #6, for the **live test-mode site**
<https://tickets-km.vercel.app>.

This is the only layer that tests the checkout as a buyer sees it. The suite
(400+ tests) runs in Node with no DOM, so the order form, the Stripe Payment
Element and the currency dropdown have **no automated coverage at all**. The
7 Sep walkthrough found four real defects that every one of those tests had
passed over.

Every number and code below was checked against Stripe's documentation on
17 Sep 2026, not recalled. Everything is **test mode** — no real money moves,
and none of these numbers work on a live account.

---

## How to work through this

1. Do a scenario in the browser.
2. **Write down the order reference** (`KM-2026-…`, shown on the order page).
3. Send me the references in batches. I check what the browser cannot show:
   `Order.status`, the payment-method column, how many `Ticket` rows exist, and
   whether `heldCount` / `soldCount` moved correctly.

Send **only the reference**, never the full order URL — the `?t=…` part is the
access token that guards the order.

Scenarios marked **★** are the ones that matter most. If time is short, do those.

---

## Before you start: what is NOT built

Do not report these as bugs.

| Missing | Plan |
|---|---|
| Ticket e-mail, PDF tickets, QR codes — a PAID order shows a confirmation page and nothing arrives by mail | 05, fulfilment half (next) |
| Toasts / notifications — state is shown only by the section of the order page | 06/07 |
| Staff refunds, promo codes, invitations | 06 |
| The door scanner — `/admin/scan` 404s | 07 |
| Alerts reach nobody — they are `console.error` lines in Vercel's runtime logs | 07/08 |
| Real legal text; native-speaker DE/EN copy | later |

---

## Concerts to use

Buy from the **top three** only. The rest exist to show a particular state and
will not sell — that is correct.

| Slug | Price PLN / EUR | Capacity | Use it for |
|---|---|---|---|
| `wieczor-bachowski` | 80 / 19 | 900 | **most purchases** |
| `karlowicz-kwartet` | 60 / 14 | 300 | purchases |
| `koncert-finalowy` | 90 / 21 | 900 | purchases |
| `test-przedsprzedaz` | 50 / 12 | 300 | listed, "sales open on …", not buyable |
| `test-sprzedaz-zamknieta` | 50 / 12 | 300 | listed, sales window closed |
| `test-wyprzedany` | 50 / 12 | 300 | listed, **sold out** |
| `test-zamkniety` | 50 / 12 | 300 | status CLOSED |
| `test-w-rezerwacji` | 50 / 12 | 100 | 5 seats held by a seeded stale order |
| `test-roboczy`, `test-odwolany`, `test-miniony` | — | — | **must not appear**; direct URL must 404 |

Up to **10 tickets per order**. A hold lasts **30 minutes**, extended by 15 when
you click Pay.

---

## Test data

### Buyer details (any values work)

Use a real-looking e-mail you can recognise, e.g. `twoj.email+km1@gmail.com`,
changing the number per order. **Nothing is e-mailed yet**, so it does not have
to be reachable.

Why vary it: two orders with the **same e-mail for the same concert** are
deliberately merged into one (same-buyer dedupe, scenario D3). Use a new e-mail
whenever you want a genuinely new order.

### Cards — any future expiry (e.g. `12/34`), any 3-digit CVC, any name

| Card | Number | Result |
|---|---|---|
| Visa — success | `4242 4242 4242 4242` | succeeds |
| Mastercard — success | `5555 5555 5555 4444` | succeeds |
| Polish Visa — success | `4000 0061 6000 0005` | succeeds, issued in PL |
| German Visa — success | `4000 0027 6000 0016` | succeeds, issued in DE |
| Generic decline | `4000 0000 0000 0002` | `card_declined` |
| Insufficient funds | `4000 0000 0000 9995` | `insufficient_funds` |
| Expired card | `4000 0000 0000 0069` | `expired_card` |
| Incorrect CVC | `4000 0000 0000 0127` | `incorrect_cvc` |
| 3D Secure, always asks | `4000 0027 6000 3184` | shows a 3DS test window — **Complete** succeeds, **Fail** declines |

### BLIK (PLN)

**Any 6-digit code works**, e.g. `123456`.

Stripe also has failure simulations for BLIK (`customer_declined@…`,
`insufficient_funds@…`, `customer_timeout@…`), but they are triggered by the
**billing e-mail on the payment method** — and our Payment Element does not
send one (the order's e-mail goes to the PaymentIntent as `receipt_email`, which
is a different field). So they are **probably unreachable** from our checkout.
Scenario B6 checks this once.

### Przelewy24 (PLN)

Pick any bank in the Element. Stripe then shows its **test redirect page** with
two buttons: authorise the test payment, or fail it.

### Klarna (EUR) — Germany test identity

Klarna **does** have test phone numbers. `HANDOFF.md` recorded Klarna as
"needs a real phone number, never exercised"; that was not true.

| | Approved | Denied |
|---|---|---|
| E-mail | `customer@email.de` | `customer+denied@email.de` |
| Phone | `+49017614284340` | `+49017610927312` |
| First / last name | `Mock` / `Mock` | `Test` / `Person-de` |
| Date of birth | `10-07-1970` | `10-07-1970` |
| Address | `Neue Schönhauser Str. 2, 10178 Berlin` | same |
| One-time code | **any 6 digits** | — |
| One-time code that **fails** | `999999` | — |

Klarna decides approve/deny **by the e-mail typed inside Klarna's window**.
Klarna keeps you logged in with a cookie — **log out of the Klarna sandbox (or
use a private window) between approved and denied runs**, or the second run
reuses the first identity.

If Klarna asks how to pay: card `4111 1111 1111 1111`, CVV `123`, any future
date; or direct debit `DE11520513735120710131`.

### PayPal (EUR)

Stripe shows a **test redirect page** instead of real PayPal: authorise or fail.
No PayPal account needed.

### SEPA Direct Debit (EUR) — IBANs

Name and e-mail: anything. The Element shows a mandate text; accept it.

| IBAN | What happens |
|---|---|
| `DE89370400440532013000` | `processing` → **succeeded** (quickly) |
| `DE08370400440532013003` | `processing` → **succeeded after ≥ 3 minutes** |
| `DE62370400440532013001` | `processing` → **fails** |
| `DE78370400440532013004` | `processing` → **fails after ≥ 3 minutes** |
| `DE35370400440532013002` | succeeds, then **a dispute is opened** immediately |
| `DE65370400440002222227` | fails with `insufficient_funds` |

---

## A — Happy paths

| # | ★ | Language / currency | Method & data | Expected in the browser |
|---|---|---|---|---|
| A1 | ★ | PL / PLN | Card `4242 4242 4242 4242` | Pay → "paid" confirmation. **No Pay button** after returning. |
| A2 | ★ | PL / PLN | BLIK, code `123456` | short "processing" section that refreshes by itself → paid |
| A3 | ★ | PL / PLN | Przelewy24 → **authorise** on Stripe's test page | you return to `https://tickets-km.vercel.app/pl/order/…` (**not** localhost) → processing → paid |
| A4 | | EN / EUR | Card `5555 5555 5555 4444` | paid |
| A5 | ★ | DE / EUR | Klarna, approved identity above | redirect to Klarna → back to our site → paid |
| A6 | ★ | DE / EUR | PayPal → **authorise** | redirect → back → paid |
| A7 | ★ | DE / EUR | SEPA `DE89370400440532013000` | "processing" section; becomes paid within minutes (reload if the page has stopped polling — it stops after 5 min) |
| A8 | | PL / PLN | Card `4000 0027 6000 3184` → **Complete** in the 3DS window | paid |
| A9 | | PL / PLN | 3 tickets, card `4242…` | paid; I confirm **3** `Ticket` rows and three distinct attendee names |

**For every A-scenario I check:** `Order.status = PAID`, `paymentMethodType`
matches the method, `Ticket` count = quantity, `soldCount` rose and `heldCount`
fell by the quantity.

---

## B — Failures (the buyer must keep their seats and be able to retry)

| # | ★ | Method & data | Expected |
|---|---|---|---|
| B1 | ★ | Card `4000 0000 0000 9995`, then on **the same page** retry with `4242…` | decline message in the Element; **order stays pending, seats stay held**; the retry pays **the same order** (same reference) |
| B2 | | Card `4000 0000 0000 0002` | decline message; order still pending |
| B3 | | Card `4000 0027 6000 3184` → **Fail** in the 3DS window | payment not taken; order still pending; retry possible |
| B4 | ★ | Przelewy24 → **fail** on the test page | back on our order page, **not** paid, Pay button available again |
| B5 | | PayPal → **fail** | same as B4 |
| B6 | | BLIK, order e-mail `customer_declined@example.com`, code `123456` | **Record what happens.** If it simply succeeds, that confirms BLIK failure simulation is unreachable from our checkout (see Test data) |
| B7 | | Klarna, **denied** identity (`customer+denied@email.de`) | Klarna refuses; back on our page, not paid, retry possible |
| B8 | | Klarna, approved identity, one-time code `999999` | authentication fails inside Klarna; not paid |
| B9 | | SEPA `DE62370400440532013001` | processing, then **not paid** |

B1 is the most important test in this file. It proves a declined card does
**not** release the buyer's seats — a bug in the first draft of Plan 05.

---

## C — Checkout form and buy box (no payment needed)

| # | ★ | Do | Expected |
|---|---|---|---|
| C1 | ★ | On a concert page, switch the **currency dropdown** PLN ↔ EUR | prices change; the line below changes between "karta, BLIK, Przelewy24" and card / Klarna / SEPA / PayPal |
| C2 | ★ | Fill the order form, type a **bad e-mail** (`abc@`), submit | error under the e-mail field; **every other field keeps its value** (fixed 7 Sep) |
| C3 | | Choose EUR, go to the order page | **no currency switcher** there — currency is frozen for the order |
| C4 | | Try 11 tickets (edit `?q=11` in the URL) | clamped to 10 |
| C5 | | Leave an attendee name empty with quantity 3 | error; nothing else cleared |
| C6 | | Submit without ticking the terms checkbox | refused with an error |
| C7 | | Visit `/pl`, `/de`, `/en` | 8 concerts each; texts in the right language |
| C8 | | Open `/pl/koncert/test-roboczy`, `/pl/koncert/test-odwolany`, `/pl/koncert/test-miniony` | **404** each |
| C9 | | Open `test-wyprzedany` and `test-przedsprzedaz` | sold-out / "sales open on …"; no way to buy |

---

## D — Holds, cancellation, and not losing seats

| # | ★ | Do | Expected |
|---|---|---|---|
| D1 | ★ | Create an order, click **Cancel** on the order page | order cancelled; I confirm the seats returned (`heldCount` back down) |
| D2 | ★ | Create an order and **walk away** without paying | after 30 min + up to 5 min for the cron, reload: hold expired, seats released |
| D3 | | Submit the form twice for the **same concert with the same e-mail** | the second submit lands on the **same reference** — no second hold |
| D4 | | Pay A1, then press the browser **Back** button to the order page and reload | still "paid", no Pay button |
| D5 | | Open the order URL **without** `?t=…` (delete it) | looks like an unknown order — the token is the only guard |

---

## E — Advanced: asynchronous success and the safety net

These need a database step in the middle, which I do. Tell me before starting
and give me the reference as soon as the order exists.

| # | ★ | Method & data | Middle step (me) | Expected |
|---|---|---|---|---|
| E1 | ★ | SEPA `DE08370400440532013003` (succeeds after ≥ 3 min) | Right after you submit, I move the hold into the past and run the sweep, so the seats are released **before** the money arrives | When the payment succeeds, the order **reclaims its seats and becomes PAID** (reclaim-or-refund safety net — the path Plan 05 relies on most) |
| E2 | | Same as E1, but on a concert I first mark as having no seats left | as E1 | the payment succeeds but there is no seat → **automatic refund**, order `REFUNDED`, an ALERT in the Vercel logs |
| E3 | | SEPA `DE35370400440532013002` | — | paid, then a dispute opens → I confirm the ALERT audit row |

E1 and E2 exercise the code that exists because Plan 05 does **not** cancel
PaymentIntents when a hold expires. They are the most valuable tests here and
the hardest to set up — worth doing once before the real launch.

---

## Record results

Copy this table into a message or the Findings log:

| # | Reference | Pass / fail | Notes |
|---|---|---|---|
| A1 | | | |

Anything that surprised you — a confusing message, a wrong language, a page that
looked broken — counts as a finding even if the payment worked.

---

## Sources

Checked 17 Sep 2026:

- Cards and 3DS — <https://docs.stripe.com/testing>
- BLIK — <https://docs.stripe.com/payments/blik/accept-a-payment?payment-ui=direct-api>
- SEPA IBANs — <https://docs.stripe.com/payments/sepa-debit/accept-a-payment?payment-ui=elements>
- Klarna — <https://docs.stripe.com/payments/klarna/accept-a-payment?payment-ui=elements>
