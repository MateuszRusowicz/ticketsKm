import { describe, expect, it } from 'vitest'
import {
  formatOrderReference,
  OrderReferenceOverflow,
  REFERENCE_RE,
} from '@/lib/shared/order-reference'

describe('formatOrderReference', () => {
  it('formats a sequence value as KM-{year}-{6 digits}', () => {
    expect(formatOrderReference(137, 2026)).toBe('KM-2026-000137')
  })

  it('zero-pads to six digits', () => {
    expect(formatOrderReference(1, 2026)).toBe('KM-2026-000001')
  })

  it('throws once the sequence would need a seventh digit', () => {
    // Tested as a pure function on purpose. Driving the real sequence to
    // 1_000_000 with setval would poison order_reference_seq for every later
    // test file — TRUNCATE ... RESTART IDENTITY does not reset a standalone
    // sequence.
    expect(() => formatOrderReference(1_000_000, 2026)).toThrow(OrderReferenceOverflow)
  })

  it('carries the offending value on the error', () => {
    expect.assertions(1)
    try {
      formatOrderReference(1_000_000, 2026)
    } catch (e) {
      expect((e as OrderReferenceOverflow).seq).toBe(1_000_000)
    }
  })

  it('accepts the last valid value', () => {
    expect(formatOrderReference(999_999, 2026)).toBe('KM-2026-999999')
  })
})

describe('REFERENCE_RE', () => {
  it('matches a well-formed reference', () => {
    expect(REFERENCE_RE.test('KM-2026-000137')).toBe(true)
  })

  it('rejects seven digits', () => {
    expect(REFERENCE_RE.test('KM-2026-1234567')).toBe(false)
  })

  it('rejects a two-digit year', () => {
    expect(REFERENCE_RE.test('KM-26-000137')).toBe(false)
  })

  it('matches the seeded reference, which uses year 0000 by design', () => {
    expect(REFERENCE_RE.test('KM-0000-000001')).toBe(true)
  })
})
