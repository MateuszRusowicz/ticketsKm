import { BCP47, TIMEZONE, type Locale } from './locale'

// Every public-facing date and time goes through here.
//
// Concerts are stored as UTC instants but happen at a Warsaw wall-clock time,
// and Vercel functions run in UTC. Formatting without an explicit timeZone
// therefore prints the UTC hour — which is correct-looking for half the year
// and an hour wrong for the other half, the hardest kind of bug to notice.

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: TIMEZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
}

const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  // Poland and Germany use a 24-hour clock, and so does a concert programme
  // in English. Left to Intl, en-GB would still give 24-hour, but stating it
  // removes the dependency on that staying true.
  hour12: false,
}

export function formatConcertDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(BCP47[locale], DATE_OPTIONS).format(date)
}

export function formatConcertTime(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(BCP47[locale], TIME_OPTIONS).format(date)
}

/** Date and time together, for a single line on a card. */
export function formatConcertDateTime(date: Date, locale: Locale): string {
  return `${formatConcertDate(date, locale)}, ${formatConcertTime(date, locale)}`
}

/** Machine-readable value for <time dateTime="…">. */
export function isoDateTime(date: Date): string {
  return date.toISOString()
}
