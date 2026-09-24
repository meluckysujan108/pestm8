import { describe, expect, test } from 'vitest'
import {
  MAX_RECENT,
  MAX_USUAL,
  OPTION_SET_KEYS,
  OPTION_SET_LABELS,
  defaultOptionSet,
  rememberedOrder,
  usualOrder,
} from './optionLibraries'
import { optionSetKeySchema } from './customTemplateSchema'
import { optionSetKey } from '../../../convex/schema'

/**
 * The vocabularies a business owns, and the order a picker offers them in.
 *
 * Two separate promises. The settings screen must be able to reach every list
 * the forms draw on — a key missing from `OPTION_SET_KEYS` is a list no owner
 * can ever edit, and nothing would say so. And a picker must put the handful
 * this business reaches for above the thirteen it does not, without ever
 * showing the same option twice or growing into a second list.
 */

describe('the settings screen reaches every list', () => {
  test('every key in the union is listed exactly once', () => {
    // `OPTION_SET_LABELS` is `Record<OptionSetKey, string>`, so the compiler
    // already refuses a missing key there; this is the other direction — a
    // key the settings screen forgets to list is a list no owner can edit.
    expect([...OPTION_SET_KEYS].sort()).toEqual(
      Object.keys(OPTION_SET_LABELS).sort(),
    )
    expect(new Set(OPTION_SET_KEYS).size).toBe(OPTION_SET_KEYS.length)
  })

  test('the three hand-written copies of the union still agree', () => {
    // The TypeScript union, the Convex validator and the zod enum for
    // business-authored templates are mirrored by hand, and nothing in the
    // build connects them. A key added to one and forgotten in another fails
    // at the edge — a custom template that will not validate, or a mutation
    // that refuses a key the app just offered.
    const expected = [...OPTION_SET_KEYS].sort()
    expect([...optionSetKeySchema.options].sort()).toEqual(expected)
    expect(optionSetKey.members.map((member) => member.value).sort()).toEqual(
      expected,
    )
  })

  test('every listed key has a name and a default list behind it', () => {
    for (const key of OPTION_SET_KEYS) {
      expect(OPTION_SET_LABELS[key], key).toBeTruthy()
      // A key with no built-in binding is a vocabulary no form asks for — the
      // settings screen would show an empty card no owner could explain.
      expect(defaultOptionSet(key)?.options.length ?? 0, key).toBeGreaterThan(0)
    }
  })

  test('the list a technician opens weekly comes first', () => {
    // Editorial, and pinned because it is the kind of thing an alphabetical
    // sort quietly undoes.
    expect(OPTION_SET_KEYS[0]).toBe('products')
    expect(OPTION_SET_KEYS.at(-1)).toBe('topography')
  })
})

describe('what a picker offers first', () => {
  test("the business's own marks come before this member's habits", () => {
    expect(usualOrder(['Fipforce HP'], ['Stardust Pro'])).toEqual([
      'Fipforce HP',
      'Stardust Pro',
    ])
  })

  test('an option both marked and recently used appears once', () => {
    expect(
      usualOrder(['Fipforce HP'], ['Fipforce HP', 'Stardust Pro']),
    ).toEqual(['Fipforce HP', 'Stardust Pro'])
  })

  test('the group stays small enough to be a glance', () => {
    const flagged = Array.from({ length: 6 }, (_, i) => `flagged-${i}`)
    const recent = Array.from({ length: 5 }, (_, i) => `recent-${i}`)
    const order = usualOrder(flagged, recent)
    expect(order).toHaveLength(MAX_USUAL)
    // And the business's own marks are the ones that survive the cut.
    expect(order.slice(0, 6)).toEqual(flagged)
  })

  test('no preference is no group, not an empty one', () => {
    expect(usualOrder([], [])).toEqual([])
  })
})

describe('what this member last reached for', () => {
  test('the newest choice leads', () => {
    expect(rememberedOrder(['A', 'B'], ['C'])).toEqual(['C', 'A', 'B'])
  })

  test('reaching for the same thing again moves it up, it does not repeat it', () => {
    expect(rememberedOrder(['A', 'B', 'C'], ['C'])).toEqual(['C', 'A', 'B'])
  })

  test('a whole checklist is remembered in the order it was ticked', () => {
    expect(rememberedOrder(['A'], ['B', 'C'])).toEqual(['B', 'C', 'A'])
  })

  test('it never grows past five, however many reports get filled', () => {
    let recent: Array<string> = []
    for (let i = 0; i < 40; i++)
      recent = rememberedOrder(recent, [`option-${i}`])
    expect(recent).toHaveLength(MAX_RECENT)
    expect(recent[0]).toBe('option-39')
  })
})
