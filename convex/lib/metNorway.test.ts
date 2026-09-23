import { describe, expect, test } from 'vitest'
import { dailyFromMetNorway, symbolToWmo } from './metNorway'
import type { MetTimestep } from './metNorway'

const PERTH = 'Australia/Perth'

/** One step at a UTC time. Rain and symbol for the hour after it (`one`), or
 * the six after it (`six`). */
function step(
  iso: string,
  temp: number,
  windMs: number,
  periods: {
    one?: { mm?: number; symbol?: string }
    six?: { mm?: number; symbol?: string }
  } = {},
): MetTimestep {
  const period = (p?: { mm?: number; symbol?: string }) =>
    p && {
      summary: p.symbol ? { symbol_code: p.symbol } : undefined,
      details: p.mm === undefined ? undefined : { precipitation_amount: p.mm },
    }
  return {
    time: iso,
    data: {
      instant: { details: { air_temperature: temp, wind_speed: windMs } },
      next_1_hours: period(periods.one),
      next_6_hours: period(periods.six),
    },
  }
}

describe("reading MET Norway's forecast as the card's days", () => {
  test('a day is its own hours in the tenant’s zone, not UTC’s', () => {
    // 15:00 UTC is 23:00 in Perth on the 25th; 16:00 UTC is midnight, the 26th.
    const days = dailyFromMetNorway(
      [step('2026-09-25T15:00:00Z', 14, 2), step('2026-09-25T16:00:00Z', 9, 1)],
      PERTH,
      ['2026-09-25', '2026-09-26'],
    )
    expect(days.map(([d, w]) => [d, w.maxTempC])).toEqual([
      ['2026-09-25', 14],
      ['2026-09-26', 9],
    ])
  })

  test('highest and lowest temperature, and the strongest wind in km/h', () => {
    const [[, day]] = dailyFromMetNorway(
      [
        step('2026-09-25T00:00:00Z', 12, 2),
        step('2026-09-25T01:00:00Z', 19.5, 6.25),
        step('2026-09-25T02:00:00Z', 16, 3),
      ],
      PERTH,
      ['2026-09-25'],
    )
    expect(day).toMatchObject({ maxTempC: 19.5, minTempC: 12, windKmh: 22.5 })
  })

  test('rain is counted once where the 1- and 6-hour totals overlap', () => {
    const [[, day]] = dailyFromMetNorway(
      [
        // Hourly steps each carry the hour AND the six hours after them.
        step('2026-09-25T00:00:00Z', 15, 2, {
          one: { mm: 0.4 },
          six: { mm: 3 },
        }),
        step('2026-09-25T01:00:00Z', 15, 2, {
          one: { mm: 0.6 },
          six: { mm: 2.8 },
        }),
        // The last hourly step: the next is six hours on, so its six count.
        step('2026-09-25T02:00:00Z', 15, 2, {
          one: { mm: 0.2 },
          six: { mm: 1 },
        }),
        step('2026-09-25T08:00:00Z', 15, 2, { six: { mm: 2 } }),
      ],
      PERTH,
      ['2026-09-25'],
    )
    expect(day.rainMm).toBe(4) // 0.4 + 0.6 + 1 + 2
  })

  test('a day takes its worst weather, as the WMO code the glyph draws', () => {
    const [[, day]] = dailyFromMetNorway(
      [
        step('2026-09-25T00:00:00Z', 15, 2, { one: { symbol: 'fair_day' } }),
        step('2026-09-25T01:00:00Z', 15, 2, {
          one: { symbol: 'lightrainshowers_day' },
        }),
        step('2026-09-25T02:00:00Z', 15, 2, { one: { symbol: 'cloudy' } }),
      ],
      PERTH,
      ['2026-09-25'],
    )
    expect(day.code).toBe(80)
  })

  test('days beyond the forecast are left out, not made up', () => {
    const days = dailyFromMetNorway(
      [step('2026-09-25T00:00:00Z', 15, 2)],
      PERTH,
      ['2026-09-25', '2026-10-09'],
    )
    expect(days.map(([d]) => d)).toEqual(['2026-09-25'])
  })

  test('no rain figure at all is not the same as none forecast', () => {
    const [[, day]] = dailyFromMetNorway(
      [step('2026-09-25T00:00:00Z', 15, 2)],
      PERTH,
      ['2026-09-25'],
    )
    expect(day.rainMm).toBeUndefined()
  })
})

describe('MET symbols as WMO weather codes', () => {
  test.each([
    ['clearsky_day', 0],
    ['fair_night', 1],
    ['partlycloudy_day', 2],
    ['cloudy', 3],
    ['fog', 45],
    ['lightrain', 61],
    ['rain', 63],
    ['heavyrain', 65],
    ['rainshowers_day', 81],
    ['heavyrainshowersandthunder_day', 95],
    ['snow', 73],
  ])('%s is %i', (symbol, code) => {
    expect(symbolToWmo(symbol)).toBe(code)
  })
})
