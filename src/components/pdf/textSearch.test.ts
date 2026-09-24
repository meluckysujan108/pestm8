import { describe, expect, it } from 'vitest'
import { findInPage, foldQuery, indexPageText, rangeRect } from './textSearch'
import type { TextItemLike } from './textSearch'

/**
 * Search inside a PDF. The words a technician types rarely match the bytes a
 * PDF writer produced — different case, curly apostrophes, an em dash, a line
 * break mid-phrase, a word split across two runs — and every one of those is
 * a "No matches" on a sheet that plainly says it.
 */

function find(items: TextItemLike[], query: string) {
  return findInPage(indexPageText(items), items, query)
}

/** The text a match covers, read back out of the items. */
function covered(items: TextItemLike[], query: string): string[] {
  return find(items, query).map(({ ranges }) =>
    ranges
      .map(({ item, from, to }) => items[item].str.slice(from, to))
      .join('|'),
  )
}

describe('foldQuery', () => {
  it('trims, collapses spaces, lower-cases and drops accents', () => {
    expect(foldQuery('  First   AID  ')).toBe('first aid')
    expect(foldQuery('Café')).toBe('cafe')
    expect(foldQuery('Don’t — “stop”')).toBe(`don't - "stop"`)
  })

  it('is empty for nothing but spaces', () => {
    expect(foldQuery(' \t\n ')).toBe('')
  })
})

describe('findInPage', () => {
  it('finds a word whatever its case', () => {
    const items = [{ str: 'SECTION 4: First Aid Measures' }]
    expect(covered(items, 'first aid')).toEqual(['First Aid'])
  })

  it('finds a phrase split across items', () => {
    const items = [{ str: 'Seek medical ' }, { str: 'adv' }, { str: 'ice now' }]
    const [match] = find(items, 'medical advice')
    expect(match.ranges).toEqual([
      { item: 0, from: 5, to: 13 },
      { item: 1, from: 0, to: 3 },
      { item: 2, from: 0, to: 3 },
    ])
  })

  it('reads the end of a line as a space', () => {
    const items = [{ str: 'Hazard', hasEOL: true }, { str: 'statements' }]
    expect(covered(items, 'hazard statements')).toEqual(['Hazard|statements'])
  })

  it('collapses runs of whitespace on both sides', () => {
    const items = [{ str: 'Wear   protective\u00a0 gloves' }]
    expect(covered(items, 'protective gloves')).toEqual([
      'protective\u00a0 gloves',
    ])
    expect(covered(items, 'wear  protective')).toEqual(['Wear   protective'])
  })

  it('matches accents, quotes and dashes loosely', () => {
    const items = [{ str: 'Page 1 — Don’t use near the Café' }]
    expect(covered(items, "page 1 - don't")).toEqual(['Page 1 — Don’t'])
    expect(covered(items, 'cafe')).toEqual(['Café'])
  })

  it('spells out ligatures and maps back to the ligature', () => {
    const items = [{ str: 'ﬁrst aid' }]
    const [match] = find(items, 'first')
    expect(match.ranges).toEqual([{ item: 0, from: 0, to: 4 }])
    // "ﬁ" is one character standing for two, so "rst" starts inside it and
    // the highlight starts with it.
    expect(find(items, 'irst')[0].ranges).toEqual([{ item: 0, from: 0, to: 4 }])
  })

  it('keeps offsets right after a character outside the BMP', () => {
    const items = [{ str: '⚠️🧪 Toxic if inhaled' }]
    expect(covered(items, 'toxic')).toEqual(['Toxic'])
  })

  it('finds every occurrence, without overlap', () => {
    expect(find([{ str: 'aaaa' }], 'aa')).toHaveLength(2)
    expect(find([{ str: 'Rinse. Rinse again.' }], 'rinse')).toHaveLength(2)
  })

  it('ignores soft hyphens a PDF writer left in', () => {
    const items = [{ str: 'inhal\u00adation' }]
    expect(covered(items, 'inhalation')).toEqual(['inhal\u00adation'])
  })

  it('finds nothing for an empty search', () => {
    expect(find([{ str: 'anything' }], '   ')).toEqual([])
  })
})

describe('indexPageText', () => {
  it('knows a page with no text — a scan — from one with some', () => {
    expect(indexPageText([]).hasText).toBe(false)
    expect(indexPageText([{ str: ' ', hasEOL: true }]).hasText).toBe(false)
    expect(indexPageText([{ str: 'x' }]).hasText).toBe(true)
  })
})

describe('rangeRect', () => {
  // A4 at scale 1: flip y, origin at the top-left.
  const viewport = { transform: [1, 0, 0, -1, 0, 842], width: 595, height: 842 }

  it('places part of a horizontal item by its share of the characters', () => {
    // 12pt text at (72, 700), 100pt wide, ten characters.
    const item = {
      str: '0123456789',
      transform: [12, 0, 0, 12, 72, 700],
      width: 100,
      height: 12,
    }
    const rect = rangeRect(item, 2, 5, viewport)
    expect(rect.x * 595).toBeCloseTo(72 + 20)
    expect(rect.w * 595).toBeCloseTo(30)
    // Ascent 0.8 of the 12pt font above the baseline (842 − 700 = 142 down).
    expect(rect.y * 842).toBeCloseTo(142 - 9.6)
    expect(rect.h * 842).toBeCloseTo(12)
  })

  it('turns with rotated text', () => {
    // Running up the page, rotated 90° anticlockwise.
    const item = {
      str: 'abcd',
      transform: [0, 10, -10, 0, 300, 400],
      width: 40,
      height: 10,
    }
    const rect = rangeRect(item, 0, 4, viewport)
    expect(rect.w * 595).toBeCloseTo(10)
    expect(rect.h * 842).toBeCloseTo(40)
  })
})
