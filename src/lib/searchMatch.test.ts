import { describe, expect, test, vi } from 'vitest'
import {
  decideDetails,
  filterByWords,
  joinDetails,
  orderedMatches,
  startsFirst,
  withSearchKeys,
} from './searchMatch'

/**
 * A picker's search (lib/searchMatch.ts) past the words of each row: keys
 * worked out once, rows a lookup puts first, and a row's extra line decided
 * as it first shows.
 */

const ROWS = [
  withSearchKeys({
    value: 'p-harbour',
    label: 'Josh Harbour — 12 Harvey St, Perth',
    searchText: 'Josh Harbour 12 Harvey St Perth 0491570156',
  }),
  withSearchKeys({
    value: 'p-strata',
    label: 'Harbourside Strata — 1 Riverside Dr, East Perth',
  }),
  withSearchKeys({
    value: 'p-jane',
    label: 'Jane Nguyen — 12 Wattle St, Bayswater',
    searchText: 'Jane Nguyen 12 Wattle St Bayswater 6053 55504321',
  }),
]

describe('search keys worked out as the options are built', () => {
  test('searched as the words were, with no searchText kept', () => {
    expect(ROWS[0]).not.toHaveProperty('searchText')
    expect(ROWS[0].searchKey).toBe('josh harbour 12 harvey st perth 0491570156')
    expect(ROWS[1].labelKey).toBe(
      'harbourside strata 1 riverside dr east perth',
    )
    expect(
      filterByWords(ROWS, 'WATTLE, bayswater').map((r) => r.value),
    ).toEqual(['p-jane'])
    expect(startsFirst(filterByWords(ROWS, 'harb'), 'harb')[0].value).toBe(
      'p-strata',
    )
  })

  test('a row built without keys is still found', () => {
    const plain = [{ value: 'gpc', label: 'General Pest Control' }]
    expect(filterByWords(plain, 'pest').map((r) => r.value)).toEqual(['gpc'])
  })
})

describe('the rows a query lists (`orderedMatches`)', () => {
  test('a lookup’s rows first, whether or not their words match, then the rest', () => {
    // Saved as "5550 4321", "08 5550 4321" is not found by its words (no
    // "08"): only the index finds Jane, and her site leads.
    expect(
      orderedMatches(ROWS, '08 5550 4321', ['p-jane']).map((r) => r.value),
    ).toEqual(['p-jane'])
    expect(
      orderedMatches(ROWS, 'harb', ['p-jane']).map((r) => r.value),
    ).toEqual(['p-jane', 'p-strata', 'p-harbour'])
  })

  test('a row the lookup names and the words find is listed once', () => {
    expect(
      orderedMatches(ROWS, 'harbour', ['p-harbour']).map((r) => r.value),
    ).toEqual(['p-harbour', 'p-strata'])
  })

  test('a lookup naming a row the list doesn’t have adds nothing', () => {
    expect(
      orderedMatches(ROWS, 'jane', ['p-gone']).map((r) => r.value),
    ).toEqual(['p-jane'])
  })

  test('nothing typed: every row, in the order given', () => {
    expect(orderedMatches(ROWS, '  ').map((r) => r.value)).toEqual([
      'p-harbour',
      'p-strata',
      'p-jane',
    ])
  })
})

describe('a row’s extra line, decided as it first shows (`decideDetails`)', () => {
  test('decided at open for the rows shown, and unchanged by a later push', () => {
    let booked = 'Booked Thu 30 Oct'
    const detailOf = vi.fn((value: string) =>
      value === 'p-jane' ? booked : undefined,
    )
    const opened = decideDetails(new Map(), ['p-harbour', 'p-jane'], detailOf)
    expect(opened.get('p-jane')).toBe('Booked Thu 30 Oct')
    expect(opened.get('p-harbour')).toBeUndefined()
    expect(opened.has('p-harbour')).toBe(true)

    // What is booked there changes while the sheet is open: the row says
    // what it said, and nothing is asked again.
    booked = 'Booked Fri 31 Oct'
    detailOf.mockClear()
    expect(decideDetails(opened, ['p-harbour', 'p-jane'], detailOf)).toBe(
      opened,
    )
    expect(detailOf).not.toHaveBeenCalled()
  })

  test('a row that comes into view later is decided then, and only it', () => {
    const detailOf = vi.fn(() => 'Last visit Wed 15 Oct')
    const opened = decideDetails(new Map(), ['p-jane'], detailOf)
    const later = decideDetails(opened, ['p-strata', 'p-jane'], detailOf)
    expect(detailOf).toHaveBeenCalledTimes(2)
    expect(detailOf).toHaveBeenLastCalledWith('p-strata')
    expect(later.get('p-strata')).toBe('Last visit Wed 15 Oct')
  })

  test('joined before the option’s own line, with a spaced dot', () => {
    expect(joinDetails('Booked Thu 30 Oct', 'Added Tue 29 Sept')).toBe(
      'Booked Thu 30 Oct · Added Tue 29 Sept',
    )
    expect(joinDetails(undefined, 'Added Tue 29 Sept')).toBe(
      'Added Tue 29 Sept',
    )
    expect(joinDetails('Booked Thu 30 Oct', undefined)).toBe(
      'Booked Thu 30 Oct',
    )
    expect(joinDetails(undefined, undefined)).toBeUndefined()
  })
})
