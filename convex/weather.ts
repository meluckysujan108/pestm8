import { v } from 'convex/values'
import { action, internalMutation, internalQuery } from './_generated/server'
import { internal } from './_generated/api'
import { requireMembership } from './lib/access'
// Shared with the client (src/lib/weather.ts) rather than mirrored: these four
// were previously private copies here with a comment asking whoever changed
// them to keep the client's copy in step. That is how e2e/calendar.spec.ts
// ended up asserting against a key shape the server had already stopped using.
import {
  compositeKeyOf,
  suburbKeyOf,
  withinForecastWindow,
} from './lib/forecastWindow'
import { dayKeyOf } from './lib/dates'
import type { ActionCtx } from './_generated/server'

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
export const readGeocache = internalQuery({
  args: { suburbKey: v.string() },
  handler: async (ctx, { suburbKey }) =>
    ctx.db
      .query('suburbGeocache')
      .withIndex('by_suburb_key', (q) => q.eq('suburbKey', suburbKey))
      .unique(),
})

export const writeGeocache = internalMutation({
  args: {
    suburbKey: v.string(),
    state: v.string(),
    lat: v.number(),
    lng: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('suburbGeocache')
      .withIndex('by_suburb_key', (q) => q.eq('suburbKey', args.suburbKey))
      .unique()

    const doc = { ...args, fetchedAt: Date.now() }
    if (existing) await ctx.db.patch(existing._id, doc)
    else await ctx.db.insert('suburbGeocache', doc)
  },
})

/**
 * Membership check, plus the tenant's timezone — which the caller needs in
 * order to know what "today" is. The forecast window is relative to the
 * tenant's local day, not the server's UTC day: for an Australian tenant those
 * differ for the first 8-11 hours of every local morning, and using UTC would
 * quietly drop the far edge of the window during exactly that period.
 */
export const assertAccessInternal = internalQuery({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)
    const business = await ctx.db.get(businessId)
    return { timezone: business?.timezone ?? 'Australia/Perth' }
  },
})

export type DailyWeather = {
  maxTempC?: number
  minTempC?: number
  rainMm?: number
  windKmh?: number
  code?: number
  suburb: string
  // The suburb's centroid, so the schedule can show how far apart consecutive
  // jobs are without a second round trip. Absent when geocoding failed.
  lat?: number
  lng?: number
}

/**
 * Suburb centroid, cached permanently in `suburbGeocache`. Unlike a forecast,
 * this answer does not go stale — Bayswater does not move — so there is no
 * freshness window here, only "have we ever asked".
 */
async function geocode(
  ctx: ActionCtx,
  suburb: string,
  postcode: string,
  state: string,
): Promise<{ latitude: number; longitude: number } | null> {
  const suburbKey = suburbKeyOf(suburb, postcode)

  const cached = await ctx.runQuery(internal.weather.readGeocache, { suburbKey })
  if (cached) return { latitude: cached.lat, longitude: cached.lng }

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
  if (!place) return null

  await ctx.runMutation(internal.weather.writeGeocache, {
    suburbKey,
    state,
    lat: place.latitude,
    lng: place.longitude,
  })

  return { latitude: place.latitude, longitude: place.longitude }
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
    const { timezone } = await ctx.runQuery(
      internal.weather.assertAccessInternal,
      { businessId },
    )
    const todayKey = dayKeyOf(Date.now(), timezone)

    const out: Record<string, DailyWeather> = {}
    const wanted = (days as Array<DayRow>).filter((d) =>
      withinForecastWindow(d.dayKey, todayKey),
    )

    const bySuburb = new Map<string, Array<DayRow>>()
    for (const day of wanted) {
      const key = suburbKeyOf(day.suburb, day.postcode)
      bySuburb.set(key, [...(bySuburb.get(key) ?? []), day])
    }

    for (const rows of bySuburb.values()) {
      const { suburb, postcode } = rows[0]
      const suburbKey = suburbKeyOf(suburb, postcode)

      // Resolved before the forecast-cache check rather than after it: the
      // coordinates belong on EVERY entry (they drive the schedule's travel
      // hints), including entries whose forecast comes back from cache and so
      // never reach the fetch below. After a suburb's first ever lookup this
      // is a database read, not a network call.
      const place = await geocode(ctx, suburb, postcode, state).catch(() => null)
      const coords = place ? { lat: place.latitude, lng: place.longitude } : {}

      const missing: Array<string> = []
      for (const row of rows) {
        const cached = await ctx.runQuery(internal.weather.readCache, {
          suburbKey,
          dayKey: row.dayKey,
        })
        if (cached && Date.now() - cached.fetchedAt < STALE_MS) {
          out[compositeKeyOf(suburbKey, row.dayKey)] = {
            maxTempC: cached.maxTempC,
            minTempC: cached.minTempC,
            rainMm: cached.rainMm,
            windKmh: cached.windKmh,
            code: cached.code,
            suburb,
            ...coords,
          }
        } else {
          missing.push(row.dayKey)
        }
      }
      if (missing.length === 0) continue

      try {
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
          if (missing.includes(dayKey)) {
            out[compositeKeyOf(suburbKey, dayKey)] = { ...entry, suburb, ...coords }
          }
        }
      } catch {
        // Advisory only: an outage must never stop the schedule rendering.
      }
    }

    return out
  },
})

