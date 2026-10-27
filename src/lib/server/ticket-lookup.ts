import 'server-only'
import type { Locale } from '@/lib/shared/locale'
import { db } from './db'

// ---------------------------------------------------------------------------
// Crockford base32 validation — catches garbage before a DB round-trip
// ---------------------------------------------------------------------------

const CROCKFORD_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

/**
 * Returns true when the code looks like a valid 26-character Crockford
 * base32 ticket code. Does not check whether it exists in the DB.
 */
export function isValidTicketCode(code: string): boolean {
  return CROCKFORD_RE.test(code)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PublicTicket = {
  code: string
  holderName: string | null
  event: {
    title: string
    startsAt: Date
    venue: string
    city: string
    address: string
  }
  orderLocale: Locale
  orderReference: string
}

export type PublicTicketView =
  | { kind: 'valid'; ticket: PublicTicket }
  | { kind: 'used'; ticket: PublicTicket; usedAt: Date }
  | { kind: 'revoked'; ticket: PublicTicket }

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Loads a ticket for the public `/t/<code>` page.
 *
 * Returns null for:
 * - Malformed codes (invalid Crockford alphabet / wrong length) — no DB query
 * - Unknown codes
 *
 * Returns `kind: 'revoked'` when:
 * - Ticket.status === 'REVOKED', OR
 * - Order.status is REFUNDED, PARTIALLY_REFUNDED, or CANCELLED
 *
 * NEVER mutates ticket state. Only the Plan 07 scan endpoint does that.
 */
export async function getPublicTicket(code: string): Promise<PublicTicketView | null> {
  if (!isValidTicketCode(code)) return null

  const ticket = await db.ticket.findUnique({
    where: { code },
    select: {
      code: true,
      holderName: true,
      status: true,
      usedAt: true,
      order: {
        select: {
          locale: true,
          reference: true,
          status: true,
        },
      },
      event: {
        select: {
          startsAt: true,
          venue: { select: { name: true, city: true, address: true } },
          translations: {
            select: { title: true, locale: true },
          },
        },
      },
    },
  })

  if (!ticket) return null

  const orderLocale = ticket.order.locale as Locale
  const translation = ticket.event.translations.find((t) => t.locale === orderLocale)
    ?? ticket.event.translations[0]

  const publicTicket: PublicTicket = {
    code: ticket.code,
    holderName: ticket.holderName,
    event: {
      title: translation?.title ?? '',
      startsAt: ticket.event.startsAt,
      venue: ticket.event.venue.name,
      city: ticket.event.venue.city,
      address: ticket.event.venue.address,
    },
    orderLocale,
    orderReference: ticket.order.reference,
  }

  // A refunded/cancelled/partially-refunded order invalidates all its tickets
  const orderRevokes =
    ticket.order.status === 'REFUNDED' ||
    ticket.order.status === 'PARTIALLY_REFUNDED' ||
    ticket.order.status === 'CANCELLED'

  if (ticket.status === 'REVOKED' || orderRevokes) {
    return { kind: 'revoked', ticket: publicTicket }
  }

  if (ticket.status === 'USED') {
    return { kind: 'used', ticket: publicTicket, usedAt: ticket.usedAt! }
  }

  return { kind: 'valid', ticket: publicTicket }
}
