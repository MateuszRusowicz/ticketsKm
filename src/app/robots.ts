import type { MetadataRoute } from 'next'

/**
 * Indexing is OFF until launch.
 *
 * The shop is publicly reachable at tickets-km.vercel.app with dummy concerts
 * and placeholder legal text. Letting Google index that means test concerts
 * appearing in search results for the festival's own name, and cached
 * placeholder terms outliving the real ones.
 *
 * Flip the site-wide `disallow` to an empty string as part of Plan 02 Task 9,
 * alongside connecting the real database and domain.
 *
 * **`/*​/order/` must stay disallowed after that flip.** Those URLs carry an
 * access token in the query string, and tokens in URLs leak through referrer
 * headers, proxy logs and browser history sync. The page also shows buyer
 * name and email. Do not delete this rule when relaxing the one above.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: ['/', '/*/order/'],
    },
  }
}
