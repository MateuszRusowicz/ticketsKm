# Manual test — Plan 06 tickets

What to open, what to click, and what should happen. Written 27 Oct 2026
against `feat/plan-06-tickets` at the Plan 06 gate (489 tests, exit 0 twice
from a clean tree).

This file covers the ticket delivery layer only. Payment mechanics are in
[`05-manual-test.md`](05-manual-test.md). Do both together for a full
end-to-end pass.

Everything below is **test mode** — no real money moves.

---

## Prerequisites

1. Docker Postgres is running: `docker compose up -d`
2. Seed is applied: `pnpm db:seed` (expected: "Seeded 2 venues, 11 concerts,
   2 admin accounts.")
3. App is running: `pnpm dev` → <http://localhost:3000>
4. You have a PAID test order to work from. Either make one (Flow A below)
   or pick a reference from the DB.

To find a valid ticket code from the DB:

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
pnpm exec tsx -e "
import('./src/lib/server/db').then(async ({db}) => {
  const t = await db.ticket.findFirst({ where: { status: 'VALID' } })
  console.log(JSON.stringify(t))
  process.exit(0)
})"
```

---

## Flows

| Flow | Summary | Expected |
|---|---|---|
| A | Happy path — PLN card, 1 ticket | PDF is one page, QR scans into `/t/<code>` showing green |
| B | Forwarding — PLN card, 3 tickets | Three separate PDFs, each downloadable in a private window with no login |
| C | Web ticket page — valid | Green banner, event details, QR, code in plain text |
| D | Web ticket page — revoked | Red banner; PDF returns 404 |
| E | Expired hold | `tickets: []` in paid-band response |
| F | Tampered code | 404 from both `/t/<code>` and `/t/<code>/pdf` |
| G | Stale PDF after refund | Downloaded PDF still readable; QR resolves to red web page |
| H | Rate limiting | 21st PDF request in 60s → 429 |

---

## Flow A — happy path, PLN, card, 1 ticket

1. Open <http://localhost:3000/pl/wieczor-bachowski> in Polish.
2. Click **Kup bilety**, choose 1 ticket, fill the form with a test buyer name
   and `+km-a1@gmail.com`, click **Zamów**.
3. Pay with card **4242 4242 4242 4242**, any future date, any CVC.
   - Expected: redirected to `/pl/order/<ref>?t=<token>`, band is `paid`.
4. On the paid band, verify:
   - "Bilet 1" row appears with the buyer's name below it.
   - Two links: **Pobierz PDF** and **Bilet w przeglądarce**.
   - A note about forwarding individual tickets.
5. Click **Pobierz PDF**.
   - Expected: browser downloads `ticket-<code6>.pdf`.
   - Open it: one page, festival name "Krzyżowa-Music" at top, event title,
     date (Warsaw time), venue. QR in the top-right. Holder name present.
     Order reference in the footer.
6. Scan the QR with a phone camera.
   - Expected: opens `/t/<code>` in the phone browser, green banner "Bilet ważny".
7. Click **Bilet w przeglądarce** link.
   - Expected: opens `/t/<code>` in a new tab, same green page.

---

## Flow B — forwarding story, PLN, card, 3 tickets

1. Same concert as Flow A, 3 tickets, three different holder names.
2. On the paid band: three rows (Bilet 1, Bilet 2, Bilet 3), each row shows its
   holder's name.
3. Download ticket 1's PDF. Verify it shows ticket 1's holder name, not tickets 2 or 3.
4. Right-click ticket 2's **Pobierz PDF** → "Copy link".
   Open the copied URL in a **new private window** (no cookies, no session token).
   - Expected: PDF downloads without a login prompt. The ticket code in the URL
     is the credential — no `?t=` token needed.
5. Open ticket 3's **Bilet w przeglądarce** in a private window.
   - Expected: green page with ticket 3's holder name.

> This is the forwarding story working: the buyer can share `/t/<code>/pdf` or
> `/t/<code>` with a guest by messaging them the URL, with no login required.

---

## Flow C — web ticket page, valid ticket

Using a code from Flow A or B (or from the DB query above):

1. Open `http://localhost:3000/t/<code>` directly.
2. Check:
   - Green banner: "Bilet ważny" (PL) / "Valid ticket" (EN) / "Gültige Eintrittskarte" (DE),
     in the language the order was placed in.
   - Concert title, date, venue.
   - Holder name (or "–" if null).
   - QR code is visible as an inline SVG.
   - Below the QR, the 26-character code is printed in plain text.
   - Page carries `<meta name="robots" content="noindex, nofollow">`.
3. Scan the inline QR with a phone — it resolves back to the same URL. Confirm
   you are not in a redirect loop.
4. Open `http://localhost:3000/t/ZZZZZZZZZZZZZZZZZZZZZZZZZZ`
   - Expected: "Nie znaleziono biletu / Ticket not found / Eintrittskarte nicht
     gefunden" page. Verify `pnpm dev` logs show no DB query (the Crockford regex
     rejects the code before any DB access — confirm by searching logs for
     `SELECT` or `findUnique`).
