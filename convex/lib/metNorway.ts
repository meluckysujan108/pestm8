import {
  addDaysToKey,
  dayKeyOf,
  endOfDayInZone,
  startOfDayInZone,
} from './dates'

/**
 * MET Norway's Locationforecast (api.met.no), read into the same daily shape
 * the card and the cache use for Open-Meteo. It is the fallback source for
 * when Open-Meteo refuses us (convex/weather.ts): free, licensed for any use
 * including commercial (NLOD 2.0 / CC BY 4.0), and for Australia it runs the
 * same ECMWF model at about 9 km, so a whole day's numbers barely move when it
 * steps in.
 *
 * What it cannot do is look back. Its forecast starts at the current hour and
 * runs about 9–10 days, hourly for the first ~60 hours and 6-hourly after, so
 * it has no past days, only the rest of today, and a last day it stops part
 * way through. Today comes back marked `partial`, and the card says "rest of
 * day"; a past day, or one it only half reaches, is left out rather than
 * passed off as a whole day's weather.
 */

type Summary = { symbol_code?: string }
type Period = { summary?: Summary; details?: { precipitation_amount?: number } }

export type MetTimestep = {
  time: string
  data: {
    instant: { details: { air_temperature?: number; wind_speed?: number } }
    next_1_hours?: Period
    next_6_hours?: Period
    next_12_hours?: Period
  }
}

export type DailyFromMet = {
  maxTempC?: number
  minTempC?: number
  rainMm?: number
  windKmh?: number
  code?: number
  /** Only the hours still to come today: the forecast began part way
   * through it. */
  partial?: boolean
}

/** The furthest day ahead MET is asked about. Its forecast ends 9–10 days
 * out, and a day it only half reaches is dropped anyway. */
const MET_REACH_DAYS = 10

/** Whether MET's forecast can hold `dayKey` at all: from today (in the
 * place's zone) to its horizon. Past days are never in it. */
export function metCanForecast(dayKey: string, todayKey: string): boolean {
  return dayKey >= todayKey && dayKey <= addDaysToKey(todayKey, MET_REACH_DAYS)
}

/** The IANA zone for each state, so MET's UTC steps fall on the right local
 * day — Open-Meteo's `timezone=auto` does the same from the coordinates. */
export const STATE_TIMEZONES: Record<string, string> = {
  ACT: 'Australia/Sydney',
  NSW: 'Australia/Sydney',
  NT: 'Australia/Darwin',
  QLD: 'Australia/Brisbane',
  SA: 'Australia/Adelaide',
  TAS: 'Australia/Hobart',
  VIC: 'Australia/Melbourne',
  WA: 'Australia/Perth',
}

/**
 * A MET symbol ("lightrainshowers_day", "partlycloudy_night") as the WMO
 * weather code Open-Meteo sends, so WeatherGlyph draws either the same way.
 * Returned with a severity, so a day takes its worst hour's weather.
 */
function wmoOf(symbol: string): { code: number; severity: number } {
  const s = symbol.replace(/_(day|night|polartwilight)$/, '')
  if (s.includes('thunder')) return { code: 95, severity: 9 }
  if (s.includes('snow')) return { code: 73, severity: 8 }
  if (s.includes('sleet')) return { code: 66, severity: 7 }
  if (s === 'heavyrainshowers') return { code: 82, severity: 6 }
  if (s === 'heavyrain') return { code: 65, severity: 6 }
  if (s === 'rainshowers') return { code: 81, severity: 5 }
  if (s === 'rain') return { code: 63, severity: 5 }
  if (s === 'lightrainshowers') return { code: 80, severity: 4 }
  if (s === 'lightrain') return { code: 61, severity: 4 }
  if (s === 'fog') return { code: 45, severity: 3 }
  if (s === 'cloudy') return { code: 3, severity: 2 }
  if (s === 'partlycloudy') return { code: 2, severity: 1 }
  if (s === 'fair') return { code: 1, severity: 0.5 }
  return { code: 0, severity: 0 } // clearsky, and anything unrecognised
}

export function symbolToWmo(symbol: string): number {
  return wmoOf(symbol).code
}

const HOUR_MS = 60 * 60 * 1000

/** How far into a day its first step, or before its end its last covered
 * hour, may fall for it to still count as the whole day. Six hours, because
 * that is the gap between steps once they go 6-hourly, and a local day's
 * first step then lands anywhere up to six hours after midnight. */
