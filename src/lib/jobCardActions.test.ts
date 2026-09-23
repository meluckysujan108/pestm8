import { describe, expect, test } from 'vitest'
import { cardActionsFor, isOverdueProjection } from './jobCardActions'
import type { JobStatus } from '#/components/primitives/StatusPill'

const PERTH = 'Australia/Perth'

/** An instant given as Perth wall-clock time (UTC+8, no daylight saving). */
function perth(iso: string): number {
  return Date.parse(`${iso}+08:00`)
}

const NOW = perth('2026-09-23T10:00:00')

function job(status: JobStatus, at: string) {
  return { status, scheduledAt: perth(at) }
}

describe('what a job card offers besides opening the job', () => {
  test('committed work offers Call and Map, whatever stage it is at', () => {
    for (const status of [
      'pending',
      'booked',
      'completed',
      'invoiced',
    ] as const) {
      expect(
        cardActionsFor(job(status, '2026-09-23T14:00:00'), PERTH, NOW),
      ).toBe('visit')
    }
  })

  test('committed work on another day still offers them — the Job tab lists every day', () => {
    expect(
      cardActionsFor(job('booked', '2026-12-01T09:00:00'), PERTH, NOW),
    ).toBe('visit')
    expect(
      cardActionsFor(job('invoiced', '2026-06-01T09:00:00'), PERTH, NOW),
    ).toBe('visit')
  })

  test('a cancelled job offers nothing', () => {
    expect(
      cardActionsFor(job('cancelled', '2026-09-23T14:00:00'), PERTH, NOW),
    ).toBe('none')
  })

  test('a projection due today offers a call to book it, and no map', () => {
    expect(
      cardActionsFor(job('recurring', '2026-09-23T15:00:00'), PERTH, NOW),
    ).toBe('book')
  })

  test('an overdue projection carried onto today offers the same', () => {
    expect(
      cardActionsFor(job('recurring', '2026-09-19T09:00:00'), PERTH, NOW),
    ).toBe('book')
  })

  test('a projection whose day is still ahead offers nothing', () => {
    expect(
      cardActionsFor(job('recurring', '2026-09-24T09:00:00'), PERTH, NOW),
    ).toBe('none')
    expect(
      cardActionsFor(job('recurring', '2027-01-15T09:00:00'), PERTH, NOW),
    ).toBe('none')
  })

  test("'today' is the tenant's day, not UTC's", () => {
    // 07:00 Perth is still yesterday in UTC, and 20:00 Perth is today in both.
    // Compared as UTC days, the visit would look like tomorrow's.
    const early = perth('2026-09-23T07:00:00')
    expect(
      cardActionsFor(job('recurring', '2026-09-23T20:00:00'), PERTH, early),
    ).toBe('book')
    // And the other way: 00:30 Perth on the 24th is still the 23rd in UTC,
    // but it is tomorrow for the business.
    expect(
      cardActionsFor(job('recurring', '2026-09-24T00:30:00'), PERTH, NOW),
    ).toBe('none')
  })
})

describe('what counts as overdue', () => {
  test('a projection whose day has passed', () => {
    expect(
      isOverdueProjection(job('recurring', '2026-09-22T15:00:00'), PERTH, NOW),
    ).toBe(true)
  })

  test('not one due later today — due, and on the day, but not late', () => {
    expect(
      isOverdueProjection(job('recurring', '2026-09-23T15:00:00'), PERTH, NOW),
    ).toBe(false)
  })

  test('not committed work, however old', () => {
    expect(
      isOverdueProjection(job('booked', '2026-09-01T09:00:00'), PERTH, NOW),
    ).toBe(false)
  })

  test("the day turns over at the tenant's midnight, not UTC's", () => {
    // 23:59 Perth on the 22nd is the 22nd; one minute later it is overdue.
    const visit = job('recurring', '2026-09-22T23:59:00')
    expect(
      isOverdueProjection(visit, PERTH, perth('2026-09-22T23:59:30')),
    ).toBe(false)
    expect(
      isOverdueProjection(visit, PERTH, perth('2026-09-23T00:00:30')),
    ).toBe(true)
  })
})
