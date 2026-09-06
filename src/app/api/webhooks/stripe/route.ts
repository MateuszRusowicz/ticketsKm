import type Stripe from 'stripe'
import { NextResponse } from 'next/server'
import { db } from '@/lib/server/db'
import { env } from '@/lib/server/env'
import { stripe } from '@/lib/server/stripe'
import { dispatchWebhookEvent, WebhookMalformedError } from '@/lib/server/webhook-dispatch'
import { recordAudit } from '@/lib/server/audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get('stripe-signature')
  if (!signature) return new NextResponse('missing stripe-signature', { status: 400 })

  // MUST use request.text() — Stripe signature verification requires the raw
  // bytes exactly as received. Any JSON.parse/stringify round-trip changes
  // whitespace and invalidates the HMAC.
  const raw = await request.text()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET)
  } catch (e) {
    return new NextResponse(`invalid signature: ${(e as Error).message}`, { status: 400 })
  }

  const early = await db.$transaction(
    async (tx) => {
      // Insert-or-continue (idempotency ledger).
      await tx.$executeRawUnsafe(
        `INSERT INTO "StripeWebhookEvent" ("stripeEventId", type)
           VALUES ($1, $2) ON CONFLICT ("stripeEventId") DO NOTHING`,
        event.id,
        event.type,
      )

      // Row lock — serialises concurrent deliveries of the same event id.
      const rows = await tx.$queryRawUnsafe<
        Array<{
          stripeEventId: string
          processedAt: Date | null
          attemptCount: number
          deadLettered: boolean
        }>
      >(
        `SELECT "stripeEventId", "processedAt", "attemptCount", "deadLettered"
           FROM "StripeWebhookEvent"
          WHERE "stripeEventId" = $1
          FOR UPDATE`,
        event.id,
      )
      const row = rows[0]

      if (row.processedAt) {
        return new NextResponse('duplicate, already processed', { status: 200 })
      }

      if (row.deadLettered) {
        return new NextResponse('dead-lettered', { status: 200 })
      }

      if (row.attemptCount >= env.WEBHOOK_MAX_ATTEMPTS) {
        await tx.stripeWebhookEvent.update({
          where: { stripeEventId: event.id },
          data: { deadLettered: true },
        })
        await recordAudit(
          {
            action: 'stripe.webhook_dead_lettered',
            entityType: 'StripeWebhookEvent',
            entityId: event.id,
            meta: {
              severity: 'ALERT',
              type: event.type,
              attemptCount: row.attemptCount,
            },
          },
          tx,
        )
        // Return 200 so Stripe stops retrying. The ALERT audit is what surfaces this.
        return new NextResponse('dead-lettered on this attempt', { status: 200 })
      }

      await tx.stripeWebhookEvent.update({
        where: { stripeEventId: event.id },
        data: { attemptCount: { increment: 1 } },
      })

      // Returning undefined signals: proceed to dispatch outside the transaction.
      return undefined
    },
    { timeout: 10_000 },
  )

  // Short-circuit responses from the transaction (duplicate / dead-letter).
  if (early) return early

  // Dispatch OUTSIDE the ledger transaction so a slow Stripe API call cannot
  // hold the row lock and block other webhook deliveries.
  try {
    const result = await dispatchWebhookEvent(event)
    await db.stripeWebhookEvent.update({
      where: { stripeEventId: event.id },
      data: { processedAt: new Date(), error: null },
    })
    return NextResponse.json(result, { status: 200 })
  } catch (e) {
    if (e instanceof WebhookMalformedError) {
      // Mark processedAt so Stripe does not retry a permanently malformed event.
      await db.stripeWebhookEvent.update({
        where: { stripeEventId: event.id },
        data: { processedAt: new Date(), error: e.message },
      })
      return new NextResponse(e.message, { status: 400 })
    }
    // Transient failure: record error, leave processedAt NULL so Stripe retries.
    await db.stripeWebhookEvent.update({
      where: { stripeEventId: event.id },
      data: { error: (e as Error).message },
    })
    throw e
  }
}
