import { v } from 'convex/values'
import { action, internalMutation, internalQuery } from './_generated/server'
import { internal } from './_generated/api'
import { requireMembership } from './lib/access'

/**
 * Weather is decision-relevant here, not decoration: rain within a day of a
 * treatment washes it off, and wind decides whether spraying is viable at all.
 *
 * Open-Meteo needs no API key, which keeps this working for a design partner
 * before any commercial arrangement exists.
 */
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

/** Cache entries older than this are refetched; forecasts move during a day. */
const STALE_MS = 3 * 60 * 60 * 1000

/**
 * Open-Meteo returns admin1 as the full state name. Australian suburb names
 * repeat across states — Bayswater exists in both WA and Victoria — so the
 * state is what disambiguates, and a mismatch is refused rather than guessed.
 */
const STATE_NAMES: Record<string, string> = {
  ACT: 'Australian Capital Territory',
  NSW: 'New South Wales',
  NT: 'Northern Territory',
  QLD: 'Queensland',
  SA: 'South Australia',
  TAS: 'Tasmania',
  VIC: 'Victoria',
  WA: 'Western Australia',
}

function suburbKeyOf(suburb: string, postcode: string) {
  return `${suburb.trim().toLowerCase().replace(/\s+/g, '-')}-${postcode.trim()}`
}

export const readCache = internalQuery({
  args: { suburbKey: v.string(), dayKey: v.string() },
  handler: async (ctx, { suburbKey, dayKey }) =>
    ctx.db
      .query('weatherCache')
      .withIndex('by_suburb_day', (q) =>
        q.eq('suburbKey', suburbKey).eq('dayKey', dayKey),
      )
      .unique(),
})

export const writeCache = internalMutation({
  args: {
    suburbKey: v.string(),
    dayKey: v.string(),
    maxTempC: v.optional(v.number()),
    minTempC: v.optional(v.number()),
    rainMm: v.optional(v.number()),
    windKmh: v.optional(v.number()),
    code: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('weatherCache')
      .withIndex('by_suburb_day', (q) =>
        q.eq('suburbKey', args.suburbKey).eq('dayKey', args.dayKey),
      )
      .unique()

    const doc = { ...args, fetchedAt: Date.now() }
    if (existing) await ctx.db.patch(existing._id, doc)
    else await ctx.db.insert('weatherCache', doc)
  },
})

/**
 * Membership check for the action, which has no ctx.db of its own. The
 * caller's identity propagates through runQuery, so this is a real check and
 * not a formality — the forecast is cheap, but the businessId is not something
 * a non-member should be able to probe.
 */
export const assertAccessInternal = internalQuery({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)
    return true
  },
})

/**
 * Open-Meteo forecasts run about 16 days ahead and a few days back. Asking
 * outside that returns nothing useful, so days beyond the window are reported
 * as absent rather than fetched and quietly rendered as blank.
 */
const FORECAST_AHEAD_DAYS = 14
const FORECAST_BEHIND_DAYS = 2

function withinForecastWindow(dayKey: string): boolean {
  const day = Date.parse(`${dayKey}T00:00:00Z`)
  if (Number.isNaN(day)) return false

  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)
  const days = Math.round((day - today) / 86_400_000)
  return days >= -FORECAST_BEHIND_DAYS && days <= FORECAST_AHEAD_DAYS
}

export type DailyWeather = {
  maxTempC?: number
  minTempC?: number
  rainMm?: number
  windKmh?: number
  code?: number
  suburb: string
}

async function geocode(
  suburb: string,
  state: string,
): Promise<{ latitude: number; longitude: number } | null> {
  // countryCode, not country: the latter is ignored and happily returns
  // Bayswater, New Zealand for an Australian pest controller.
  const res = await fetch(
    `${GEOCODE_URL}?name=${encodeURIComponent(suburb)}&count=10&countryCode=AU&language=en&format=json`,
  )
  if (!res.ok) return null

  const body = (await res.json()) as {
    results?: Array<{
      latitude: number
      longitude: number
      admin1?: string
      country_code?: string
    }>
  }

  const wanted = STATE_NAMES[state]
  // Showing a Perth tech Melbourne's rainfall is worse than showing nothing,
  // so an ambiguous match is refused rather than approximated.
  const place = body.results?.find(
    (r) => r.country_code === 'AU' && (!wanted || r.admin1 === wanted),
  )
  return place ? { latitude: place.latitude, longitude: place.longitude } : null
}

type DayRow = { dayKey: string; suburb: string; postcode: string }

/**
 * Weather for a set of days, each with its own suburb — a week can span
 * several. One request per distinct suburb rather than one per day, since the
 * forecast API takes a date range.
 */
