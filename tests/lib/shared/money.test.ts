import { describe, expect, it } from 'vitest'
import { applyPercentDiscount, formatMoney, toMajor, toMinor } from '@/lib/shared/money'

// Intl separates the amount from the currency symbol with a non-breaking
// space (U+00A0) in pl-PL and de-DE, and some ICU versions use a narrow
// one (U+202F). Normalising both keeps the assertions readable and stops
// the suite breaking on a Node upgrade.
const norm = (s: string) => s.replace(/[  ]/g, ' ')

describe('toMinor / toMajor', () => {
  it('converts major units to minor units', () => {
    expect(toMinor(49)).toBe(4900)
    expect(toMinor(12.5)).toBe(1250)
  })

  it('rounds rather than truncating', () => {
    expect(toMinor(0.005)).toBe(1)
  })

  it('converts back', () => {
    expect(toMajor(4900)).toBe(49)
  })
})

describe('formatMoney', () => {
  it('formats PLN for a Polish reader', () => {
    expect(norm(formatMoney(4900, 'PLN', 'pl'))).toBe('49,00 zł')
  })

  it('formats EUR for a German reader', () => {
    expect(norm(formatMoney(1200, 'EUR', 'de'))).toBe('12,00 €')
  })

  it('formats EUR for an English reader', () => {
    expect(norm(formatMoney(1200, 'EUR', 'en'))).toBe('€12.00')
  })

  it('formats zero', () => {
    expect(norm(formatMoney(0, 'PLN', 'pl'))).toBe('0,00 zł')
  })
})

describe('applyPercentDiscount', () => {
  it('computes a percentage of the subtotal', () => {
    expect(applyPercentDiscount(10000, 10)).toBe(1000)
  })

  it('rounds down so the seller never loses a grosz', () => {
    expect(applyPercentDiscount(999, 10)).toBe(99)
  })

  it('never exceeds the subtotal', () => {
    expect(applyPercentDiscount(5000, 100)).toBe(5000)
    expect(applyPercentDiscount(5000, 150)).toBe(5000)
  })

  it('never returns a negative discount', () => {
    expect(applyPercentDiscount(5000, -10)).toBe(0)
  })
})
