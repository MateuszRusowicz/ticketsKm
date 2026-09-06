import 'server-only'
import type Stripe from 'stripe'
import { computeAllowedPaymentMethods } from './payment-methods'
import { stripe, stripeCurrency, stripeAmount } from './stripe'
import { db } from './db'
import { env } from './env'

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class PaymentIntentReuseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentIntentReuseError'
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDEMPOTENCY_RETRY_LIMIT = 3
const IDEMPOTENCY_BACKOFF_MS = 250

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates (or retrieves an existing) Stripe PaymentIntent for an order.
 *
 * Idempotency is guaranteed by two seams:
 *  1. `Order.stripePaymentIntentId` @unique — DB-level uniqueness.
 *  2. Stripe idempotency key `pi_<orderId>` — Stripe deduplicates at their end.
 *  3. Bounded backoff on Stripe's 409 `idempotency_key_in_use` with a DB re-read.
 *
 * `paymentIntentStatus = 'requires_confirmation'` is written in the SAME UPDATE
 * as `stripePaymentIntentId` so the sweep predicate always sees consistent state.
 *
 * NEVER call this on page mount — only on Pay-click. An order that never has
 * a PI set will match the primary sweep's `stripePaymentIntentId IS NULL` filter.
 */
export async function createPaymentIntent(orderId: string): Promise<{
  clientSecret: string
  paymentIntentId: string
  publishableKey: string
}> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true,
      reference: true,
      email: true,
      total: true,
      currency: true,
      status: true,
      stripePaymentIntentId: true,
    },
  })

  // Terminal / already-paid statuses.
  if (['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.status)) {
    throw new PaymentIntentReuseError('alreadyPaid')
  }
  if (order.status !== 'PENDING') {
    throw new PaymentIntentReuseError('notPending')
  }

  // If this order already has a PI (second click, back button, second tab),
  // retrieve and return it — do NOT create a second one.
  if (order.stripePaymentIntentId) {
    const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId)
    return {
      clientSecret: pi.client_secret!,
      paymentIntentId: pi.id,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY,
    }
  }

  // Compute allowed methods (server-side; enforces SEPA guardrail).
  const methods = await computeAllowedPaymentMethods(order.id)

  const params: Stripe.PaymentIntentCreateParams = {
    amount: stripeAmount(order),
    currency: stripeCurrency(order.currency),
    payment_method_types: methods,
    metadata: { orderId: order.id, reference: order.reference },
    receipt_email: order.email,
  }

  const pi = await createWithRetry(params, `pi_${order.id}`, order.id)

  // Claim UPDATE — writes BOTH fields together so the sweep predicate never
  // sees an inconsistent state (a PI id set without the matching status).
  // Guarded on IS NULL: a concurrent winner will have set it already → zero rows.
  const claimed = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "Order"
        SET "stripePaymentIntentId" = $1,
            "paymentIntentStatus"    = 'requires_confirmation'
      WHERE id = $2 AND "stripePaymentIntentId" IS NULL
    RETURNING id`,
    pi.id,
    order.id,
  )

  if (claimed.length === 0) {
    // Another concurrent call won the claim. Read back the winning PI id.
    const winner = await db.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { stripePaymentIntentId: true },
    })
    if (winner.stripePaymentIntentId !== pi.id) {
      // This call created a genuinely different PI. Throw — the caller should
      // discard this result and retry from the top (next call will hit the
      // retrieve path).
      throw new Error(
        `Idempotency-key collision: local ${pi.id}, DB ${winner.stripePaymentIntentId}`,
      )
    }
  }

  return {
    clientSecret: pi.client_secret!,
    paymentIntentId: pi.id,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function createWithRetry(
  params: Stripe.PaymentIntentCreateParams,
  idempotencyKey: string,
  orderId: string,
): Promise<Stripe.PaymentIntent> {
  for (let attempt = 0; attempt < IDEMPOTENCY_RETRY_LIMIT; attempt++) {
    try {
      return await stripe.paymentIntents.create(params, { idempotencyKey })
    } catch (e) {
      const err = e as { code?: string; raw?: { code?: string } }
      const code = err.raw?.code ?? err.code
      if (code === 'idempotency_key_in_use') {
        // Another request is using the same key right now. Back off, then
        // re-read the DB — if a concurrent winner already claimed the order,
        // retrieve its PI instead of creating a duplicate.
        await new Promise((r) => setTimeout(r, IDEMPOTENCY_BACKOFF_MS))
        const current = await db.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { stripePaymentIntentId: true },
        })
        if (current.stripePaymentIntentId) {
          return stripe.paymentIntents.retrieve(current.stripePaymentIntentId)
        }
        continue
      }
      throw e
    }
  }
  throw new Error(
    `createPaymentIntent: idempotency_key_in_use after ${IDEMPOTENCY_RETRY_LIMIT} retries (orderId=${orderId})`,
  )
}
