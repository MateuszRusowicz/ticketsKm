import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/routing'

/**
 * Footer on every shop page.
 *
 * Without it the terms and privacy pages are reachable only from a checkbox
 * inside the checkout form — so a visitor who has not started buying cannot
 * find them at all, which is the opposite of what publishing them is for.
 */
export async function SiteFooter() {
  const [tLegal, tFooter] = await Promise.all([
    getTranslations('legal'),
    getTranslations('footer'),
  ])

  return (
    <footer className="mt-16 border-t border-border">
      <nav
        aria-label={tFooter('festival')}
        className="mx-auto flex max-w-[1200px] flex-wrap gap-x-6 gap-y-2 px-8 py-8 text-sm"
      >
        <Link href="/regulamin" className="text-text-secondary underline hover:text-accent">
          {tLegal('terms')}
        </Link>
        <Link href="/prywatnosc" className="text-text-secondary underline hover:text-accent">
          {tLegal('privacy')}
        </Link>
        {/* Not a next-intl Link: this leaves the ticket shop for the Wix
            marketing site, which has no locale-prefixed routing of ours. */}
        <a
          href="https://krzyzowa-music.eu"
          className="text-text-secondary underline hover:text-accent"
        >
          {tFooter('festival')}
        </a>
      </nav>
    </footer>
  )
}
