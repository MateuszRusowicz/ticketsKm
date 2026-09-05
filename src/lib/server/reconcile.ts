import 'server-only'
import { recordAudit } from './audit'
import { db } from './db'
import { env } from './env'
import { stripe } from './stripe'

export type ReconcileResult = {
  recoveredRefunds: number
  stuckWebhooks: number
  ticketGaps: number
  alerts: number
}

/**
 * Reconciliation cron — queries and recovers the three narrow "money taken,
 * nothing delivered" states.
 *
 * A. **Stuck refunds**: `refundRequestedAt IS NOT NULL AND stripeRefundId IS NULL
 *    AND status <> 'REFUNDED'` — resume the refund from phase 2.
 *
 * B. **Stuck webhooks**: `StripeWebhookEvent.processedAt IS NULL AND
 *    deadLettered = false AND attemptCount < WEBHOOK_MAX_ATTEMPTS AND
 *    receivedAt < now() - interval '10 minutes'` — count; ALERT if older
 *    than 1 hour (Stripe is no longer retrying).
 *
 * C. **Paid with missing tickets**: `paidAt IS NOT NULL AND ticket_count <
 *    expected_ticket_count` — count and ALERT only; recovery is a manual
 *    admin action, not guesswork by a cron.
 *
 * Emits `RECONCILE recovered=<r> stuckWebhooks=<w> ticketGaps=<g> alerts=<a>`
 * on stderr so the owner can grep Vercel logs.
 */
export async function reconcile(): Promise<ReconcileResult> {
  let recoveredRefunds = 0
  let stuckWebhooks = 0
  let ticketGaps = 0
  let alerts = 0

  // ------------------------------------------------------------------
  // A. Stuck refunds — resume from phase 2.
  // ------------------------------------------------------------------
  const stuckRefunds = await db.order.findMany({
    where: {
      refundRequestedAt: { not: null },
      stripeRefundId: null,
      status: { not: 'REFUNDED' },
    },
    select: {
      id: true,
      stripePaymentIntentId: true,
    },
  })

  for (const order of stuckRefunds) {
    if (!order.stripePaymentIntentId) continue
    const piId = order.stripePaymentIntentId

    try {
      let refundId: string

      try {
        const r = await stripe.refunds.create(
          { payment_intent: piId, reason: 'requested_by_customer' },
          { idempotencyKey: `refund_${piId}` },
        )
        refundId = r.id
      } catch (e) {
        const code = (e as { raw?: { code?: string } }).raw?.code
        if (code === 'charge_already_refunded' || code === 'idempotency_key_in_use') {
          // Retrieve the existing refund from Stripe.
          const list = await stripe.refunds.list({ payment_intent: piId, limit: 1 })
          if (!list.data[0]) throw new Error(`reconcile: ${code} but no refund found for ${piId}`)
          refundId = list.data[0].id
        } else {
          throw e
        }
      }

      // Phase 3 — persist the refund id and mark order REFUNDED.
      await db.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'REFUNDED', stripeRefundId: refundId },
        })
        await recordAudit(
          {
            action: 'order.refunded',
            entityType: 'Order',
            entityId: order.id,
            meta: { source: 'reconcile', paymentIntentId: piId, refundId },
          },
          tx,
        )
      })

      recoveredRefunds += 1
    } catch {
      // Log but continue — one stuck order must not block others.
      alerts += 1
    }
  }

  // ------------------------------------------------------------------
  // B. Stuck webhooks — count; ALERT if older than 1 hour.
  // ------------------------------------------------------------------
  type WebhookRow = {
    stripeEventId: string
    receivedAt: Date
    attemptCount: number
  }

  const stuckRows = (await db.$queryRawUnsafe<WebhookRow[]>(
    `SELECT "stripeEventId", "receivedAt", "attemptCount"
       FROM "StripeWebhookEvent"
      WHERE "processedAt" IS NULL
        AND "deadLettered" = false
        AND "attemptCount" < $1
        AND "receivedAt" < now() - INTERVAL '10 minutes'`,
    env.WEBHOOK_MAX_ATTEMPTS,
  )) as WebhookRow[]

  stuckWebhooks = stuckRows.length

  const cutoffOneHour = Date.now() - 60 * 60 * 1000
  for (const row of stuckRows) {
    if (row.receivedAt.getTime() < cutoffOneHour) {
      alerts += 1
      await recordAudit({
        action: 'stripe.webhook_stuck',
        entityType: 'StripeWebhookEvent',
        entityId: row.stripeEventId,
        meta: { severity: 'ALERT', attemptCount: row.attemptCount, receivedAt: row.receivedAt },
      })
    }
  }

  // ------------------------------------------------------------------
  // C. Paid with missing tickets — count and ALERT only.
  // ------------------------------------------------------------------
  type TicketGapRow = { id: string }

  const gapRows = (await db.$queryRawUnsafe<TicketGapRow[]>(
    `SELECT o.id
       FROM "Order" o
      WHERE o."paidAt" IS NOT NULL
        AND (SELECT count(*) FROM "Ticket" t WHERE t."orderId" = o.id)
            < (SELECT coalesce(sum(oi.quantity), 0) FROM "OrderItem" oi WHERE oi."orderId" = o.id)`,
  )) as TicketGapRow[]

  ticketGaps = gapRows.length

  for (const row of gapRows) {
    alerts += 1
    await recordAudit({
      action: 'order.ticket_gap',
      entityType: 'Order',
      entityId: row.id,
      meta: { severity: 'ALERT', source: 'reconcile' },
    })
  }

  // Grep-able stderr line for Vercel log monitoring.
  console.error(
    `RECONCILE recovered=${recoveredRefunds} stuckWebhooks=${stuckWebhooks} ticketGaps=${ticketGaps} alerts=${alerts}`,
  )

  return { recoveredRefunds, stuckWebhooks, ticketGaps, alerts }
}
