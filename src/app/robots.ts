import type { MetadataRoute } from 'next'

/**
 * Indexing is OFF until launch.
 *
 * The shop is publicly reachable at tickets-km.vercel.app with dummy concerts
 * and placeholder legal text. Letting Google index that means test concerts
 * appearing in search results for the festival's own name, and cached
 * placeholder terms outliving the real ones.
 *
 * Flip `disallow` to an empty string as part of Plan 02 Task 9, alongside
 * connecting the real database and domain.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', disallow: '/' },
  }
}
