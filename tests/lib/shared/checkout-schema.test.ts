import { describe, expect, it } from 'vitest'
import { checkoutSchema, clampQuantity, MAX_NAME_LENGTH } from '@/lib/shared/checkout'

function valid(overrides: Record<string, unknown> = {}) {
  return {
    ticketTypeId: '3f9a1b2c-4d5e-4f6a-8b9c-0d1e2f3a4b5c', // a real v4
    quantity: 2,
    locale: 'pl',
    currency: 'PLN',
    email: 'jan@example.test',
    firstName: 'Jan',
    lastName: 'Kowalski',
    attendeeNames: ['Jan Kowalski', 'Anna Kowalska'],
    needsInvoice: false,
    acceptedTerms: true,
    ...overrides,
  }
}

describe('clampQuantity', () => {
  it('accepts a value inside the bounds', () => {
    expect(clampQuantity('3', 10, 100)).toBe(3)
  })

  it('defaults to 1 when absent or unparseable', () => {
    // ?q= is user-controlled; none of these may throw.
    expect(clampQuantity(undefined, 10, 100)).toBe(1)
    expect(clampQuantity('', 10, 100)).toBe(1)
    expect(clampQuantity('abc', 10, 100)).toBe(1)
    expect(clampQuantity('2.5', 10, 100)).toBe(1)
    expect(clampQuantity('1e3', 10, 100)).toBe(1)
  })

  it('clamps rather than rejecting an over-large request', () => {
    // Clamping and telling the buyer beats an error page they cannot act on.
    expect(clampQuantity('99', 10, 100)).toBe(10)
    expect(clampQuantity('99', 10, 3)).toBe(3)
  })

  it('never returns less than 1 for a positive allowance', () => {
    expect(clampQuantity('0', 10, 100)).toBe(1)
    expect(clampQuantity('-5', 10, 100)).toBe(1)
  })

  it('returns 0 when nothing is available at all', () => {
    // A sold-out concert must not offer a quantity of 1.
    expect(clampQuantity('3', 10, 0)).toBe(0)
  })
})

describe('checkoutSchema', () => {
  it('accepts a well-formed order', () => {
    expect(checkoutSchema.safeParse(valid()).success).toBe(true)
  })

  it('rejects a malformed email', () => {
    expect(checkoutSchema.safeParse(valid({ email: 'not-an-email' })).success).toBe(false)
  })

  it('requires first and last name', () => {
    expect(checkoutSchema.safeParse(valid({ firstName: '' })).success).toBe(false)
    expect(checkoutSchema.safeParse(valid({ lastName: '   ' })).success).toBe(false)
  })

  it('treats phone as optional', () => {
    expect(checkoutSchema.safeParse(valid({ phone: undefined })).success).toBe(true)
    expect(checkoutSchema.safeParse(valid({ phone: '+48 600 000 000' })).success).toBe(true)
  })

  describe('attendee names', () => {
    it('requires exactly one name per ticket', () => {
      expect(checkoutSchema.safeParse(valid({ attendeeNames: ['Only One'] })).success).toBe(false)
      expect(
        checkoutSchema.safeParse(valid({ attendeeNames: ['A B', 'C D', 'E F'] })).success,
      ).toBe(false)
    })

    it('rejects a blank name among filled ones', () => {
      expect(checkoutSchema.safeParse(valid({ attendeeNames: ['Jan Kowalski', '  '] })).success).toBe(
        false,
      )
    })

    it('trims names', () => {
      const parsed = checkoutSchema.parse(valid({ attendeeNames: ['  Jan Kowalski  ', 'Anna'] }))
      expect(parsed.attendeeNames[0]).toBe('Jan Kowalski')
    })

    it('caps length — the name goes into a fixed-width PDF layout', () => {
      const tooLong = 'x'.repeat(MAX_NAME_LENGTH + 1)
      expect(checkoutSchema.safeParse(valid({ attendeeNames: [tooLong, 'Anna'] })).success).toBe(
        false,
      )
    })

    it('accepts Polish and German diacritics', () => {
      const names = ['Małgorzata Świętosławska', 'Jürgen Müller']
      expect(checkoutSchema.safeParse(valid({ attendeeNames: names })).success).toBe(true)
    })

    it('tracks a changed quantity', () => {
      expect(
        checkoutSchema.safeParse(valid({ quantity: 3, attendeeNames: ['A', 'B', 'C'] })).success,
      ).toBe(true)
    })
  })

  describe('invoice details', () => {
    it('does not require them when no invoice is wanted', () => {
      expect(checkoutSchema.safeParse(valid({ needsInvoice: false })).success).toBe(true)
    })

    it('requires all three when an invoice is wanted', () => {
      // The classic failure: optional fields that become required, and a form
      // that silently accepts nothing.
      expect(checkoutSchema.safeParse(valid({ needsInvoice: true })).success).toBe(false)
      expect(
        checkoutSchema.safeParse(valid({ needsInvoice: true, companyName: 'Acme' })).success,
      ).toBe(false)
      expect(
        checkoutSchema.safeParse(
          valid({
            needsInvoice: true,
            companyName: 'Acme',
            nip: '1234567890',
            invoiceAddress: 'ul. Testowa 1, Warszawa',
          }),
        ).success,
      ).toBe(true)
    })
  })

  it('requires the terms to be accepted', () => {
    expect(checkoutSchema.safeParse(valid({ acceptedTerms: false })).success).toBe(false)
  })

  it('rejects a ticket type id that is not a real UUID', () => {
    // Zod 4 checks the version and variant nibbles, so a shape-only
    // placeholder does not pass. Prisma's uuid() default is v4 and does.
    expect(
      checkoutSchema.safeParse(valid({ ticketTypeId: '11111111-1111-1111-1111-111111111111' }))
        .success,
    ).toBe(false)
    expect(checkoutSchema.safeParse(valid({ ticketTypeId: 'not-a-uuid' })).success).toBe(false)
  })

  it('rejects an unknown locale or currency', () => {
    expect(checkoutSchema.safeParse(valid({ locale: 'fr' })).success).toBe(false)
    expect(checkoutSchema.safeParse(valid({ currency: 'USD' })).success).toBe(false)
  })
})
