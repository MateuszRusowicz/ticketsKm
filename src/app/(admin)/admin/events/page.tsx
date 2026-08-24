import Link from 'next/link'
import { requireAdmin } from '@/lib/server/auth'
import { db } from '@/lib/server/db'
import { formatMoney } from '@/lib/shared/money'
import { TIMEZONE } from '@/lib/shared/locale'

export default async function EventsPage() {
  await requireAdmin()

  const events = await db.event.findMany({
    orderBy: { startsAt: 'asc' },
    include: {
      venue: true,
      ticketTypes: true,
      translations: { where: { locale: 'pl' } },
    },
  })

  const when = new Intl.DateTimeFormat('pl-PL', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: TIMEZONE,
  })

  return (
    <main className="mx-auto max-w-[1200px] px-8 py-16">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-3xl font-bold">Koncerty</h1>
        <Link
          href="/admin/events/new"
          className="min-h-[48px] rounded-[2px] bg-accent px-6 py-3 font-semibold text-white"
        >
          Dodaj koncert
        </Link>
      </div>

      <table className="mt-8 w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-[var(--color-border)]">
            <th className="py-3">Tytuł</th>
            <th>Data</th>
            <th>Miejsce</th>
            <th>Pojemność</th>
            <th>Sprzedane</th>
            <th>Cena</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const type = e.ticketTypes[0]
            const sold = e.ticketTypes.reduce((n, t) => n + t.soldCount, 0)
            return (
              <tr key={e.id} className="border-b border-[var(--color-border)]">
                <td className="py-3">
                  <Link href={`/admin/events/${e.id}`} className="text-accent underline">
                    {e.translations[0]?.title ?? e.slug}
                  </Link>
                </td>
                <td>{when.format(e.startsAt)}</td>
                <td className="text-[var(--color-text-secondary)]">{e.venue.name}</td>
                <td className="price">{e.capacity}</td>
                <td className="price">{sold}</td>
                <td className="price">
                  {type ? `${formatMoney(type.pricePln, 'PLN', 'pl')} / ${formatMoney(type.priceEur, 'EUR', 'pl')}` : '—'}
                </td>
                <td>{e.status}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {events.length === 0 && (
        <p className="mt-8 text-[var(--color-text-secondary)]">Brak koncertów. Dodaj pierwszy.</p>
      )}
    </main>
  )
}
