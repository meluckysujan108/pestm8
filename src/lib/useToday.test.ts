import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { nextToday, useToday } from './useToday'

/**
 * The schedule's today: the loader's until the page has hydrated, then the
 * phone's, in the business's time zone — which is where the day turns over,
 * not at the phone's or the server's midnight.
 */

describe('nextToday', () => {
  test('turns over at midnight in Perth, not at UTC midnight', () => {
    // Perth is UTC+8 all year: its midnight is 16:00 UTC the day before.
    expect(
      nextToday(Date.UTC(2026, 9, 25, 15, 59, 59, 999), 'Australia/Perth'),
    ).toBe('2026-10-25')
    expect(nextToday(Date.UTC(2026, 9, 25, 16), 'Australia/Perth')).toBe(
      '2026-10-26',
    )
    // UTC's own midnight is 8am in Perth, well into the day.
    expect(nextToday(Date.UTC(2026, 9, 26), 'Australia/Perth')).toBe(
      '2026-10-26',
    )
  })

  test('Brisbane turns over at the same hour in winter and summer', () => {
    // UTC+10 all year: Queensland has no daylight saving.
    const brisbane = 'Australia/Brisbane'
    expect(nextToday(Date.UTC(2026, 0, 14, 13, 59), brisbane)).toBe(
      '2026-01-14',
    )
    expect(nextToday(Date.UTC(2026, 0, 14, 14), brisbane)).toBe('2026-01-15')
    expect(nextToday(Date.UTC(2026, 6, 14, 13, 59), brisbane)).toBe(
      '2026-07-14',
    )
    expect(nextToday(Date.UTC(2026, 6, 14, 14), brisbane)).toBe('2026-07-15')
  })

  test('follows Sydney across the clocks going forward', () => {
    // Sunday 4 October 2026 is 23 hours long. It starts at 14:00 UTC on
    // the 3rd (AEST, UTC+10) and ends at 13:00 UTC on the 4th (AEDT, UTC+11).
    const sydney = 'Australia/Sydney'
    expect(nextToday(Date.UTC(2026, 9, 3, 13, 59), sydney)).toBe('2026-10-03')
    expect(nextToday(Date.UTC(2026, 9, 3, 14), sydney)).toBe('2026-10-04')
    expect(nextToday(Date.UTC(2026, 9, 4, 12, 59), sydney)).toBe('2026-10-04')
    expect(nextToday(Date.UTC(2026, 9, 4, 13), sydney)).toBe('2026-10-05')
  })

  test('and back', () => {
    // Sunday 4 April 2027 is 25 hours long: from 13:00 UTC on the 3rd
    // (AEDT) to 14:00 UTC on the 4th (AEST). A fixed 24 hours from its start
    // would call its last hour Monday.
    const sydney = 'Australia/Sydney'
    expect(nextToday(Date.UTC(2027, 3, 3, 12, 59), sydney)).toBe('2027-04-03')
    expect(nextToday(Date.UTC(2027, 3, 3, 13), sydney)).toBe('2027-04-04')
    expect(nextToday(Date.UTC(2027, 3, 4, 13, 59), sydney)).toBe('2027-04-04')
    expect(nextToday(Date.UTC(2027, 3, 4, 14), sydney)).toBe('2027-04-05')
  })
})

describe('useToday', () => {
  test('the first render is the loader’s day, whatever the clock says', () => {
    // A page the service worker kept from long ago: it must hydrate with
    // the day it was rendered with.
    function Probe() {
      return createElement(
        'span',
        null,
        useToday('Australia/Perth', '2020-01-01'),
      )
    }
    expect(renderToStaticMarkup(createElement(Probe))).toBe(
      '<span>2020-01-01</span>',
    )
  })
})
