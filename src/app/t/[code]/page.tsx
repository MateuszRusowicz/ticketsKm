import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getPublicTicket } from '@/lib/server/ticket-lookup'
import { rateLimit } from '@/lib/server/ratelimit'
import { env } from '@/lib/server/env'
import { formatConcertDate, formatConcertTime } from '@/lib/shared/format'
import { qrSvgString } from '@/lib/shared/qr'
import type { Locale } from '@/lib/shared/locale'
import { headers } from 'next/headers'

// Force dynamic rendering — ticket state can change (REVOKED after refund),
// and the page contains holder PII.
export const dynamic = 'force-dynamic'
export const fetchCache = 'default-no-store'

// ---------------------------------------------------------------------------
// Inline translations (page is outside the locale group — no locale in URL)
// ---------------------------------------------------------------------------

type TicketLabel = {
  valid: { heading: string; body: string }
  used: { heading: string; body: string }
  revoked: { heading: string; body: string }
  notFound: { heading: string; body: string }
  codeLabel: string
  concert: string
  venue: string
  holder: string
}

const LABELS: Record<Locale, TicketLabel> = {
  pl: {
    valid: { heading: 'Bilet ważny', body: 'Pokaż ten kod przy wejściu.' },
    used: { heading: 'Bilet wykorzystany', body: 'Wejście zarejestrowano' },
    revoked: { heading: 'Bilet nieważny', body: 'Ten bilet został anulowany lub zwrócony.' },
    notFound: { heading: 'Nie znaleziono biletu', body: 'Sprawdź adres z biletu lub skontaktuj się z organizatorem.' },
    codeLabel: 'Kod biletu',
    concert: 'Koncert',
    venue: 'Miejsce',
    holder: 'Imię i nazwisko',
  },
  en: {
    valid: { heading: 'Valid ticket', body: 'Show this code at the entrance.' },
    used: { heading: 'Ticket already used', body: 'Entry was recorded at' },
    revoked: { heading: 'Ticket not valid', body: 'This ticket has been cancelled or refunded.' },
    notFound: { heading: 'Ticket not found', body: 'Check the address from your ticket or contact the organiser.' },
    codeLabel: 'Ticket code',
    concert: 'Concert',
    venue: 'Venue',
    holder: 'Name',
  },
  de: {
    valid: { heading: 'Gültige Eintrittskarte', body: 'Zeigen Sie diesen Code am Eingang vor.' },
    used: { heading: 'Eintrittskarte bereits verwendet', body: 'Einlass wurde registriert um' },
    revoked: { heading: 'Eintrittskarte ungültig', body: 'Diese Eintrittskarte wurde storniert oder erstattet.' },
    notFound: { heading: 'Eintrittskarte nicht gefunden', body: 'Prüfen Sie die Adresse auf Ihrer Karte oder wenden Sie sich an den Veranstalter.' },
    codeLabel: 'Ticketcode',
    concert: 'Konzert',
    venue: 'Ort',
    holder: 'Name',
  },
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata: Metadata = {
  robots: 'noindex, nofollow',
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

type Props = {
  params: Promise<{ code: string }>
}

export default async function PublicTicketPage({ params }: Props) {
  const { code } = await params

  // Rate-limit by IP: 60 req/min per IP (same as the login page)
  const headersList = await headers()
  const ip = headersList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const allowed = rateLimit(`t:${ip}`, 60, 60_000)
  if (!allowed) {
    // Deliberately identical response to "not found" — rate limit must not
    // be an existence oracle. Return not-found; the buyer can try again in a minute.
    notFound()
  }

  const result = await getPublicTicket(code)
  if (!result) notFound()

  const { ticket } = result
  const locale = ticket.orderLocale
  const labels = LABELS[locale]
  const ticketUrl = `${env.NEXT_PUBLIC_SITE_URL}/t/${code}`
  const qrSvg = await qrSvgString(ticketUrl)

  const dateStr = formatConcertDate(ticket.event.startsAt, locale)
  const timeStr = formatConcertTime(ticket.event.startsAt, locale)

  const displayName = ticket.holderName || '–'

  return (
    <>
      <link rel="canonical" href={ticketUrl} />
      <main className="mx-auto max-w-[600px] px-4 pt-10 pb-16 sm:px-8">
        {/* State banner */}
        {result.kind === 'valid' && (
          <div className="mb-6 rounded-lg bg-green-600 px-5 py-4 text-white">
            <p className="text-xl font-bold">{labels.valid.heading}</p>
            <p className="mt-1 text-sm">{labels.valid.body}</p>
          </div>
        )}

        {result.kind === 'used' && (
          <div className="mb-6 rounded-lg bg-amber-500 px-5 py-4 text-white">
            <p className="text-xl font-bold">{labels.used.heading}</p>
            <p className="mt-1 text-sm">
              {labels.used.body}{' '}
              {formatConcertTime(result.usedAt, locale)},{' '}
              {formatConcertDate(result.usedAt, locale)}
            </p>
          </div>
        )}

        {result.kind === 'revoked' && (
          <div className="mb-6 rounded-lg bg-red-600 px-5 py-4 text-white">
            <p className="text-xl font-bold">{labels.revoked.heading}</p>
            <p className="mt-1 text-sm">{labels.revoked.body}</p>
          </div>
        )}

        {/* Event details */}
        <dl className="panel grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 p-5 sm:p-6">
          <dt className="text-sm text-text-secondary">{labels.concert}</dt>
          <dd className="font-medium">{ticket.event.title}</dd>

          <dt className="text-sm text-text-secondary">{labels.venue}</dt>
          <dd>
            {ticket.event.venue}, {ticket.event.city}
          </dd>

          <dt className="text-sm text-text-secondary">&nbsp;</dt>
          <dd className="text-sm text-text-secondary">
            {dateStr}, {timeStr}
          </dd>

          <dt className="text-sm text-text-secondary">{labels.holder}</dt>
          <dd>{displayName}</dd>
        </dl>

        {/* QR code */}
        <div className="mt-8 flex flex-col items-center">
          <div
            className="w-64"
            aria-label={`QR code for ticket ${code}`}
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
          <p className="mt-3 text-center text-sm text-text-secondary">{labels.codeLabel}</p>
          <p className="mt-1 font-mono text-lg font-bold tracking-wider">{code}</p>
        </div>
      </main>
    </>
  )
}
