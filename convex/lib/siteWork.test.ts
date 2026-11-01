import { describe, expect, test } from 'vitest'
import { startOfDayInZone, zonedDateTimeToUtc } from './dates'
import {
  OPEN_WORK_DAYS_AHEAD,
  OPEN_WORK_DAYS_BACK,
  SITE_WINDOW_DAYS,
  isDayKey,
  isOpenStatus,
  openNear,
  openWorkCovers,
  openWorkDays,
  openWorkSpan,
  slotOf,
  slotShown,
} from './siteWork'

/**
 * The one rule the phone's double-booking check and the server's share:
 * what counts as open, which slot a visit holds, the days `jobs.openWork`
 * answers for, and what is near a booking.
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const PERTH = 'Australia/Perth'

describe('what counts as open', () => {
  test('booked by someone or projected by the engine, and nothing done or called off', () => {
    expect(['pending', 'booked', 'recurring'].map(isOpenStatus)).toEqual([
      true,
      true,
      true,
    ])
    expect(['completed', 'invoiced', 'cancelled'].map(isOpenStatus)).toEqual([
      false,
      false,
      false,
    ])
  })
})

describe('slotOf', () => {
  test('a visit keeps the slot it was projected onto when it is moved', () => {
    expect(slotOf({ scheduledAt: 2_000, occurrenceAt: 1_000 })).toBe(1_000)
  })

  test('anything else is in the slot it is booked for', () => {
    expect(slotOf({ scheduledAt: 2_000 })).toBe(2_000)
  })
})

describe('isDayKey', () => {
  test('a day that exists, written YYYY-MM-DD', () => {
    expect(isDayKey('2026-11-02')).toBe(true)
    expect(isDayKey('2028-02-29')).toBe(true)
  })

  test('never one that doesn’t, or is written any other way', () => {
    for (const key of [
      '2026-02-29',
      '2026-11-31',
      '2026-13-01',
      '2026-1-02',
      '20261102',
      '2026-11-02T00:00',
      '',
    ]) {
      expect(isDayKey(key), key).toBe(false)
    }
  })
})

describe('the days an answer covers', () => {
  test('four weeks back from its Monday and sixteen ahead', () => {
    expect(OPEN_WORK_DAYS_BACK).toBe(28)
    expect(OPEN_WORK_DAYS_AHEAD).toBe(112)
    expect(openWorkDays('2026-10-26')).toEqual({
      firstKey: '2026-09-28',
      endKey: '2027-02-15',
    })
  })

  test('from the first day up to, not including, the end', () => {
    expect(openWorkCovers('2026-10-26', '2026-09-28')).toBe(true)
    expect(openWorkCovers('2026-10-26', '2026-09-27')).toBe(false)
    expect(openWorkCovers('2026-10-26', '2027-02-14')).toBe(true)
    expect(openWorkCovers('2026-10-26', '2027-02-15')).toBe(false)
  })

  test('last week’s answer still covers this Monday, opened with no signal', () => {
    expect(openWorkCovers('2026-10-19', '2026-10-26')).toBe(true)
  })
})

describe('the slot someone else’s visit is told by (slotShown)', () => {
  const nine = (dayKey: string) => zonedDateTimeToUtc(dayKey, 9, 0, PERTH)
  const told = (slot: string, booked: string) =>
    slotShown(
      { occurrenceAt: nine(slot), scheduledAt: nine(booked) },
      '2026-10-26',
      PERTH,
    )

  test('its own slot while that is within the twenty weeks too, to their last day', () => {
    expect(told('2026-10-29', '2026-10-30')).toBe(nine('2026-10-29'))
    expect(told('2026-09-28', '2026-10-30')).toBe(nine('2026-09-28'))
    expect(told('2027-02-14', '2026-10-30')).toBe(nine('2027-02-14'))
  })

  test('when it is booked, once its slot is past them either side', () => {
    expect(told('2026-09-27', '2026-10-30')).toBe(nine('2026-10-30'))
    expect(told('2027-02-15', '2026-10-30')).toBe(nine('2026-10-30'))
  })

  test('a one-off is told by when it is booked, its only slot', () => {
    expect(
      slotShown({ scheduledAt: nine('2026-10-30') }, '2026-10-26', PERTH),
    ).toBe(nine('2026-10-30'))
  })
})

describe('openWorkSpan', () => {
  // Perth, Sydney (daylight saving starts 4 Oct 2026), and the zones
  // furthest ahead of UTC and behind it.
  test.each([
    PERTH,
    'Australia/Sydney',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
    'Etc/GMT+12',
    'UTC',
  ])(
    'every day the answer covers is whole in %s, and at most 26 hours more is read',
    (zone) => {
      for (const startKey of ['2026-09-28', '2026-10-05', '2027-03-29']) {
        const { firstKey, endKey } = openWorkDays(startKey)
        const { from, weekFrom, to } = openWorkSpan(startKey)
        const first = startOfDayInZone(firstKey, zone)
        const end = startOfDayInZone(endKey, zone)
        const week = startOfDayInZone(startKey, zone)

        expect(from).toBeLessThanOrEqual(first)
        expect(to).toBeGreaterThanOrEqual(end)
        expect(weekFrom).toBeLessThanOrEqual(week)
        // The 14 hours UTC+14 is ahead and the 12 UTC−12 is behind.
        expect(first - from).toBeLessThanOrEqual(26 * HOUR)
        expect(to - end).toBeLessThanOrEqual(26 * HOUR)
        expect(week - weekFrom).toBeLessThanOrEqual(26 * HOUR)
      }
    },
  )
})

describe('openNear', () => {
  const at = (dayKey: string, hh: number, mm = 0, zone = PERTH) =>
    zonedDateTimeToUtc(dayKey, hh, mm, zone)
  // Booking for Thursday 29 Oct 2026 at 8am, Perth.
  const booking = at('2026-10-29', 8)

  test('a week either side, inclusive, by the calendar rather than the hour', () => {
    expect(SITE_WINDOW_DAYS).toBe(7)
    const rows = [
      // Seven days on, though more than seven times 24 hours.
      { id: 'thu-after', scheduledAt: at('2026-11-05', 16) },
      // Eight days on, though less than eight times 24 hours.
      { id: 'fri-after', scheduledAt: at('2026-11-06', 7) },
      // Seven days before, late in the evening.
      { id: 'thu-before', scheduledAt: at('2026-10-22', 23, 30) },
      { id: 'wed-before', scheduledAt: at('2026-10-21', 23, 59) },
    ]
    expect(openNear(rows, booking, PERTH).map((r) => r.id)).toEqual([
      'thu-before',
      'thu-after',
    ])
  })

  test('only open work: someone else’s (no status) counts, anything done or cancelled doesn’t', () => {
    const scheduledAt = at('2026-10-30', 9)
    const rows = [
      { id: 'pending', scheduledAt, status: 'pending' },
      { id: 'booked', scheduledAt, status: 'booked' },
      { id: 'visit', scheduledAt, status: 'recurring' },
      { id: 'theirs', scheduledAt },
      { id: 'done', scheduledAt, status: 'completed' },
      { id: 'billed', scheduledAt, status: 'invoiced' },
      { id: 'off', scheduledAt, status: 'cancelled' },
    ]
    expect(openNear(rows, booking, PERTH).map((r) => r.id)).toEqual([
      'pending',
      'booked',
      'visit',
      'theirs',
    ])
  })

  test('nearest first, and of two as near the earlier', () => {
    const rows = [
      { id: 'in-3-days', scheduledAt: booking + 3 * DAY },
      { id: 'tomorrow', scheduledAt: booking + DAY },
      { id: 'yesterday', scheduledAt: booking - DAY },
      { id: 'same-day', scheduledAt: booking + 2 * 60 * 60 * 1000 },
    ]
    expect(openNear(rows, booking, PERTH).map((r) => r.id)).toEqual([
      'same-day',
      'yesterday',
      'tomorrow',
      'in-3-days',
    ])
  })

  test('by the business’s own days: a booking near midnight in Sydney', () => {
    const SYDNEY = 'Australia/Sydney'
    // 11:30pm on Saturday 3 Oct 2026, the night the clocks go forward.
    const late = at('2026-10-03', 23, 30, SYDNEY)
    const rows = [
      { id: 'sat-after', scheduledAt: at('2026-10-10', 23, 59, SYDNEY) },
      // In Perth this is still the Saturday; in Sydney it is eight days on.
      { id: 'sun-after', scheduledAt: at('2026-10-11', 0, 30, SYDNEY) },
    ]
    expect(openNear(rows, late, SYDNEY).map((r) => r.id)).toEqual(['sat-after'])
    expect(openNear(rows, late, PERTH).map((r) => r.id)).toEqual([
      'sat-after',
      'sun-after',
    ])
  })

  test('nothing when nothing is near', () => {
    expect(
      openNear([{ scheduledAt: booking + 30 * DAY }], booking, PERTH),
    ).toEqual([])
  })
})
