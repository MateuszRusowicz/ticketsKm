import 'server-only'
import { z } from 'zod'
import type Stripe from 'stripe'
import { recordAudit } from './audit'
import { failOrder, fulfilOrder, recordPaymentAttempt, type RefundHook } from './orders'
import { stripe } from './stripe'

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class WebhookMalformedError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'WebhookMalformedError'
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const orderIdSchema = z.uuid()

function extractOrderId(pi: Stripe.PaymentIntent): string {
  const parsed = orderIdSchema.safeParse(pi.metadata?.orderId)
  if (!parsed.success) {
    throw new WebhookMalformedError(
      `PaymentIntent ${pi.id} metadata.orderId is missing or not a valid UUID`,
    )
  }
  return parsed.data
}

/**
 * Stripe refund hook for the succeeded dispatch path.
 *
 * Handles exactly-once refund with two fallback strategies on soft errors:
 *   - charge_already_refunded: retrieve the existing refund by charge or PI
 *   - idempotency_key_in_use:  retrieve the existing refund by charge or PI
 *
 * See plan/00-decisions.md "Refunds are idempotent by our own field, not
 * Stripe's key retention" for the rationale.
 */
function buildRefundHook(piId: string): RefundHook {
  return async (paymentIntentId: string, chargeId: string | null) => {
    try {
      const r = await stripe.refunds.create(
        { payment_intent: paymentIntentId, reason: 'requested_by_customer' },
        { idempotencyKey: `refund_${paymentIntentId}` },
      )
      return { refundId: r.id }
    } catch (e) {
      const code = (e as { raw?: { code?: string } }).raw?.code
      if (code === 'charge_already_refunded' || code === 'idempotency_key_in_use') {
        // Look up the existing refund through the charge if available, else through the PI.
        const list = await stripe.refunds.list(
          chargeId
            ? { charge: chargeId, limit: 1 }
            : { payment_intent: paymentIntentId, limit: 1 },
        )
        if (list.data[0]) return { refundId: list.data[0].id }
        throw new Error(`refund: ${code} but no existing refund found for ${piId}`)
      }
      throw e
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Routes a verified Stripe event to the appropriate handler.
 *
 * Called from the webhook route AFTER signature verification and ledger
 * bookkeeping. Must be idempotent: each handler is either idempotent itself
 * (fulfilOrder checks Order.status) or writes audit-only rows.
 *
 * payment_intent.payment_failed does NOT call failOrder. A declined card is
 * retryable; releasing seats would cause the retry to charge against a FAILED
 * order and fulfilOrder would then skip and refund instead of fulfilling.
 * Only payment_intent.canceled is terminal.
 */
export async function dispatchWebhookEvent(
  event: Stripe.Event,
): Promise<{ acknowledged: true; action: string; detail?: string }> {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi0 = event.data.object as Stripe.PaymentIntent
      const orderId = extractOrderId(pi0)
      // Expand latest_charge so extractPaymentMethodType sees the full Charge object.
      const pi = await stripe.paymentIntents.retrieve(pi0.id, { expand: ['latest_charge'] })
      // Record the observed PI status and payment method type BEFORE fulfilling.
      // Order matters: the PI genuinely succeeded at Stripe regardless of what fulfilOrder
      // then does. Persisting the fact first means it survives a fulfilOrder throw (Stripe
      // retries) and remains truthful when fulfilOrder takes the refund branch.
      await recordPaymentAttempt(orderId, pi, { reason: 'succeeded' })
      const refundHook = buildRefundHook(pi.id)
      const result = await fulfilOrder(orderId, refundHook, pi)
      return { acknowledged: true, action: 'fulfilOrder', detail: JSON.stringify(result) }
    }

    case 'payment_intent.processing': {
      const pi0 = event.data.object as Stripe.PaymentIntent
      const orderId = extractOrderId(pi0)
      // Expand latest_charge so extractPaymentMethodType can read charge.payment_method_details.
      const pi = await stripe.paymentIntents.retrieve(pi0.id, { expand: ['latest_charge'] })
      await recordPaymentAttempt(orderId, pi, { reason: 'processing' })
      return { acknowledged: true, action: 'processing' }
    }

    case 'payment_intent.requires_action': {
      const pi = event.data.object as Stripe.PaymentIntent
      // No retrieve needed — method type is not yet determinable at requires_action.
      await recordPaymentAttempt(extractOrderId(pi), pi, { reason: 'requires_action' })
      return { acknowledged: true, action: 'requires_action' }
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent
      // IMPORTANT: do NOT call failOrder here. A declined card is retryable.
      // Releasing seats (failOrder) makes the retry charge against a FAILED order;
      // fulfilOrder would then detect the terminal state and trigger a refund instead
      // of issuing tickets. Only payment_intent.canceled is terminal.
      await recordPaymentAttempt(extractOrderId(pi), pi, { reason: 'declined' })
      return { acknowledged: true, action: 'declined' }
    }

    case 'payment_intent.canceled': {
      const pi = event.data.object as Stripe.PaymentIntent
      const result = await failOrder(
        extractOrderId(pi),
        `stripe.canceled:${pi.cancellation_reason ?? 'unknown'}`,
      )
      return { acknowledged: true, action: 'failOrder', detail: JSON.stringify(result) }
    }

    case 'charge.dispute.created': {
      const d = event.data.object as Stripe.Dispute
      await recordAudit({
        action: 'stripe.dispute',
        entityType: 'Charge',
        entityId: typeof d.charge === 'string' ? d.charge : d.charge.id,
        meta: {
          severity: 'ALERT',
          reason: d.reason,
          amount: d.amount,
          currency: d.currency,
        },
      })
      return { acknowledged: true, action: 'dispute_flagged' }
    }

    default:
      return { acknowledged: true, action: 'ignored', detail: event.type }
  }
}
