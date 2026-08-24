import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/server/auth'
import { db } from '@/lib/server/db'
import { toMajor } from '@/lib/shared/money'
import { utcToWarsawLocalInput } from '@/lib/server/time'
import { LOCALES, type Locale } from '@/lib/shared/locale'
import { EventForm } from '../EventForm'
import { updateEventAction } from '../actions'

export default async function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin()
  const { id } = await params

  const [event, venues] = await Promise.all([
    db.event.findUnique({
      where: { id },
      include: { translations: true, ticketTypes: true },
    }),
    db.venue.findMany({ orderBy: { name: 'asc' } }),
  ])

  if (!event) notFound()

  const type = event.ticketTypes[0]

  const translations = Object.fromEntries(
    LOCALES.map((l) => {
      const t = event.translations.find((x) => x.locale === l)
      return [l, { title: t?.title ?? '', description: t?.description ?? '', performers: t?.performers ?? '' }]
    }),
  ) as Record<Locale, { title: string; description: string; performers: string }>

  const boundAction = updateEventAction.bind(null, event.id)

  return (
    <main className="mx-auto max-w-[800px] px-8 py-16">
      <h1 className="font-serif text-3xl font-bold">Edycja koncertu</h1>
      <div className="mt-8">
        <EventForm
          action={boundAction}
          venues={venues}
          submitLabel="Zapisz zmiany"
          initial={{
            slug: event.slug,
            venueId: event.venueId,
            startsAtLocal: utcToWarsawLocalInput(event.startsAt),
            capacity: event.capacity,
            status: event.status,
            pricePlnMajor: type ? String(toMajor(type.pricePln)) : '',
            priceEurMajor: type ? String(toMajor(type.priceEur)) : '',
            maxPerOrder: type?.maxPerOrder ?? 10,
            translations,
          }}
        />
      </div>
    </main>
  )
}
