# 07 — Security and testing

## The five things that actually matter

Ranked by severity. Everything else in this document is secondary to these.

1. **Stripe webhook signature verification.** An unverified webhook endpoint
   lets anyone on the internet mint free tickets by POSTing a fake
   `payment_intent.succeeded`. Verify with `stripe.webhooks.constructEvent`
   against the raw body, in the Node runtime.
2. **Server-side price calculation.** Prices come from the database. The
   checkout request does not carry them at all, so there is nothing to tamper
   with.
3. **Webhook idempotency.** Stripe retries. Duplicate delivery must not produce
   duplicate tickets, duplicate emails or duplicate refunds. Enforced by a
   unique primary key on `StripeWebhookEvent.stripeEventId`.
4. **Unguessable ticket codes.** `crypto.randomBytes(16)`, base32-encoded.
   Never sequential, never derived from the order id. A guessable code is a free
   ticket generator.
5. **Keeping Next.js patched.** Next.js has shipped serious vulnerabilities,
   including a middleware authorisation bypass (CVE-2025-29927) and an SSRF in
   Server Actions. Renovate or Dependabot runs weekly, and security releases are
   applied promptly — particularly in the weeks around a sale.

## Checklist

**Boundary**
- [ ] `import 'server-only'` in every `src/lib/server/**` file
- [ ] ESLint rule blocking `lib/server/**` imports from client components
- [ ] Only `NEXT_PUBLIC_*` variables exposed; verified by grepping the built bundle
- [ ] Postgres never publicly reachable; Neon access restricted

**Payments**
- [ ] Webhook signature verified against the raw body
- [ ] Idempotency ledger on `stripeEventId`
- [ ] Fulfilment idempotent independently of the ledger
- [ ] Stripe idempotency keys on every PaymentIntent and Refund creation
- [ ] Amounts computed server-side from the database
- [ ] Card data never touches our servers (Payment Element → PCI SAQ-A)
- [ ] Webhook endpoint responds 200 to unknown event types

**Authorisation**
- [ ] `requireAdmin()` / `requireStaff()` at the top of every admin route
      handler and server action — never middleware alone
- [ ] `SCANNER` role cannot reach any non-scan endpoint (tested, not assumed)
- [ ] Passwords hashed with argon2id
- [ ] Session cookies httpOnly, secure, sameSite=lax
- [ ] Origin check on state-changing route handlers

**Abuse**
- [ ] Rate limiting on: checkout, promo-code validation, admin login, scan
- [ ] Failed promo-code attempts counted and throttled
- [ ] `maxPerOrder` enforced server-side
- [ ] Admin login lockout after repeated failures

**Headers and transport**
- [ ] Content-Security-Policy (allowing only Stripe's required origins)
- [ ] HSTS, `X-Content-Type-Options`, `Referrer-Policy`, frame denial
- [ ] `noindex` on `/admin/**` and `/t/**`

**Secrets**
- [ ] All secrets in Vercel environment variables; `.env.example` committed with
      no real values
- [ ] Environment validated at boot by a zod schema — the app refuses to start
      with a missing or malformed variable
- [ ] Separate Stripe test and live keys; separate webhook secrets

## RODO / GDPR

The buyer data held is: email, first and last name, optional phone, optional
company/NIP/address, purchase history and IP at checkout time.

- [ ] Privacy policy (`polityka prywatności`) and terms of sale (`regulamin`)
      published — **both are legally required for online sales in Poland**, and
      an explicit acceptance checkbox is recorded on the order
- [ ] Data processing agreements in place with Stripe, Resend, Neon and Vercel
- [ ] All infrastructure in EU regions (Vercel `fra1`, Neon Frankfurt)
- [ ] Retention job: anonymise buyer PII on orders a defined period after the
      last concert of an edition, keeping financial and attendance records
- [ ] A documented procedure for access and deletion requests
- [ ] No analytics cookies — which avoids a consent banner entirely. If
      analytics are wanted later, use a cookieless product rather than adding
      a banner to a checkout flow.

## Testing

**Unit — Vitest.** Pure logic, no database:
- Discount arithmetic, including rounding and the negative-total guard
- Currency formatting and minor-unit conversion
- Order state machine transitions
- Ticket code generation (entropy, encoding, uniqueness over a large sample)
- Webhook event routing

**Integration — Vitest against a real Postgres** in Docker, not a mock. Prisma
against SQLite or a mock does not exercise the behaviour that matters here.
- **The oversell test.** Fire N concurrent checkout requests at a ticket type
  with capacity M, assert that exactly M succeed and `soldCount + heldCount`
  never exceeds capacity. This is the single most important test in the suite,
  and it is written in phase 3, before Stripe is involved at all.
- **The double-scan test.** Two concurrent scans of one ticket; exactly one
  returns `VALID`.
- Webhook idempotency: deliver the same event five times, assert one set of
  tickets and one email.
- Hold expiry returns capacity and decrements promo usage.
- The expired-hold-then-payment race triggers an automatic refund.
- Refunds return capacity and revoke tickets.
- Promo `maxUses` cannot be exceeded under concurrency.

**Stripe.** The Stripe CLI forwards live test webhooks to `localhost`. Test the
declined card, the 3-D Secure card, the disputed card, and — because they are
90% of real buyers — **BLIK, Przelewy24 and Klarna in test mode**, including
abandoning a redirect halfway.

**End-to-end — Playwright.**
- Full purchase in each of the three languages
- Sold-out concert cannot be bought
- Promo code applied; 100% code skips payment entirely
- Order page transitions from pending to paid
- Ticket email link opens a valid web ticket
- Admin: issue an invitation, refund an order, scan a ticket

**Load test before go-live.** k6 or Artillery simulating the on-sale rush —
several hundred concurrent buyers against the 900-seat concert. What this is
really checking is the `PrismaPg` adapter's connection-pool behaviour against
Neon's pooled endpoint, which is the most likely thing to fall over under a
real burst. Prisma 7 has no bundled query engine — pooling is entirely the
adapter's, so tune `max` on it rather than looking for a Prisma setting.

**Development approach.** Tests first for the money and inventory code. Not as
ceremony: the oversell and idempotency behaviours are impossible to verify by
clicking around, and they are exactly the behaviours that fail in production and
cannot be undone afterwards.

## Before going live

- [ ] A real transaction with live keys, for a small amount, then refunded
- [ ] Live webhook endpoint registered and verified in the Stripe dashboard
- [ ] Neon point-in-time recovery confirmed **by performing a restore**, not by
      reading the documentation
- [ ] Uptime monitoring with alerting to a phone that someone carries
- [ ] Error tracking (Sentry) with alerts on webhook and fulfilment failures
- [ ] A staff runbook in Polish: how to issue an invitation, how to refund, how
      to scan, what to do when the scanner shows amber, who to call
