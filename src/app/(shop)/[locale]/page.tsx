import { getTranslations, setRequestLocale } from 'next-intl/server'

export default async function ProgrammePage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)
  const t = await getTranslations('site')

  return (
    <main className="mx-auto max-w-[1200px] px-8 py-16">
      <h1>{t('programme')}</h1>
    </main>
  )
}
