import { defineRouting } from 'next-intl/routing'
import { createNavigation } from 'next-intl/navigation'
import { DEFAULT_LOCALE, LOCALES } from '@/lib/shared/locale'

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'always',
})

export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing)
