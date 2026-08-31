// Shape and pure logic for the public-facing view of a concert.
//
// This lives in shared/ rather than server/ because src/components/** needs
// these types, and eslint.config.mjs bans components from importing
// @/lib/server/* — with no allowTypeImports escape, so even `import type`
// fails. The query that produces a PublicEvent is in
// @/lib/server/public-events.
import type { Currency } from './money'
import type { Locale } from './locale'

/** How availability is shown. The exact remaining count is never published. */
export type AvailabilityBand = 'available' | 'few' | 'soldOut'

/**
 * Why a concert cannot be bought right now. `null` when it can.
 *
 * Computed once, server-side, so the listing, the detail page and the buy box
 * cannot each derive the sales-window rules slightly differently.
 */
export type NotPurchasableReason =
  | 'past' // the concert has already happened
  | 'notYetOpen' // salesOpenAt is in the future
  | 'closed' // salesCloseAt has passed, or status is CLOSED
  | 'soldOut' // no capacity left
  | 'unavailable' // DRAFT/CANCELLED, or no active ticket type

export type PublicEventTranslation = {
  locale: Locale
  title: string
  description: string
  performers: string
}

export type PublicEvent = {
  id: string
  slug: string
  startsAt: Date
  doorsAt: Date | null
  imageUrl: string | null
  venue: { name: string; city: string; address: string }
  translation: PublicEventTranslation

  // Plan 04's hold targets this specific ticket type, so it must survive the
  // trip to the checkout form.
  ticketTypeId: string
  pricePln: number
  priceEur: number
  maxPerOrder: number

  // Needed to render "sales open on <date>": a notYetOpen reason without the
  // date tells the visitor nothing actionable.
  salesOpenAt: Date | null

  available: number
  band: AvailabilityBand
  purchasable: boolean
  notPurchasableReason: NotPurchasableReason | null
}

/**
 * Below this share of capacity the badge reads "few remaining".
 * A share rather than a fixed number: 20 left is nearly sold out in the
 * 300-seat palace and unremarkable in the 900-seat church.
 */
export const FEW_REMAINING_RATIO = 0.1

export function availabilityBand(available: number, capacity: number): AvailabilityBand {
  if (available <= 0) return 'soldOut'
  // A non-positive capacity would otherwise make every concert "few".
  if (capacity <= 0) return 'soldOut'
  return available <= capacity * FEW_REMAINING_RATIO ? 'few' : 'available'
}

/**
 * Upper bound for the quantity selector: policy (`maxPerOrder`) and physics
 * (`available`), whichever binds first.
 *
 * This is a UI convenience only. Plan 04 re-checks transactionally at order
 * creation, because a concert can sell out between render and submit.
 */
export function maxSelectableQuantity(maxPerOrder: number, available: number): number {
  return Math.max(0, Math.min(maxPerOrder, available))
}

/** Price in the active currency, in minor units. */
export function priceFor(event: PublicEvent, currency: Currency): number {
  return currency === 'PLN' ? event.pricePln : event.priceEur
}
