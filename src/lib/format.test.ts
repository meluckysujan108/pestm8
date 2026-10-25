import { describe, expect, test } from 'vitest'
import {
  formatJobDate,
  formatTimeRange,
  formatUpdated,
  formatWhen,
} from './format'

const PERTH = 'Australia/Perth'
const SYDNEY = 'Australia/Sydney'

/** An instant given as wall-clock time in a zone's fixed offset. */
function at(iso: string, offset: string): number {
  return Date.parse(`${iso}${offset}`)
}

describe('the date a job is booked for', () => {
  test('weekday, day and month, with no comma', () => {
    expect(formatJobDate('2026-09-25', '2026-09-24')).toBe('Fri 25 Sept')
  })

  test('says the year only when it is not this year', () => {
    expect(formatJobDate('2027-01-08', '2026-12-30')).toBe('Fri 8 Jan 2027')
    expect(formatJobDate('2025-12-30', '2026-01-02')).toBe('Tue 30 Dec 2025')
  })

  test('keeps the months en-AU writes in full', () => {
    expect(formatJobDate('2026-06-02', '2026-01-01')).toBe('Tue 2 June')
    expect(formatJobDate('2026-07-14', '2026-01-01')).toBe('Tue 14 July')
  })
})

describe('the time a job runs', () => {
  test('a job within one day', () => {
    expect(formatTimeRange(at('2026-09-25T09:30', '+08:00'), 45, PERTH)).toBe(
      '9:30am – 10:15am · 45 min',
    )
  })

  test('a job that runs past midnight names the day it ends', () => {
    expect(formatTimeRange(at('2026-09-25T23:00', '+08:00'), 120, PERTH)).toBe(
      '11:00pm – Sat 1:00am · 2 hr',
    )
  })

  test('an end exactly at midnight is still that day’s', () => {
    expect(formatTimeRange(at('2026-09-25T23:00', '+08:00'), 60, PERTH)).toBe(
      '11:00pm – 12:00am · 1 hr',
    )
  })

  test('a job starting at midnight with no length stays on its day', () => {
    expect(formatTimeRange(at('2026-09-25T00:00', '+08:00'), 0, PERTH)).toBe(
      '12:00am – 12:00am · 0 min',
    )
  })

  test('in the tenant’s own zone, across daylight saving', () => {
    // Sydney moves to AEDT (+11) on the first Sunday in October 2026.
    expect(formatTimeRange(at('2026-10-05T08:00', '+11:00'), 90, SYDNEY)).toBe(
      '8:00am – 9:30am · 1 hr 30 min',
    )
  })
})

describe('the moment something happened', () => {
  test('is said in the business’s zone, not the reader’s', () => {
    const sent = at('2020-09-01T09:30:00', '+08:00')
    expect(formatWhen(sent, PERTH)).toBe('Tue 1 Sept 2020, 9:30am')
    expect(formatWhen(sent, SYDNEY)).toBe('Tue 1 Sept 2020, 11:30am')
  })

  test('crosses midnight with the zone', () => {
    const late = at('2020-09-01T23:30:00', '+08:00')
    expect(formatWhen(late, SYDNEY)).toBe('Wed 2 Sept 2020, 1:30am')
  })
})

describe('when what is on screen was last known right', () => {
  test('the time alone on the day given as today', () => {
    const at942 = at('2026-10-25T09:42', '+08:00')
    expect(formatUpdated(at942, PERTH, '2026-10-25')).toBe('9:42am')
  })

  test('the day as well when it was another, from the day given, not the clock', () => {
    const at942 = at('2026-10-25T09:42', '+08:00')
    expect(formatUpdated(at942, PERTH, '2026-10-26')).toBe('Sun 25 Oct, 9:42am')
    expect(formatUpdated(at942, PERTH, '2027-01-04')).toBe(
      'Sun 25 Oct 2026, 9:42am',
    )
  })

  test('in the business’s zone: late in Perth is the next day in Sydney', () => {
    const late = at('2026-10-25T23:30', '+08:00')
    expect(formatUpdated(late, PERTH, '2026-10-25')).toBe('11:30pm')
    expect(formatUpdated(late, SYDNEY, '2026-10-25')).toBe('Mon 26 Oct, 2:30am')
  })
})
