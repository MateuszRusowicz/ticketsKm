import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { AvailabilityBadge } from '@/components/AvailabilityBadge'
import { ConcertImage } from '@/components/ConcertImage'
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

  return (
    <main className="mx-auto max-w-[65ch] px-8 py-12">
      <p className="text-sm">
        <Link href="/" className="text-text-secondary underline hover:text-accent">
          ← {(await getTranslations('site'))('backToProgramme')}
        </Link>
      </p>

      <time dateTime={isoDateTime(event.startsAt)} className="mt-8 block text-sm text-text-secondary">
        {formatConcertDate(event.startsAt, locale)}, {formatConcertTime(event.startsAt, locale)}
      </time>

      <h1 className="mt-1 text-3xl">{event.translation.title}</h1>

      <ConcertImage
        src={event.imageUrl}
        alt={event.translation.title}
        className="mt-6"
      />

      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-text-secondary">{t('venue')}</dt>
        <dd>
          {event.venue.name}, {event.venue.address}, {event.venue.city}
        </dd>

        {event.doorsAt && (
          <>
            <dt className="text-text-secondary">{t('doors')}</dt>
            <dd>{formatConcertTime(event.doorsAt, locale)}</dd>
          </>
        )}

        <dt className="text-text-secondary">{t('performers')}</dt>
        <dd>{event.translation.performers}</dd>

        <dt className="text-text-secondary">{t('price')}</dt>
        <dd>{formatMoney(priceFor(event, currency), currency, locale)}</dd>
      </dl>

      {/* hyphens: auto needs the lang attribute the layout sets, or German
          compounds overflow on a phone. */}
      <p className="mt-6 hyphens-auto">{event.translation.description}</p>

      <div className="mt-8 border-t border-border pt-6">
        <AvailabilityBadge band={event.band} label={tAvailability(event.band)} />

        {event.purchasable ? (
          <BuyBox
            slug={event.slug}
            locale={locale}
            maxPerOrder={event.maxPerOrder}
            available={event.available}
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
      </div>
    </main>
  )
}
