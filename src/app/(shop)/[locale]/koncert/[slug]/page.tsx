import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { AvailabilityBadge } from '@/components/AvailabilityBadge'
import { ConcertImage } from '@/components/ConcertImage'
import { DateTile } from '@/components/DateTile'
import { BuyBox } from '@/components/BuyBox'
import { Link } from '@/i18n/routing'
import { getActiveCurrency } from '@/lib/server/currency'
import { env } from '@/lib/server/env'
import { getPublicEvent } from '@/lib/server/public-events'
import { localeAlternates } from '@/lib/shared/concert-metadata'
import { formatConcertDate, formatConcertTime, isoDateTime } from '@/lib/shared/format'
import { isLocale } from '@/lib/shared/locale'
import { formatMoney } from '@/lib/shared/money'
import { priceFor } from '@/lib/shared/public-event'

type Props = { params: Promise<{ locale: string; slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params
  if (!isLocale(locale)) return {}

  const event = await getPublicEvent(slug, locale)
  if (!event) return {}

  return {
    // Absolute URLs need a base; NEXT_PUBLIC_SITE_URL is tickets-km.vercel.app
    // until launch, not the festival subdomain.
    metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
    title: event.translation.title,
    description: event.translation.description.slice(0, 200),
    alternates: { languages: localeAlternates(slug, env.NEXT_PUBLIC_SITE_URL) },
  }
}

export default async function ConcertPage({ params }: Props) {
  const { locale, slug } = await params
  if (!isLocale(locale)) notFound()

  setRequestLocale(locale)

  const event = await getPublicEvent(slug, locale)
  // Covers an unknown slug, a DRAFT concert, a CANCELLED one and a past one.
  // A draft reachable by guessing its slug is a real leak — programme changes
  // are sometimes embargoed until an announcement.
  if (!event) notFound()

  const [t, tAvailability, tNot, currency] = await Promise.all([
    getTranslations('concert'),
    getTranslations('availability'),
    getTranslations('notPurchasable'),
    getActiveCurrency(locale),
  ])

  const tSite = await getTranslations('site')

  return (
    <main className="mx-auto max-w-[1200px] px-4 pt-10 sm:px-8 sm:pt-12">
      <p className="text-sm">
        <Link href="/" className="link font-display">
          ← {tSite('backToProgramme')}
        </Link>
      </p>

      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_380px] lg:gap-16">
        <article className="min-w-0">
          <div className="flex items-start gap-6 sm:gap-8">
            {!event.imageUrl && <DateTile date={event.startsAt} locale={locale} size="lg" />}
            <div className="min-w-0">
              <time dateTime={isoDateTime(event.startsAt)} className="eyebrow block">
                {formatConcertDate(event.startsAt, locale)}, {formatConcertTime(event.startsAt, locale)}
              </time>
              <h1 className="mt-2 text-accent">{event.translation.title}</h1>
              {event.translation.performers && (
                <p className="mt-3 font-serif text-xl italic text-text-primary sm:text-2xl">
                  {event.translation.performers}
                </p>
              )}
            </div>
          </div>

          {event.imageUrl && (
            <ConcertImage src={event.imageUrl} alt={event.translation.title} className="mt-8" />
          )}

          {/* hyphens: auto needs the lang attribute the layout sets, or German
              compounds overflow on a phone. */}
          <p className="prose-serif mt-8 max-w-[65ch] hyphens-auto">{event.translation.description}</p>

          <dl className="mt-8 grid max-w-[65ch] grid-cols-[auto_1fr] gap-x-6 gap-y-3 border-t border-border pt-6">
            <dt className="text-sm text-text-secondary">{t('venue')}</dt>
            <dd>
              {event.venue.name}, {event.venue.address}, {event.venue.city}
            </dd>

            {event.doorsAt && (
              <>
                <dt className="text-sm text-text-secondary">{t('doors')}</dt>
                <dd>{formatConcertTime(event.doorsAt, locale)}</dd>
              </>
            )}

            <dt className="text-sm text-text-secondary">{t('performers')}</dt>
            <dd>{event.translation.performers}</dd>

            <dt className="text-sm text-text-secondary">{t('price')}</dt>
            <dd className="price">{formatMoney(priceFor(event, currency), currency, locale)}</dd>
          </dl>
        </article>

        {/* Sticky on desktop so the buy box stays in reach while reading a long
            description; on a phone it simply follows the text. */}
        <aside className="panel h-fit p-6 sm:p-8 lg:sticky lg:top-8">
          <p className="price font-display text-3xl text-text-primary">
            {formatMoney(priceFor(event, currency), currency, locale)}
          </p>
          {/* Only when it is true: a closed sale would otherwise read "tickets
              available" directly above "sales have ended". */}
          {(event.purchasable || event.band === 'soldOut') && (
            <div className="mt-2">
              <AvailabilityBadge band={event.band} label={tAvailability(event.band)} />
            </div>
          )}

          {event.purchasable ? (
            <BuyBox
              slug={event.slug}
              locale={locale}
              maxPerOrder={event.maxPerOrder}
              available={event.available}
              currency={currency}
              labels={{ quantity: t('quantity'), buy: t('buy') }}
            />
          ) : (
            // Each state gets its own sentence rather than a disabled button:
            // "sales open on 1 June" and "sold out" are different news.
            <p className="mt-4 text-text-secondary">
              {event.notPurchasableReason === 'notYetOpen' && event.salesOpenAt
                ? tNot('notYetOpen', { date: formatConcertDate(event.salesOpenAt, locale) })
                : tNot(event.notPurchasableReason ?? 'unavailable')}
            </p>
          )}
        </aside>
      </div>
    </main>
  )
}
