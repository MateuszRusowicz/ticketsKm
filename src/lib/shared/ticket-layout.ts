/**
 * Fits a holder name onto a fixed-width PDF field.
 *
 * Rules (from 06-i18n-email-pdf.md):
 * - null/undefined/"" → return "" (caller shows "–" or hides the field)
 * - Trim whitespace from both ends
 * - Normalize internal runs of whitespace to single spaces
 * - If .length > maxChars after trim/normalize, truncate to maxChars - 1
 *   and append "…" (U+2026, one character, not three dots)
 *
 * Default maxChars = 32. The caller can override for a different cell width.
 */
export function fitHolderName(raw: string | null | undefined, maxChars = 32): string {
  if (raw == null || raw === '') return ''

  // Trim outer whitespace and normalize internal whitespace runs
  const trimmed = raw.trim().replace(/\s+/g, ' ')

  if (trimmed === '') return ''

  if (trimmed.length <= maxChars) return trimmed

  // Truncate and append the Unicode ellipsis (one character)
  return trimmed.slice(0, maxChars - 1) + '…'
}
