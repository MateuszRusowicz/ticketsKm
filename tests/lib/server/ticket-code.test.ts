import { describe, expect, it } from 'vitest'
import { ticketCode } from '@/lib/server/orders'

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CROCKFORD_SET = new Set(CROCKFORD_ALPHABET.split(''))

describe('ticketCode', () => {
  it('returns only characters from the Crockford base32 alphabet', () => {
    const code = ticketCode()
    for (const char of code) {
      expect(CROCKFORD_SET.has(char), `Character '${char}' is not in the Crockford alphabet`).toBe(true)
    }
  })

  it('returns exactly 26 characters', () => {
    const code = ticketCode()
    expect(code).toHaveLength(26)
  })

  it('generates 100 000 collision-free codes', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 100_000; i++) {
      codes.add(ticketCode())
    }
    expect(codes.size).toBe(100_000)
  })
})
