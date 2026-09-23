import { describe, expect, test } from 'vitest'
import {
  dayPhase,
  describeDayLoad,
  splitDayRows,
  weekDayKeys,
  weekTotals,
} from './weekView'
import { formatShortDayLabel, formatWeekRange } from './format'
import type { JobStatus } from '../../convex/lib/jobStatus'

const PERTH = 'Australia/Perth'
const at = (iso: string) => Date.parse(`${iso}+08:00`)
const row = (id: string, status: JobStatus, when: string) => ({
  _id: id,
  status,
  scheduledAt: at(when),
})

describe('the week', () => {
  test('is seven days from the strip’s Monday, across a month end', () => {
    expect(weekDayKeys('2026-09-28')).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ])
  })

  test('each day has arrived, is today, or is ahead', () => {
    expect(dayPhase('2026-09-22', '2026-09-23')).toBe('past')
    expect(dayPhase('2026-09-23', '2026-09-23')).toBe('today')
    expect(dayPhase('2026-09-24', '2026-09-23')).toBe('future')
  })
})

describe('splitting a day’s rows', () => {
  const rows = [
    row('booked', 'booked', '2026-09-23T09:00:00'),
    row('done', 'completed', '2026-09-23T11:00:00'),
    row('due', 'recurring', '2026-09-23T14:00:00'),
    row('carried', 'recurring', '2026-09-19T09:00:00'),
  ]
  const split = splitDayRows(rows, '2026-09-23', PERTH)

  test('booked work, this day’s projections, and projections carried from earlier days', () => {
    expect(split.committed.map((r) => r._id)).toEqual(['booked', 'done'])
    expect(split.dueHere.map((r) => r._id)).toEqual(['due'])
    expect(split.carried.map((r) => r._id)).toEqual(['carried'])
  })

  test('is a partition: nothing dropped, nothing in two places', () => {
    const all = [...split.committed, ...split.dueHere, ...split.carried]
    expect(all.map((r) => r._id).sort()).toEqual(rows.map((r) => r._id).sort())
    expect(new Set(all).size).toBe(rows.length)
  })

  test("'this day' is the tenant's day: 00:30 Perth belongs to it though UTC says yesterday", () => {
    const early = [row('early', 'recurring', '2026-09-23T00:30:00')]
    expect(splitDayRows(early, '2026-09-23', PERTH).dueHere).toHaveLength(1)
  })
})

describe('the two numbers', () => {
  test('are totalled apart, never summed into one', () => {
    expect(
      weekTotals([
        { count: 3, recurringCount: 1 },
        { count: 0, recurringCount: 2 },
        { count: 2 },
      ]),
    ).toEqual({ jobs: 5, recurring: 3 })
  })

  test('read aloud as what they are on each kind of day', () => {
    expect(describeDayLoad({ count: 3, recurringCount: 0 }, 'future')).toBe(
      '3 jobs',
    )
    expect(describeDayLoad({ count: 1, recurringCount: 2 }, 'future')).toBe(
      '1 job, 2 recurring visits not yet booked',
    )
    expect(describeDayLoad({ count: 0, recurringCount: 1 }, 'today')).toBe(
      '0 jobs, 1 recurring visit due',
    )
    expect(describeDayLoad({ count: 2, recurringCount: 1 }, 'past')).toBe(
      '2 jobs, 1 recurring visit overdue',
    )
  })
})

describe('naming a week', () => {
  test('within a month', () => {
    expect(formatWeekRange('2026-09-21')).toBe('21–27 September')
  })

  test('across a month', () => {
    expect(formatWeekRange('2026-09-28')).toBe('28 September – 4 October')
  })

  test('across a year', () => {
    expect(formatWeekRange('2026-12-28')).toBe(
      '28 December 2026 – 3 January 2027',
    )
  })

  test('a day inside it', () => {
    expect(formatShortDayLabel('2026-09-21')).toBe('Mon 21')
  })
})
