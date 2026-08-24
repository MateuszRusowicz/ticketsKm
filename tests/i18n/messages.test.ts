import { describe, expect, it } from 'vitest'
import pl from '@/messages/pl.json'
import en from '@/messages/en.json'
import de from '@/messages/de.json'

function keys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? keys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  )
}

describe('message catalogues', () => {
  it('English has every key Polish has', () => {
    expect(keys(en).sort()).toEqual(keys(pl).sort())
  })

  it('German has every key Polish has', () => {
    expect(keys(de).sort()).toEqual(keys(pl).sort())
  })

  it('has no empty strings', () => {
    for (const [name, cat] of [['pl', pl], ['en', en], ['de', de]] as const) {
      for (const key of keys(cat)) {
        const value = key
          .split('.')
          .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], cat)
        expect(value, `${name}.${key} is empty`).not.toBe('')
      }
    }
  })
})
