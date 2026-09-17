import { EB_Garamond, Jost } from 'next/font/google'

// Self-hosted at build time, not linked from Google's CDN. Two reasons:
// latin-ext is required for Polish diacritics (ą ć ę ł ń ó ś ż ź), and a
// German court (LG München I, 2022) held that loading fonts from Google's
// servers transmits the visitor's IP without consent.
//
// The pairing follows the festival's main site (krzyzowa-music.eu), which sets
// headings in Futura and text in EB Garamond. Futura is a commercial face
// licensed to that Wix site, so its files cannot be reused here; Jost is an
// open-licence geometric sans drawn after Futura. EB Garamond is the same face
// the main site uses. Revised 17 Sep 2026 — see plan/10-design-system.md.

/** Headings, concert titles, navigation, buttons — the main site's Futura role. */
export const jost = Jost({
  weight: ['300', '400', '500'],
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-jost',
})

/** Long-form text: concert descriptions, taglines, legal prose. */
export const ebGaramond = EB_Garamond({
  weight: ['400', '500'],
  style: ['normal', 'italic'],
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-eb-garamond',
})

/** Both variables, for the <html> element of each root layout. */
export const fontVariables = `${jost.variable} ${ebGaramond.variable}`
