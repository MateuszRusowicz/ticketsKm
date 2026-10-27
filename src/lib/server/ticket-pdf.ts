import 'server-only'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PDFDocument, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { Locale } from '@/lib/shared/locale'
import { fitHolderName } from '@/lib/shared/ticket-layout'
import { qrPngBuffer } from '@/lib/shared/qr'
import { formatConcertDate, formatConcertTime } from '@/lib/shared/format'

// ---------------------------------------------------------------------------
// Font loading — done once at module scope, not per render.
// ---------------------------------------------------------------------------

const FONTS_DIR = path.join(process.cwd(), 'src', 'assets', 'fonts')
const notoRegularBytes = readFileSync(path.join(FONTS_DIR, 'NotoSans-Regular.ttf'))
const notoBoldBytes = readFileSync(path.join(FONTS_DIR, 'NotoSans-Bold.ttf'))

// ---------------------------------------------------------------------------
// i18n labels for the three supported locales
// ---------------------------------------------------------------------------

const LABELS: Record<Locale, { holder: string; code: string; reference: string }> = {
  pl: { holder: 'Imię i nazwisko', code: 'Kod biletu', reference: 'Nr zamówienia' },
  en: { holder: 'Name', code: 'Ticket code', reference: 'Order reference' },
  de: { holder: 'Name', code: 'Ticketcode', reference: 'Bestellnummer' },
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TicketPdfInput = {
  code: string
  holderName: string | null
  order: {
    reference: string
    locale: Locale
  }
  event: {
    title: string
    startsAt: Date
    venue: string
    address: string
    city: string
  }
  publicBaseUrl: string
  /** For tests: fix the creation date to make output deterministic. */
  _creationDate?: Date
}

// ---------------------------------------------------------------------------
// PDF generator
// ---------------------------------------------------------------------------

/**
 * Renders a single-ticket PDF as a Buffer.
 *
 * No DB access — the caller is responsible for fetching all data and passing
 * it in. PDFs are generated on demand and never stored.
 */
export async function renderTicketPdf(input: TicketPdfInput): Promise<Buffer> {
  const { code, holderName, order, event, publicBaseUrl, _creationDate } = input
  const locale = order.locale
  const labels = LABELS[locale]

  const doc = await PDFDocument.create()

  // Fix creation/modification dates when provided (for deterministic output in tests)
  if (_creationDate) {
    doc.setCreationDate(_creationDate)
    doc.setModificationDate(_creationDate)
  }

  // Set metadata
  doc.setTitle(`Krzyżowa-Music ticket ${order.reference}-${code.slice(0, 6)}`)
  doc.setAuthor('Krzyżowa-Music')
  doc.setProducer('Krzyżowa-Music ticketing')

  // Register fontkit for embedded TTF support (required for latin-ext)
  doc.registerFontkit(fontkit)
  const regularFont = await doc.embedFont(notoRegularBytes, { subset: true })
  const boldFont = await doc.embedFont(notoBoldBytes, { subset: true })

  // A4 portrait: 595.28 × 841.89 pt
  const page = doc.addPage([595.28, 841.89])
  const { width, height } = page.getSize()
  const margin = 40
  const contentWidth = width - 2 * margin

  // ---------------------------------------------------------------------------
  // QR code — generate first so we know its size for layout
  // ---------------------------------------------------------------------------
  const qrUrl = `${publicBaseUrl}/t/${code}`
  const qrBuf = await qrPngBuffer(qrUrl)
  const qrImage = await doc.embedPng(qrBuf)

  const QR_SIZE = 170 // pts, ~60mm
  const qrX = width - margin - QR_SIZE
  const textAreaWidth = contentWidth - QR_SIZE - 20

  let y = height - margin

  // ---------------------------------------------------------------------------
  // Header — festival name
  // ---------------------------------------------------------------------------
  page.drawText('Krzyżowa-Music', {
    x: margin,
    y: y - 16,
    font: boldFont,
    size: 16,
    color: rgb(0.8, 0.07, 0.09), // #CC1216 brand red
  })
  y -= 30

  // ---------------------------------------------------------------------------
  // Event title (buyer locale)
  // ---------------------------------------------------------------------------
  page.drawText(event.title, {
    x: margin,
    y,
    font: boldFont,
    size: 18,
    color: rgb(0, 0, 0),
    maxWidth: textAreaWidth,
  })
  y -= 28

  // ---------------------------------------------------------------------------
  // Date and venue
  // ---------------------------------------------------------------------------
  const dateStr = `${formatConcertDate(event.startsAt, locale)}, ${formatConcertTime(event.startsAt, locale)}`
  page.drawText(dateStr, { x: margin, y, font: regularFont, size: 11, color: rgb(0.2, 0.2, 0.2), maxWidth: textAreaWidth })
  y -= 18

  const venueStr = `${event.venue}, ${event.address}, ${event.city}`
  page.drawText(venueStr, { x: margin, y, font: regularFont, size: 10, color: rgb(0.3, 0.3, 0.3), maxWidth: textAreaWidth })
  y -= 24

  // ---------------------------------------------------------------------------
  // Holder name
  // ---------------------------------------------------------------------------
  const displayName = fitHolderName(holderName, 32) || '–'
  page.drawText(labels.holder + ':', { x: margin, y, font: boldFont, size: 10, color: rgb(0.4, 0.4, 0.4) })
  y -= 14
  page.drawText(displayName, { x: margin, y, font: regularFont, size: 13, color: rgb(0, 0, 0) })
  y -= 24

  // ---------------------------------------------------------------------------
  // QR code — placed in the top-right, starting from the top of the page
  // ---------------------------------------------------------------------------
  const qrTopY = height - margin - QR_SIZE
  page.drawImage(qrImage, {
    x: qrX,
    y: qrTopY,
    width: QR_SIZE,
    height: QR_SIZE,
  })

  // Ticket code below the QR (plain text, for manual entry)
  page.drawText(labels.code + ':', {
    x: qrX,
    y: qrTopY - 14,
    font: boldFont,
    size: 8,
    color: rgb(0.4, 0.4, 0.4),
  })
  page.drawText(code, {
    x: qrX,
    y: qrTopY - 24,
    font: regularFont,
    size: 9,
    color: rgb(0, 0, 0),
  })

  // ---------------------------------------------------------------------------
  // Separator line
  // ---------------------------------------------------------------------------
  const lineY = Math.min(y - 10, qrTopY - 40)
  page.drawLine({
    start: { x: margin, y: lineY },
    end: { x: width - margin, y: lineY },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  })

  // ---------------------------------------------------------------------------
  // Order reference block
  // ---------------------------------------------------------------------------
  page.drawText(`${labels.reference}: ${order.reference}`, {
    x: margin,
    y: lineY - 16,
    font: regularFont,
    size: 9,
    color: rgb(0.5, 0.5, 0.5),
  })

  // ---------------------------------------------------------------------------
  // Footer — terms & contact
  // ---------------------------------------------------------------------------
  const footerY = margin + 20
  page.drawText(
    'Bilet jest imienny i uprawnia jedną osobę do wejścia na koncert. Organizator: Towarzystwo Muzyczne im. Hanny Czempisz — Krzyżowa-Music.',
    {
      x: margin,
      y: footerY,
      font: regularFont,
      size: 6,
      color: rgb(0.6, 0.6, 0.6),
      maxWidth: contentWidth,
    },
  )
  page.drawText(`kontakt: bilety@krzyzowa-music.eu`, {
    x: margin,
    y: footerY - 10,
    font: regularFont,
    size: 6,
    color: rgb(0.6, 0.6, 0.6),
  })

  const saved = await doc.save()
  return Buffer.from(saved)
}
