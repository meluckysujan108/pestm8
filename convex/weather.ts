import { v } from 'convex/values'
import { action, internalAction, internalMutation, internalQuery } from './_generated/server'
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
import {
  STATE_TIMEZONES,
  dailyFromMetNorway,
  metCanForecast,
} from './lib/metNorway'
import { stateOfPostcode } from './lib/postcodes'
import type { MetTimestep } from './lib/metNorway'
import type { ActionCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'

/**
 * Weather is decision-relevant here, not decoration: rain within a day of a
 * treatment washes it off, and wind decides whether spraying is viable at all.
 *
 * Open-Meteo first (no key), MET Norway when Open-Meteo will not answer. Open-
 * Meteo's free tier counts its limits per IP address, and Convex sends every
 * app's requests from shared addresses, so another app can use up the day's
 * allowance and ours are refused through no fault of our own. MET Norway is
 * free for any use, needs only an honest User-Agent, and runs the same ECMWF
 * model for Australia — see convex/lib/metNorway.ts. Both are credited
 * wherever the forecast shows (WeatherCredit.tsx).
 */
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact'
/** MET Norway blocks anonymous or made-up agents; this says who is asking
 * and where to find us. */
const USER_AGENT = 'PestM8/1.0 (+https://pestm8.vercel.app)'

/** How long a suburb the geocoder has no place for is left alone. */
const GEOCODE_MISS_MS = 24 * 60 * 60 * 1000

/** A failed lookup, said where it can be read (`npx convex logs`) instead of
 * vanishing into "No forecast". */
async function warnFailed(what: string, res: Response) {
  const body = await res.text().catch(() => '')
  console.warn(`[weather] ${what}: HTTP ${res.status} ${body.slice(0, 200)}`)
}

/** Cache entries older than this are refetched; forecasts move during a day. */
const STALE_MS = 3 * 60 * 60 * 1000
/** The rest of today from MET is asked for again sooner: Open-Meteo may be
 * answering again with the whole day, and MET's own answers are good for
 * about this long (its Expires header). */
const PARTIAL_STALE_MS = 30 * 60 * 1000

/** Whether a cached forecast is still fresh enough to show without asking. */
function isFresh(row: Doc<'weatherCache'>, now: number): boolean {
  return now - row.fetchedAt < (row.partial ? PARTIAL_STALE_MS : STALE_MS)
}

/**
 * What has refused us during one call, so it is not asked again for every
 * suburb after it: one refusal per call, not one per suburb, each a wasted
 * round trip before the fallback. Scoped to the call rather than kept longer,
 * so the next view finds out as soon as it answers again.
 */
type Refusals = { openMeteo: boolean; geocoder: boolean }

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
    partial: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('weatherCache')
      .withIndex('by_suburb_day', (q) =>
        q.eq('suburbKey', args.suburbKey).eq('dayKey', args.dayKey),
      )
      .unique()

    const doc = { ...args, fetchedAt: Date.now() }
    // Replaced, not patched: a patch keeps any field the new forecast leaves
    // out, so yesterday's rain, or a `partial` flag, would outlive it.
    if (existing) await ctx.db.replace(existing._id, doc)
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

export const readGeocodeMiss = internalQuery({
  args: { suburbKey: v.string(), state: v.string() },
  handler: async (ctx, { suburbKey, state }) =>
    ctx.db
      .query('geocodeMisses')
      .withIndex('by_suburb_state', (q) =>
        q.eq('suburbKey', suburbKey).eq('state', state),
      )
      .unique(),
})

export const writeGeocodeMiss = internalMutation({
  args: { suburbKey: v.string(), state: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('geocodeMisses')
      .withIndex('by_suburb_state', (q) =>
        q.eq('suburbKey', args.suburbKey).eq('state', args.state),
      )
      .unique()
    const doc = { ...args, missedAt: Date.now() }
    if (existing) await ctx.db.patch(existing._id, doc)
    else await ctx.db.insert('geocodeMisses', doc)
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
  /** Only the rest of today (MET Norway, standing in for Open-Meteo). */
  partial?: boolean
}

type Place = { latitude: number; longitude: number; state: string }

/**
 * Suburb centroid, cached permanently in `suburbGeocache`. Unlike a forecast,
 * this answer does not go stale — Bayswater does not move — so there is no
 * freshness window here, only "have we ever asked".
 *
 * Looked for in the postcode's state first, then the one given (the
 * property's, or the business's): the cache is shared by every business under
 * suburb + postcode, so it must hold the place the postcode means, not the one
 * a mis-picked state found. See convex/lib/postcodes.ts.
 */
async function geocode(
  ctx: ActionCtx,
  suburb: string,
  postcode: string,
  state: string,
  refused: Refusals,
): Promise<Place | null> {
  const suburbKey = suburbKeyOf(suburb, postcode)
  const states = [...new Set([stateOfPostcode(postcode) ?? state, state])]

  const cached = await ctx.runQuery(internal.weather.readGeocache, { suburbKey })
  if (cached && states.includes(cached.state)) {
    return { latitude: cached.lat, longitude: cached.lng, state: cached.state }
  }

  // A suburb that was not there yesterday is not asked about again today.
  const missed = await ctx.runQuery(internal.weather.readGeocodeMiss, {
    suburbKey,
    state,
  })
  if (missed && Date.now() - missed.missedAt < GEOCODE_MISS_MS) return null
  if (refused.geocoder) return null

  // "Mt Lawley" is how people type it and "Mount Lawley" how the gazetteer
  // has it, so the long form is tried when the short one finds nothing.
  const names = [suburb]
  if (/^mt\.?\s/i.test(suburb)) names.push(suburb.replace(/^mt\.?\s/i, 'Mount '))

  for (const name of names) {
    // countryCode, not country: the latter is ignored and happily returns
    // Bayswater, New Zealand for an Australian pest controller.
    const res = await fetch(
      `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=10&countryCode=AU&language=en&format=json`,
    )
    if (!res.ok) {
      // Refused or broken, not "no such place": left to try again next time.
      // There is no second geocoder, so a suburb never looked up before has
      // no forecast until this one answers; one already cached is unaffected.
      await warnFailed(`geocoding ${name}`, res)
      refused.geocoder = true
      return null
    }

    const body = (await res.json()) as {
      results?: Array<{
        latitude: number
        longitude: number
        admin1?: string
        country_code?: string
        feature_code?: string
      }>
    }

    // Showing a Perth tech Melbourne's rainfall is worse than showing nothing,
    // so an ambiguous match is refused rather than approximated. A populated
    // place only (feature codes PPL…): "Morley" also finds Morley Dam, Morley
    // Park and Morley Island, and a dam in the right state is still wrong.
    for (const inState of states) {
      const wanted = STATE_NAMES[inState]
      const place = body.results?.find(
        (r) =>
          r.country_code === 'AU' &&
          (!wanted || r.admin1 === wanted) &&
          (r.feature_code?.startsWith('PPL') ?? true),
      )
      if (!place) continue

      await ctx.runMutation(internal.weather.writeGeocache, {
        suburbKey,
        state: inState,
        lat: place.latitude,
        lng: place.longitude,
      })
      return {
        latitude: place.latitude,
        longitude: place.longitude,
        state: inState,
      }
    }
  }

  console.info(`[weather] no place called ${suburb} in ${state}`)
  await ctx.runMutation(internal.weather.writeGeocodeMiss, { suburbKey, state })
  return null
}

type DayRow = {
  dayKey: string
  suburb: string
  postcode: string
  state?: string
}

/**
 * One forecast request covering every day asked for, as `[dayKey, entry]`.
 *
 * Split out because two callers need the same numbers and only one of them has
 * a signed-in user: the schedule asks through a public action, while a report
 * being created schedules a fetch that runs with no identity at all.
 *
 * MET is asked only about the days it can hold (today onwards, ~10 days), and
 * not at all when none are: asking it again for yesterday on every view would
 * only fetch the same forecast to throw away, which its terms ask us not to do.
 */
async function fetchDailyRange(
  place: Place,
  dayKeys: Array<string>,
  timezone: string,
  refused: Refusals,
): Promise<Array<[string, DailyEntry]>> {
  if (dayKeys.length === 0) return []
  if (!refused.openMeteo) {
    const fromOpenMeteo = await fetchOpenMeteo(place, dayKeys).catch(
      (error: unknown) => {
        console.warn(`[weather] Open-Meteo unreachable: ${String(error)}`)
        return null
      },
    )
    if (fromOpenMeteo === null) refused.openMeteo = true
    else if (fromOpenMeteo.length > 0) return fromOpenMeteo
  }

  const todayThere = dayKeyOf(Date.now(), timezone)
  const reachable = dayKeys.filter((d) => metCanForecast(d, todayThere))
  if (reachable.length === 0) return []
  const fromMet = await fetchMetNorway(place, reachable, timezone).catch(
    (error: unknown) => {
      console.warn(`[weather] MET Norway unreachable: ${String(error)}`)
      return null
    },
  )
  return fromMet ?? []
}

/** Open-Meteo's daily forecast for the days asked, or null if it would not
 * answer. */
async function fetchOpenMeteo(
  place: { latitude: number; longitude: number },
  dayKeys: Array<string>,
): Promise<Array<[string, DailyEntry]> | null> {
  const sorted = [...dayKeys].sort()
  const res = await fetch(
    `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max' +
      `&timezone=auto&start_date=${sorted[0]}&end_date=${sorted[sorted.length - 1]}`,
  )
  if (!res.ok) {
    await warnFailed('Open-Meteo forecast', res)
    return null
  }

  const body = (await res.json()) as {
    daily?: {
      time?: Array<string>
      weather_code?: Array<number | null>
      temperature_2m_max?: Array<number | null>
      temperature_2m_min?: Array<number | null>
      precipitation_sum?: Array<number | null>
      wind_speed_10m_max?: Array<number | null>
    }
  }
  const daily = body.daily
  if (!daily?.time) {
    console.warn('[weather] Open-Meteo forecast: no daily data in the answer')
    return null
  }

  // A gap in the model comes back as null, which the cache (numbers or
  // nothing) refuses — and one refused write used to lose the whole suburb.
  const value = (list: Array<number | null> | undefined, i: number) =>
    list?.[i] ?? undefined

  return daily.time.map((dayKey, i) => [
    dayKey,
    {
      maxTempC: value(daily.temperature_2m_max, i),
      minTempC: value(daily.temperature_2m_min, i),
      rainMm: value(daily.precipitation_sum, i),
      windKmh: value(daily.wind_speed_10m_max, i),
      code: value(daily.weather_code, i),
    },
  ])
}

/**
 * MET Norway's forecast for the same days, read into the same shape — the
 * fallback. Coordinates to four decimals, as its terms ask; days past its
 * ~9–10-day reach are left out rather than guessed.
 */
async function fetchMetNorway(
  place: { latitude: number; longitude: number },
  dayKeys: Array<string>,
  timezone: string,
): Promise<Array<[string, DailyEntry]> | null> {
  const res = await fetch(
    `${MET_URL}?lat=${place.latitude.toFixed(4)}&lon=${place.longitude.toFixed(4)}`,
    { headers: { 'User-Agent': USER_AGENT } },
  )
  if (!res.ok) {
    await warnFailed('MET Norway forecast', res)
    return null
  }
  const body = (await res.json()) as {
    properties?: { timeseries?: Array<MetTimestep> }
  }
  const timeseries = body.properties?.timeseries
  if (!timeseries) {
    console.warn('[weather] MET Norway forecast: no timeseries in the answer')
    return null
  }
  return dailyFromMetNorway(timeseries, timezone, dayKeys)
}

type DailyEntry = {
  maxTempC?: number
  minTempC?: number
  rainMm?: number
  windKmh?: number
  code?: number
  partial?: boolean
}

/**
 * Fetches the forecast a report wanted and was not able to find cached, then
 * hands it back to the report as a suggested answer.
 *
 * Scheduled from `reports.create`, so it runs with no identity — every check
 * that matters happened in the mutation that scheduled it, and the only thing
 * this can touch is the one report it was given. Silent on failure: a report
 * whose weather never arrives simply asks the technician, which is what the
 * form did before any of this existed.
 */
export const fillForReport = internalAction({
  args: {
    reportId: v.id('reports'),
    state: v.string(),
    suburb: v.string(),
    postcode: v.string(),
    dayKey: v.string(),
  },
  handler: async (ctx, { reportId, state, suburb, postcode, dayKey }) => {
    const suburbKey = suburbKeyOf(suburb, postcode)
    const refused: Refusals = { openMeteo: false, geocoder: false }
    try {
      const place = await geocode(ctx, suburb, postcode, state, refused)
      if (!place) return

      const fetched = await fetchDailyRange(
        place,
        [dayKey],
        STATE_TIMEZONES[place.state] ?? 'Australia/Perth',
        refused,
      )
      for (const [key, entry] of fetched) {
        await ctx.runMutation(internal.weather.writeCache, { suburbKey, dayKey: key, ...entry })
      }

      // Not the rest of the day: what a report records is the day's weather,
      // and the morning's rain is exactly what it would be missing.
      const wanted = fetched.find(([key]) => key === dayKey)?.[1]
      if (!wanted || wanted.partial) return
      await ctx.runMutation(internal.reports.applyWeatherSuggestion, {
        reportId,
        forecast: { rainMm: wanted.rainMm, windKmh: wanted.windKmh, code: wanted.code },
      })
    } catch (error) {
      // Advisory only, exactly as above — but said, not swallowed.
      console.warn(`[weather] report ${reportId}: ${String(error)}`)
    }
  },
})

export const forDays = action({
  args: {
    businessId: v.id('businesses'),
    state: v.string(),
    days: v.array(
      v.object({
        dayKey: v.string(),
        suburb: v.string(),
        postcode: v.string(),
        // The property's own state, which is what finds the right suburb:
        // Darwin is in the NT whatever state the business is in. Optional,
        // with `state` above standing in for a caller that does not send it.
        state: v.optional(v.string()),
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
    const now = Date.now()
    const todayKey = dayKeyOf(now, timezone)
    const refused: Refusals = { openMeteo: false, geocoder: false }

    const out: Record<string, DailyWeather> = {}
    const wanted = (days as Array<DayRow>).filter((d) =>
      withinForecastWindow(d.dayKey, todayKey),
    )

    // Grouped by suburb AND the state it is looked for in, since a group is
    // looked up once. (Its postcode's state comes first: see geocode.)
    const bySuburb = new Map<string, Array<DayRow>>()
    for (const day of wanted) {
      const key = `${suburbKeyOf(day.suburb, day.postcode)}|${day.state ?? state}`
      bySuburb.set(key, [...(bySuburb.get(key) ?? []), day])
    }

    for (const rows of bySuburb.values()) {
      const { suburb, postcode } = rows[0]
      const placeState = rows[0].state ?? state
      const suburbKey = suburbKeyOf(suburb, postcode)

      // Resolved before the forecast-cache check rather than after it: the
      // coordinates belong on EVERY entry (they drive the schedule's travel
      // hints), including entries whose forecast comes back from cache and so
      // never reach the fetch below. After a suburb's first ever lookup this
      // is a database read, not a network call.
      const place = await geocode(
        ctx,
        suburb,
        postcode,
        placeState,
        refused,
      ).catch((error: unknown) => {
        console.warn(`[weather] geocoding ${suburb}: ${String(error)}`)
        return null
      })
      const coords = place ? { lat: place.latitude, lng: place.longitude } : {}
      const show = (dayKey: string, entry: DailyEntry) => {
        out[compositeKeyOf(suburbKey, dayKey)] = {
          maxTempC: entry.maxTempC,
          minTempC: entry.minTempC,
          rainMm: entry.rainMm,
          windKmh: entry.windKmh,
          code: entry.code,
          ...(entry.partial ? { partial: true } : {}),
          suburb,
          ...coords,
        }
      }

      const missing: Array<string> = []
      // Kept for when neither source answers: yesterday's forecast for
      // yesterday, or a week-old one for day 12 while only MET is answering,
      // says more than "No forecast".
      const stale = new Map<string, Doc<'weatherCache'>>()
      for (const row of rows) {
        const cached = await ctx.runQuery(internal.weather.readCache, {
          suburbKey,
          dayKey: row.dayKey,
        })
        if (cached && isFresh(cached, now)) {
          show(row.dayKey, cached)
          continue
        }
        if (cached) stale.set(row.dayKey, cached)
        missing.push(row.dayKey)
      }
      if (missing.length === 0) continue

      try {
        const fetched = place
          ? await fetchDailyRange(
              place,
              missing,
              STATE_TIMEZONES[place.state] ?? timezone,
              refused,
            )
          : []
        for (const [dayKey, entry] of fetched) {
          await ctx.runMutation(internal.weather.writeCache, {
            suburbKey,
            dayKey,
            ...entry,
          })
        }
        const got = new Map(fetched)
        for (const dayKey of missing) {
          const entry = got.get(dayKey) ?? stale.get(dayKey)
          if (entry) show(dayKey, entry)
        }
      } catch (error) {
        // Advisory only: an outage must never stop the schedule rendering.
        console.warn(`[weather] forecast for ${suburb}: ${String(error)}`)
        for (const [dayKey, entry] of stale) show(dayKey, entry)
      }
    }

    return out
  },
})

