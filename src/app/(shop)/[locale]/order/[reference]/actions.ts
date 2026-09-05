'use server'

import { redirect } from 'next/navigation'
import { db } from '@/lib/server/db'
import { env } from '@/lib/server/env'
import { tokenMatches } from '@/lib/server/order-lookup'
import { cancelOrder } from '@/lib/server/orders'
import { createPaymentIntent, PaymentIntentReuseError } from '@/lib/server/payment-intent'

export type CancelState = Record<string, never> | { errors: { _form: string[] } }

export type ExtendHoldState =
  | Record<string, never>
  | { errors: { _form: string[] } }
  | { clientSecret: string; publishableKey: string; paymentIntentId: string }

export async function cancelOrderAction(_prev: CancelState, form: FormData): Promise<CancelState> {
  const reference = String(form.get('reference') ?? '')
  const token = String(form.get('accessToken') ?? '')

  const order = await db.order.findUnique({
    where: { reference },
    select: { id: true, accessToken: true, locale: true },
  })

  // A wrong token and an unknown reference return the same thing. References
  // come from a monotonic sequence, so distinguishing them would let anyone
  // enumerate which orders exist — and cancelling is a destructive write.
  if (!order || !tokenMatches(order.accessToken, token)) {
    return { errors: { _form: ['notFound'] } }
  }

  // Idempotent: a second cancel returns { skipped } and releases nothing more.
  await cancelOrder(order.id, 'buyer_cancelled')

  redirect(`/${order.locale}/order/${reference}?t=${token}`)
}

/**
 * Called on Pay-click BEFORE Stripe Elements mounts.
 *
 * Two things happen in one round-trip:
 * 1. `holdExpiresAt` is extended by `PAY_CLICK_HOLD_EXTENSION_MS` so the buyer
 *    mid-3DS / mid-BLIK is never swept by the primary or secondary sweep.
 * 2. `createPaymentIntent` claims the PI and writes `paymentIntentStatus =
 *    'requires_confirmation'` atomically with `stripePaymentIntentId`.
 *
 * Error keys match what the client looks up in the message catalogue:
 * - `notPending${status}` — order is not PENDING (e.g. `notPendingEXPIRED`)
 * - `piReuseAlreadyPaid` / `piReuseNotPending` — PaymentIntentReuseError
 * - `notFound` — wrong token or unknown reference
 */
export async function extendHoldAction(
  _prev: ExtendHoldState,
  form: FormData,
): Promise<ExtendHoldState> {
  const reference = String(form.get('reference') ?? '')
  const token = String(form.get('accessToken') ?? '')

  const order = await db.order.findUnique({
    where: { reference },
    select: { id: true, accessToken: true, status: true },
  })

  if (!order || !tokenMatches(order.accessToken, token)) {
    return { errors: { _form: ['notFound'] } }
  }

  if (order.status !== 'PENDING') {
    return { errors: { _form: [`notPending${order.status}`] } }
  }

  // Extend hold so the buyer mid-3DS or mid-BLIK is not swept.
  const newExpiresAt = new Date(Date.now() + env.PAY_CLICK_HOLD_EXTENSION_MS)
  await db.$queryRawUnsafe(
    `UPDATE "Order" SET "holdExpiresAt" = $1
      WHERE id = $2 AND status = 'PENDING' AND "holdExpiresAt" < $1`,
    newExpiresAt,
    order.id,
  )

  try {
    const { clientSecret, paymentIntentId, publishableKey } = await createPaymentIntent(order.id)
    return { clientSecret, publishableKey, paymentIntentId }
  } catch (e) {
    if (e instanceof PaymentIntentReuseError) {
      // Capitalise so 'alreadyPaid' → 'piReuseAlreadyPaid', 'notPending' → 'piReuseNotPending'.
      // These exact keys exist in all three message catalogues.
      const reason = e.message.charAt(0).toUpperCase() + e.message.slice(1)
      return { errors: { _form: [`piReuse${reason}`] } }
    }
    throw e
  }
}
