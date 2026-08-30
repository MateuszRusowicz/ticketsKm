import 'server-only'
import { cookies } from 'next/headers'
import type { Locale } from '@/lib/shared/locale'
import { CURRENCY_COOKIE, resolveCurrency, type Currency } from '@/lib/shared/money'

/**
 * The currency to render this request with.
 *
 * Reading a cookie in a Server Component opts the route out of static
 * rendering. That is accepted deliberately for the shop — see the
 * architecture note in plan/steps/03-public-programme.md. The alternative,
 * resolving currency on the client after hydration, flashes the wrong prices
 * on every navigation, which on a page whose whole purpose is showing a price
 * is worse than losing the prerender.
 *
 * The shop is dynamic anyway: availability must be live, not frozen at build
 * time.
 */
export async function getActiveCurrency(locale: Locale): Promise<Currency> {
  const stored = (await cookies()).get(CURRENCY_COOKIE)?.value
  return resolveCurrency(stored, locale)
}
