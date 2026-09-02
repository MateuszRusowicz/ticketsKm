# Manual test — Plan 03 demo

What to click, what should happen, and what is deliberately missing. Written
30 Aug 2026 against `feat/plan-03-public-programme`.

Everything here was verified through HTTP already; the point of this pass is
the half a machine cannot judge — whether it **looks and feels** right.

---

## Before you start: what is NOT built

Do not report these as bugs. They are the next plans.

| Missing | Plan |
|---|---|
| **Stripe / payments — nothing is connected** | 05 |
| Orders. The form validates and stops; no `Order` row is ever created | 04 |
| Capacity holds, so availability never moves | 04 |
| Email, PDF tickets, QR codes | 05 |
| Promo codes, invitations, refunds | 06 |
| The door scanner — `/admin/scan` 404s | 07 |
| Real legal text; both pages are marked drafts | — |
| Native-speaker DE/EN copy | later |
| Concert images — no upload path yet, so every card shows the grey fallback | 04 |

---

## Setup

```bash
pnpm db:seed          # safe to re-run; restores all ten test concerts
pnpm dev
```

Open <http://localhost:3000/pl>.

The seed gives you ten concerts, seven visible. If the programme looks wrong,
re-run `pnpm db:seed` — the dates are relative to seed time and drift as days
pass.

---

## 1. Programme listing — `/pl`

- [ ] **Seven concerts listed**, earliest first.
- [ ] These three are **absent**: `test-roboczy` (draft), `test-odwolany`
      (cancelled), `test-miniony` (past). If any appears, that is a data leak,
      not a cosmetic bug — say so immediately.
- [ ] Each card shows date, time, venue, performers, price and an availability
      line.
- [ ] `test-wyprzedany` reads **Wyprzedane** and is struck through.
- [ ] **No card shows a number of tickets remaining.** Exact counts are never
      published.
- [ ] The grey block on each card is the image fallback, not a broken image.

**Judgement calls for you:** is the card layout right? Is the date format what
a Polish reader expects? Is the fallback acceptable, or should cards have no
image area until real images exist?

---

## 2. Language and currency

- [ ] Switch **PL → EN → DE** in the header. Titles, dates and all copy change.
- [ ] The URL changes to `/en`, `/de`.
- [ ] Switch **zł → €**. Every price changes.
- [ ] Navigate to a concert, then back. **The currency choice survives.**
- [ ] Reload the page. It still survives (it is in a cookie).
- [ ] Prices are round numbers in both currencies — 80,00 zł and 19,00 €, never
      something like 18,37 €. There is no conversion anywhere; each concert
      carries two explicit prices.
- [ ] Open `/en` in a fresh private window: it should default to **€**, and
      `/pl` to **zł**.

---

## 3. Concert page

Open **Wieczór Bachowski**.

- [ ] Date, time, venue with address, performers, price, description.
- [ ] A quantity selector and a **Kup bilety** button.
- [ ] The quantity list stops at **10** (`maxPerOrder`), not at capacity.

Then check the states, by URL:

| URL | Expect |
|---|---|
| `/pl/koncert/test-przedsprzedaz` | "Sprzedaż rusza \<date\>", no buy button |
| `/pl/koncert/test-sprzedaz-zamknieta` | "Sprzedaż zakończona" |
| `/pl/koncert/test-wyprzedany` | "Bilety wyprzedane" |
| `/pl/koncert/test-zamkniety` | "Sprzedaż zakończona" |
| `/pl/koncert/test-roboczy` | **404**, in Polish |
| `/pl/koncert/nie-istnieje` | **404**, in Polish |

- [ ] The 404 page is translated and offers a way back — not Next.js's default.

---

## 4. Order form

Click **Kup bilety** with quantity 3.

- [ ] URL is `…/zamowienie?q=3`.
- [ ] Summary reads **3 bilety** and the total is 3 × the unit price.
- [ ] There are **exactly three name fields**, numbered.
- [ ] Change the URL to `?q=99` → **10 fields**, not 99.
- [ ] `?q=abc`, `?q=0`, `?q=-1` → **1 field** each, no error page.

Now try to break the validation:

- [ ] Submit empty → errors on every required field, **in Polish**.
- [ ] Fill two of three names, submit → still rejected.
- [ ] Enter a malformed email → rejected.
- [ ] Tick **Chcę fakturę** → three more fields appear, all required.
- [ ] Untick it → they vanish and stop being required.
- [ ] Leave the terms box unticked → rejected.
- [ ] Click **regulamin** and **politykę prywatności** in the checkbox line →
      both open the real pages.
- [ ] Fill everything correctly and submit → a message saying the form is valid
      and **payment comes later**. Nothing is saved. This is correct.

Also worth trying: **use only the keyboard.** Tab through the whole form. Every
field should be reachable, focus visible, and errors should be read out if you
have a screen reader available.

---

## 5. Legal pages and footer

- [ ] Footer on every page: regulamin, polityka prywatności, festival site.
- [ ] The external link goes to `krzyzowa-music.eu`.
- [ ] Both legal pages show a **draft banner**. If that banner is ever missing,
      stop — placeholder text must never look final.
- [ ] Seven numbered sections on each.
- [ ] Both are translated into all three languages.

---

## 6. Narrow screens — the part I could not check

Devtools → device toolbar → **320px wide**, then 360 and 768.

- [ ] Nothing overflows horizontally. No sideways scrollbar.
- [ ] On `/de`, the long compound words (**Abschlusskonzert**,
      **Kammermusikfestival** if you add one) wrap or hyphenate rather than
      pushing the layout wide.
- [ ] The programme becomes a stacked list, not a sideways-scrolling row.
- [ ] Buttons and the quantity selector are comfortably tappable.
- [ ] Tapping a form field on a real iPhone does **not** zoom the page.

This is the one section where I verified the mechanism but not the appearance.

---

## 7. Admin still works — regression check

Plan 03 touched the shared layout and message files, so confirm the back-office
is undamaged.

```
http://localhost:3000/admin/login
admin@krzyzowa-music.eu / DevPassword123!
```

- [ ] Login works; the dashboard renders.
- [ ] `/admin/events` lists all ten concerts, including the drafts and the
      cancelled one that the public side hides.
- [ ] Editing a concert still saves.
- [ ] Times shown are **Warsaw local**, matching the public pages.

---

## How to report back

For anything wrong, the useful form is: **the URL, what you saw, what you
expected.** A screenshot beats a description for anything visual.

Sort into two piles — it changes what I do next:

- **Broken** — wrong behaviour, a leak, something that fails. Fix before merge.
- **Ugly** — spacing, wording, layout you dislike. Fix now if quick; otherwise
  it becomes its own task rather than quietly expanding this branch.
