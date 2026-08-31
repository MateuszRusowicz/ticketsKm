import { Link } from '@/i18n/routing'
import { AvailabilityBadge } from '@/components/AvailabilityBadge'
import { formatConcertDateTime, isoDateTime } from '@/lib/shared/format'
import { formatMoney, type Currency } from '@/lib/shared/money'
import { priceFor, type PublicEvent } from '@/lib/shared/public-event'
import type { Locale } from '@/lib/shared/locale'

export function EventCard({
  event,
  locale,
  currency,
  availabilityLabel,
}: {
  event: PublicEvent
  locale: Locale
  currency: Currency
  availabilityLabel: string
}) {
  return (
    <article className="border-b border-border py-6">
      <time dateTime={isoDateTime(event.startsAt)} className="text-sm text-text-secondary">
        {formatConcertDateTime(event.startsAt, locale)}
      </time>

      <h2 className="mt-1 text-xl">
        {/* The whole title is the link target: a small "more" link is a poor
            touch target and a poor screen-reader label. */}
        <Link href={`/koncert/${event.slug}`} className="hover:text-accent hover:underline">
          {event.translation.title}
        </Link>
      </h2>

      <p className="mt-1 text-sm text-text-secondary">
        {event.venue.name}, {event.venue.city}
      </p>

      {event.translation.performers && (
        <p className="mt-1 text-sm">{event.translation.performers}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-base">{formatMoney(priceFor(event, currency), currency, locale)}</span>
        <AvailabilityBadge band={event.band} label={availabilityLabel} />
      </div>
    </article>
  )
}
