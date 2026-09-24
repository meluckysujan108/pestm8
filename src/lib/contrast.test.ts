import { describe, expect, test } from 'vitest'
import { contrastRatio, luminance } from './contrast'

describe('WCAG contrast', () => {
  test('black on white is 21:1, and a colour against itself 1:1', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrastRatio('#0A84FF', '#0A84FF')).toBeCloseTo(1, 5)
  })

  test('matches the published AA boundary: #767676 on white is 4.54:1', () => {
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2)
  })

  test('is symmetric and case-insensitive', () => {
    expect(contrastRatio('#ffffff', '#1c1c1e')).toBeCloseTo(
      contrastRatio('#1C1C1E', '#FFFFFF'),
      10,
    )
  })

  test('refuses what is not #rrggbb', () => {
    expect(() => luminance('rgba(0,0,0,0.5)')).toThrow()
  })
})
