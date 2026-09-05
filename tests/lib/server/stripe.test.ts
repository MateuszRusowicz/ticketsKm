import { describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import { stripe, stripeCurrency, stripeAmount } from '@/lib/server/stripe'
import * as stripeModule from '@/lib/server/stripe' // same-file identity

describe('stripe wrapper', () => {
  it('exports a single client instance', () => {
    expect(stripe).toBe(stripeModule.stripe)
  })

  it('uses a real Stripe client', () => {
    expect(stripe).toBeInstanceOf(Stripe)
  })

  it('lowercases currency PLN', () => {
    expect(stripeCurrency('PLN')).toBe('pln')
  })

  it('lowercases currency EUR', () => {
    expect(stripeCurrency('EUR')).toBe('eur')
  })

  it('reads amount from the order', () => {
    expect(stripeAmount({ total: 12345, currency: 'PLN', id: 'o1' })).toBe(12345)
  })

  it('refuses zero-amount', () => {
    expect(() => stripeAmount({ total: 0, currency: 'PLN', id: 'o1' })).toThrow(/zero-amount/i)
  })
})
