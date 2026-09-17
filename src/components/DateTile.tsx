import { concertDateParts } from '@/lib/shared/format'
import type { Locale } from '@/lib/shared/locale'

/**
 * A calendar-leaf tile standing in for concert artwork.
 *
 * Concerts have no images yet (there is no upload path), so a grey box was
 * the normal rendering of every card. The date is the one thing every concert
 * has and every buyer looks for first, so the space goes to that instead.
 *
 * Decorative: the full date is also in a <time> element beside it, so the tile
 * is hidden from screen readers rather than read out twice.
 */
export function DateTile({
  date,
  locale,
  size = 'md',
}: {
  date: Date
  locale: Locale
  size?: 'md' | 'lg'
}) {
  const { day, month, weekday } = concertDateParts(date, locale)
  const large = size === 'lg'

  return (
    <div
      aria-hidden="true"
      className={`flex shrink-0 flex-col items-center justify-center border-t-4 border-accent bg-surface text-center font-display ${
        // The large tile only grows from sm up: at phone width it would squeeze the
        // concert title beside it into a one-word-per-line column.
        large ? 'size-24 sm:size-40 lg:size-44' : 'size-24 sm:size-28'
      }`}
    >
      <span className={`font-light uppercase tracking-widest text-text-secondary ${large ? 'text-xs sm:text-sm' : 'text-xs'}`}>
        {weekday}
      </span>
      <span className={`font-medium leading-none text-accent ${large ? 'text-5xl sm:text-7xl' : 'text-5xl'}`}>
        {day}
      </span>
      <span className={`mt-1 uppercase tracking-widest text-text-primary ${large ? 'text-sm sm:text-base' : 'text-sm'}`}>
        {month}
      </span>
    </div>
  )
}
