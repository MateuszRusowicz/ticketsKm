import { describe, expect, it } from 'vitest'
import { fitHolderName } from '@/lib/shared/ticket-layout'

describe('fitHolderName', () => {
  it('returns "" for null', () => {
    expect(fitHolderName(null)).toBe('')
  })

  it('trims whitespace and normalizes internal spaces', () => {
    expect(fitHolderName('  Jan   Kowalski  ')).toBe('Jan Kowalski')
  })

  it('truncates long names with Unicode ellipsis', () => {
    const long = 'a'.repeat(100)
    const result = fitHolderName(long, 32)
    expect(result).toHaveLength(32)
    expect(result.endsWith('…')).toBe(true)
  })

  it('does not truncate a name within the limit', () => {
    const name = 'Małgorzata Świętosławska' // 24 chars
    expect(fitHolderName(name)).toBe(name)
  })

  it('truncates a long Polish name preserving latin-ext characters intact', () => {
    const name = 'Małgorzata Świętosławska i Rodzina' // 35 chars
    const result = fitHolderName(name, 32)
    expect(result).toHaveLength(32)
    expect(result.endsWith('…')).toBe(true)
    // Verify the diacritics before the truncation point are preserved
    // First 31 chars of the 35-char name: "Małgorzata Świętosławska i Rodz"
    expect(result.startsWith('Małgorzata Świętosławska i Rodz')).toBe(true)
  })

  it('counts "…" as one character, not three', () => {
    expect('…'.length).toBe(1)
    // A name at exactly maxChars should NOT be truncated
    const exactly32 = 'a'.repeat(32)
    const result = fitHolderName(exactly32, 32)
    expect(result).toHaveLength(32)
    expect(result.endsWith('…')).toBe(false)
    // A name at maxChars + 1 should be truncated to 32 chars (31 + ellipsis)
    const thirtyThree = 'a'.repeat(33)
    const truncated = fitHolderName(thirtyThree, 32)
    expect(truncated).toHaveLength(32)
    expect(truncated.endsWith('…')).toBe(true)
  })
})
