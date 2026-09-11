import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/**
 * The three states a job card's forecast can be in, and the caching that makes
 * the first of them rare.
 *
 * The bug these guard: weather used to be fetched by a bare Convex action in a
 * `useEffect`, with no cache. Entries are keyed by suburb AND day, so on every
 * day change the retained map missed on every lookup and each card rendered
 * "No forecast" until the refetch landed — including when merely returning to a
 * day already looked at, and again on every remount.
 *
 * Scope, stated honestly: Playwright's assertions retry, so these lock the
 * SETTLED state, not the absence of a flash. A Convex action travels over the
 * sync WebSocket rather than as an HTTP request, so counting requests cannot
 * cheaply prove "this came from cache" either. What they do prove is that the
 * card ends up showing a forecast rather than "No forecast", and that a job
 * beyond the horizon shows nothing at all — the second of which is new
 * behaviour that would otherwise regress silently. The flash itself is
 * prevented by construction: the query is keyed per day and cached for 6h, so
 * a revisited day has no pending state to render.
 */

const DAY = 86_400_000

function perthDayKey(ts: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts))
}

async function seed(prefix: string, scheduledAt: number) {
  const email = uniqueEmail(prefix)
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `${prefix} ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
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
  await owner.client.mutation(api.jobs.create, {
    businessId,
    propertyId,
    assignedMembershipId: members.find((m) => m.role === 'owner')!._id,
    jobType: 'Termite Inspection',
    price: 38000,
    scheduledAt,
    durationMinutes: 90,
  })

  return { email, slug }
}

test('returning to a day already seen renders its forecast without a placeholder', async ({
  page,
}) => {
  const today = Date.now()
  const { email, slug } = await seed('weather-cache', today)
  await signInViaUi(page, email)

  const card = page.getByRole('button', { name: /Termite Inspection/ })

  await page.goto(`/${slug}/schedule`)
  await expect(card).toBeVisible()
  // First visit may legitimately show the placeholder while the forecast is in
  // flight; wait for it to settle before measuring anything.
  await expect(card.getByTestId('weather-pending')).toHaveCount(0)
  await expect(card).toContainText(/\d+°|No forecast/)

  // Leave the day, then come back. This is the exact move that used to blank
  // every card: same suburb, same job, a day key the map no longer matched.
  await page.goto(`/${slug}/schedule?date=${perthDayKey(today + 2 * DAY)}`)
  await expect(card).toHaveCount(0)
  await page.goto(`/${slug}/schedule`)

  // Served from the query cache, so the forecast is there on the first paint —
  // no placeholder, and above all never the word "No forecast".
  await expect(card).toBeVisible()
  await expect(card.getByTestId('weather-pending')).toHaveCount(0)
  await expect(card).not.toContainText('No forecast')
  await expect(card).toContainText(/\d+°/)
})

test('a job beyond the forecast horizon shows nothing, not "No forecast"', async ({
  page,
}) => {
  // Well past where any forecast exists. "No forecast" here would read as a
  // fault; the honest rendering is to say nothing at all, which is the
  // distinction the shared forecast window exists to draw.
  const distant = Date.now() + 120 * DAY
  const { email, slug } = await seed('weather-distant', distant)
  await signInViaUi(page, email)

  await page.goto(`/${slug}/schedule?date=${perthDayKey(distant)}`)

  const card = page.getByRole('button', { name: /Termite Inspection/ })
  await expect(card).toBeVisible()
  await expect(card.getByTestId('weather-pending')).toHaveCount(0)
  await expect(card).not.toContainText('No forecast')
  await expect(card).not.toContainText('°')
})
