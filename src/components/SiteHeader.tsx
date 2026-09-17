import Image from 'next/image'
import { getTranslations } from 'next-intl/server'
import { CurrencySwitcher } from '@/components/CurrencySwitcher'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import { Link } from '@/i18n/routing'
import type { Currency } from '@/lib/shared/money'
import logo from '@/assets/km-logo.png'

/**
 * Shop header, modelled on the festival's main site: the red logo square, the
 * festival's trilingual motto beside it, navigation on the right.
 *
 * The motto is quoted verbatim from krzyzowa-music.eu and is deliberately not
 * translated — it is one sentence in three languages, the same on every locale,
 * which is the point of it.
 */
export async function SiteHeader({ currency }: { currency: Currency }) {
  const t = await getTranslations('site')

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-x-8 gap-y-3 px-4 py-4 sm:px-8 sm:py-6">
        <Link href="/" className="flex items-center gap-5" aria-label={t('title')}>
          <Image
            src={logo}
            alt=""
            width={96}
            height={96}
            priority
            className="size-16 sm:size-20 lg:size-24"
          />
          <span
            // Decorative restatement of the brand; the link's aria-label
            // already names the destination, so screen readers skip this.
            aria-hidden="true"
            className="hidden font-serif text-lg leading-snug text-text-primary md:block lg:text-xl"
          >
            Muzyka dla Europy.
            <br />
            Music for Europe.
            <br />
            Musik aus Kreisau. Für Europa.
          </span>
        </Link>

        {/* A div, not a nav: the two switchers are already <nav> landmarks, and
            nesting landmarks makes screen-reader navigation noisier, not clearer. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <Link
            href="/"
            className="font-display text-base font-light text-text-secondary hover:text-accent"
          >
            {t('programme')}
          </Link>
          <div className="flex items-center gap-2 border-l border-border pl-4">
            <CurrencySwitcher active={currency} label={t('currency')} />
            <LocaleSwitcher />
          </div>
        </div>
      </div>
    </header>
  )
}
