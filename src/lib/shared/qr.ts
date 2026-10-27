import QRCode from 'qrcode'

// Shared QR generation options — same settings for both PNG and SVG so the
// QR payload is identical regardless of output format.
const COMMON_OPTIONS: QRCode.QRCodeRenderersOptions = {
  errorCorrectionLevel: 'H',
  margin: 4,
  color: { dark: '#000000', light: '#FFFFFF' },
}

/**
 * Generates a PNG buffer encoding the given URL as a QR code.
 *
 * The buffer starts with standard PNG magic bytes and is ready to pass
 * directly to pdf-lib's embedPng() for embedding in a ticket PDF.
 *
 * High error correction (H = 30% damage recovery) is required because
 * tickets may be viewed on cracked phone screens in dark venues.
 */
export async function qrPngBuffer(url: string): Promise<Buffer> {
  const result = await QRCode.toBuffer(url, {
    ...COMMON_OPTIONS,
    type: 'png',
    width: 512,
  })
  // Normalise to Buffer — qrcode emits a Uint8Array in some Node versions
  return Buffer.from(result)
}

/**
 * Generates an SVG string encoding the given URL as a QR code.
 *
 * The SVG is inline-safe (no XML declaration) and can be embedded directly
 * in the public ticket page's HTML without a separate request.
 */
export async function qrSvgString(url: string): Promise<string> {
  return QRCode.toString(url, {
    ...COMMON_OPTIONS,
    type: 'svg',
  })
}
