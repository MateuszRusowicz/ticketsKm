import { notFound } from 'next/navigation'
import { hasLocale, NextIntlClientProvider } from 'next-intl'
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server'
import { merriweather } from '@/app/fonts'
import { CurrencySwitcher } from '@/components/CurrencySwitcher'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import { SiteFooter } from '@/components/SiteFooter'
import { getActiveCurrency } from '@/lib/server/currency'
import { routing } from '@/i18n/routing'
import type { ReactNode } from 'react'
import '@/app/globals.css'

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()

  setRequestLocale(locale)

  // Messages are passed explicitly. Any client component calling
  // useTranslations() throws MISSING_MESSAGES without them — and because the
  // only client component in Plan 01 hardcodes Polish, that failure would not
  // surface until Plan 02's buy box, a long way from its cause.
  const messages = await getMessages()

  // Reading the currency cookie here makes the shop dynamic rather than
  // statically prerendered. Deliberate: availability has to be live anyway,
  // and resolving currency after hydration would flash the wrong price on
  // every navigation.
  const currency = await getActiveCurrency(locale)
  const t = await getTranslations('site')

  // The lang attribute is what selects the browser's hyphenation dictionary.
  // Without it, `hyphens: auto` does nothing and German compounds overflow.
  return (
    <html lang={locale} className={merriweather.variable}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <header className="mx-auto flex max-w-[1200px] items-center justify-end gap-4 px-8 py-4">
            <CurrencySwitcher active={currency} label={t('currency')} />
            <LocaleSwitcher />
          </header>
          {children}
          <SiteFooter />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
