import { describe, expect, test } from 'vitest'
import { dailyFromMetNorway, metCanForecast, symbolToWmo } from './metNorway'
import type { MetTimestep } from './metNorway'

const PERTH = 'Australia/Perth'
const HOUR = 3600_000
/** Perth's midnight starting 2026-09-25 (UTC+8, no daylight saving). */
const PERTH_25TH = Date.parse('2026-09-24T16:00:00Z')

type Period = { mm?: number; symbol?: string }

/** One step at an instant. Rain and symbol for the hour after it (`one`), or
 * the six after it (`six`). */
function step(
  at: number,
  temp: number,
  windMs: number,
  periods: { one?: Period; six?: Period } = {},
): MetTimestep {
  const period = (p?: Period) =>
    p && {
      summary: p.symbol ? { symbol_code: p.symbol } : undefined,
      details: p.mm === undefined ? undefined : { precipitation_amount: p.mm },
    }
  return {
    time: new Date(at).toISOString(),
    data: {
      instant: { details: { air_temperature: temp, wind_speed: windMs } },
      next_1_hours: period(periods.one),
      next_6_hours: period(periods.six),
    },
  }
}

/** `count` hourly steps from `from`, each with an hour's (dry) period unless
 * `make` says otherwise. */
function hourly(
  from: number,
  count: number,
  make: (i: number, at: number) => MetTimestep = (_, at) =>
    step(at, 15, 2, { one: { mm: 0 } }),
): Array<MetTimestep> {
  return Array.from({ length: count }, (_, i) => make(i, from + i * HOUR))
}

describe("reading MET Norway's forecast as the card's days", () => {
  test('a day is its own hours in the tenant’s zone, not UTC’s', () => {
    // Two Perth days, 20° all through the 25th and 10° all through the 26th.
    // By UTC's day the 25th would take in eight hours of the 26th's 10°.
    const days = dailyFromMetNorway(
      hourly(PERTH_25TH, 48, (i, at) =>
        step(at, i < 24 ? 20 : 10, 2, { one: { mm: 0 } }),
      ),
      PERTH,
      ['2026-09-25', '2026-09-26'],
    )
    expect(days.map(([d, w]) => [d, w.minTempC, w.maxTempC])).toEqual([
      ['2026-09-25', 20, 20],
      ['2026-09-26', 10, 10],
    ])
  })

  test('highest and lowest temperature, and the strongest wind in km/h', () => {
    const [[, day]] = dailyFromMetNorway(
      hourly(PERTH_25TH, 24, (i, at) =>
        step(at, [12, 19.5][i] ?? 16, i === 1 ? 6.25 : 3, { one: { mm: 0 } }),
      ),
      PERTH,
      ['2026-09-25'],
    )
    expect(day).toMatchObject({ maxTempC: 19.5, minTempC: 12, windKmh: 22.5 })
  })

  test('rain is counted once where the 1- and 6-hour totals overlap', () => {
    const at = (h: number) => PERTH_25TH + h * HOUR
    const [[, day]] = dailyFromMetNorway(
      [
        // Hourly steps each carry the hour AND the six hours after them.
        step(at(0), 15, 2, { one: { mm: 0.4 }, six: { mm: 3 } }),
        step(at(1), 15, 2, { one: { mm: 0.6 }, six: { mm: 2.8 } }),
        // The last hourly step: the next is six hours on, so its six count.
        step(at(2), 15, 2, { one: { mm: 0.2 }, six: { mm: 1 } }),
        step(at(8), 15, 2, { six: { mm: 2 } }),
        step(at(14), 15, 2, { six: { mm: 0 } }),
        step(at(20), 15, 2, { six: { mm: 0 } }),
      ],
      PERTH,
      ['2026-09-25'],
    )
    expect(day.rainMm).toBe(4) // 0.4 + 0.6 + 1 + 2
  })

  test('a six-hour total already counted is not counted again by the hours inside it', () => {
    // A step with only its six hours (6 mm), then hourly steps inside them.
    const [[, day]] = dailyFromMetNorway(
      hourly(PERTH_25TH, 24, (i, at) =>
        i === 0
          ? step(at, 15, 2, { six: { mm: 6 } })
          : step(at, 15, 2, { one: { mm: i < 6 ? 1 : 0 } }),
      ),
      PERTH,
      ['2026-09-25'],
    )
    expect(day.rainMm).toBe(6)
  })

  test('a day takes its worst weather, as the WMO code the glyph draws', () => {
    const symbols = ['fair_day', 'lightrainshowers_day', 'cloudy']
    const [[, day]] = dailyFromMetNorway(
      hourly(PERTH_25TH, 24, (i, at) =>
        step(at, 15, 2, { one: { mm: 0, symbol: symbols[i % 3] } }),
      ),
      PERTH,
      ['2026-09-25'],
    )
    expect(day.code).toBe(80)
  })

  test('days beyond the forecast are left out, not made up', () => {
    const days = dailyFromMetNorway(hourly(PERTH_25TH, 24), PERTH, [
      '2026-09-25',
      '2026-10-09',
    ])
    expect(days.map(([d]) => d)).toEqual(['2026-09-25'])
  })

  test('no rain figure at all is not the same as none forecast', () => {
    const [[, day]] = dailyFromMetNorway(
      hourly(PERTH_25TH, 24, (_, at) => step(at, 15, 2, { one: {} })),
      PERTH,
      ['2026-09-25'],
    )
    expect(day.rainMm).toBeUndefined()
  })
})

