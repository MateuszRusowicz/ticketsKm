export const LOCALES = ['pl', 'en', 'de'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'pl'

// BCP-47 tags used for Intl formatting. 'en' maps to en-GB so that dates
// render day-first, matching Polish and German expectations.
export const BCP47: Record<Locale, string> = {
  pl: 'pl-PL',
  en: 'en-GB',
  de: 'de-DE',
}

export const TIMEZONE = 'Europe/Warsaw'

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value)
}
