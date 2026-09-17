'use client'

import { useLocale } from 'next-intl'
import { Link, usePathname } from '@/i18n/routing'
import { LOCALES, type Locale } from '@/lib/shared/locale'

const LABEL: Record<Locale, string> = { pl: 'PL', en: 'EN', de: 'DE' }

export function LocaleSwitcher() {
  // usePathname() from next-intl returns the path WITHOUT the locale prefix,
  // so the same path can be handed to <Link> for a different locale.
  const pathname = usePathname()
  const active = useLocale()

  return (
    <nav aria-label="Język" className="flex gap-0.5">
      {LOCALES.map((l) => (
        <Link
          key={l}
          href={pathname}
          locale={l}
          aria-current={l === active ? 'true' : undefined}
          // Active state is carried by weight and a rule as well as colour,
          // so it does not depend on seeing red (WCAG 1.4.1).
          className={`inline-flex min-h-[44px] items-center border-b-2 px-2 font-display text-sm tracking-wide ${
            l === active
              ? 'border-accent font-medium text-accent'
              : 'border-transparent font-light text-text-secondary hover:text-accent'
          }`}
        >
          {LABEL[l]}
        </Link>
      ))}
    </nav>
  )
}
