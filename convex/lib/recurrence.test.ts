import { describe, expect, test } from 'vitest'
import { dayKeyOf, timeKeyOf, zonedDateTimeToUtc } from './dates'
import {
  MAX_INTERVAL_COUNT,
  assertInterval,
  describeInterval,
  describeRepeat,
  intervalOf,
  occurrencesFrom,
} from './recurrence'
import type { Doc } from '../_generated/dataModel'

/**
 * The interval a Recurring Job repeats on (convex/lib/recurrence.ts): any
 * whole number of days, weeks, months or years, the calendar rules for
 * stepping one forward IN THE TENANT'S ZONE, and how a row written before the
 * custom-interval migration is read.
 */

const DAY = 24 * 60 * 60 * 1000
const PERTH = 'Australia/Perth' // UTC+8, no DST
const SYDNEY = 'Australia/Sydney' // UTC+10/+11, DST

/** An instant from a tenant-local wall clock, the way the app books one. */
function local(tz: string, dayKey: string, hh = 9, mm = 0): number {
  return zonedDateTimeToUtc(dayKey, hh, mm, tz)
}

/** What a tenant would read off the calendar for an instant. */
function reads(tz: string, ts: number): string {
  return `${dayKeyOf(ts, tz)} ${timeKeyOf(ts, tz)}`
}

const days = (tz: string, out: Array<number>) => out.map((t) => dayKeyOf(t, tz))

/** A stored row, as `intervalOf` reads one. */
function row(
  fields: Partial<Doc<'recurrences'>>,
): Pick<Doc<'recurrences'>, 'intervalCount' | 'intervalUnit' | 'frequency'> {
  return {
    intervalCount: fields.intervalCount,
    intervalUnit: fields.intervalUnit,
    frequency: fields.frequency,
  }
}

describe('reading a stored interval', () => {
  test('uses the interval fields when they are there', () => {
    expect(intervalOf(row({ intervalCount: 2, intervalUnit: 'week' }))).toEqual(
      {
        count: 2,
        unit: 'week',
      },
    )
  })

  test.each([
    ['monthly', { count: 1, unit: 'month' }],
    ['quarterly', { count: 3, unit: 'month' }],
    ['sixMonthly', { count: 6, unit: 'month' }],
    ['yearly', { count: 1, unit: 'year' }],
  ] as const)(
    'maps the retired %s enum onto the same shape',
    (frequency, expected) => {
      expect(intervalOf(row({ frequency }))).toEqual(expected)
    },
  )

  test('prefers the interval fields over a frequency left behind', () => {
    // The contract step of the migration has not run, so a backfilled row
    // carries both. The new fields are the truth.
    expect(
      intervalOf(
        row({ intervalCount: 15, intervalUnit: 'year', frequency: 'monthly' }),
      ),
    ).toEqual({ count: 15, unit: 'year' })
  })

  test('falls back to monthly rather than throwing on a row with neither', () => {
    // One malformed row must not take down every query that reads a series.
    expect(intervalOf(row({}))).toEqual({ count: 1, unit: 'month' })
  })
})

describe('what counts as an interval', () => {
  test.each([1, 2, 15, MAX_INTERVAL_COUNT])('accepts %i', (count) => {
    expect(() => assertInterval({ count, unit: 'day' })).not.toThrow()
  })

  test.each([0, -3, 2.5, Number.NaN, MAX_INTERVAL_COUNT + 1])(
    'refuses %p',
    (count) => {
      expect(() => assertInterval({ count, unit: 'day' })).toThrow()
    },
  )
})

