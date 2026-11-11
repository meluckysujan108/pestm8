import { describe, expect, test } from 'vitest'
import {
  ageBandOf,
  bucketIndex,
  bucketStarts,
  comparisonRange,
  daysBetween,
  grainFor,
  isRealDayKey,
  isValidRange,
  rangeDays,
} from './analyticsRange'

describe('a range of days', () => {
  test('counts both its ends', () => {
    expect(rangeDays({ from: '2026-11-01', to: '2026-11-01' })).toBe(1)
    expect(rangeDays({ from: '2026-10-13', to: '2026-11-11' })).toBe(30)
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
  })

  test('is refused when a day is not a day, the ends are swapped, or it is longer than a year', () => {
    expect(isRealDayKey('2026-02-30')).toBe(false)
    expect(isRealDayKey('2026-2-3')).toBe(false)
    expect(isRealDayKey('2028-02-29')).toBe(true)
    expect(isValidRange({ from: '2026-11-11', to: '2026-11-01' })).toBe(false)
    expect(isValidRange({ from: '2025-11-11', to: '2026-11-11' })).toBe(true)
    expect(isValidRange({ from: '2025-11-10', to: '2026-11-11' })).toBe(false)
  })
})

describe('what a range is compared with', () => {
  test('the days before are as many days, ending the day before it starts', () => {
    expect(
      comparisonRange({ from: '2026-10-13', to: '2026-11-11' }, 'previous'),
    ).toEqual({ from: '2026-09-13', to: '2026-10-12' })
  })

  test('a year earlier is the same dates, with 29 February as the 28th', () => {
    expect(
      comparisonRange({ from: '2026-07-01', to: '2026-09-30' }, 'year'),
    ).toEqual({ from: '2025-07-01', to: '2025-09-30' })
    expect(
      comparisonRange({ from: '2028-02-01', to: '2028-02-29' }, 'year'),
    ).toEqual({ from: '2027-02-01', to: '2027-02-28' })
  })

  test('nothing, when asked for nothing', () => {
    expect(
      comparisonRange({ from: '2026-10-13', to: '2026-11-11' }, 'none'),
    ).toBeNull()
  })
})

describe('the points of a chart', () => {
  test('are days up to a month, weeks up to four months, then months', () => {
    expect(grainFor(1)).toBe('day')
    expect(grainFor(31)).toBe('day')
    expect(grainFor(32)).toBe('week')
    expect(grainFor(124)).toBe('week')
    expect(grainFor(125)).toBe('month')
  })

  test('weeks are counted from the first day, so the range before cuts the same way', () => {
    const range = { from: '2026-08-05', to: '2026-10-06' }
    const starts = bucketStarts(range, 'week')
    expect(starts.slice(0, 2)).toEqual(['2026-08-05', '2026-08-12'])
    expect(starts).toHaveLength(9)
    expect(bucketIndex(range, 'week', '2026-08-11')).toBe(0)
    expect(bucketIndex(range, 'week', '2026-08-12')).toBe(1)
    expect(bucketIndex(range, 'week', '2026-10-06')).toBe(8)
  })

  test('months follow the calendar across a new year', () => {
    const range = { from: '2026-11-15', to: '2027-02-10' }
    expect(bucketStarts(range, 'month')).toEqual([
      '2026-11-15',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ])
    expect(bucketIndex(range, 'month', '2026-11-30')).toBe(0)
    expect(bucketIndex(range, 'month', '2027-01-20')).toBe(2)
  })
})

test('finished work is banded by how long it has waited', () => {
  expect(ageBandOf(-3)).toBe('week')
  expect(ageBandOf(7)).toBe('week')
  expect(ageBandOf(8)).toBe('fortnight')
  expect(ageBandOf(15)).toBe('month')
  expect(ageBandOf(31)).toBe('older')
})
