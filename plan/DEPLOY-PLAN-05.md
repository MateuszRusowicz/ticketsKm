# Deploying Plan 05 — payments

**Written 7 September 2026.** `HANDOFF.md` has referenced this file since the
6 September deploy attempt; it did not exist until now, which is why the
deployment steps had to be reconstructed from `steps/05-payments.md` Task 15
and Task 16 Step 7. Everything below was checked against the repository, not
against the design docs — route paths, log strings and env keys in particular,
where `HANDOFF.md` was found to be wrong (see the note at the end).

This is Plan 05 **Task 15** — the last thing between the code and the demo. It
is all dashboard work plus a handful of terminal commands; nothing in the
repository changes.

Work top to bottom. **Step 3 must happen before Step 6**, because Step 6 needs a
secret that only Step 3 produces. Every step says what to expect; if you do not
see it, stop there rather than carrying on.

| Part | Steps | What | Where |
|---|---|---|---|
| 0 | 1–2 | Preconditions | your machine |
| 1 | 3–4 | Stripe dashboard | dashboard.stripe.com |
| 2 | 5–11 | Vercel environment, redeploy, smoke tests | vercel.com + your machine |
| 3 | 12 | Six-flow manual walkthrough | browser |

Steps 1–11 take about half an hour. Step 12 is the long one, and it is the only
layer that catches form / Payment Element / currency-dropdown defects: the suite
is 427 tests but runs in Node with no DOM. The 7 September walkthrough found
four real defects that every one of those tests had passed over.

---

## Part 0 — before you start

### Step 1 — confirm Vercel is on Pro

Vercel → your project → **Settings → Billing**.

Expected: **Pro**. Recorded as done on 4 Sep 2026, so this is a re-check.

On Hobby the 5-minute crons silently downgrade to once a day, which means
abandoned holds are never released and seats stay locked. Hobby also forbids
commercial use, so selling tickets on it breaks Vercel's terms.

### Step 2 — confirm the code you are about to ship is green

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
cd ~/Documents/Kodowanie/KM
git status
```

Expected: `nothing to commit, working tree clean`. If it is not clean, commit or
stash first — Vercel builds what is pushed, not what is on your disk.

Then, from a clean tree:

```bash
rm -rf .next next-env.d.ts tsconfig.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all four finish, the last line of the test run reads
`Tests  427 passed (427)`, and the build ends with a route table. Takes roughly
six minutes.

The `rm -rf` matters: a warm `.next` hides the Next 16 generated-type failures
that only appear in CI. (That first line puts `pnpm` on the PATH — without it
every command dies with `pnpm: command not found`, because `~/.bashrc` returns
early for non-interactive shells and nvm never loads.)

---

## Part 1 — Stripe dashboard

### Step 3 — register the production webhook endpoint in Stripe

**Do this before touching Vercel.** It produces a secret that Step 5 needs.

Go to <https://dashboard.stripe.com>. **Check that the Test mode toggle is on** —
the live-mode screens look identical, and the account
(`acct_1UBpQ6GVCpToPFr7`, country PL) has no live keys anyway.

Developers → **Webhooks** → **Add endpoint**.

- **Endpoint URL:** `https://tickets-km.vercel.app/api/webhooks/stripe`
- **Events to send** — exactly these six, which are the ones
  [`webhook-dispatch.ts`](../src/lib/server/webhook-dispatch.ts) handles.
  Anything else is accepted, written to the ledger and ignored, so subscribing
  to more only adds noise:

| Event | What the app does with it |
|---|---|
| `payment_intent.succeeded` | records the attempt, then issues tickets — or refunds automatically if the seats are gone |
| `payment_intent.processing` | writes the PI status only. BLIK, P24 and SEPA sit here |
| `payment_intent.requires_action` | writes the PI status only |
| `payment_intent.payment_failed` | writes PI status + an audit row. **Does not** change `Order.status` — a declined card is retryable and the buyer keeps their seats |
| `payment_intent.canceled` | terminal: fails the order, releases the seats |
| `charge.dispute.created` | audit row at ALERT severity |

Create it, then **reveal the signing secret** (`whsec_…`) and copy it.