describe('stepping the calendar forward', () => {
  test('every day, for a fortnight', () => {
    const anchor = local(PERTH, '2026-01-05')
    const out = occurrencesFrom(
      anchor,
      { count: 1, unit: 'day' },
      { timezone: PERTH, from: anchor, until: anchor + 13 * DAY },
    )
    expect(out).toHaveLength(14)
    expect(days(PERTH, out)[1]).toBe('2026-01-06')
    expect(days(PERTH, out)[13]).toBe('2026-01-18')
  })

  test('every 2 weeks keeps its weekday', () => {
    const anchor = local(PERTH, '2026-01-05') // a Monday
    const out = occurrencesFrom(
      anchor,
      { count: 2, unit: 'week' },
      { timezone: PERTH, from: anchor, until: local(PERTH, '2026-03-05') },
    )
    expect(days(PERTH, out)).toEqual([
      '2026-01-05',
      '2026-01-19',
      '2026-02-02',
      '2026-02-16',
      '2026-03-02',
    ])
  })

  test('every 3 months stays on the same date rather than drifting', () => {
    const anchor = local(PERTH, '2026-01-15')
    const out = occurrencesFrom(
      anchor,
      { count: 3, unit: 'month' },
      { timezone: PERTH, from: anchor, until: local(PERTH, '2026-12-31') },
    )
    expect(days(PERTH, out)).toEqual([
      '2026-01-15',
      '2026-04-15',
      '2026-07-15',
      '2026-10-15',
    ])
  })

  test('a 31st clamps to the last day of a short month', () => {
    const anchor = local(PERTH, '2026-01-31')
    const out = occurrencesFrom(
      anchor,
      { count: 1, unit: 'month' },
      { timezone: PERTH, from: anchor, until: local(PERTH, '2026-04-30') },
    )
    // Not 3 March: a naive step would roll a 31 Feb forward, which is how a
    // monthly service silently moves to the start of the next month.
    expect(days(PERTH, out)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
  })

  test('29 February clamps like a short month, not into 1 March', () => {
    const anchor = local(PERTH, '2028-02-29') // 2028 is a leap year
    const out = occurrencesFrom(
      anchor,
      { count: 1, unit: 'year' },
      { timezone: PERTH, from: anchor, until: local(PERTH, '2030-12-31') },
    )
    expect(days(PERTH, out)).toEqual(['2028-02-29', '2029-02-28', '2030-02-28'])
  })

  test('an interval whose next visit is past the window yields only the anchor', () => {
    // The 15-year warranty inspection: one visit now, nothing else inside the
    // engine's horizon. This is why the Recurring Job view counts series.
    const anchor = local(PERTH, '2026-01-05')
    const out = occurrencesFrom(
      anchor,
      { count: 15, unit: 'year' },
      { timezone: PERTH, from: anchor, until: anchor + 180 * DAY },
    )
    expect(days(PERTH, out)).toEqual(['2026-01-05'])
  })

  test('refuses an interval that would not advance', () => {
    const anchor = local(PERTH, '2026-01-05')
    expect(() =>
      occurrencesFrom(
        anchor,
        { count: 0, unit: 'day' },
        { timezone: PERTH, from: anchor, until: anchor + 365 * DAY },
      ),
    ).toThrow()
  })
})

/**
 * The tenant's calendar, not the server's. Convex runs in UTC, so an early
 * morning job in a positive-offset zone is stored on the PREVIOUS UTC day —
 * and stepping the UTC day-of-month through a short month pins it there.
 */
describe('repeats on the tenant’s own calendar', () => {
  test('an early-morning monthly service keeps its local date through February', () => {
    // 07:00 Perth on the 1st is 23:00Z on the 28th/29th/30th/31st. Stepping
    // UTC would give 1 Mar, then 29 Mar, 29 Apr, 29 May — never the 1st again.
    const anchor = local(PERTH, '2026-03-01', 7, 0)
    expect(dayKeyOf(anchor, 'UTC')).toBe('2026-02-28') // the trap, spelled out

    const out = occurrencesFrom(
      anchor,
      { count: 1, unit: 'month' },
      {
        timezone: PERTH,
        from: anchor,
        until: local(PERTH, '2026-08-01', 7, 0),
      },
    )
    expect(out.map((t) => reads(PERTH, t))).toEqual([
      '2026-03-01 07:00',
      '2026-04-01 07:00',
      '2026-05-01 07:00',
      '2026-06-01 07:00',
      '2026-07-01 07:00',
      '2026-08-01 07:00',
    ])
  })

  test('a weekly service keeps its wall-clock time across a DST transition', () => {
    // Sydney puts clocks forward on 4 Oct 2026. A fixed 7×24h step would slide
    // an 08:00 visit to 09:00 for the rest of the series.
    const anchor = local(SYDNEY, '2026-09-21', 8, 0)
    const out = occurrencesFrom(
      anchor,
      { count: 1, unit: 'week' },
      {
        timezone: SYDNEY,
        from: anchor,
        until: local(SYDNEY, '2026-10-19', 8, 0),
      },
    )
    expect(out.map((t) => reads(SYDNEY, t))).toEqual([
      '2026-09-21 08:00',
      '2026-09-28 08:00',
      '2026-10-05 08:00',
      '2026-10-12 08:00',
      '2026-10-19 08:00',
    ])
  })
})

/**
 * The window is what bounds the work, not the age of the series. This is the
 * one that bit: with the walk always starting at the anchor, a daily series
 * spent its whole iteration budget on occurrences in the past — under-filling
 * its horizon within a year and, once the anchor was `limit` days old,
 * projecting nothing at all, for ever, with no error anywhere.
 */
describe('finds the window however old the series is', () => {
  test.each([0, 250, 400, 4000])(
    'a daily series anchored %i days ago still fills the next 180',
    (age) => {
      const now = local(PERTH, '2026-06-01')
      const anchor = now - age * DAY
      const out = occurrencesFrom(
        anchor,
        { count: 1, unit: 'day' },
        { timezone: PERTH, from: now, until: now + 180 * DAY, limit: 400 },
      )
      expect(out).toHaveLength(181)
      expect(dayKeyOf(out[0], PERTH)).toBe('2026-06-01')
      expect(out.every((t) => t >= now)).toBe(true)
    },
  )

  test('a fortnightly series anchored eight years ago is still on its weekday', () => {
    const now = local(PERTH, '2026-06-01') // a Monday
    const anchor = now - 8 * 365 * DAY
    const out = occurrencesFrom(
      anchor,
      { count: 2, unit: 'week' },
      { timezone: PERTH, from: now, until: now + 60 * DAY },
    )
    expect(out.length).toBeGreaterThan(3)
    // Every visit lands on the anchor's weekday and 14 days apart.
    const weekday = new Date(anchor).getUTCDay()
    expect(out.every((t) => new Date(t).getUTCDay() === weekday)).toBe(true)
    for (let i = 1; i < out.length; i++) {
      expect(out[i] - out[i - 1]).toBe(14 * DAY)
    }
  })

  test('nothing before `from` is ever returned', () => {
    const now = local(PERTH, '2026-06-01')
    const anchor = local(PERTH, '2020-01-15')
    const out = occurrencesFrom(
      anchor,
      { count: 1, unit: 'month' },
      { timezone: PERTH, from: now, until: now + 90 * DAY },
    )
    expect(out.every((t) => t >= now)).toBe(true)
    expect(days(PERTH, out)).toEqual(['2026-06-15', '2026-07-15', '2026-08-15'])
  })

  test('the limit caps one call and the next call resumes where it stopped', () => {
    const now = local(PERTH, '2026-06-01')
    const anchor = now
    const first = occurrencesFrom(
      anchor,
      { count: 1, unit: 'day' },
      { timezone: PERTH, from: now, until: now + 180 * DAY, limit: 60 },
    )
    expect(first).toHaveLength(60)

    // Resuming from just after the last one yields the REST of the horizon —
    // no hole, which is the promise materialiseOne makes to the cron.
    const rest = occurrencesFrom(
      anchor,
      { count: 1, unit: 'day' },
      {
        timezone: PERTH,
        from: first[59] + 1,
        until: now + 180 * DAY,
        limit: 400,
      },
    )
    expect(rest).toHaveLength(121)
    expect(rest[0]).toBe(first[59] + DAY)
    expect(first.length + rest.length).toBe(181)
  })

  test('an empty or inverted window returns nothing rather than looping', () => {
    const now = local(PERTH, '2026-06-01')
    expect(
      occurrencesFrom(
        now,
        { count: 1, unit: 'day' },
        { timezone: PERTH, from: now, until: now - DAY },
      ),
    ).toEqual([])
  })
})

describe('saying an interval out loud', () => {
  test.each([
    [{ count: 1, unit: 'day' }, 'Every day'],
    [{ count: 2, unit: 'day' }, 'Every 2 days'],
    [{ count: 1, unit: 'week' }, 'Every week'],
    [{ count: 3, unit: 'month' }, 'Every 3 months'],
    [{ count: 15, unit: 'year' }, 'Every 15 years'],
  ] as const)('%p reads as "%s"', (interval, expected) => {
    expect(describeInterval(interval)).toBe(expected)
  })

  test('the sentence form lower-cases the phrase inside it', () => {
    expect(describeRepeat({ count: 2, unit: 'week' })).toBe(
      'Repeats every 2 weeks',
    )
  })
})