const WHOLE_DAY_SLACK_MS = 6 * 60 * 60 * 1000

/** Today, when the forecast began more than this into it, is only its rest. */
const PARTIAL_START_MS = 60 * 60 * 1000

/**
 * The days asked for, each from the steps that start on it in `timezone`:
 * the highest and lowest temperature, the strongest wind (m/s to km/h), the
 * rain over the day, and the worst weather.
 *
 * Rain is counted once. Each step carries a 1-hour and a 6-hour total that
 * overlap; a step counts the one matching the gap to the next step (an hour
 * while the steps are hourly, six after), and nothing already counted.
 *
 * Only whole days come back — the steps reach from near its start to near its
 * end — with one exception: the day the forecast begins on (today), which is
 * returned as `partial` when it began more than an hour in. A day the
 * forecast stops part way through is left out.
 */
export function dailyFromMetNorway(
  timeseries: Array<MetTimestep>,
  timezone: string,
  dayKeys: Array<string>,
): Array<[string, DailyFromMet]> {
  const wanted = new Set(dayKeys)
  const days = new Map<
    string,
    {
      temps: Array<number>
      winds: Array<number>
      rain: number
      rainSeen: boolean
      worst: { code: number; severity: number } | null
      /** The first step's time, and the end of the last hour the steps
       * account for. */
      from: number
      until: number
    }
  >()

  let coveredUntil = -Infinity
  const steps = [...timeseries].sort(
    (a, b) => Date.parse(a.time) - Date.parse(b.time),
  )

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const at = Date.parse(step.time)
    const next = steps.at(i + 1)
    const gapHours = next ? (Date.parse(next.time) - at) / HOUR_MS : 1
    const dayKey = dayKeyOf(at, timezone)
    if (!wanted.has(dayKey)) {
      continue
    }
    const day = days.get(dayKey) ?? {
      temps: [],
      winds: [],
      rain: 0,
      rainSeen: false,
      worst: null,
      from: at,
      until: at,
    }
    days.set(dayKey, day)

    const { air_temperature, wind_speed } = step.data.instant.details
    if (typeof air_temperature === 'number') day.temps.push(air_temperature)
    if (typeof wind_speed === 'number') day.winds.push(wind_speed * 3.6)

    // The period that spans this step's hours: six where the steps have
    // gone 6-hourly (the last hourly step included), otherwise one.
    const six = step.data.next_6_hours
    const one = step.data.next_1_hours
    const [period, hours] =
      gapHours >= 6 && six
        ? [six, 6]
        : one
          ? [one, 1]
          : six
            ? [six, 6]
            : [null, 0]
    if (at >= coveredUntil && period && hours > 0) {
      const amount = period.details?.precipitation_amount
      if (typeof amount === 'number') {
        day.rain += amount
        day.rainSeen = true
      }
      coveredUntil = at + hours * HOUR_MS
    }
    day.until = Math.max(day.until, at + hours * HOUR_MS)

    const symbol = (
      step.data.next_1_hours ??
      step.data.next_6_hours ??
      step.data.next_12_hours
    )?.summary?.symbol_code
    if (symbol) {
      const w = wmoOf(symbol)
      if (!day.worst || w.severity > day.worst.severity) day.worst = w
    }
  }

  const firstDay =
    steps.length > 0 ? dayKeyOf(Date.parse(steps[0].time), timezone) : null

  const out: Array<[string, DailyFromMet]> = []
  for (const dayKey of dayKeys) {
    const day = days.get(dayKey)
    if (!day) continue
    const late = day.from - startOfDayInZone(dayKey, timezone)
    const early = endOfDayInZone(dayKey, timezone) - day.until
    if (early > WHOLE_DAY_SLACK_MS) continue
    const partial = dayKey === firstDay && late > PARTIAL_START_MS
    if (!partial && late > WHOLE_DAY_SLACK_MS) continue

    out.push([
      dayKey,
      {
        maxTempC: day.temps.length ? Math.max(...day.temps) : undefined,
        minTempC: day.temps.length ? Math.min(...day.temps) : undefined,
        rainMm: day.rainSeen ? Math.round(day.rain * 10) / 10 : undefined,
        windKmh: day.winds.length
          ? Math.round(Math.max(...day.winds) * 10) / 10
          : undefined,
        code: day.worst?.code,
        ...(partial ? { partial: true } : {}),
      },
    ])
  }
  return out
}
