import 'server-only'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import { format } from 'date-fns'
import { TIMEZONE } from '@/lib/shared/locale'

/** "2026-08-14T19:00" typed as Warsaw wall-clock → the correct UTC instant. */
export function warsawLocalToUtc(value: string): Date {
  return fromZonedTime(value, TIMEZONE)
}

/** A stored instant → the "YYYY-MM-DDTHH:mm" a datetime-local input expects. */
export function utcToWarsawLocalInput(date: Date): string {
  return format(toZonedTime(date, TIMEZONE), "yyyy-MM-dd'T'HH:mm")
}
