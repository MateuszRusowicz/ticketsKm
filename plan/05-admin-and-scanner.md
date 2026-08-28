# 05 — Admin area and door scanner

Polish-language, authenticated, not indexed. Two roles:

| Role | Can do |
|---|---|
| `ADMIN` | Everything: events, orders, refunds, invitations, promo codes, staff accounts, scanning |
| `SCANNER` | Log in and scan tickets. Nothing else. |

The `SCANNER` role exists so that a phone handed to a volunteer at the door
cannot issue free tickets or read the buyer list.

## Authentication

Email + password (Auth.js credentials provider), passwords hashed with
**argon2id**. Sessions are httpOnly, `secure`, `sameSite=lax` cookies.

Why not magic links: staff scan tickets at a venue, often on a borrowed phone,
sometimes on bad signal. Requiring email access to log in at the door is a
predictable operational failure. Passwords with rate limiting are the practical
choice here.

**Authorisation happens inside every route handler and server action.** Not in
middleware alone. Next.js has shipped a middleware authorisation bypass
(CVE-2025-29927), and the general lesson stands regardless: middleware is a
convenience layer, not a security boundary. Every server action begins with
`await requireAdmin()` or `await requireStaff()`, which throws if the session is
missing or the role is insufficient.

Server Actions are publicly callable HTTP endpoints. "It runs on the server" is
not authorisation.

Login is rate-limited per IP and per email, with a temporary lockout after
repeated failures. Optional TOTP two-factor for `ADMIN` accounts is a
nice-to-have, deferred.

## Admin screens

**Dashboard** (`/admin`)
Per concert: sold / held / available, revenue split by currency, check-in count
once the event starts. Flags anything needing attention — orders paid but not
emailed, auto-refunded oversells, disputed charges.

**Events** (`/admin/events`)
CRUD over concerts: venue, date, doors, capacity, status, sales window, image,
and a three-tab editor for the PL/EN/DE title, description and performers. Price
in PLN and EUR. Publishing is an explicit status change, so a half-written
concert never appears on the public program.

Guard rail: capacity cannot be reduced below `soldCount + heldCount`, and the UI
explains why rather than silently rejecting.

**Orders** (`/admin/orders`)
Search by reference, email or name. Filter by event, status, currency. Order
detail shows items, tickets and their check-in state, payment method, Stripe
links, invoice details when requested, and the full audit trail. Actions: resend
ticket email, refund (full or partial), revoke individual tickets, add an
internal note.

**Invitations** (`/admin/invitations`)
Issue form plus a list of everything issued, by whom and when.

**Promo codes** (`/admin/promo-codes`)
CRUD with live usage statistics — uses remaining, revenue discounted.

**Export** (`/admin/export`)
CSV per event or per edition: order reference, date, buyer, email, quantity,
currency, gross, discount, promo code, payment method, invoice details, status.
This is what accounting works from, and what makes "invoice on request" workable
without generating documents in-app. UTF-8 with BOM so Excel opens Polish
characters correctly.

**Audit log** (`/admin/audit`)
Filterable record of every money-moving and ticket-moving action.

## The door scanner

`/admin/scan` — a mobile-first page, not a native app. Staff open it in a phone
browser, log in once, and the session persists.

**Camera and decoding.** `navigator.mediaDevices.getUserMedia` with the rear
camera, decoded client-side by a JS QR library (`@zxing/browser` or
`html5-qrcode`). Requires HTTPS, which the production subdomain has. No app
store, no install, no dedicated hardware — which was the constraint.

**QR payload:** `https://bilety.krzyzowa-music.eu/t/<code>`. A URL rather than a
bare code, so that a buyer's own phone camera opens their ticket page. The
scanner extracts the trailing code. The public ticket page **never** marks a
ticket used — only the authenticated scan endpoint does.

**Flow:** the scanner posts the code to `/api/admin/scan`, which returns one of
five states, rendered full-screen in colour with a sound and a vibration so
staff can work without reading carefully in the dark:

| State | Colour | Meaning |
|---|---|---|
| `VALID` | green | Admitted. The ticket is now used. **Shows the holder's name.** |
| `ALREADY_USED` | amber | Shows when, by which staff member, and the holder's name. Possible duplicate or a genuine re-entry. |
| `REVOKED` | red | Refunded or cancelled. |
| `WRONG_EVENT` | red | A valid ticket, but for a different concert. Shows which one. |
| `NOT_FOUND` | red | No such ticket. |

**The holder's name is shown on `VALID` and `ALREADY_USED`** — added 27 Aug 2026
alongside the decision to put a name on every ticket. Being able to check the
name against the person standing there is the entire justification for that
decision, so a scanner that does not display it makes the added checkout friction
buy nothing.

Two constraints on how it is shown. It must stay **secondary to the colour** —
staff work fast in the dark and the green/red judgement has to survive being
read at a glance, so the name is a subtitle, never the headline. And it is
**advisory, not a gate**: the QR remains the control. Staff decide what to do
about a mismatch; the scanner must not refuse entry on a name that does not
match, because buyers routinely pass tickets to family with different surnames.

On an invitation, `holderName` may be null — show the order reference instead of
an empty space.

**First scan wins, atomically.** Two staff members scanning the same code
simultaneously must not both see green:

```sql
UPDATE ticket
   SET status = 'USED', used_at = now(), used_by_admin_id = $staffId
 WHERE code = $code AND status = 'VALID'
RETURNING *;
```

Zero rows returned means someone else got there first, and the state is looked
up and reported. There is no read-then-write window.

**Event selector.** Staff pick tonight's concert before scanning, so a ticket
for a different night is caught rather than silently admitted. A running counter
shows checked-in / sold.

**Manual entry fallback.** A text field for typing the code, for damaged QRs,
cracked screens and cameras that refuse to focus. This will be used more often
than anyone expects.

**Connectivity.** V1 requires a network connection. This is a genuine
operational risk: a 900-person queue in a venue with poor signal is a bad
evening. Mitigations, in order of preference:

1. Test mobile signal at each venue **before** the festival, and arrange a
   hotspot where it is weak.
2. Keep the endpoint tiny — a single indexed lookup and one update — so it works
   on a slow connection.
3. Deferred: an offline mode that pre-downloads the event's valid ticket codes
   to the device, validates locally, and syncs afterwards. Feasible because 900
   codes are a trivial payload, but it permits double-entry across devices while
   offline, so it needs care. Listed in [09](09-open-questions.md).
