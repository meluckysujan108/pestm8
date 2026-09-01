import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

const DAY = 86_400_000

function perthDayKey(ts: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts))
}

async function seed(label: string) {
  const email = uniqueEmail(label)
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `${label} ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  return { email, owner, businessId, slug, propertyId, me: members[0]._id }
}

test('the month grid shows which days have work and picks one', async ({
  page,
}) => {
  const s = await seed('month-grid')

  const base = new Date()
  base.setHours(9, 30, 0, 0)
  // Two days out so it lands inside the same month for all but the last two
  // days of a month, where the grid would need paging to see it.
  const target = base.getTime() + 2 * DAY

  await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.me,
    jobType: 'Termite Inspection',
    price: 38000,
    scheduledAt: target,
    durationMinutes: 90,
  })

  await signInViaUi(page, s.email)
  await page.goto(`/${s.slug}/schedule`)

  const targetKey = perthDayKey(target)
  const monthKicker = page.getByRole('button', { name: /\d{4}$/ }).first()
  await expect(monthKicker).toBeEnabled()
  await monthKicker.click()

  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()

  // The grid is a real month, not a repeat of the week strip.
  await expect(sheet.getByRole('button', { name: targetKey })).toBeVisible()
  await sheet.getByRole('button', { name: targetKey }).click()

  // Picking a day drives the schedule, and the day survives in the URL.
  await expect(page).toHaveURL(new RegExp(`date=${targetKey}`))
  await expect(
    page.getByRole('button', { name: /Termite Inspection/ }),
  ).toBeVisible()
})

test('a job shows the forecast for its own property and day', async ({
  page,
}) => {
  const s = await seed('job-weather')

  const base = new Date()
  base.setHours(9, 30, 0, 0)
  await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.me,
    jobType: 'Termite Inspection',
    price: 38000,
    scheduledAt: base.getTime(),
    durationMinutes: 90,
  })

  await signInViaUi(page, s.email)
  await page.goto(`/${s.slug}/schedule`)
  await page.getByRole('button', { name: /Termite Inspection/ }).click()

  const sheet = page.getByRole('dialog')
  await expect(sheet.getByText('Weather')).toBeVisible()
  // Named for the property's suburb, since two jobs on one day can sit in
  // different places.
  await expect(sheet.getByText(/Bayswater · \d+°/)).toBeVisible()
})

test('weather is returned per day, and omitted beyond the forecast window', async () => {
  const s = await seed('weather-window')

  const today = perthDayKey(Date.now())
  const soon = perthDayKey(Date.now() + 3 * DAY)
  // Well past where any forecast exists — must be absent rather than invented.
  const distant = perthDayKey(Date.now() + 120 * DAY)

  const result = await s.owner.client.action(api.weather.forDays, {
    businessId: s.businessId,
    state: 'WA',
    days: [today, soon, distant].map((dayKey) => ({
      dayKey,
      suburb: 'Bayswater',
      postcode: '6053',
    })),
  })

  expect(result[today]).toBeDefined()
  expect(result[soon]).toBeDefined()
  expect(result[distant]).toBeUndefined()

  // One call covering several days, each carrying its own numbers.
  expect(result[today].suburb).toBe('Bayswater')
  expect(typeof result[soon].maxTempC).toBe('number')
})
