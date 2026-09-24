/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { addDaysToKey, startOfDayInZone } from './lib/dates'

/**
 * The forecast behind the job cards (convex/weather.ts), with the network
 * faked and the clock stopped at 3pm in Perth: which place a suburb resolves
 * to, what is asked again and what is not, and MET Norway answering when
 * Open-Meteo will not.
 */

const PERTH = 'Australia/Perth'
const HOUR = 3600_000
const DAY = 24 * HOUR
const TODAY = '2026-09-25'
const YESTERDAY = addDaysToKey(TODAY, -1)
const TOMORROW = addDaysToKey(TODAY, 1)
/** 3pm in Perth on the 25th. */
const NOW = startOfDayInZone(TODAY, PERTH) + 15 * HOUR

type Place = {
  name: string
  latitude: number
  longitude: number
  admin1: string
  feature_code: string
}

/**
 * MET's forecast as it really comes: from the current hour, hourly for 60
 * hours, then 6-hourly on 00/06/12/18 UTC to about 9½ days, the last step
 * with no period. 18 km/h wind throughout, 0.1 mm an hour of cloud, and a
 * temperature of 10° + 5° per day after today + half the Perth hour — so
 * reading tomorrow by UTC's day instead of Perth's gets its low wrong.
 */
function metSeries(now: number) {
  const midnight = startOfDayInZone(TODAY, PERTH)
  const tempAt = (at: number) => {
    const d = Math.floor((at - midnight) / DAY)
    const hour = Math.floor(((at - midnight) % DAY) / HOUR)
    return 10 + 5 * d + hour / 2
  }
  const times: Array<number> = []
  const first = Math.floor(now / HOUR) * HOUR
  for (let i = 0; i < 60; i++) times.push(first + i * HOUR)
  let at = times[times.length - 1] + HOUR
  while (new Date(at).getUTCHours() % 6 !== 0) at += HOUR
  for (; at <= now + 9.5 * DAY; at += 6 * HOUR) times.push(at)

  return times.map((t, i) => {
    const last = i === times.length - 1
    const hourlyStep = i < 60
    const cloud = (mm: number) => ({
      summary: { symbol_code: 'cloudy' },
      details: { precipitation_amount: mm },
    })
    return {
      time: new Date(t).toISOString(),
      data: {
        instant: { details: { air_temperature: tempAt(t), wind_speed: 5 } },
        ...(hourlyStep && !last ? { next_1_hours: cloud(0.1) } : {}),
        ...(last ? {} : { next_6_hours: cloud(0.6) }),
      },
    }
  })
}

/** A fake network: the geocoder's places by name, and how the geocoder and
 * Open-Meteo's forecast answer. Records every request. */
function fakeNetwork(opts: {
  places?: Record<string, Array<Place>>
  geocoder?: 'ok' | 'refused'
  forecast?: 'ok' | 'refused' | 'gap' | 'empty'
}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const refused = () =>
    json({ error: true, reason: 'Daily API request limit exceeded' }, 429)

  const fetchFake = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      url: url.href,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })
    if (url.host === 'geocoding-api.open-meteo.com') {
      if (opts.geocoder === 'refused') return refused()
      const name = url.searchParams.get('name') ?? ''
      return json({
        results: (opts.places?.[name] ?? []).map((p) => ({
          ...p,
          country_code: 'AU',
        })),
      })
    }
    if (url.host === 'api.open-meteo.com') {
      if (opts.forecast === 'refused') return refused()
      const from = url.searchParams.get('start_date') ?? ''
      const to = url.searchParams.get('end_date') ?? ''
      const days: Array<string> = []
      if (opts.forecast !== 'empty') {
        for (let d = from; d <= to; d = addDaysToKey(d, 1)) days.push(d)
      }
      return json({
        daily: {
          time: days,
          weather_code: days.map(() => 3),
          temperature_2m_max: days.map(() => 21),
          temperature_2m_min: days.map(() => 11),
          precipitation_sum: days.map(() =>
            opts.forecast === 'gap' ? null : 0.4,
          ),
          wind_speed_10m_max: days.map(() => 18),
        },
      })
    }
    if (url.host === 'api.met.no') {
      return json({ properties: { timeseries: metSeries(Date.now()) } })
    }
    return new Response('not faked', { status: 500 })
  })
  vi.stubGlobal('fetch', fetchFake)

  const to = (host: string) => calls.filter((c) => c.url.includes(host))
  return {
    calls,
    geocodes: () => to('geocoding-api.open-meteo.com'),
    openMeteo: () => to('api.open-meteo.com/v1/forecast'),
    met: () => to('api.met.no'),
  }
}

