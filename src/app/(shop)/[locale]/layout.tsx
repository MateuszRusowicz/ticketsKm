import { notFound } from 'next/navigation'
import { hasLocale, NextIntlClientProvider } from 'next-intl'
import { getMessages, setRequestLocale } from 'next-intl/server'
import { merriweather } from '@/app/fonts'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
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

  // The lang attribute is what selects the browser's hyphenation dictionary.
  // Without it, `hyphens: auto` does nothing and German compounds overflow.
  return (
    <html lang={locale} className={merriweather.variable}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <header className="mx-auto flex max-w-[1200px] justify-end px-8 py-4">
            <LocaleSwitcher />
          </header>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
