import { describe, expect, test } from 'vitest'
import { formatJobDate, formatTimeRange } from './format'

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
