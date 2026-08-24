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
    <nav aria-label="Język" className="flex gap-1">
      {LOCALES.map((l) => (
        <Link
          key={l}
          href={pathname}
          locale={l}
          aria-current={l === active ? 'true' : undefined}
          className={`min-h-[44px] px-3 py-2 text-sm ${
            l === active ? 'font-semibold text-accent underline' : 'text-text-secondary'
          }`}
        >
          {LABEL[l]}
        </Link>
      ))}
    </nav>
  )
}
