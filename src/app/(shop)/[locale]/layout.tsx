import { notFound } from 'next/navigation'
import { hasLocale, NextIntlClientProvider } from 'next-intl'
import { getMessages, setRequestLocale } from 'next-intl/server'
import { fontVariables } from '@/app/fonts'
import { SiteHeader } from '@/components/SiteHeader'
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

  // The lang attribute is what selects the browser's hyphenation dictionary.
  // Without it, `hyphens: auto` does nothing and German compounds overflow.
  return (
    <html lang={locale} className={fontVariables}>
      <body className="flex min-h-dvh flex-col">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <SiteHeader currency={currency} />
          <div className="flex-1">{children}</div>
          <SiteFooter />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
