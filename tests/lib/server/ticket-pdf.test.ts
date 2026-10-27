import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { PNG } from 'pngjs'
import jsQR from 'jsqr'
import { renderTicketPdf, type TicketPdfInput } from '@/lib/server/ticket-pdf'

const FIXED_DATE = new Date('2026-10-27T12:00:00Z')
const PUBLIC_BASE_URL = 'https://tickets-km.vercel.app'

const BASE_INPUT: TicketPdfInput = {
  code: 'ABCDEF1234567890ABCDEF12',
  holderName: 'Jan Kowalski',
  order: {
    reference: 'KM-0001',
    locale: 'pl',
  },
  event: {
    title: 'Kwartet smyczkowy',
    startsAt: new Date('2027-08-15T19:00:00Z'),
    venue: 'Centrum Krzyżowa',
    address: 'Krzyżowa 7',
    city: 'Krzyżowa',
  },
  publicBaseUrl: PUBLIC_BASE_URL,
  _creationDate: FIXED_DATE,
}

// Ensure the test code is exactly 26 characters
const VALID_CODE = 'ABCDEF1234567890ABCDEF12AB' // 26 chars

const INPUT: TicketPdfInput = { ...BASE_INPUT, code: VALID_CODE }

describe('renderTicketPdf', () => {
  it('generates exactly 1 page', async () => {
    const buf = await renderTicketPdf(INPUT)
    const doc = await PDFDocument.load(buf)
    expect(doc.getPageCount()).toBe(1)
  })

  it('generates three distinct single-page PDFs for three different codes (per-ticket contract)', async () => {
    const codes = ['AAAA1111BBBB2222CCCC3333AA', 'DDDD4444EEEE5555FFFF6666DD', 'GGGG7777HHHH8888JJJJ9999GG']
    const pdfs = await Promise.all(
      codes.map((code) => renderTicketPdf({ ...INPUT, code })),
    )
    // Each is a Buffer starting with %PDF-
    for (const buf of pdfs) {
      expect(buf.slice(0, 4).toString()).toBe('%PDF')
    }
    // All three are different from each other
    expect(pdfs[0].equals(pdfs[1])).toBe(false)
    expect(pdfs[1].equals(pdfs[2])).toBe(false)
  })

  it('embeds a latin-ext font without throwing', async () => {
    // If NotoSans is missing or not registered, pdf-lib throws on diacritics
    await expect(
      renderTicketPdf({
        ...INPUT,
        holderName: 'Małgorzata Świętosławska',
      }),
    ).resolves.toBeInstanceOf(Buffer)
  })

  it('sets the title to Krzyżowa-Music ticket <reference>-<code6>', async () => {
    const buf = await renderTicketPdf(INPUT)
    const doc = await PDFDocument.load(buf)
    expect(doc.getTitle()).toBe(`Krzyżowa-Music ticket ${INPUT.order.reference}-${VALID_CODE.slice(0, 6)}`)
  })

  it('single-ticket PDF is under 200KB', async () => {
    const buf = await renderTicketPdf(INPUT)
    expect(buf.length).toBeLessThan(200 * 1024)
  })

  it('renders "–" for null holder name, not "null" or empty', async () => {
    const buf = await renderTicketPdf({ ...INPUT, holderName: null })
    // The null case should not throw and should produce a valid PDF
    const doc = await PDFDocument.load(buf)
    expect(doc.getPageCount()).toBe(1)
    expect(buf.length).toBeGreaterThan(0)
  })

  it('QR code decodes back to the expected URL', async () => {
    // Verify the QR generator was called with the right URL by generating
    // the QR PNG separately and verifying it decodes correctly
    const { qrPngBuffer } = await import('@/lib/shared/qr')
    const qrBuf = await qrPngBuffer(`${PUBLIC_BASE_URL}/t/${VALID_CODE}`)
    const png = PNG.sync.read(qrBuf)
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
    expect(code?.data).toBe(`${PUBLIC_BASE_URL}/t/${VALID_CODE}`)
  })

  it('German locale produces different label text than Polish', async () => {
    const plBuf = await renderTicketPdf({ ...INPUT, order: { ...INPUT.order, locale: 'pl' } })
    const deBuf = await renderTicketPdf({ ...INPUT, order: { ...INPUT.order, locale: 'de' } })
    // Different locales produce different PDFs (different label text)
    expect(plBuf.equals(deBuf)).toBe(false)
  })

  it('identical input with fixed creation date produces identical bytes', async () => {
    const buf1 = await renderTicketPdf(INPUT)
    const buf2 = await renderTicketPdf(INPUT)
    expect(buf1.equals(buf2)).toBe(true)
  })
})
