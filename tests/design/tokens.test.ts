import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/app/globals.css', 'utf8')

// Tokens are declared inside @theme (Tailwind v4), not :root. The regexes
// below match either, so this test survives a move between the two.

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))
  if (!match) throw new Error(`Token --${name} not found in globals.css`)
  return match[1]
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('design tokens', () => {
  const required = [
    'color-background', 'color-surface', 'color-text-primary', 'color-text-secondary',
    'color-accent', 'color-border', 'color-border-input', 'color-border-strong',
    'color-accent-hover',
  ]

  it.each(required)('defines --%s', (name) => {
    expect(token(name)).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })

  it('uses the agreed palette values', () => {
    expect(token('color-background')).toBe('#FFFFFF')
    expect(token('color-text-primary')).toBe('#1A1A1A')
    expect(token('color-text-secondary')).toBe('#4A4A4A')
    expect(token('color-accent')).toBe('#C4122D')
    expect(token('color-border')).toBe('#E0E0E0')
  })

  it('body text meets WCAG AA (4.5:1)', () => {
    expect(contrast(token('color-text-primary'), token('color-background'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('color-text-secondary'), token('color-background'))).toBeGreaterThanOrEqual(4.5)
  })

  it('white text on the accent meets WCAG AA', () => {
    expect(contrast('#FFFFFF', token('color-accent'))).toBeGreaterThanOrEqual(4.5)
  })

  // WCAG 2.1 SC 1.4.11: the visual boundary of a UI component needs 3:1.
  // --color-border (#E0E0E0) is ~1.3:1 and is therefore decorative only.
  it('form field borders meet WCAG non-text contrast (3:1)', () => {
    expect(contrast(token('color-border-input'), token('color-background'))).toBeGreaterThanOrEqual(3)
    expect(contrast(token('color-border-strong'), token('color-background'))).toBeGreaterThanOrEqual(3)
  })

  it('defines the 8px spacing scale', () => {
    for (const s of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8']) {
      expect(css).toContain(s)
    }
  })

  it('enables hyphenation, which German compound nouns depend on', () => {
    expect(css).toMatch(/hyphens:\s*auto/)
  })
})
