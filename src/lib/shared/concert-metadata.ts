import { LOCALES, type Locale } from './locale'

/**
 * Path to a concert page.
 *
 * The `koncert` segment stays Polish in all three locales. Translating route
 * segments would triple the routing surface and break any link the Wix site
 * has already published.
 */
export function concertPath(locale: Locale, slug: string): string {
  return `/${locale}/koncert/${slug}`
}

/**
 * hreflang alternates for a concert, as absolute URLs.
 *
 * Absolute because search engines ignore relative alternates — which is most
 * of the SEO value of having localised URLs at all.
 */
export function localeAlternates(slug: string, siteUrl: string): Record<Locale, string> {
  const base = siteUrl.replace(/\/+$/, '')
  return Object.fromEntries(
    LOCALES.map((locale) => [locale, `${base}${concertPath(locale, slug)}`]),
  ) as Record<Locale, string>
}
