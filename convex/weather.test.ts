/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { dayKeyOf, startOfDayInZone } from './lib/dates'

/**
 * The forecast behind the job cards (convex/weather.ts), with the network
 * faked: which place a suburb resolves to, what is asked again and what is
 * not, and MET Norway answering when Open-Meteo will not.
 */

const PERTH = 'Australia/Perth'

type Place = {
  name: string
  latitude: number
  longitude: number
  admin1: string
  feature_code: string
}

/** A fake network: the geocoder's answers by name, and whether Open-Meteo's
 * forecast answers. Records every request. */
function fakeNetwork(opts: {
  places?: Record<string, Array<Place>>
  forecast?: 'ok' | 'refused' | 'gap'
}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const today = dayKeyOf(Date.now(), PERTH)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  const fetchFake = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })
    if (url.includes('geocoding-api.open-meteo.com')) {
      const name = new URL(url).searchParams.get('name') ?? ''
      return json({
        results: (opts.places?.[name] ?? []).map((p) => ({
          ...p,
          country_code: 'AU',
        })),
      })
    }
    if (url.includes('api.open-meteo.com/v1/forecast')) {
      if (opts.forecast === 'refused') {
        return json(
          { error: true, reason: 'Daily API request limit exceeded' },
          429,
        )
      }
      return json({
        daily: {
          time: [today],
          weather_code: [3],
          temperature_2m_max: [21],
          temperature_2m_min: [11],
          precipitation_sum: [opts.forecast === 'gap' ? null : 0.4],
          wind_speed_10m_max: [18],
        },
      })
    }
    if (url.includes('api.met.no')) {
      const midnight = startOfDayInZone(today, PERTH)
      const hour = (h: number) =>
        new Date(midnight + h * 3600_000).toISOString()
      return json({
        properties: {
          timeseries: [9, 12, 15].map((h) => ({
            time: hour(h),
            data: {
              instant: {
                details: { air_temperature: 17 + h / 3, wind_speed: 5 },
              },
              next_1_hours: {
                summary: { symbol_code: 'cloudy' },
                details: { precipitation_amount: 0.1 },
              },
            },
          })),
        },
      })
    }
    return new Response('not faked', { status: 500 })
  })
  vi.stubGlobal('fetch', fetchFake)
  return { calls, today }
}

const morley: Place = {
  name: 'Morley',
  latitude: -31.88775,
  longitude: 115.9099,
  admin1: 'Western Australia',
  feature_code: 'PPLX',
}

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId } = await createBusiness(t, owner) // a WA business
  const forecast = (days: Array<Record<string, string>>) =>
    owner.as.action(api.weather.forDays, {
      businessId,
      state: 'WA',
      days: days as Array<{ dayKey: string; suburb: string; postcode: string }>,
    })
  return { t, forecast }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('when Open-Meteo will not answer', () => {
  test('MET Norway does, and the card still gets its forecast', async () => {
    const net = fakeNetwork({
      places: { Morley: [morley] },
      forecast: 'refused',
    })
    const s = await setup()

    const out = await s.forecast([
      { dayKey: net.today, suburb: 'Morley', postcode: '6062' },
    ])
    const entry = Object.values(out)[0]
    expect(entry).toMatchObject({ maxTempC: 22, minTempC: 20, windKmh: 18 })
    expect(entry.rainMm).toBeCloseTo(0.3)

    const met = net.calls.find((c) => c.url.includes('api.met.no'))!
    // Its terms: say who is asking, and four decimals at most.
    expect(met.headers['user-agent']).toMatch(/^PestM8\//)
    expect(met.url).toContain('lat=-31.8878&lon=115.9099')
  })

  test('…and when Open-Meteo answers, MET Norway is not asked at all', async () => {
    const net = fakeNetwork({ places: { Morley: [morley] }, forecast: 'ok' })
    const s = await setup()
    await s.forecast([
      { dayKey: net.today, suburb: 'Morley', postcode: '6062' },
    ])
    expect(net.calls.some((c) => c.url.includes('api.met.no'))).toBe(false)
  })
})

describe('finding the suburb', () => {
  test('in the property’s own state, not the business’s', async () => {
    const net = fakeNetwork({
      places: {
        Darwin: [
          {
            name: 'Darwin',
            latitude: -12.46,
            longitude: 130.84,
            admin1: 'Northern Territory',
            feature_code: 'PPLA',
          },
        ],
      },
    })
    const s = await setup()

    const asBusiness = await s.forecast([
      { dayKey: net.today, suburb: 'Darwin', postcode: '0800' },
    ])
    expect(Object.keys(asBusiness)).toHaveLength(0)

    const asProperty = await s.forecast([
      { dayKey: net.today, suburb: 'Darwin', postcode: '0800', state: 'NT' },
    ])
    expect(Object.values(asProperty)[0]).toMatchObject({ maxTempC: 21 })
  })

  test('a populated place, not a dam or a park of the same name', async () => {
    const net = fakeNetwork({
      places: {
        Morley: [
          { ...morley, name: 'Morley Dam', latitude: -30, feature_code: 'DAM' },
          morley,
        ],
      },
    })
    const s = await setup()
    const out = await s.forecast([
      { dayKey: net.today, suburb: 'Morley', postcode: '6062' },
    ])
    expect(Object.values(out)[0]).toMatchObject({ lat: -31.88775 })
  })

  test('"Mt Lawley" is tried as "Mount Lawley"', async () => {
    const net = fakeNetwork({
      places: { 'Mount Lawley': [{ ...morley, name: 'Mount Lawley' }] },
    })
    const s = await setup()
    const out = await s.forecast([
      { dayKey: net.today, suburb: 'Mt Lawley', postcode: '6050' },
    ])
    expect(Object.keys(out)).toHaveLength(1)
  })

  test('a place that does not exist is asked about once, not on every view', async () => {
    const net = fakeNetwork({})
    const s = await setup()
    const row = { dayKey: net.today, suburb: 'Fannybay', postcode: '0810' }
    await s.forecast([row])
    await s.forecast([row])
    const geocodes = net.calls.filter((c) => c.url.includes('geocoding-api'))
    expect(geocodes).toHaveLength(1)
  })
})

test('a gap in the forecast leaves that figure out, not the whole suburb', async () => {
  const net = fakeNetwork({ places: { Morley: [morley] }, forecast: 'gap' })
  const s = await setup()
  const out = await s.forecast([
    { dayKey: net.today, suburb: 'Morley', postcode: '6062' },
  ])
  const entry = Object.values(out)[0]
  expect(entry).toMatchObject({ maxTempC: 21 })
  expect(entry.rainMm).toBeUndefined()
})
