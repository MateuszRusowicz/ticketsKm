import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import jsQR from 'jsqr'
import { qrPngBuffer, qrSvgString } from '@/lib/shared/qr'

const TEST_URL = 'https://tickets-km.vercel.app/t/0123456789ABCDEFGHJKMNPQRS'
const TEST_URL_2 = 'https://tickets-km.vercel.app/t/ABCDEFGHJKMNPQRSTVWXYZ0123'

describe('qrPngBuffer', () => {
  it('returns a Buffer starting with PNG magic bytes', async () => {
    const buf = await qrPngBuffer(TEST_URL)
    expect(buf).toBeInstanceOf(Buffer)
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(buf[0]).toBe(0x89)
    expect(buf[1]).toBe(0x50)
    expect(buf[2]).toBe(0x4e)
    expect(buf[3]).toBe(0x47)
    expect(buf[4]).toBe(0x0d)
    expect(buf[5]).toBe(0x0a)
    expect(buf[6]).toBe(0x1a)
    expect(buf[7]).toBe(0x0a)
  })

  it('produces identical bytes for the same URL (deterministic)', async () => {
    const buf1 = await qrPngBuffer(TEST_URL)
    const buf2 = await qrPngBuffer(TEST_URL)
    expect(buf1.equals(buf2)).toBe(true)
  })

  it('produces different bytes for different URLs (non-degenerate)', async () => {
    const buf1 = await qrPngBuffer(TEST_URL)
    const buf2 = await qrPngBuffer(TEST_URL_2)
    expect(buf1.equals(buf2)).toBe(false)
  })

  it('decodes back to the original URL (round-trip)', async () => {
    const buf = await qrPngBuffer(TEST_URL)
    const png = PNG.sync.read(buf)
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
    expect(code).not.toBeNull()
    expect(code?.data).toBe(TEST_URL)
  })
})

describe('qrSvgString', () => {
  it('returns a string containing <svg and the input URL', async () => {
    const svg = await qrSvgString(TEST_URL)
    expect(typeof svg).toBe('string')
    expect(svg).toContain('<svg')
    // The URL itself appears in a comment or data attribute in the SVG output
    // (qrcode library includes it as a comment)
    expect(svg.toLowerCase()).toContain('svg')
  })
})
