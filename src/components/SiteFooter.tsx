import Image from 'next/image'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/routing'
import logo from '@/assets/km-logo.png'

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
    <footer className="mt-24 border-t border-border bg-surface">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div className="flex items-center gap-4">
          <Image src={logo} alt="" width={48} height={48} className="size-12" />
          <p className="font-serif text-base leading-snug text-text-secondary">
            Krzyżowa-Music
            <br />
            Kammermusik-Festival
          </p>
        </div>

        <nav
          aria-label={tFooter('festival')}
          className="flex flex-wrap gap-x-6 gap-y-2 font-display text-sm font-light"
        >
          <Link href="/regulamin" className="text-text-secondary hover:text-accent">
            {tLegal('terms')}
          </Link>
          <Link href="/prywatnosc" className="text-text-secondary hover:text-accent">
            {tLegal('privacy')}
          </Link>
          {/* Not a next-intl Link: this leaves the ticket shop for the Wix
              marketing site, which has no locale-prefixed routing of ours. */}
          <a href="https://krzyzowa-music.eu" className="text-text-secondary hover:text-accent">
            {tFooter('festival')}
            {/* An SVG, not "↗": most platforms draw that character as a
                coloured emoji. */}
            <svg aria-hidden="true" viewBox="0 0 12 12" className="ml-1 inline size-3 align-baseline">
              <path d="M3 9 9 3M4.5 3H9v4.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </a>
        </nav>
      </div>
    </footer>
  )
}
