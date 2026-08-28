# 06 — Languages, currency, email and the ticket itself

## Three languages

`next-intl`, locale as the first URL segment: `/pl/...`, `/en/...`, `/de/...`.
Default `pl`.

Putting the locale in the path (rather than a cookie) means the Wix site can
link straight into the correct language — a German visitor reading the German
page lands on `bilety.krzyzowa-music.eu/de/koncert/...` and never sees Polish.
It is also the only version search engines can index properly.

- **UI strings** live in `src/messages/{pl,en,de}.json`.
- **Concert content** is translated per event in `EventTranslation`, edited in
  the admin as three tabs.
- **Fallback:** a missing translation falls back to Polish rather than showing a
  raw key. Untranslated concerts are flagged in the admin so staff can see gaps
  before publishing.
- **Emails and PDFs** are rendered in `Order.locale`, captured at checkout.
- **The admin is Polish only** and deliberately untranslated.
- **Dates** are formatted per locale, always with an explicit timezone
  (Europe/Warsaw). A German buyer seeing "19:00" must be seeing Polish local
  time — this is a real source of missed concerts.

## Two currencies

Each `TicketType` stores `pricePln` and `priceEur` as separate, hand-set
integers. There is no exchange-rate lookup anywhere in the system.

The reason is that prices must be stable and roundable. A concert costs 49 PLN
or 12 EUR — not 11.37 EUR, recalculated hourly. It also means a price never
changes between the buyer seeing it and paying it.

- **Default currency** follows locale: `pl → PLN`, `de`/`en` → `EUR`.
- **A visible switcher** lets anyone override it — a Pole living in Germany with
  a EUR card, or a German who wants BLIK.
- **Currency is frozen onto the order at creation** and used for the
  PaymentIntent, the PDF, the email and any later refund.
- The switcher explains the consequence, because it is not obvious: switching to
  PLN is what makes BLIK available; switching to EUR is what makes Klarna
  available. See [00-decisions.md](00-decisions.md).

## Email

**Resend**, with templates written in `react-email` and rendered per locale.

| Template | Trigger |
|---|---|
| Ticket delivery | Order fulfilled (purchase or invitation) |
| Refund confirmation | Refund processed |
| Event cancelled | Concert cancelled, refund issued |
| Oversell apology | Auto-refund after a capacity race |
| Order expired | Hold expired without payment (optional, low priority) |

**Deliverability is a project risk, not a detail.** Tickets that land in spam
are tickets that do not exist as far as the buyer is concerned. Required before
go-live:

- SPF, DKIM and DMARC records on the sending domain, verified in Resend.
- A real, monitored `Reply-To` at the festival — not `noreply@`.
- Send tests to Gmail, Outlook/Hotmail, GMX and WP.pl / Onet.pl accounts. The
  Polish and German consumer mail providers are the ones that matter here, and
  they are not the ones most people test.
- Plain-text alternative alongside the HTML.
- Sending domain warm-up is unnecessary at this volume, but the domain must be
  verified well in advance — **DNS access is a prerequisite and may be locked
  inside Wix.** See [09](09-open-questions.md).

The ticket email contains: the concert (title, date, time, venue, address), the
number of tickets, the order reference, **the PDF attached**, and **a link to
each ticket** on the web.

## The PDF ticket

Generated with **`pdf-lib`** — pure JavaScript, no headless Chrome. This is
required to run on Vercel functions and keeps the Docker image small enough that
moving to a VPS later stays easy.

One page per ticket, all tickets for an order in a single PDF:

- Festival logo and the concert title in the buyer's language
- Date, time (Europe/Warsaw), venue name and address
- Ticket type and **the holder's name** — always present on a purchased
  ticket since the 27 Aug 2026 decision, optional only on invitations
- **The QR code**, large and high-contrast, generated as a PNG and embedded
- Order reference and ticket code in text, for manual entry when a QR will not
  scan
- A short terms line and the festival's contact address

**The holder's name needs a layout rule, not just a field.** It is buyer-supplied
free text dropped into a fixed-width page, so it must be trimmed and
length-capped at the checkout validator (see
[`03-purchase-flow.md`](03-purchase-flow.md)), and truncated with an ellipsis
rather than allowed to overflow or wrap into the QR's quiet zone. It must render
Polish and German diacritics — the embedded font has to carry latin-ext, which
`pdf-lib`'s standard fonts do **not**. A name like `Małgorzata Świętosławska`
that renders as mojibake on a door ticket is worse than no name at all, because
staff will trust it.

Design constraints that come from how this is actually used: the QR must survive
being printed on a home inkjet **and** being displayed on a cracked phone screen
in a dark foyer. That means high error correction, generous quiet zone, no
background image behind it, and no light-grey branding near it.

## The web ticket

`/t/<code>` renders the same information as a mobile-friendly page with the QR.

It is public and unguessable — the code is 128 bits of randomness, so it cannot
be enumerated. **Opening it never marks the ticket used**; only the
authenticated scan endpoint does that. It shows the ticket's current state, so a
buyer whose order was refunded sees that clearly rather than arriving at the
door with a dead ticket.

This page is the reason attachment failures are survivable, and it is also the
foundation for adding Apple/Google Wallet passes later, should that ever be
wanted.
