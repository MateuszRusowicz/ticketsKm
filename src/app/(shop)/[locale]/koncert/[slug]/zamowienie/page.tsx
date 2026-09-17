import { notFound } from 'next/navigation'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { CheckoutForm } from '@/components/CheckoutForm'
import { Link } from '@/i18n/routing'
import { getActiveCurrency } from '@/lib/server/currency'
import { getPublicEvent } from '@/lib/server/public-events'
import { clampQuantity } from '@/lib/shared/checkout'
import { formatConcertDate, formatConcertTime } from '@/lib/shared/format'
import { isLocale } from '@/lib/shared/locale'
import { formatMoney } from '@/lib/shared/money'
import { priceFor } from '@/lib/shared/public-event'

type Props = {
  params: Promise<{ locale: string; slug: string }>
  searchParams: Promise<{ q?: string }>
}

export default async function OrderPage({ params, searchParams }: Props) {
  const { locale, slug } = await params
  if (!isLocale(locale)) notFound()
  setRequestLocale(locale)

  const event = await getPublicEvent(slug, locale)
  if (!event) notFound()

  // A concert that cannot be bought has no order page. Without this, a stale
  // tab could submit against a concert that sold out ten minutes ago.
  if (!event.purchasable) notFound()

  // `?q=` is user-controlled. Re-validated and re-clamped here against both
  // bounds rather than trusted — the buy box's <select> is a convenience, not
  // a guarantee, and nothing stops someone typing ?q=500.
  const { q } = await searchParams
  const quantity = clampQuantity(q, event.maxPerOrder, event.available)
  if (quantity === 0) notFound()

  const [t, currency] = await Promise.all([
    getTranslations('checkout'),
    getActiveCurrency(locale),
  ])

  const unit = priceFor(event, currency)

  return (
    <main className="mx-auto max-w-[800px] px-4 pt-10 sm:px-8 sm:pt-12">
      <p className="text-sm">
        <Link href={`/koncert/${event.slug}`} className="link font-display">
          ← {event.translation.title}
        </Link>
      </p>

      <h1 className="mt-6 text-accent">{t('heading')}</h1>

      {/* What is being bought, before a single field — the buyer should never
          have to scroll back up to check the concert or the total. */}
      <div className="panel mt-6 flex flex-col gap-1 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-6">
        <div className="min-w-0">
          <p className="font-display text-xl text-text-primary">{event.translation.title}</p>
          <p className="text-sm text-text-secondary">
            {formatConcertDate(event.startsAt, locale)}, {formatConcertTime(event.startsAt, locale)} ·{' '}
            {event.venue.name}
          </p>
        </div>
        <p className="price shrink-0 font-display text-xl text-text-primary">
          {t('summary', { count: quantity, total: formatMoney(unit * quantity, currency, locale) })}
        </p>
      </div>

      <CheckoutForm
        ticketTypeId={event.ticketTypeId}
        quantity={quantity}
        locale={locale}
        currency={currency}
        termsHref={`/${locale}/regulamin`}
        privacyHref={`/${locale}/prywatnosc`}
      />
    </main>
  )
}