5. Open `http://localhost:3000/t/i-am-lowercase-code` (invalid alphabet)
   - Expected: same not-found page, same no-DB-query guarantee.

---

## Flow D — revoked ticket

Mark a ticket as revoked directly (Plan 07 admin refund will automate this):

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
# Use a code from Flow A or B — do NOT use one you want to keep
CODE="PASTE_CODE_HERE"
pnpm exec tsx -e "
import('./src/lib/server/db').then(async ({db}) => {
  await db.ticket.update({ where: { code: '$CODE' }, data: { status: 'REVOKED' } })
  console.log('revoked')
  process.exit(0)
})"
```

Or revoke by marking the order as REFUNDED (tests the order-status path):

```bash
pnpm exec tsx -e "
import('./src/lib/server/db').then(async ({db}) => {
  const t = await db.ticket.findFirst({ where: { code: '$CODE' }, include: { order: true } })
  await db.order.update({ where: { id: t.order.id }, data: { status: 'REFUNDED' } })
  console.log('order refunded')
  process.exit(0)
})"
```

Then:

1. Open `http://localhost:3000/t/<code>`.
   - Expected: red banner "Bilet nieważny" (or locale equivalent). No QR.
2. Open `http://localhost:3000/t/<code>/pdf`.
   - Expected: 404 (revoked tickets have no PDF). The web page is the source of
     truth; a copy already in a buyer's hands keeps rendering visually, but the
     live URL tells the truth.
3. Go back to the order confirmation page (`/pl/order/<ref>?t=<token>`).
   - Expected: the confirmation page still renders (it is not revoked — only the
     individual ticket is). The ticket links still appear but the web page they
     point to shows red.

---

## Flow E — expired hold, no tickets

Create an order and mark it expired (simulating the hold sweep):

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
pnpm exec tsx -e "
import('./src/lib/server/db').then(async ({db}) => {
  const o = await db.order.findFirst({ where: { status: 'PENDING' } })
  if (!o) { console.log('no pending orders'); process.exit(0) }
  await db.order.update({ where: { id: o.id }, data: { status: 'EXPIRED' } })
  console.log('expired:', o.reference)
  process.exit(0)
})"
```

Navigate to that order's confirmation page (you need its `?t=<token>` — check
the DB for `accessToken`):

- Expected: `expired` band renders, the per-ticket list does not appear
  (because `getOrderForConfirmation` returns `tickets: []` when the band
  is not `paid`).

---

## Flow F — tampered code

1. Take a valid URL like `http://localhost:3000/t/ABCDE1234567890ABCDE12345A`
   and change the last character to a lowercase `a`:
   `http://localhost:3000/t/ABCDE1234567890ABCDE12345a`
   - Expected: 404, no DB query (lowercase fails the Crockford regex).
2. Try a code with an `I` in it (invalid Crockford character):
   `http://localhost:3000/t/IIIIIIIIIIIIIIIIIIIIIIIIII`
   - Expected: 404, no DB query.
3. Try a valid-alphabet but unknown code:
   `http://localhost:3000/t/ABCDE1234567890ABCDE12345Z`
   - Expected: 404. A DB query IS expected here (valid shape, just not found).
4. Same for the PDF route — replace `/t/<code>` with `/t/<code>/pdf` in all
   three cases. Same 404 results.

---

## Flow G — stale PDF after refund

1. Download the PDF for a VALID ticket (saves it to your Downloads folder).
2. Revoke the ticket (as in Flow D).
3. Open the already-downloaded PDF in your PDF viewer.
   - Expected: PDF still renders correctly (it is a local file — it does not
     phone home).
4. Scan the QR in the PDF with a phone camera.
   - Expected: phone opens `/t/<code>` — but now shows the **red** "Bilet
     nieważny" banner. The live web page is the source of truth; the PDF is
     a snapshot in time.

> This is intentional: the ticket design states that a PDF in a buyer's hands
> keeps working visually, but the QR resolves to the live state. Staff check the
> web page, not the PDF.

---

## Flow H — rate limiting

The PDF endpoint allows 20 requests per IP per 60 seconds. To verify:

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
CODE="PASTE_VALID_CODE_HERE"
for i in $(seq 1 21); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/t/${CODE}/pdf")
  echo "$i: $STATUS"
done
```

- Expected: requests 1–20 return 200 (or 301/302 then 200), request 21 returns
  **429** with body "Too many requests".
- To reset: wait 60 seconds. The rate limiter is in-memory and per-instance.

The public `/t/<code>` page has a separate 60-requests-per-minute limit. Verify
similarly by substituting the URL (without `/pdf`).

---

## Stripe test card numbers

(Also in `05-manual-test.md`. Repeated here for convenience.)

| Card number | Behaviour |
|---|---|
| `4242 4242 4242 4242` | Immediate success |
| `4000 0025 0000 3155` | 3DS required |
| `4000 0000 0000 9995` | Always declined |

Use any future expiry (e.g. `12/30`) and any 3-digit CVC.
