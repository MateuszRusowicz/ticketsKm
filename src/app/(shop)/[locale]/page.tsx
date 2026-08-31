import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { EventCard } from '@/components/EventCard'
import { getActiveCurrency } from '@/lib/server/currency'
import { listPublicEvents } from '@/lib/server/public-events'
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

  const [t, tAvailability, currency, events] = await Promise.all([
    getTranslations('programme'),
    getTranslations('availability'),
    getActiveCurrency(locale),
    listPublicEvents(locale),
  ])

  return (
    <main className="mx-auto max-w-[1200px] px-8 py-12">
      <h1 className="text-3xl">{t('heading')}</h1>
      <p className="mt-2 text-text-secondary">{t('intro')}</p>

      {events.length === 0 ? (
        // Eleven months of the year this is the normal state, not an error.
        <p className="mt-12 text-text-secondary">{t('empty')}</p>
      ) : (
        <div className="mt-8">
          {events.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              locale={locale}
              currency={currency}
              availabilityLabel={tAvailability(event.band)}
            />
          ))}
        </div>
      )}
    </main>
  )
}
