'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { maxSelectableQuantity } from '@/lib/shared/public-event'

export function BuyBox({
  slug,
  locale,
  maxPerOrder,
  available,
  labels,
}: {
  slug: string
  locale: string
  maxPerOrder: number
  available: number
  labels: { quantity: string; buy: string }
}) {
  const router = useRouter()
  const max = maxSelectableQuantity(maxPerOrder, available)
  const [quantity, setQuantity] = useState(1)

  // The bound here is a convenience, not a guarantee. The order page
  // re-clamps it server-side, and Plan 04 re-checks transactionally at order
  // creation — between this render and a submit the concert can sell out.
  const options = Array.from({ length: max }, (_, i) => i + 1)

  return (
    <form
      className="mt-6 flex flex-wrap items-end gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        router.push(`/${locale}/koncert/${slug}/zamowienie?q=${quantity}`)
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="quantity" className="text-sm text-text-secondary">
          {labels.quantity}
        </label>
        <select
          id="quantity"
          name="quantity"
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
          // 1rem or iOS zooms the whole page on focus.
          className="min-h-[48px] border border-border px-3 text-base"
        >
          {options.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        className="min-h-[48px] bg-accent px-6 text-base text-white hover:opacity-90"
      >
        {labels.buy}
      </button>
    </form>
  )
}