export const forDays = action({
  args: {
    businessId: v.id('businesses'),
    state: v.string(),
    days: v.array(
      v.object({
        dayKey: v.string(),
        suburb: v.string(),
        postcode: v.string(),
      }),
    ),
  },
  handler: async (
    ctx,
    { businessId, state, days },
  ): Promise<Record<string, DailyWeather>> => {
    await ctx.runQuery(internal.weather.assertAccessInternal, { businessId })

    const out: Record<string, DailyWeather> = {}
    const wanted = (days as Array<DayRow>).filter((d) =>
      withinForecastWindow(d.dayKey),
    )

    const bySuburb = new Map<string, Array<DayRow>>()
    for (const day of wanted) {
      const key = suburbKeyOf(day.suburb, day.postcode)
      bySuburb.set(key, [...(bySuburb.get(key) ?? []), day])
    }

    for (const rows of bySuburb.values()) {
      const { suburb, postcode } = rows[0]
      const suburbKey = suburbKeyOf(suburb, postcode)

      const missing: Array<string> = []
      for (const row of rows) {
        const cached = await ctx.runQuery(internal.weather.readCache, {
          suburbKey,
          dayKey: row.dayKey,
        })
        if (cached && Date.now() - cached.fetchedAt < STALE_MS) {
          out[row.dayKey] = {
            maxTempC: cached.maxTempC,
            minTempC: cached.minTempC,
            rainMm: cached.rainMm,
            windKmh: cached.windKmh,
            code: cached.code,
            suburb,
          }
        } else {
          missing.push(row.dayKey)
        }
      }
      if (missing.length === 0) continue

      try {
        const place = await geocode(suburb, state)
        if (!place) continue

        const sorted = [...missing].sort()
        const res = await fetch(
          `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max' +
            `&timezone=auto&start_date=${sorted[0]}&end_date=${sorted[sorted.length - 1]}`,
        )
        if (!res.ok) continue

        const body = (await res.json()) as {
          daily?: {
            time?: Array<string>
            weather_code?: Array<number>
            temperature_2m_max?: Array<number>
            temperature_2m_min?: Array<number>
            precipitation_sum?: Array<number>
            wind_speed_10m_max?: Array<number>
          }
        }
        const daily = body.daily
        if (!daily?.time) continue

        for (let i = 0; i < daily.time.length; i++) {
          const dayKey = daily.time[i]
          const entry = {
            maxTempC: daily.temperature_2m_max?.[i],
            minTempC: daily.temperature_2m_min?.[i],
            rainMm: daily.precipitation_sum?.[i],
            windKmh: daily.wind_speed_10m_max?.[i],
            code: daily.weather_code?.[i],
          }
          await ctx.runMutation(internal.weather.writeCache, {
            suburbKey,
            dayKey,
            ...entry,
          })
          if (missing.includes(dayKey)) out[dayKey] = { ...entry, suburb }
        }
      } catch {
        // Advisory only: an outage must never stop the schedule rendering.
      }
    }

    return out
  },
})

export const forDay = action({
  args: {
    businessId: v.id('businesses'),
    suburb: v.string(),
    postcode: v.string(),
    state: v.string(),
    dayKey: v.string(),
  },
  // Annotated because the handler calls queries defined in this same file,
  // which otherwise makes the inferred return type circular.
  handler: async (
    ctx,
    { businessId, suburb, postcode, state, dayKey },
  ): Promise<DailyWeather | null> => {
    await ctx.runQuery(internal.weather.assertAccessInternal, { businessId })

    const suburbKey = suburbKeyOf(suburb, postcode)

    const cached = await ctx.runQuery(internal.weather.readCache, {
      suburbKey,
      dayKey,
    })
    if (cached && Date.now() - cached.fetchedAt < STALE_MS) {
      return {
        maxTempC: cached.maxTempC,
        minTempC: cached.minTempC,
        rainMm: cached.rainMm,
        windKmh: cached.windKmh,
        code: cached.code,
        suburb,
      }
    }

    try {
      // countryCode, not country: the latter is ignored and happily returns
      // Bayswater, New Zealand for an Australian pest controller.
      const geo = await fetch(
        `${GEOCODE_URL}?name=${encodeURIComponent(suburb)}&count=10&countryCode=AU&language=en&format=json`,
      )
      if (!geo.ok) return null
      const geoBody = (await geo.json()) as {
        results?: Array<{
          latitude: number
          longitude: number
          admin1?: string
          country_code?: string
        }>
      }

      const wanted = STATE_NAMES[state]
      const place = geoBody.results?.find(
        (r) => r.country_code === 'AU' && (!wanted || r.admin1 === wanted),
      )
      // Showing a Perth tech Melbourne's rainfall is worse than showing
      // nothing, so an ambiguous match is refused rather than approximated.
      if (!place) return null

      const forecast = await fetch(
        `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
          '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max' +
          `&timezone=auto&start_date=${dayKey}&end_date=${dayKey}`,
      )
      if (!forecast.ok) return null

      const body = (await forecast.json()) as {
        daily?: {
          weather_code?: Array<number>
          temperature_2m_max?: Array<number>
          temperature_2m_min?: Array<number>
          precipitation_sum?: Array<number>
          wind_speed_10m_max?: Array<number>
        }
      }
      const daily = body.daily
      if (!daily) return null

      const result = {
        maxTempC: daily.temperature_2m_max?.[0],
        minTempC: daily.temperature_2m_min?.[0],
        rainMm: daily.precipitation_sum?.[0],
        windKmh: daily.wind_speed_10m_max?.[0],
        code: daily.weather_code?.[0],
      }

      await ctx.runMutation(internal.weather.writeCache, {
        suburbKey,
        dayKey,
        ...result,
      })

      return { ...result, suburb }
    } catch {
      // Weather is advisory. A forecast outage must never stop someone from
      // seeing their day's work.
      return null
    }
  },
})