**This is production's secret and it is not the one in your `.env`.** The local
value comes from `stripe listen`; they are different secrets for different
endpoints. Do not paste either into a chat window, an issue, or a commit
message — that has leaked twice on this project.

### Step 4 — two dashboard toggles

Still in Stripe, **Settings → Payment methods**:

**4a. Turn Link off.** Link is not in our `payment_method_types`; the Payment
Element offers it because it is enabled on the account. For a one-off ticket
purchase it confuses buyers — they get "return to paying without Link" and the
way back to the method list is hidden behind an overflow menu. This is a
dashboard toggle, not a code change. (UX backlog #2, 7 Sep 2026.)

**4b. Confirm the methods we actually send are enabled.** If one is not, Stripe
rejects the whole PaymentIntent rather than quietly hiding that method:

| Currency | Methods sent ([`payment-methods.ts:19-24`](../src/lib/shared/payment-methods.ts#L19-L24)) |
|---|---|
| PLN | `card`, `blik`, `p24` |
| EUR | `card`, `klarna`, `sepa_debit`, `paypal` |

We send an explicit `payment_method_types` list, and that list **overrides** the
account's own configuration. Enabling a method in the dashboard alone does
nothing — it must also be in `basePaymentMethodsFor`. That was the PayPal
finding of 7 September.

SEPA is filtered further per order by `computeAllowedPaymentMethods`: a 10% cap
on concurrent in-flight SEPA holds, and hidden once the concert is within 20% of
selling out. **PayPal is deliberately exempt from both** — it settles in seconds,
SEPA holds seats for days. Do not "fix" that inconsistency.

---

## Part 2 — Vercel

### Step 5 — generate `CRON_SECRET`

Production needs its own, different from the one in `.env`.

```bash
cd ~/Documents/Kodowanie/KM
openssl rand -base64 32 > .env.cron-secret-prod.txt
```

The redirect matters: it keeps the secret out of this terminal's scrollback.
`.env*` is git-ignored, so the file cannot be committed by accident — and it must
be **inside the repo**, never `/tmp`, which gets cleared and has already
destroyed a set of production passwords once.

Open it to copy the value:

```bash
cat .env.cron-secret-prod.txt
```

Paste it into Vercel in Step 6, then delete the file:

```bash
rm .env.cron-secret-prod.txt
```

### Step 6 — set five environment variables on Vercel

Vercel → project → **Settings → Environment Variables**. Add each one for
**Production and Preview both** (tick both checkboxes).

| Variable | Value | Where it comes from |
|---|---|---|
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` | same test-mode key as your local `.env` |
| `STRIPE_SECRET_KEY` | `sk_test_…` | same test-mode key as your local `.env` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | **Step 3** — not the `.env` value |
| `CRON_SECRET` | 44-character random string | **Step 5** |
| `NEXT_PUBLIC_SITE_URL` | `https://tickets-km.vercel.app` | see Step 7 |

**Check the prefix, never the name.** The Stripe keys arrived swapped once — the
secret sat in a variable called `STRIPE_API_KEY` and the publishable one in
`STRIPE_SECRET_KEY`. `pk_` is publishable, `sk_` is secret.

The deploy **fails without these five**. That is exactly how the 6 September
build died: it got as far as collecting page data and then threw
`Invalid environment configuration:` naming these variables.

The six numeric config variables — `ASYNC_PAYMENT_TIMEOUT_MS`,
`PAY_CLICK_HOLD_EXTENSION_MS`, `SEPA_HOLD_CAP_SHARE`, `SELLOUT_HIDE_THRESHOLD`,
`SEPA_HARD_TIMEOUT_DAYS`, `WEBHOOK_MAX_ATTEMPTS` — are **optional**. Every one
has a default in [`env-schema.ts`](../src/lib/server/env-schema.ts) equal to the
value you would type (6 h, 15 min, 0.10, 0.20, 5 days, 8 attempts). Set one only
if you want to change it.

### Step 7 — check `NEXT_PUBLIC_SITE_URL` twice

Still on the Environment Variables screen, look at `NEXT_PUBLIC_SITE_URL` for
**Production**.

Expected, exactly: `https://tickets-km.vercel.app` — no trailing slash, `https`
not `http`.

This is the single most damaging variable on the page. The app builds the
payment `return_url` from it, so if it reads `http://localhost:3000`, every
BLIK, P24, Klarna and PayPal buyer is redirected to *their own machine* after
paying. The payment succeeds, the money moves, and the buyer stares at a dead
page. It breaks four of the six demo flows and **only in production**, so no
local walkthrough can ever catch it.

It is baked into the build. Editing the variable does nothing on its own — which
is what Step 8 is for.

### Step 8 — redeploy

Vercel → **Deployments** → the most recent Production deployment → the `⋯` menu
→ **Redeploy**.

Expected: the build succeeds, taking a few minutes.

If it fails with `Invalid environment configuration:` followed by variable
names, Step 6 was incomplete or has a typo — the error names exactly which ones.

> **A failed build has still applied the migrations.** `vercel-build` runs
> `prisma migrate deploy && prisma generate && next build`, so a build that dies
> at `next build` has *already* changed the Neon database. After such a failure
> the database is ahead of the deployed code. Do not try to re-apply anything —
> fix the environment variables and redeploy.

### Step 9 — smoke: the cron routes reject anonymous callers

```bash
curl -i https://tickets-km.vercel.app/api/cron/release-holds
```

Expected: `HTTP/2 401` and the body `unauthorized`.

Anything else — a 200, a JSON body — means `CRON_SECRET` is unset and the sweep
endpoints are open to the world. Stop and fix it before going further.

### Step 10 — smoke: the webhook rejects unsigned payloads

```bash
curl -i -X POST https://tickets-km.vercel.app/api/webhooks/stripe -d '{}'
```

Expected: `HTTP/2 400` and the body `missing stripe-signature`.

```bash
curl -sI https://tickets-km.vercel.app/pl | head -1
```

Expected: `HTTP/2 200` — the shop itself is up.

### Step 11 — confirm the three crons registered

Vercel → project → **Cron Jobs**. Three entries must appear, matching
[`vercel.json`](../vercel.json):

| Path | Schedule | Does |
|---|---|---|
| `/api/cron/release-holds` | every 5 min | expires holds whose PaymentIntent is not in flight; makes no Stripe call |
| `/api/cron/async-release-holds` | every 30 min | expires async-method holds past their timeout — 6 h, or 5 days for SEPA |
| `/api/cron/reconcile` | every 10 min | stuck refunds, unprocessed webhook events, PAID orders missing tickets |

If the list is empty, or the schedules read "daily", the account is on Hobby —
back to Step 1.

### Step 12 — walk through the six flows

Part 3 below, against `https://tickets-km.vercel.app` rather than localhost.
This is Task 16 Step 7 and it is what the demo is actually judged on.

---

## Part 3 — manual walkthrough

**Run this before every release that touches checkout.** It is the only layer
that catches the form / Element / dropdown class of defect.

### 3.0 Preconditions — the sandbox trap

This cost a full debugging session on 7 September. `stripe login` can authorise
a **sandbox**, which is a separate account that also issues `sk_test_` keys.
Nothing in the prefix reveals the mismatch. The app then creates PaymentIntents
on one account while the listener subscribes to the other, so **real payments
produce no webhooks at all** — orders sit at `PENDING` forever while Stripe's
dashboard shows success. `stripe trigger` still works, because it creates its
PI on the CLI's own account, which makes the setup look healthy.

Always start the listener pinned to the app's key:

```bash
set -a; . ./.env; set +a
stripe listen --api-key "$STRIPE_SECRET_KEY" \
  --forward-to localhost:3000/api/webhooks/stripe
```

Copy the `whsec_` it prints into `.env` as `STRIPE_WEBHOOK_SECRET`, then start
the app in a second terminal:

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
docker compose up -d
pnpm db:seed
pnpm dev
```

`stripe config --list` reflects the stored *login*, not the account a single
command used, so it is **not** a valid check when `--api-key` is in play. To
verify, look at a PaymentIntent id in a forwarded event: it embeds the account
(`pi_…GVCpToPFr7…` is the app's).

`.env` must contain `CRON_SECRET` (32+ chars) or `pnpm dev` refuses to boot.
`.env` is git-ignored, so no test or gate catches its absence.

### 3.1 The scenarios

**The scenarios and every piece of test data — cards, BLIK, P24, Klarna test
identity, PayPal, SEPA IBANs — live in [`05-manual-test.md`](05-manual-test.md).**
They are kept there and only there, so the two files cannot drift apart.

On the **live site** you do not need `stripe listen` (3.0 above is for local
testing only): Stripe delivers webhooks straight to the endpoint registered in
Step 3.

The minimum pass before a release is the ★ scenarios in that file.

**Local only — SEPA hard-timeout simulation** (on the live site I do this step; see scenario E1). Set the hold into the past, then fire the secondary sweep:

`psql` is unusable on this machine (the `pg_wrapper` shim is on `PATH` but no
client is installed), so edit the row through Prisma:

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
pnpm exec dotenv -e .env -- prisma studio     # Order → the reference → holdExpiresAt → six days ago
```

Then fire the secondary sweep by hand, as Vercel's cron would:

```bash
set -a; . ./.env; set +a
curl -i -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/cron/async-release-holds
```

Expected: `200` with `{"expired":1,…}` and `SWEEP-ASYNC expired=1 released=1
failed=0` on the dev server's stderr.

### 3.2 After the flows

```bash
pnpm holds:sweep
pnpm holds:verify
```

Expected: drift `0`. Counter drift is the one failure that does not heal on its
own when a hold lapses.

Record which methods appeared for each locale × currency combination. That
table is the deliverable of the walkthrough, along with anything that surprised
you — append it to `plan/steps/05-payments.md`'s Findings log **in the same
session**, not afterwards.

---

## Part 4 — watching it in production

All three cron jobs write fixed-format strings to **stderr**. Vercel captures
stderr into runtime logs; response bodies never reach the logs, so the grep
must target these strings and nothing else:

```
SWEEP-PRIMARY expired=<e> released=<r> failed=<f>
SWEEP-ASYNC   expired=<e> released=<r> failed=<f>
RECONCILE recovered=<r> stuckWebhooks=<w> ticketGaps=<g> alerts=<a>
```

Project → Logs → Runtime. Search for `failed=[1-9]`, `alerts=[1-9]`,
`stuckWebhooks=[1-9]` or `ticketGaps=[1-9]`. Any non-zero value warrants a
look. A cron returning **207** rather than 200 means at least one order failed
inside an otherwise successful sweep.

**This is a stopgap, not alerting.** Nobody is notified of anything; a stuck
refund is discovered only because a human looked. Plan 07's admin dashboard
surfaces the same audit rows; Sentry or Slack is Plan 08. On a sale day, keep a
log stream open in a browser tab.

---

## Rolling back

Vercel → Deployments → last good one → **Promote to Production**. Seconds, no
rebuild.

**A rollback does not undo a migration.** Promoting an older build leaves the
newer schema in place, which is why migrations must be additive — add columns,
never drop them in the release that stops using them.

---

## Corrections this file makes to `HANDOFF.md`

Found 7 September 2026 by reading the repository. `HANDOFF.md`'s
"Operations — payments" section named routes and formats that do not exist, so
its instructions could not have worked:

| `HANDOFF.md` said | Actually |
|---|---|
| `/api/cron/sweep-primary` | `/api/cron/release-holds` |
| `/api/cron/sweep-async`, every 5 min | `/api/cron/async-release-holds`, every 30 min |
| `/api/cron/reconcile` every 15 min | every 10 min |
| `RECONCILE alerts=<n> failed=<f> deadlettered=<d>` | `RECONCILE recovered=<r> stuckWebhooks=<w> ticketGaps=<g> alerts=<a>` — so the documented `deadlettered=` and `failed=` greps could never match a RECONCILE line |

`HANDOFF.md` has been corrected to match. Sources of truth are `vercel.json`,
`src/app/api/cron/*/route.ts` and `src/lib/server/reconcile.ts:164`.
