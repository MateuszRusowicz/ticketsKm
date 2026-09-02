'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { setCurrencyAction } from '@/app/(shop)/actions'
import { usePathname } from '@/i18n/routing'
import { CURRENCIES, type Currency } from '@/lib/shared/money'

const LABEL: Record<Currency, string> = { PLN: 'zł', EUR: '€' }

export function CurrencySwitcher({ active, label }: { active: Currency; label: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const [pending, startTransition] = useTransition()

  // Currency is frozen at the order page (00-decisions.md, "Currency freeze
  // point"): the summary must show what will actually be charged. usePathname()
  // from @/i18n/routing strips the locale prefix, so this is /koncert/…/zamowienie.
  // Called after every hook — an early return above them breaks the rules of hooks.
  if (pathname.endsWith('/zamowienie')) return null

  function choose(currency: Currency) {
    if (currency === active) return

    startTransition(async () => {
      await setCurrencyAction(currency)
      // Prices are rendered on the server, so the cookie alone changes
      // nothing until the route re-renders.
      router.refresh()
    })
  }

  return (
    <nav aria-label={label} className="flex gap-1">
      {CURRENCIES.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => choose(c)}
          aria-current={c === active ? 'true' : undefined}
          disabled={pending}
          className={`min-h-[44px] px-3 py-2 text-sm ${
            c === active ? 'font-semibold text-accent underline' : 'text-text-secondary'
          }`}
        >
          {LABEL[c]}
        </button>
      ))}
    </nav>
  )
}
