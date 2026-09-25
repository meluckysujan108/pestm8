// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MEMBER_COLOURS } from '../../../convex/lib/colours'
import {
  PEN_REDS,
  colourDistance,
  parseColour,
  passesForPen,
  teammateColour,
} from './markupColour'

/**
 * A teammate's marks must never be drawn in a colour that passes for your
 * pen's: the whole point of pen red for yours and member colours for theirs
 * is telling at a glance which marks Undo and Clear will take. The case that
 * matters is the second person on every team, who is dealt a red.
 */

const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')

/** `--red` as each theme block of the stylesheet declares it. */
function penRedsInStylesheet(): Array<string> {
  return [...css.matchAll(/^\s*--red:\s*(#[0-9a-f]{6});/gim)].map((m) =>
    m[1].toLowerCase(),
  )
}

describe('the pen’s red', () => {
  it('is measured against the red the stylesheet actually draws with', () => {
    const declared = penRedsInStylesheet()
    expect(declared.length).toBeGreaterThanOrEqual(2)
    expect(new Set(declared)).toEqual(new Set(PEN_REDS))
  })
})

describe('teammateColour', () => {
  it('draws the second member’s red in the neutral colour, not as a red that passes for yours', () => {
    expect(MEMBER_COLOURS[1]).toBe('#DC2626')
    expect(passesForPen('#DC2626')).toBe(true)
    expect(teammateColour('#DC2626')).toBeUndefined()
    expect(teammateColour('#dc2626')).toBeUndefined()
    expect(teammateColour('rgb(220, 38, 38)')).toBeUndefined()
    // The pen's own red, in either theme, most of all.
    for (const pen of PEN_REDS) expect(teammateColour(pen)).toBeUndefined()
  })

  it('keeps every other member colour as it is', () => {
    for (const colour of MEMBER_COLOURS.filter((c) => c !== '#DC2626')) {
      expect(teammateColour(colour)).toBe(colour)
    }
  })

  it('takes a colour it cannot read as given, and no colour as none', () => {
    expect(teammateColour('var(--member-3)')).toBe('var(--member-3)')
    expect(teammateColour(undefined)).toBeUndefined()
    expect(teammateColour('')).toBeUndefined()
  })
})

describe('colourDistance', () => {
  it('puts the second member’s red well inside the line, and pink well outside it', () => {
    expect(colourDistance('#DC2626', PEN_REDS[0])).toBeLessThan(0.09)
    expect(colourDistance('#DB2777', PEN_REDS[0])).toBeGreaterThan(0.12)
    expect(colourDistance('#fff', '#ffffff')).toBe(0)
  })

  it('reads the colour forms a caller is likely to hand over, and nothing else', () => {
    expect(parseColour('#f00')).toEqual([255, 0, 0])
    expect(parseColour(' #0A84FF ')).toEqual([10, 132, 255])
    expect(parseColour('#0a84ff80')).toEqual([10, 132, 255])
    expect(parseColour('rgb(10 132 255)')).toEqual([10, 132, 255])
    expect(parseColour('rgba(10, 132, 255, 0.5)')).toEqual([10, 132, 255])
    expect(parseColour('red')).toBeNull()
    expect(parseColour('var(--red)')).toBeNull()
    expect(parseColour('rgb(300, 0, 0)')).toBeNull()
  })
})
