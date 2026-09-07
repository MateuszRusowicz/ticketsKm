import { describe, expect, it } from 'vitest'
import { basePaymentMethodsFor, paymentMethodLabel, paymentMethodLabelsFor } from '@/lib/shared/payment-methods'

describe('basePaymentMethodsFor', () => {
  it('returns card, blik and p24 for PLN — no paypal', () => {
    const methods = basePaymentMethodsFor('PLN')
    expect(methods).toContain('card')
    expect(methods).toContain('blik')
    expect(methods).toContain('p24')
    expect(methods).not.toContain('paypal')
    expect(methods).not.toContain('klarna')
    expect(methods).not.toContain('sepa_debit')
  })

  it('returns card, klarna, sepa_debit and paypal for EUR — no PLN methods', () => {
    const methods = basePaymentMethodsFor('EUR')
    expect(methods).toContain('card')
    expect(methods).toContain('klarna')
    expect(methods).toContain('sepa_debit')
    expect(methods).toContain('paypal')
    expect(methods).not.toContain('blik')
    expect(methods).not.toContain('p24')
  })
})

describe('paymentMethodLabel', () => {
  it('returns the translated card label for card', () => {
    expect(paymentMethodLabel('card', 'karta')).toBe('karta')
  })

  it('returns BLIK for blik (brand name, untranslated)', () => {
    expect(paymentMethodLabel('blik', 'karta')).toBe('BLIK')
  })

  it('returns Przelewy24 for p24 (brand name, untranslated)', () => {
    expect(paymentMethodLabel('p24', 'karta')).toBe('Przelewy24')
  })

  it('returns Klarna for klarna (brand name, untranslated)', () => {
    expect(paymentMethodLabel('klarna', 'card')).toBe('Klarna')
  })

  it('returns SEPA for sepa_debit (brand name, untranslated)', () => {
    expect(paymentMethodLabel('sepa_debit', 'card')).toBe('SEPA')
  })

  it('returns PayPal for paypal (brand name, untranslated)', () => {
    expect(paymentMethodLabel('paypal', 'card')).toBe('PayPal')
  })
})

describe('paymentMethodLabelsFor', () => {
  it('PLN yields translated card label then BLIK then Przelewy24', () => {
    const labels = paymentMethodLabelsFor('PLN', 'karta')
    expect(labels).toEqual(['karta', 'BLIK', 'Przelewy24'])
  })

  it('EUR yields translated card label then Klarna then SEPA then PayPal', () => {
    const labels = paymentMethodLabelsFor('EUR', 'card')
    expect(labels).toEqual(['card', 'Klarna', 'SEPA', 'PayPal'])
  })

  it('card label is locale-specific — same brand names regardless of cardLabel', () => {
    const pl = paymentMethodLabelsFor('PLN', 'karta')
    const de = paymentMethodLabelsFor('PLN', 'Karte')
    expect(pl[0]).toBe('karta')
    expect(de[0]).toBe('Karte')
    // Brand names are identical regardless of locale
    expect(pl.slice(1)).toEqual(de.slice(1))
  })
})
