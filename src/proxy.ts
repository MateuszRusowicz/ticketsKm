import createMiddleware from 'next-intl/middleware'
import { routing } from './i18n/routing'

// Next 16 renamed the `middleware` file convention to `proxy`. next-intl
// still exports it as createMiddleware; only the filename changed.
export default createMiddleware(routing)

export const config = {
  // /admin is excluded: it is Polish-only and must not be locale-prefixed.
  // /api and /t are excluded so their URLs stay stable — a QR code printed
  // on a ticket cannot be re-issued if the path later gains a prefix.
  matcher: ['/((?!api|admin|t|_next|_vercel|.*\\..*).*)'],
}
