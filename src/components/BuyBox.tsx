'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { maxSelectableQuantity } from '@/lib/shared/public-event'
import { setCurrencyAction } from '@/app/(shop)/actions'
import { CURRENCIES, type Currency } from '@/lib/shared/money'
import { paymentMethodLabelsFor } from '@/lib/shared/payment-methods'

export function BuyBox({
  slug,
  locale,
  maxPerOrder,
  available,
  currency,
  labels,
}: {
  slug: string
  locale: string
  maxPerOrder: number
  available: number
  currency: Currency
  labels: { quantity: string; buy: string }
}) {
  const router = useRouter()
  const t = useTranslations('concert')
  const max = maxSelectableQuantity(maxPerOrder, available)
  const [quantity, setQuantity] = useState(1)
  const [pending, startTransition] = useTransition()

  // The bound here is a convenience, not a guarantee. The order page
  // re-clamps it server-side, and Plan 04 re-checks transactionally at order
  // creation — between this render and a submit the concert can sell out.
  const options = Array.from({ length: max }, (_, i) => i + 1)

  const methodLabels = paymentMethodLabelsFor(currency, t('methodCard'))

  function chooseCurrency(value: string) {
    if (pending) return
    startTransition(async () => {
      await setCurrencyAction(value)
      // Prices are rendered on the server, so the cookie alone changes
      // nothing until the route re-renders.
      router.refresh()
    })
  }

  return (
    <div className="mt-6 flex flex-col gap-5">
      <div>
        <label htmlFor="buybox-currency" className="field-label">
          {t('currencySelect')}
        </label>
        <select
          id="buybox-currency"
          name="currency"
          value={currency}
          disabled={pending}
          onChange={(e) => chooseCurrency(e.target.value)}
          className="field"
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <p className="mt-2 text-sm leading-snug text-text-secondary">
          {t('payingIn', { currency, methods: methodLabels.join(', ') })}
        </p>
      </div>

      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          router.push(`/${locale}/koncert/${slug}/zamowienie?q=${quantity}`)
        }}
      >
        <div>
          <label htmlFor="quantity" className="field-label">
            {labels.quantity}
          </label>
          <select
            id="quantity"
            name="quantity"
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            className="field"
          >
            {options.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" className="btn btn-primary w-full">
          {labels.buy}
        </button>
      </form>
    </div>
  )
}
