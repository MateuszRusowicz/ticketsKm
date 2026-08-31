import 'server-only'
import { db } from './db'
import type { Locale } from '@/lib/shared/locale'
import {
  availabilityBand,
  type NotPurchasableReason,
  type PublicEvent,
} from '@/lib/shared/public-event'

/**
 * Statuses a visitor may see at all.
 *
 * DRAFT and CANCELLED are excluded everywhere, including by direct slug — a
 * draft concert reachable by guessing its URL is a real leak, because
 * programme changes are sometimes embargoed until an announcement.
 *
 * CLOSED is visible: sales have ended but the concert still takes place, and
 * hiding it would make the programme look wrong to someone holding a ticket.
 */
const VISIBLE_STATUSES = ['ON_SALE', 'SOLD_OUT', 'CLOSED'] as const

const eventSelect = {
  id: true,
  slug: true,
  startsAt: true,
  doorsAt: true,
  capacity: true,
  status: true,
  salesOpenAt: true,
  salesCloseAt: true,
  imageUrl: true,
  venue: { select: { name: true, city: true, address: true } },
  ticketTypes: {
    // Deliberately NOT filtered to active: an inactive ticket type must still
    // render a concert with its price, marked not purchasable — hiding it
    // would make the programme look wrong to someone holding a ticket. Active
    // first so a future multi-type event picks the sellable one.
    orderBy: { active: 'desc' },
    select: {
      id: true,
      pricePln: true,
      priceEur: true,
      maxPerOrder: true,
      soldCount: true,
      heldCount: true,
      active: true,
    },
  },
} as const

type Row = {
  id: string
  slug: string
  startsAt: Date
  doorsAt: Date | null
  capacity: number
  status: string
  salesOpenAt: Date | null
  salesCloseAt: Date | null
  imageUrl: string | null
  venue: { name: string; city: string; address: string }
  ticketTypes: {
    id: string
    pricePln: number
    priceEur: number
    maxPerOrder: number
    soldCount: number
    heldCount: number
    active: boolean
  }[]
  translations: { locale: string; title: string; description: string; performers: string }[]
}

function toPublicEvent(row: Row, locale: Locale, now: Date): PublicEvent | null {
  const translation = row.translations[0]
  const ticketType = row.ticketTypes[0]

  // No translation for this locale, or no ticket type at all, means there is
  // nothing coherent to show. Plan 01 guarantees all three translations exist
  // and that every event has one ticket type, so this is a guard rather than
  // an expected path.
  if (!translation || !ticketType) return null

  // Both counters, not just soldCount: a held ticket is mid-checkout and is
  // not available to anyone else. Floored at zero because capacity can be
  // lowered below what is already sold.
  const available = Math.max(0, row.capacity - ticketType.soldCount - ticketType.heldCount)

  // Order matters: the first true reason is the one shown, and "this already
  // happened" is more useful than "sold out" for a concert in the past.
  let reason: NotPurchasableReason | null = null
  if (row.startsAt <= now) reason = 'past'
  // SOLD_OUT is checked before the generic status branch: an admin marking a
  // concert sold out should surface as "sold out", not "unavailable".
  else if (row.status === 'SOLD_OUT') reason = 'soldOut'
  else if (row.status === 'CLOSED') reason = 'closed'
  else if (row.status !== 'ON_SALE') reason = 'unavailable'
  else if (!ticketType.active) reason = 'unavailable'
  else if (row.salesOpenAt && row.salesOpenAt > now) reason = 'notYetOpen'
  else if (row.salesCloseAt && row.salesCloseAt <= now) reason = 'closed'
  else if (available <= 0) reason = 'soldOut'

  return {
    id: row.id,
    slug: row.slug,
    startsAt: row.startsAt,
    doorsAt: row.doorsAt,
    imageUrl: row.imageUrl,
    venue: row.venue,
    translation: {
      locale: translation.locale as Locale,
      title: translation.title,
      description: translation.description,
      performers: translation.performers,
    },
    salesOpenAt: row.salesOpenAt,
    ticketTypeId: ticketType.id,
    pricePln: ticketType.pricePln,
    priceEur: ticketType.priceEur,
    maxPerOrder: ticketType.maxPerOrder,
    available,
    band: availabilityBand(available, row.capacity),
    purchasable: reason === null,
    notPurchasableReason: reason,
  }
}

/** Concerts a visitor may browse: visible status, still in the future, by date. */
export async function listPublicEvents(locale: Locale): Promise<PublicEvent[]> {
  const now = new Date()

  const rows = await db.event.findMany({
    where: { status: { in: [...VISIBLE_STATUSES] }, startsAt: { gt: now } },
    orderBy: { startsAt: 'asc' },
    select: {
      ...eventSelect,
      translations: {
        where: { locale },
        select: { locale: true, title: true, description: true, performers: true },
      },
    },
  })

  return rows
    .map((row) => toPublicEvent(row as Row, locale, now))
    .filter((e): e is PublicEvent => e !== null)
}

/**
 * One concert by slug, or null.
 *
 * Applies exactly the same visibility rules as the listing. A concert absent
 * from the programme must not be reachable by typing its URL.
 */
export async function getPublicEvent(slug: string, locale: Locale): Promise<PublicEvent | null> {
  const now = new Date()

  const row = await db.event.findFirst({
    where: { slug, status: { in: [...VISIBLE_STATUSES] }, startsAt: { gt: now } },
    select: {
      ...eventSelect,
      translations: {
        where: { locale },
        select: { locale: true, title: true, description: true, performers: true },
      },
    },
  })

  return row ? toPublicEvent(row as Row, locale, now) : null
}
