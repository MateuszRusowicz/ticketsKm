import { describe, expect, it } from 'vitest'
import {
  availabilityBand,
  maxSelectableQuantity,
  priceFor,
  type PublicEvent,
} from '@/lib/shared/public-event'

describe('availabilityBand', () => {
  it('is soldOut at zero', () => {
    expect(availabilityBand(0, 900)).toBe('soldOut')
  })

  it('is soldOut when negative', () => {
    // soldCount + heldCount can briefly exceed capacity if capacity is lowered.
    // The band must not read "available" in that window.
    expect(availabilityBand(-5, 900)).toBe('soldOut')
  })

  it('is few at or below a tenth of capacity', () => {
    expect(availabilityBand(90, 900)).toBe('few')
    expect(availabilityBand(1, 900)).toBe('few')
  })

  it('is available above a tenth of capacity', () => {
    expect(availabilityBand(91, 900)).toBe('available')
    expect(availabilityBand(900, 900)).toBe('available')
  })

  it('scales with the venue, not a fixed number', () => {
    // 20 left is nearly sold out in the 300-seat palace...
    expect(availabilityBand(20, 300)).toBe('few')
    // ...and unremarkable in the 900-seat church.
    expect(availabilityBand(20, 900)).toBe('few')
    expect(availabilityBand(120, 900)).toBe('available')
    expect(availabilityBand(120, 300)).toBe('available')
  })

  it('does not treat a zero capacity as "few"', () => {
    expect(availabilityBand(0, 0)).toBe('soldOut')
  })
})

describe('maxSelectableQuantity', () => {
  it('takes whichever bound binds first', () => {
    expect(maxSelectableQuantity(10, 900)).toBe(10)
    expect(maxSelectableQuantity(10, 3)).toBe(3)
  })

  it('never returns a negative', () => {
    expect(maxSelectableQuantity(10, -5)).toBe(0)
  })
})

describe('priceFor', () => {
  const event = { pricePln: 8000, priceEur: 1900 } as PublicEvent

  it('picks the explicit price for the currency', () => {
    expect(priceFor(event, 'PLN')).toBe(8000)
    expect(priceFor(event, 'EUR')).toBe(1900)
  })

  it('never converts between currencies', () => {
    // 1900 is the festival's chosen EUR price, not 8000 divided by a rate.
    expect(priceFor(event, 'EUR')).not.toBe(Math.round(8000 / 4.3))
  })
})
