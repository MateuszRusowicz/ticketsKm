import { describe, expect, it } from 'vitest'
import { concertPath, localeAlternates } from '@/lib/shared/concert-metadata'

describe('concertPath', () => {
  it('keeps the Polish segment in every locale', () => {
    // Translating route segments per locale triples the routing surface and
    // breaks links the Wix site has already published.
    expect(concertPath('en', 'bach')).toBe('/en/koncert/bach')
    expect(concertPath('de', 'bach')).toBe('/de/koncert/bach')
    expect(concertPath('pl', 'bach')).toBe('/pl/koncert/bach')
  })
})

describe('localeAlternates', () => {
  const alt = localeAlternates('bach', 'https://tickets-km.vercel.app')

  it('lists all three locales', () => {
    expect(Object.keys(alt).sort()).toEqual(['de', 'en', 'pl'])
  })

  it('emits absolute URLs — relative ones are ignored by search engines', () => {
    for (const url of Object.values(alt)) {
      expect(url).toMatch(/^https:\/\//)
    }
  })

  it('points each locale at its own path', () => {
    expect(alt.pl).toBe('https://tickets-km.vercel.app/pl/koncert/bach')
    expect(alt.de).toBe('https://tickets-km.vercel.app/de/koncert/bach')
  })

  it('does not double a trailing slash on the site URL', () => {
    const withSlash = localeAlternates('bach', 'https://example.test/')
    expect(withSlash.pl).toBe('https://example.test/pl/koncert/bach')
  })
})
