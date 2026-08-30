import { BCP47, type Locale } from './locale'

export const CURRENCIES = ['PLN', 'EUR'] as const
export type Currency = (typeof CURRENCIES)[number]

/** Cookie holding the visitor's chosen currency. Read server-side so the
 *  first paint already shows the right prices. */
export const CURRENCY_COOKIE = 'km_currency'

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value)
}

/**
 * Default currency for a locale.
 *
 * `en` maps to EUR, not GBP or USD — the English pages exist for
 * international visitors to a Polish festival, not for a UK audience.
 *
 * This is a *default*, not a constraint: any visitor can switch. Currency and
 * payment method are coupled (BLIK is PLN-only; Klarna in Germany needs EUR),
 * so the choice has to stay open rather than being derived from the URL.
 */
export function currencyForLocale(locale: Locale): Currency {
  return locale === 'pl' ? 'PLN' : 'EUR'
}

/**
 * The currency to render with: a stored preference if it is one we support,
 * otherwise the locale default.
 *
 * The stored value comes from a client-writable cookie, so it is untrusted
 * input — anything at all can arrive here, and it must fall back rather than
 * throw.
 */
export function resolveCurrency(stored: string | undefined, locale: Locale): Currency {
  return isCurrency(stored) ? stored : currencyForLocale(locale)
}

/** Major units (49.50) to minor units (4950). Rounds half away from zero. */
export function toMinor(major: number): number {
  return Math.round(major * 100)
}

/** Minor units (4950) to major units (49.5). For display and Intl only. */
export function toMajor(minor: number): number {
  return minor / 100
}

export function formatMoney(minor: number, currency: Currency, locale: Locale): string {
  return new Intl.NumberFormat(BCP47[locale], {
    style: 'currency',
    currency,
  }).format(toMajor(minor))
}

/**
 * Discount amount for a percentage off a subtotal, in minor units.
 * Floors, so rounding always favours the seller, and is clamped to
 * [0, subtotal] so a total can never go negative.
 */
export function applyPercentDiscount(subtotalMinor: number, percent: number): number {
  if (percent <= 0) return 0
  const raw = Math.floor((subtotalMinor * percent) / 100)
  return Math.min(Math.max(raw, 0), subtotalMinor)
}
