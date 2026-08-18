import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  signUpActor,
  uniqueEmail,
} from './fixtures'

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

  const result = await owner.client.action(api.weather.forDay, {
    businessId,
    suburb: 'Bayswater',
    postcode: '6053',
    state: 'WA',
    dayKey: todayKey(),
  })

  expect(result).not.toBeNull()
  expect(result!.suburb).toBe('Bayswater')
  // Perth in any season sits inside this range; a wildly different number
  // means the wrong place was geocoded.
  expect(result!.maxTempC).toBeGreaterThan(0)
  expect(result!.maxTempC).toBeLessThan(55)
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

  const wa = await owner.client.action(api.weather.forDay, {
    businessId,
    suburb: 'Bayswater',
    postcode: '6053',
    state: 'WA',
    dayKey,
  })
  const vic = await owner.client.action(api.weather.forDay, {
    businessId,
    suburb: 'Bayswater',
    postcode: '3153',
    state: 'VIC',
    dayKey,
  })

  expect(wa).not.toBeNull()
  expect(vic).not.toBeNull()

  // Cached per suburb+postcode, so these are genuinely two lookups. Perth and
  // Melbourne agreeing to the decimal on every measure would mean the state
  // filter is not doing anything.
  const identical =
    wa!.maxTempC === vic!.maxTempC &&
    wa!.minTempC === vic!.minTempC &&
    wa!.rainMm === vic!.rainMm &&
    wa!.windKmh === vic!.windKmh
  expect(identical).toBe(false)
})

test('an unknown suburb returns nothing rather than a guess', async () => {
  const { owner, businessId } = await business('weather-unknown')

  const result = await owner.client.action(api.weather.forDay, {
    businessId,
    suburb: 'Zzzqqx Not A Real Suburb',
    postcode: '0000',
    state: 'WA',
    dayKey: todayKey(),
  })

  expect(result).toBeNull()
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
      outsider.client.action(api.weather.forDay, {
        businessId,
        suburb: 'Bayswater',
        postcode: '6053',
        state: 'WA',
        dayKey: todayKey(),
      }),
    'NO_ACCESS',
  )
})
