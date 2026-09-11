import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { weatherKeyOf } from '../convex/lib/forecastWindow'

async function business(label: string, state = 'WA') {
  const owner = await signUpActor(
    uniqueEmail(label),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { businessId } = await owner.client.mutation(api.businesses.create, {
    name: `${label} ${Date.now()}`,
    state,
    timezone: 'Australia/Perth',
  })
  return { owner, businessId }
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

test('a forecast comes back for an Australian suburb', async () => {
  const { owner, businessId } = await business('weather-ok')

  const dayKey = todayKey()
  const result = await owner.client.action(api.weather.forDays, {
    businessId,
    state: 'WA',
    days: [{ dayKey, suburb: 'Bayswater', postcode: '6053' }],
  })

  const entry = result[weatherKeyOf('Bayswater', '6053', dayKey)]
  expect(entry).toBeDefined()
  expect(entry.suburb).toBe('Bayswater')
  // Perth in any season sits inside this range; a wildly different number
  // means the wrong place was geocoded.
  expect(entry.maxTempC).toBeGreaterThan(0)
  expect(entry.maxTempC).toBeLessThan(55)
})

/**
 * The bug this guards: `country=AU` is silently ignored by Open-Meteo, so
 * "Bayswater" returned Bayswater, New Zealand. And even within Australia the
 * name exists in both WA and Victoria — roughly 3,000 km apart. A technician
 * deciding whether to spray based on the wrong city's rainfall is worse off
 * than one shown nothing at all.
 */
test('the same suburb name in two states resolves to different places', async () => {
  const { owner, businessId } = await business('weather-states')
  const dayKey = todayKey()

  // Two calls, not one: `forDays` takes `state` at the top level, so a single
  // call could only ever resolve one of these two Bayswaters.
  const waAll = await owner.client.action(api.weather.forDays, {
    businessId,
    state: 'WA',
    days: [{ dayKey, suburb: 'Bayswater', postcode: '6053' }],
  })
  const vicAll = await owner.client.action(api.weather.forDays, {
    businessId,
    state: 'VIC',
    days: [{ dayKey, suburb: 'Bayswater', postcode: '3153' }],
  })
  const wa = waAll[weatherKeyOf('Bayswater', '6053', dayKey)]
  const vic = vicAll[weatherKeyOf('Bayswater', '3153', dayKey)]

  expect(wa).toBeDefined()
  expect(vic).toBeDefined()

  // Cached per suburb+postcode, so these are genuinely two lookups. Perth and
  // Melbourne agreeing to the decimal on every measure would mean the state
  // filter is not doing anything.
  const identical =
    wa.maxTempC === vic.maxTempC &&
    wa.minTempC === vic.minTempC &&
    wa.rainMm === vic.rainMm &&
    wa.windKmh === vic.windKmh
  expect(identical).toBe(false)
})

test('an unknown suburb returns nothing rather than a guess', async () => {
  const { owner, businessId } = await business('weather-unknown')

  const dayKey = todayKey()
  // Asked alongside a suburb that DOES resolve. `forDays` returns a map, so a
  // lone unknown suburb would come back as `{}` — which is also what a network
  // failure, an auth failure or an empty request returns. Pairing them makes
  // the absence mean what this test says it means.
  const result = await owner.client.action(api.weather.forDays, {
    businessId,
    state: 'WA',
    days: [
      { dayKey, suburb: 'Zzzqqx Not A Real Suburb', postcode: '0000' },
      { dayKey, suburb: 'Bayswater', postcode: '6053' },
    ],
  })

  expect(result[weatherKeyOf('Bayswater', '6053', dayKey)]).toBeDefined()
  expect(
    result[weatherKeyOf('Zzzqqx Not A Real Suburb', '0000', dayKey)],
  ).toBeUndefined()
})

test('a non-member cannot pull weather for a business', async () => {
  const { businessId } = await business('weather-scope')
  const outsider = await signUpActor(
    uniqueEmail('outsider'),
    FIXTURE_PASSWORD,
    'Outsider',
  )

  await expectRejected(
    () =>
      outsider.client.action(api.weather.forDays, {
        businessId,
        state: 'WA',
        days: [{ dayKey: todayKey(), suburb: 'Bayswater', postcode: '6053' }],
      }),
    'NO_ACCESS',
  )
})
