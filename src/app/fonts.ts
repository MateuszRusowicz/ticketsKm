import { Merriweather } from 'next/font/google'

// Self-hosted at build time, not linked from Google's CDN. Two reasons:
// latin-ext is required for Polish diacritics (ą ć ę ł ń ó ś ż ź), and a
// German court (LG München I, 2022) held that loading fonts from Google's
// servers transmits the visitor's IP without consent.
export const merriweather = Merriweather({
  weight: ['300', '400', '700'],
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-merriweather',
})