const place = (
  name: string,
  admin1: string,
  latitude: number,
  longitude: number,
): Place => ({ name, admin1, latitude, longitude, feature_code: 'PPLX' })

const morley = place('Morley', 'Western Australia', -31.88775, 115.9099)
const bayswater = place('Bayswater', 'Western Australia', -31.917, 115.917)
const darwin = place('Darwin', 'Northern Territory', -12.46, 130.84)

type Row = { dayKey: string; suburb: string; postcode: string; state?: string }

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId } = await createBusiness(t, owner) // a WA business
  const forecast = (days: Array<Row>) =>
    owner.as.action(api.weather.forDays, { businessId, state: 'WA', days })
  return { t, owner, businessId, forecast }
}

const at = (dayKey: string, suburb = 'Morley', postcode = '6062'): Row => ({
  dayKey,
  suburb,
  postcode,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('when Open-Meteo will not answer', () => {
  test('MET Norway does, and tomorrow’s card gets its whole day', async () => {
    const net = fakeNetwork({
      places: { Morley: [morley] },
      forecast: 'refused',
    })
    const s = await setup()

    const out = await s.forecast([at(TOMORROW)])
    const entry = Object.values(out)[0]
    // Tomorrow in Perth runs 15° at midnight to 26.5° at 11pm. By UTC's day
    // its low would be 19°, at 8am Perth.
    expect(entry).toMatchObject({ minTempC: 15, maxTempC: 26.5, windKmh: 18 })
    expect(entry.rainMm).toBeCloseTo(2.4)
    expect(entry.partial).toBeUndefined()

    const [met] = net.met()
    // Its terms: say who is asking, and four decimals at most.
    expect(met.headers['user-agent']).toMatch(/^PestM8\//)
    expect(met.url).toContain('lat=-31.8878&lon=115.9099')
  })

  test('today is only the rest of it, and says so', async () => {
    fakeNetwork({ places: { Morley: [morley] }, forecast: 'refused' })
    const s = await setup()
    const out = await s.forecast([at(TODAY)])
    // From 3pm (17.5°) on: the morning is not in it.
    expect(Object.values(out)[0]).toMatchObject({
      partial: true,
      minTempC: 17.5,
      maxTempC: 21.5,
    })
  })

  test('the rest of today is asked for again after half an hour; a whole day is not', async () => {
    const net = fakeNetwork({
      places: { Morley: [morley] },
      forecast: 'refused',
    })
    const s = await setup()
    await s.forecast([at(TODAY), at(TOMORROW)])
    expect(net.met()).toHaveLength(1)

    vi.setSystemTime(NOW + 31 * 60_000)
    await s.forecast([at(TOMORROW)])
    expect(net.met()).toHaveLength(1)
    await s.forecast([at(TODAY)])
    expect(net.met()).toHaveLength(2)
  })

  test('it is asked once per view, not again for every suburb', async () => {
    const net = fakeNetwork({
      places: { Morley: [morley], Bayswater: [bayswater] },
      forecast: 'refused',
    })
    const s = await setup()
    const out = await s.forecast([
      at(TOMORROW),
      at(TOMORROW, 'Bayswater', '6053'),
    ])
    expect(Object.keys(out)).toHaveLength(2)
    expect(net.openMeteo()).toHaveLength(1)
    expect(net.met()).toHaveLength(2)
  })

  test('MET is not asked about days it cannot hold: gone, or past its reach', async () => {
    const net = fakeNetwork({
      places: { Morley: [morley] },
      forecast: 'refused',
    })
    const s = await setup()
    const out = await s.forecast([at(YESTERDAY), at(addDaysToKey(TODAY, 12))])
    expect(out).toEqual({})
    expect(net.met()).toHaveLength(0)
  })

  test('when nothing answers for a day, its last forecast still shows', async () => {
    fakeNetwork({ places: { Morley: [morley] }, forecast: 'refused' })
    const s = await setup()
    await s.t.run((ctx) =>
      ctx.db.insert('weatherCache', {
        suburbKey: 'morley-6062',
        dayKey: YESTERDAY,
        maxTempC: 24,
        rainMm: 3.2,
        fetchedAt: NOW - 20 * HOUR,
      }),
    )
    const out = await s.forecast([at(YESTERDAY)])
    expect(Object.values(out)[0]).toMatchObject({ maxTempC: 24, rainMm: 3.2 })
  })

  test('an answer from Open-Meteo with no days in it is no answer', async () => {
    const net = fakeNetwork({ places: { Morley: [morley] }, forecast: 'empty' })
    const s = await setup()
    const out = await s.forecast([at(TOMORROW)])
    expect(net.met()).toHaveLength(1)
    expect(Object.keys(out)).toHaveLength(1)
  })

  test('…and when Open-Meteo answers, MET Norway is not asked at all', async () => {
    const net = fakeNetwork({ places: { Morley: [morley] }, forecast: 'ok' })
    const s = await setup()
    const out = await s.forecast([at(TODAY)])
    expect(net.met()).toHaveLength(0)
    // Open-Meteo's day is the whole day, whatever the hour.
    expect(Object.values(out)[0].partial).toBeUndefined()
  })
})

describe('finding the suburb', () => {
  test('in the state its postcode is in, whatever the property says', async () => {
    fakeNetwork({ places: { Darwin: [darwin] } })
    const s = await setup()
    const out = await s.forecast([
      { dayKey: TODAY, suburb: 'Darwin', postcode: '0800', state: 'WA' },
    ])
    expect(Object.values(out)[0]).toMatchObject({ lat: -12.46 })
  })

  test('in the property’s own state when there is no postcode to go by', async () => {
    fakeNetwork({ places: { Darwin: [darwin] } })
    const s = await setup()

    const asBusiness = await s.forecast([at(TODAY, 'Darwin', '')])
    expect(Object.keys(asBusiness)).toHaveLength(0)

    const asProperty = await s.forecast([
      { dayKey: TODAY, suburb: 'Darwin', postcode: '', state: 'NT' },
    ])
    expect(Object.values(asProperty)[0]).toMatchObject({ maxTempC: 21 })
  })

  test('a border town under its neighbour’s postcode, in its own state', async () => {
    // Barooga is in NSW; its postcode, 3644, is Victoria's.
    fakeNetwork({
      places: { Barooga: [place('Barooga', 'New South Wales', -35.9, 145.68)] },
    })
    const s = await setup()
    const out = await s.forecast([
      { dayKey: TODAY, suburb: 'Barooga', postcode: '3644', state: 'NSW' },
    ])
    expect(Object.values(out)[0]).toMatchObject({ lat: -35.9 })
  })

  test('a place once found in the wrong state is looked up again', async () => {
    // Left by a property saved as WA: Mount Pleasant, Perth, under a NSW
    // postcode, for every business.
    const net = fakeNetwork({
      places: {
        'Mount Pleasant': [
          place('Mount Pleasant', 'Western Australia', -32.03, 115.85),
          place('Mount Pleasant', 'New South Wales', -34.4, 150.86),
        ],
      },
    })
    const s = await setup()
    await s.t.run((ctx) =>
      ctx.db.insert('suburbGeocache', {
        suburbKey: 'mount-pleasant-2519',
        state: 'WA',
        lat: -32.03,
        lng: 115.85,
        fetchedAt: NOW - DAY,
      }),
    )
    const out = await s.forecast([
      {
        dayKey: TODAY,
        suburb: 'Mount Pleasant',
        postcode: '2519',
        state: 'NSW',
      },
    ])
    expect(net.geocodes()).toHaveLength(1)
    expect(Object.values(out)[0]).toMatchObject({ lat: -34.4 })
  })

  test('a populated place, not a dam or a park of the same name', async () => {
    fakeNetwork({
      places: {
        Morley: [
          { ...morley, name: 'Morley Dam', latitude: -30, feature_code: 'DAM' },
          morley,
        ],
      },
    })
    const s = await setup()
    const out = await s.forecast([at(TODAY)])
    expect(Object.values(out)[0]).toMatchObject({ lat: -31.88775 })
  })

  test('"Mt Lawley" is tried as "Mount Lawley"', async () => {
    fakeNetwork({
      places: { 'Mount Lawley': [{ ...morley, name: 'Mount Lawley' }] },
    })
    const s = await setup()
    const out = await s.forecast([at(TODAY, 'Mt Lawley', '6050')])
    expect(Object.keys(out)).toHaveLength(1)
  })

  test('a place that does not exist is asked about once a day, not on every view', async () => {
    const net = fakeNetwork({})
    const s = await setup()
    const row = at(TODAY, 'Fannybay', '0810')
    await s.forecast([row])
    await s.forecast([row])
    expect(net.geocodes()).toHaveLength(1)

    // A day on. (The miss is aged rather than the clock moved on: a day
    // would outlive the test's sign-in.)
    await s.t.run(async (ctx) => {
      for (const miss of await ctx.db.query('geocodeMisses').collect()) {
        await ctx.db.patch(miss._id, { missedAt: NOW - 25 * HOUR })
      }
    })
    await s.forecast([row])
    expect(net.geocodes()).toHaveLength(2)
  })

  test('a geocoder refusing us is not "no such place"', async () => {
    const net = fakeNetwork({ geocoder: 'refused' })
    const s = await setup()
    const rows = [at(TODAY), at(TODAY, 'Bayswater', '6053')]

    expect(await s.forecast(rows)).toEqual({})
    // Once for the view, not once per suburb…
    expect(net.geocodes()).toHaveLength(1)
    // …and nothing written down as missing, so the next view asks again.
    const misses = await s.t.run((ctx) =>
      ctx.db.query('geocodeMisses').collect(),
    )
    expect(misses).toHaveLength(0)
    await s.forecast(rows)
    expect(net.geocodes()).toHaveLength(2)
  })
})

describe('what is kept', () => {
  test('a gap in the forecast leaves that figure out, not the whole suburb', async () => {
    fakeNetwork({ places: { Morley: [morley] }, forecast: 'gap' })
    const s = await setup()
    const entry = Object.values(await s.forecast([at(TODAY)]))[0]
    expect(entry).toMatchObject({ maxTempC: 21 })
    expect(entry.rainMm).toBeUndefined()
  })

  test('a new forecast replaces the old one whole, not figure by figure', async () => {
    fakeNetwork({ places: { Morley: [morley] }, forecast: 'ok' })
    const s = await setup()
    await s.forecast([at(TODAY)])

    // Past its three hours.
    await s.t.run(async (ctx) => {
      for (const row of await ctx.db.query('weatherCache').collect()) {
        await ctx.db.patch(row._id, { fetchedAt: NOW - 4 * HOUR })
      }
    })
    fakeNetwork({ places: { Morley: [morley] }, forecast: 'gap' })
    const entry = Object.values(await s.forecast([at(TODAY)]))[0]
    expect(entry.rainMm).toBeUndefined()
  })

  test('once Open-Meteo answers again, today is the whole day again', async () => {
    fakeNetwork({ places: { Morley: [morley] }, forecast: 'refused' })
    const s = await setup()
    await s.forecast([at(TODAY)])

    vi.setSystemTime(NOW + 31 * 60_000)
    fakeNetwork({ places: { Morley: [morley] }, forecast: 'ok' })
    await s.forecast([at(TODAY)])
    // Read back from the cache, not from the answer just fetched.
    const again = Object.values(await s.forecast([at(TODAY)]))[0]
    expect(again).toMatchObject({ maxTempC: 21 })
    expect(again.partial).toBeUndefined()
  })
})

describe('a report’s weather', () => {
  async function report(s: Awaited<ReturnType<typeof setup>>) {
    const propertyId = await s.owner.as.mutation(api.properties.create, {
      businessId: s.businessId,
      clientName: 'J. Nguyen',
      addressLine: '12 Wattle Street',
      suburb: 'Morley',
      state: 'WA',
      postcode: '6062',
    })
    const reportId = await s.owner.as.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId,
      template: 'serviceReport',
      legalBasis: 'APVMA',
      data: {},
    })
    const fill = (dayKey: string) =>
      s.t.action(internal.weather.fillForReport, {
        reportId,
        state: 'WA',
        suburb: 'Morley',
        postcode: '6062',
        dayKey,
      })
    const suggested = async () =>
      (await s.t.run((ctx) => ctx.db.get(reportId)))?.prefill?.weather
    return { fill, suggested }
  }

  test('is never the rest of a day: the morning’s rain is what it would miss', async () => {
    fakeNetwork({ places: { Morley: [morley] }, forecast: 'refused' })
    const s = await setup()
    const r = await report(s)

    await r.fill(TODAY)
    expect(await r.suggested()).toBeUndefined()
    // The same source, for a whole day, is suggested.
    await r.fill(TOMORROW)
    expect(await r.suggested()).toEqual({ source: 'forecast' })
  })
})
