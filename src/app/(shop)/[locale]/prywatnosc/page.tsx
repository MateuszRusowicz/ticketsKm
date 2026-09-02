import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { LegalPage } from '@/components/LegalPage'
import { isLocale } from '@/lib/shared/locale'

type Props = { params: Promise<{ locale: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params
  if (!isLocale(locale)) return {}
  return { title: (await getTranslations({ locale, namespace: 'legal' }))('privacy') }
}

export default async function PrivacyPage({ params }: Props) {
  const { locale } = await params
  if (!isLocale(locale)) notFound()
  setRequestLocale(locale)

  const t = await getTranslations('legal')

  return (
    <LegalPage
      title={t('privacy')}
      intro={t('privacyIntro')}
      draftNotice={t('draftNotice')}
      sections={[1, 2, 3, 4, 5, 6, 7].map((n) => ({
        heading: t(`p${n}`),
        body: t(`p${n}body`),
      }))}
    />
  )
}
