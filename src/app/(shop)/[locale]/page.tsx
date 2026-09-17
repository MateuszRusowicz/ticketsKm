import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { EventCard } from '@/components/EventCard'
import { getActiveCurrency } from '@/lib/server/currency'
import { listPublicEvents } from '@/lib/server/public-events'
import { formatConcertDate } from '@/lib/shared/format'
import { isLocale } from '@/lib/shared/locale'

export default async function ProgrammePage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!isLocale(locale)) notFound()

  // Before any translation lookup, or the page silently opts out of the
  // request-scoped locale.
  setRequestLocale(locale)

  const [t, tAvailability, tNot, tConcert, tSite, currency, events] = await Promise.all([
    getTranslations('programme'),
    getTranslations('availability'),
    getTranslations('notPurchasable'),
    getTranslations('concert'),
    getTranslations('site'),
    getActiveCurrency(locale),
    listPublicEvents(locale),
  ])

  return (
    <main className="mx-auto max-w-[1200px] px-4 pt-12 sm:px-8 sm:pt-16">
      <div className="max-w-[46rem]">
        <p className="text-xl sm:text-2xl">
          <span className="brand-band">{tSite('title')}</span>
        </p>
        <h1 className="mt-6 text-accent">{t('heading')}</h1>
        <p className="prose-serif mt-4 text-text-secondary">{t('intro')}</p>
      </div>

      {events.length === 0 ? (
        // Eleven months of the year this is the normal state, not an error.
        <p className="prose-serif mt-12 text-text-secondary">{t('empty')}</p>
      ) : (
        <div className="mt-10 border-t border-border">
          {events.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              locale={locale}
              currency={currency}
              // A listed concert that cannot be bought says why, in the same
              // words as its own page. Before 17 Sep the listing said "tickets
              // available" for concerts whose sales had closed.
              availabilityLabel={
                event.purchasable || event.band === 'soldOut'
                  ? tAvailability(event.band)
                  : event.notPurchasableReason === 'notYetOpen' && event.salesOpenAt
                    ? tNot('notYetOpen', { date: formatConcertDate(event.salesOpenAt, locale) })
                    : tNot(event.notPurchasableReason ?? 'unavailable')
              }
              ctaLabel={tConcert('buy')}
            />
          ))}
        </div>
      )}
    </main>
  )
}
