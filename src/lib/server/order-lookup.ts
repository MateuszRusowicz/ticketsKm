import 'server-only'
import { timingSafeEqual } from 'node:crypto'
import type { Locale } from '@/lib/shared/locale'
import { db } from './db'
import { stripe } from './stripe'

/**
 * Which state the confirmation page renders.
 *
 * - `holding`    — PENDING order, hold active, buyer has not yet paid
 * - `processing` — PENDING order, async payment in-flight (BLIK/P24/SEPA)
 * - `expired`    — PENDING order past its hold window
 * - `cancelled`  — CANCELLED, FAILED, or EXPIRED order
 * - `paid`       — PAID order
 * - `refunded`   — REFUNDED or PARTIALLY_REFUNDED order
 *
 * `expired` is expanded on page load (the server calls `expireOrder` before
 * rendering) so the buyer is never told their stale hold still counts.
 */
export type OrderBand = 'holding' | 'processing' | 'expired' | 'cancelled' | 'paid' | 'refunded'

export type OrderConfirmation = {
  order: {
    id: string
    reference: string
    firstName: string
    lastName: string
    quantity: number
    total: number
    currency: 'PLN' | 'EUR'
    locale: Locale
    holdExpiresAt: Date | null
  }
  event: { title: string; slug: string; startsAt: Date; venue: string; city: string }
  band: OrderBand
}

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * The length check is not optional: `timingSafeEqual` THROWS on buffers of
 * different lengths, and the candidate arrives from a user-controlled query
 * string. Length is not a secret here — every token is a v4 UUID — so
 * returning early on a length mismatch reveals nothing.
 */
export function tokenMatches(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(candidate)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function getOrderForConfirmation(
  reference: string,
  token: string,
  locale: Locale,
): Promise<OrderConfirmation | null> {
  const order = await db.order.findUnique({
    where: { reference },
    select: {
      id: true,
      reference: true,
      accessToken: true,
      status: true,
      paymentIntentStatus: true,
      stripePaymentIntentId: true,
      firstName: true,
      lastName: true,
      total: true,
      currency: true,
      locale: true,
      holdExpiresAt: true,
      items: {
        select: {
          quantity: true,
          ticketType: {
            select: {
              event: {
                select: {
                  slug: true,
                  startsAt: true,
                  venue: { select: { name: true, city: true } },
                  translations: { where: { locale }, select: { title: true } },
                },
              },
            },
          },
        },
      },
    },
  })

  if (!order) return null
  // Wrong token is indistinguishable from unknown reference, deliberately.
  if (!tokenMatches(order.accessToken, token)) return null

  const item = order.items[0]
  if (!item) return null

  const event = item.ticketType.event
  const now = Date.now()

  // REFUNDED / PARTIALLY_REFUNDED must resolve to 'refunded', not 'paid'.
  // Previously both mapped to 'paid' — telling refunded buyers their order
  // was paid. This was a live defect once Task 7 enabled auto-refund on
  // late success (4 Sep 2026 critique finding).
  let band: OrderBand =
    order.status === 'REFUNDED' || order.status === 'PARTIALLY_REFUNDED'
      ? 'refunded'
      : order.status === 'PAID'
        ? 'paid'
        : order.status !== 'PENDING'
          ? 'cancelled'
          : order.paymentIntentStatus != null &&
              ['processing', 'requires_action', 'requires_capture'].includes(order.paymentIntentStatus)
            ? 'processing'
            : (order.holdExpiresAt?.getTime() ?? 0) <= now
              ? 'expired'
              : 'holding'

  // Fix for the post-redirect race: the Stripe return_url resolves faster
  // than the webhook, so the stored paymentIntentStatus may still read
  // 'requires_confirmation' while the PI has already succeeded. Ask Stripe
  // for the real live status and derive the band from that.
  //
  // Guard is structural: ONLY call Stripe when status is PENDING and a PI
  // exists. Never on PAID, REFUNDED, CANCELLED, EXPIRED, and never when
  // there is no PI. Do not hoist this call — it would run for every page
  // load, not just the narrow race window where it is needed.
  if (order.status === 'PENDING' && order.stripePaymentIntentId != null) {
    try {
      const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId)
      if (
        pi.status === 'succeeded' ||
        pi.status === 'processing' ||
        pi.status === 'requires_action' ||
        pi.status === 'requires_capture'
      ) {
        // Payment taken or async method in flight — show the polling UI so
        // the buyer waits for the webhook rather than clicking Pay again.
        band = 'processing'
      } else if (pi.status === 'canceled') {
        band = 'cancelled'
      }
      // requires_payment_method / requires_confirmation: buyer has not yet
      // paid or abandoned without entering card details. Keep the stored-
      // mirror band (which already handles holdExpiresAt correctly) so they
      // can retry or see the hold-expired message.
    } catch (err) {
      // Stripe unavailable (network, rate limit, etc.). Fall back to the
      // stored mirror rather than failing the page — a buyer must never see
      // an error page because Stripe was slow.
      console.error('[order-lookup] Stripe paymentIntents.retrieve failed, using stored mirror', err)
    }
  }

  // attendeeNames is deliberately never selected: it is PII the confirmation
  // flow has no need to display, token or not.
  return {
    order: {
      id: order.id,
      reference: order.reference,
      firstName: order.firstName,
      lastName: order.lastName,
      quantity: item.quantity,
      total: order.total,
      currency: order.currency,
      locale: order.locale,
      holdExpiresAt: order.holdExpiresAt,
    },
    event: {
      title: event.translations[0]?.title ?? event.slug,
      slug: event.slug,
      startsAt: event.startsAt,
      venue: event.venue.name,
      city: event.venue.city,
    },
    band,
  }
}
