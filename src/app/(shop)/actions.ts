'use server'

import { cookies } from 'next/headers'
import { CURRENCY_COOKIE, isCurrency } from '@/lib/shared/money'

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

/**
 * Store the visitor's currency choice.
 *
 * A server action rather than `document.cookie` for two reasons: the value is
 * validated here instead of trusting whatever the client writes, and the
 * `react-hooks/immutability` lint rule correctly refuses direct mutation of
 * `document` from a component.
 *
 * Not HttpOnly — nothing sensitive, and it is only ever read server-side.
 */
export async function setCurrencyAction(value: string): Promise<void> {
  if (!isCurrency(value)) return // junk input is ignored, not an error

  ;(await cookies()).set(CURRENCY_COOKIE, value, {
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
    sameSite: 'lax',
  })
}
