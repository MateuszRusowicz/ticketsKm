import 'server-only'
import { timingSafeEqual } from 'node:crypto'
import type { Locale } from '@/lib/shared/locale'
import { db } from './db'

/**
 * Which of four states the confirmation page renders.
 * `expired` is a PENDING order past its hold — the page expires it before
 * rendering, so the buyer is not told the seats are free while their own
 * stale hold still counts against the concert.
 */
export type OrderBand = 'holding' | 'expired' | 'cancelled' | 'paid'

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

  const band: OrderBand =
    order.status === 'PAID' || order.status === 'REFUNDED'
      ? 'paid'
      : order.status !== 'PENDING'
        ? 'cancelled'
        : (order.holdExpiresAt?.getTime() ?? 0) <= now
          ? 'expired'
          : 'holding'

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
