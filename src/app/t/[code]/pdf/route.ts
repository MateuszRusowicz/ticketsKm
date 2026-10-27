/**
 * GET /t/<code>/pdf
 *
 * Returns a single-ticket PDF for the given code.
 *
 * Authentication model: the ticket CODE is the bearer credential. Anyone with
 * the code can view and download the ticket. This is intentional — it is the
 * forwarding story: a buyer with three tickets forwards one to one guest by
 * sharing the URL /t/<code>/pdf, which requires no login or access token.
 *
 * The 128 bits of randomness in the code make it impossible to guess at any
 * realistic rate. Do NOT add a ?t=<token> guard here — that would break
 * forwarding and is security theatre (the /t/<code> web page already shows the
 * holder name and QR to anyone with the code, by the same design).
 */
import { headers } from 'next/headers'
import { isValidTicketCode, getPublicTicket } from '@/lib/server/ticket-lookup'
import { renderTicketPdf } from '@/lib/server/ticket-pdf'
import { rateLimit } from '@/lib/server/ratelimit'
import { env } from '@/lib/server/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const NO_STORE = 'private, no-store'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params

  // 1. Validate code format before any DB access
  if (!isValidTicketCode(code)) {
    return new Response(null, {
      status: 404,
      headers: { 'Cache-Control': NO_STORE },
    })
  }

  // 2. Rate limit by IP: 20 req/min per IP
  const headersList = await headers()
  const ip = headersList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const allowed = rateLimit(`pdf:${ip}`, 20, 60_000)
  if (!allowed) {
    return new Response('Too many requests', {
      status: 429,
      headers: { 'Cache-Control': NO_STORE, 'Content-Type': 'text/plain' },
    })
  }

  // 3. Look up the ticket
  const result = await getPublicTicket(code)
  if (!result) {
    return new Response(null, {
      status: 404,
      headers: { 'Cache-Control': NO_STORE },
    })
  }

  // 4. Revoked tickets have no PDF — the web page tells the buyer why
  if (result.kind === 'revoked') {
    return new Response(null, {
      status: 404,
      headers: { 'Cache-Control': NO_STORE },
    })
  }

  // 5. VALID and USED tickets both return a PDF.
  //    "already used" is a door-staff signal; buyers can re-print between venue entries.
  const { ticket } = result

  const pdfBuffer = await renderTicketPdf({
    code,
    holderName: ticket.holderName,
    order: {
      reference: ticket.orderReference,
      locale: ticket.orderLocale,
    },
    event: ticket.event,
    publicBaseUrl: env.NEXT_PUBLIC_SITE_URL,
  })

  // First six chars of the code make the filename distinctive enough to
  // differentiate forwarded tickets in a Downloads folder without being unwieldy.
  const filename = `ticket-${code.slice(0, 6).toLowerCase()}.pdf`

  return new Response(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': NO_STORE,
      'Content-Length': String(pdfBuffer.length),
    },
  })
}
