import { BCP47, type Locale } from './locale'

export const CURRENCIES = ['PLN', 'EUR'] as const
export type Currency = (typeof CURRENCIES)[number]

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
