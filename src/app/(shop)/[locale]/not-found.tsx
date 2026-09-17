import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/routing'

// Without this, the three 404 paths in the concert route render Next's
// built-in untranslated page — and (shop) and (admin) are separate root
// layouts, so there is no shared global one to fall back to.
export default async function NotFound() {
  const t = await getTranslations('notFound')
  const tSite = await getTranslations('site')

  return (
    <main className="mx-auto max-w-[65ch] px-4 pt-16 sm:px-8 sm:pt-24">
      <h1 className="text-accent">{t('heading')}</h1>
      <p className="prose-serif mt-4 text-text-secondary">{t('body')}</p>
      <p className="mt-8">
        <Link href="/" className="btn btn-primary">
          {tSite('backToProgramme')}
        </Link>
      </p>
    </main>
  )
}
