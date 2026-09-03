import { notFound } from 'next/navigation'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { CancelOrderButton } from '@/components/CancelOrderButton'
import { Link } from '@/i18n/routing'
import { getOrderForConfirmation } from '@/lib/server/order-lookup'
import { expireOrder } from '@/lib/server/orders'
import { formatConcertDate, formatConcertTime } from '@/lib/shared/format'
import { isLocale } from '@/lib/shared/locale'
import { formatMoney } from '@/lib/shared/money'

// The page carries buyer PII and live hold state. Next's default static
// rendering would cache one buyer's name and serve it to the next visitor —
// a leak that has nothing to do with whether the page is indexed.
export const dynamic = 'force-dynamic'
export const fetchCache = 'default-no-store'

type Props = {
  params: Promise<{ locale: string; reference: string }>
  searchParams: Promise<{ t?: string }>
}

export default async function OrderConfirmationPage({ params, searchParams }: Props) {
  const { locale, reference } = await params
  if (!isLocale(locale)) notFound()
  setRequestLocale(locale)

  // The reference is drawn from a monotonic sequence and is therefore
  // enumerable; the token is what actually guards this page.
  const { t: token } = await searchParams
  if (!token) notFound()

  let confirmation = await getOrderForConfirmation(reference, token, locale)
  if (!confirmation) notFound()

  // Expire before rendering the expired band. Without this the buyer is told
  // the seats are back on sale and offered "Start over", then rejected by
  // their own stale hold — the concert looks sold out to the one person
  // trying to get back into it. expireOrder is idempotent and races safely
  // with the sweep.
  if (confirmation.band === 'expired') {
    await expireOrder(confirmation.order.id)
    confirmation = await getOrderForConfirmation(reference, token, locale)
    if (!confirmation) notFound()
  }

  const { order, event, band } = confirmation
  const t = await getTranslations('order')

  return (
    <main className="mx-auto max-w-[800px] px-4 py-10">
      <h1 className="text-2xl font-semibold">{t(`${band}.heading` as 'holding.heading')}</h1>

      <p className="mt-3 text-text-secondary">
        {band === 'holding' && order.holdExpiresAt
          ? t('holding.body', { time: formatConcertTime(order.holdExpiresAt, locale) })
          : t(`${band}.body` as 'holding.body')}
      </p>

      <dl className="mt-8 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-border pt-6">
        <dt className="text-text-secondary">{t('reference')}</dt>
        <dd className="font-mono">{order.reference}</dd>

        <dt className="text-text-secondary">{t('buyer')}</dt>
        <dd>
          {order.firstName} {order.lastName}
        </dd>

        <dt className="text-text-secondary">{t('concert')}</dt>
        <dd>
          {event.title} — {formatConcertDate(event.startsAt, locale)},{' '}
          {formatConcertTime(event.startsAt, locale)}
        </dd>

        <dt className="text-text-secondary">{t('venue')}</dt>
        <dd>
          {event.venue}, {event.city}
        </dd>

        <dt className="text-text-secondary">{t('quantity')}</dt>
        <dd>{order.quantity}</dd>

        <dt className="text-text-secondary">{t('total')}</dt>
        <dd>{formatMoney(order.total, order.currency, locale)}</dd>
      </dl>

      {band === 'holding' && (
        <CancelOrderButton
          reference={order.reference}
          accessToken={token}
          label={t('cancel')}
          notFoundLabel={t('cancelFailed')}
        />
      )}

      {(band === 'expired' || band === 'cancelled') && (
        <Link href={`/koncert/${event.slug}`} className="mt-8 inline-block underline">
          {t('startOver')}
        </Link>
      )}
    </main>
  )
}
