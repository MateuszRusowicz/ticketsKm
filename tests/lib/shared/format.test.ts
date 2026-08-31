import { describe, expect, it } from 'vitest'
import { formatConcertDate, formatConcertTime } from '@/lib/shared/format'

// 14 Aug 2026 17:00 UTC is 19:00 in Warsaw (CEST, UTC+2).
const SUMMER = new Date('2026-08-14T17:00:00Z')
// 14 Jan 2026 17:00 UTC is 18:00 in Warsaw (CET, UTC+1).
const WINTER = new Date('2026-01-14T17:00:00Z')

describe('formatConcertTime', () => {
  it('renders Warsaw wall-clock time, not the server zone', () => {
    // The whole point: a server in UTC must still print 19:00, because that
    // is when the audience turns up.
    expect(formatConcertTime(SUMMER, 'pl')).toBe('19:00')
  })

  it('follows the Warsaw DST offset, not a fixed +2', () => {
    // A fixed offset would print 20:00 here and look right all summer.
    expect(formatConcertTime(WINTER, 'pl')).toBe('18:00')
  })

  it('uses a 24-hour clock in every locale', () => {
    for (const locale of ['pl', 'en', 'de'] as const) {
      expect(formatConcertTime(SUMMER, locale)).toBe('19:00')
    }
  })
})

describe('formatConcertDate', () => {
  it('formats in the visitor language', () => {
    expect(formatConcertDate(SUMMER, 'pl')).toContain('sierpnia')
    expect(formatConcertDate(SUMMER, 'de')).toContain('August')
    expect(formatConcertDate(SUMMER, 'en')).toContain('August')
  })

  it('is day-first in English, matching Polish and German expectations', () => {
    // BCP47 maps en to en-GB precisely so this does not read 'August 14'.
    const formatted = formatConcertDate(SUMMER, 'en')
    expect(formatted.indexOf('14')).toBeLessThan(formatted.indexOf('August'))
  })

  it('reports the Warsaw calendar day, not the UTC one', () => {
    // 22:30 UTC on the 14th is already 00:30 on the 15th in Warsaw.
    const lateNight = new Date('2026-08-14T22:30:00Z')
    expect(formatConcertDate(lateNight, 'pl')).toContain('15')
  })
})
