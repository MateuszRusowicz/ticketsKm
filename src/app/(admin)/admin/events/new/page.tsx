import { requireAdmin } from '@/lib/server/auth'
import { db } from '@/lib/server/db'
import { EventForm } from '../EventForm'
import { createEventAction } from '../actions'

export default async function NewEventPage() {
  await requireAdmin()
  const venues = await db.venue.findMany({ orderBy: { name: 'asc' } })

  return (
    <main className="mx-auto max-w-[800px] px-8 py-16">
      <h1 className="font-serif text-3xl font-bold">Nowy koncert</h1>
      <div className="mt-8">
        <EventForm
          action={createEventAction}
          venues={venues}
          submitLabel="Utwórz koncert"
          initial={{
            slug: '',
            venueId: venues[0]?.id ?? '',
            startsAtLocal: '',
            capacity: venues[0]?.defaultCapacity ?? 300,
            status: 'DRAFT',
            pricePlnMajor: '',
            priceEurMajor: '',
            maxPerOrder: 10,
            translations: {
              pl: { title: '', description: '', performers: '' },
              en: { title: '', description: '', performers: '' },
              de: { title: '', description: '', performers: '' },
            },
          }}
        />
      </div>
    </main>
  )
}