describe('only whole days, except the rest of today', () => {
  test('the forecast begun at 3pm makes that day "the rest of it", and the next day whole', () => {
    const threePm = PERTH_25TH + 15 * HOUR
    const days = dailyFromMetNorway(
      hourly(threePm, 33, (i, at) => step(at, 20 + i / 10, 2, { one: {} })),
      PERTH,
      ['2026-09-25', '2026-09-26'],
    )
    expect(days).toEqual([
      ['2026-09-25', expect.objectContaining({ partial: true, minTempC: 20 })],
      ['2026-09-26', expect.not.objectContaining({ partial: true })],
    ])
  })

  test('the forecast begun just after midnight makes that day whole', () => {
    const [[, day]] = dailyFromMetNorway(
      hourly(PERTH_25TH + HOUR / 2, 24),
      PERTH,
      ['2026-09-25'],
    )
    expect(day.partial).toBeUndefined()
  })

  test('a day the forecast stops part way through is left out', () => {
    // The 25th whole, then the 26th only to 8am: its last step has no period.
    const days = dailyFromMetNorway(
      [
        ...hourly(PERTH_25TH, 24),
        step(PERTH_25TH + 26 * HOUR, 15, 2, { six: { mm: 0 } }),
        step(PERTH_25TH + 32 * HOUR, 15, 2),
      ],
      PERTH,
      ['2026-09-25', '2026-09-26'],
    )
    expect(days.map(([d]) => d)).toEqual(['2026-09-25'])
  })

  test('a day with its morning missing is left out', () => {
    // The forecast starts on the 24th, then nothing until 10am on the 25th.
    const days = dailyFromMetNorway(
      [
        step(PERTH_25TH - 2 * HOUR, 15, 2, { one: { mm: 0 } }),
        ...hourly(PERTH_25TH + 10 * HOUR, 14),
      ],
      PERTH,
      ['2026-09-25'],
    )
    expect(days).toEqual([])
  })

  test('a 6-hourly day, its first step two hours in, is a whole day', () => {
    // Where MET's steps are 6-hourly (00/06/12/18 UTC), a Perth day's first
    // is at 2am. The step before it, on the 24th, starts the forecast.
    const at = (h: number) => PERTH_25TH + h * HOUR
    const days = dailyFromMetNorway(
      [-4, 2, 8, 14, 20, 26].map((h) =>
        step(at(h), 15, 2, { six: { mm: 0.5 } }),
      ),
      PERTH,
      ['2026-09-25'],
    )
    expect(days).toEqual([
      ['2026-09-25', expect.objectContaining({ rainMm: 2 })],
    ])
    expect(days[0][1].partial).toBeUndefined()
  })
})

describe('the days MET can hold', () => {
  test.each([
    ['2026-09-24', false], // yesterday: it forecasts from now on
    ['2026-09-25', true],
    ['2026-10-05', true],
    ['2026-10-06', false], // past its horizon
  ])('%s, from the 25th: %s', (dayKey, canHold) => {
    expect(metCanForecast(dayKey, '2026-09-25')).toBe(canHold)
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
    ['sleet', 66],
    ['lightrainshowers_day', 80],
    ['rainshowers_day', 81],
    ['heavyrainshowers_day', 82],
    ['heavyrainshowersandthunder_day', 95],
    ['snow', 73],
  ])('%s is %i', (symbol, code) => {
    expect(symbolToWmo(symbol)).toBe(code)
  })
})
