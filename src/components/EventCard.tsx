import { Link } from '@/i18n/routing'
import { AvailabilityBadge } from '@/components/AvailabilityBadge'
import { ConcertImage } from '@/components/ConcertImage'
import { DateTile } from '@/components/DateTile'
import { formatConcertDateTime, isoDateTime } from '@/lib/shared/format'
import { formatMoney, type Currency } from '@/lib/shared/money'
import { priceFor, type PublicEvent } from '@/lib/shared/public-event'
import type { Locale } from '@/lib/shared/locale'

export function EventCard({
  event,
  locale,
  currency,
  availabilityLabel,
  ctaLabel,
}: {
  event: PublicEvent
  locale: Locale
  currency: Currency
  availabilityLabel: string
  ctaLabel: string
}) {
  const href = `/koncert/${event.slug}`

  return (
    <article className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-4 border-b border-border py-8 sm:gap-x-8 md:grid-cols-[auto_1fr_auto] md:items-center">
      {/* Artwork when a concert has it; otherwise the date carries the card. */}
      {event.imageUrl ? (
        <ConcertImage src={event.imageUrl} alt={event.translation.title} className="w-28 sm:w-40" />
      ) : (
        <DateTile date={event.startsAt} locale={locale} />
      )}

      <div className="min-w-0">
        <time dateTime={isoDateTime(event.startsAt)} className="text-sm text-text-secondary">
          {formatConcertDateTime(event.startsAt, locale)}
        </time>

        <h2 className="mt-1 text-text-primary">
          {/* The whole title is the link target: a small "more" link is a poor
              touch target and a poor screen-reader label. */}
          <Link href={href} className="hover:text-accent">
            {event.translation.title}
          </Link>
        </h2>

        {event.translation.performers && (
          <p className="mt-1 font-serif text-lg italic text-text-primary">
            {event.translation.performers}
          </p>
        )}

        <p className="mt-1 text-sm text-text-secondary">
          {event.venue.name}, {event.venue.city}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="price font-display text-lg">
            {formatMoney(priceFor(event, currency), currency, locale)}
          </span>
          <AvailabilityBadge band={event.band} label={availabilityLabel} />
        </div>
      </div>

      {event.purchasable && (
        // The title above is the accessible link to this concert; this is the
        // same destination as a visible call to action, like the main site's
        // "Infos & Tickets". Hidden from the tab order and screen readers so
        // keyboard and assistive-tech users do not meet every concert twice.
        <Link
          href={href}
          tabIndex={-1}
          aria-hidden="true"
          className="btn btn-primary col-span-2 w-full md:col-span-1 md:w-auto"
        >
          {ctaLabel}
        </Link>
      )}
    </article>
  )
}
