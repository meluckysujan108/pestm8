import { describe, expect, test } from 'vitest'
import {
  COLOUR_NAME,
  MEMBER_COLOURS,
  isMemberColour,
  nextColour,
  normaliseColour,
} from './colours'
import { contrastRatio } from '../../src/lib/contrast'

describe('the technician palette', () => {
  test('deals the owner blue and the first to join orange — Terence and Kevin, by order alone', () => {
    expect(nextColour([])).toBe('#0A84FF')
    expect(nextColour(['#0A84FF'])).toBe('#E35F00')
    expect(COLOUR_NAME[MEMBER_COLOURS[0]]).toBe('Blue')
    expect(COLOUR_NAME[MEMBER_COLOURS[1]]).toBe('Orange')
  })

  test('never offers red (the brand, and Pending) or yellow (Booked)', () => {
    for (const taken of ['#FF3B30', '#FF453A', '#FFCC00', '#FFD60A']) {
      expect(isMemberColour(taken)).toBe(false)
    }
  })

  test('every colour holds 3:1 against the card in both themes, so a rail is visible outdoors', () => {
    for (const colour of MEMBER_COLOURS) {
      expect(contrastRatio(colour, '#FFFFFF')).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(colour, '#1C1C1E')).toBeGreaterThanOrEqual(3)
    }
  })

  test('has no duplicates, and a name for every colour', () => {
    expect(new Set(MEMBER_COLOURS).size).toBe(MEMBER_COLOURS.length)
    for (const colour of MEMBER_COLOURS)
      expect(COLOUR_NAME[colour]).toBeTruthy()
  })
})

describe('dealing the next colour', () => {
  test('a lower-case copy of a taken colour still counts as taken', () => {
    expect(nextColour(['#0a84ff'])).toBe('#E35F00')
  })

  test('colours from before the palette are not counted against anything', () => {
    // An old business: the owner kept the former default red.
    expect(nextColour(['#FF3B30'])).toBe('#0A84FF')
  })

  test('past the palette, the least used colour is dealt — not always the first', () => {
    const everyone = [...MEMBER_COLOURS]
    expect(nextColour(everyone)).toBe(MEMBER_COLOURS[0])
    expect(nextColour([...everyone, MEMBER_COLOURS[0]])).toBe(MEMBER_COLOURS[1])
  })
})

describe('normalising a colour', () => {
  test('trims and upper-cases a #rrggbb colour', () => {
    expect(normaliseColour(' #e35f00 ')).toBe('#E35F00')
  })

  test('refuses anything that is not #rrggbb', () => {
    for (const bad of ['red', '#FFF', '#12345G', 'url(x)', '#0A84FF;']) {
      expect(normaliseColour(bad)).toBeNull()
    }
  })
})
