import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  clickUntil,
  inviteAndJoin,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/**
 * The Phase 2 core loop (§6.2), driven through the UI rather than the API:
 * add a property, book work against it, see it on the day, open it, complete it.
 * This is the path the design partner replaces his wall calendar with, so it is
 * worth asserting end to end rather than per-function.
 */
test('an owner can add a property, book a job, and complete it', async ({
  page,
}) => {
  const email = uniqueEmail('loop-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { slug } = await owner.client.mutation(api.businesses.create, {
    name: `Loop ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  await signInViaUi(page, email)
  await expect(page).toHaveURL(new RegExp(`/${slug}/schedule$`))

  // --- add a client --------------------------------------------------------
  await page.goto(`/${slug}/clients`)
  await expect(page.getByText('No clients yet')).toBeVisible()

  const newProperty = page.getByRole('button', { name: 'New client' })
  await expect(newProperty).toBeEnabled()
  await newProperty.click()

  const propertySheet = page.getByRole('dialog')
  await expect(propertySheet.getByText('New client')).toBeVisible()

  await propertySheet.getByLabel('Client name').fill('J. Nguyen')
  await propertySheet.getByLabel('Street address').fill('12 Wattle Street')
  await propertySheet.getByLabel('Suburb').fill('Bayswater')
  await propertySheet.getByLabel('Postcode').fill('6053')
  await propertySheet.getByLabel('Phone (optional)').fill('0412345678')
  await propertySheet.getByRole('button', { name: 'Save client' }).click()

  await expect(page.getByText('12 Wattle Street')).toBeVisible()
  // Rows show the suburb; the street address belongs to the detail view (§2.3).
  await expect(page.getByText('Bayswater')).toBeVisible()

  // --- book a job ---------------------------------------------------------
  await page.goto(`/${slug}/schedule`)
  await expect(page.getByText('Nothing booked')).toBeVisible()

  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const jobSheet = page.getByRole('dialog')
  await expect(jobSheet.getByText('New job')).toBeVisible()

  await jobSheet.getByLabel('Job type').click()
  await page
    .getByRole('button', { name: 'Termite Inspection', exact: true })
    .click()
  await jobSheet.getByLabel('Start').fill('09:30')
  await jobSheet.getByLabel('Price (AUD)').fill('380')
  await jobSheet.getByRole('button', { name: 'Book job' }).click()

  // --- it appears on the day ---------------------------------------------
  const card = page.getByRole('button', { name: /Termite Inspection/ })
  await expect(card).toBeVisible()
  await expect(page.getByText('$380')).toBeVisible()
  // A job booked by hand starts Pending (convex/lib/jobStatus.ts). Scoped to
  // the card: the desktop day panel also has a "Pending" status filter, so an
  // unscoped match is ambiguous about which one is being asserted — and it is
  // the card's status pill that matters here.
  await expect(card.getByText('Pending')).toBeVisible()

  // --- open and complete it ----------------------------------------------
  await card.click()

  const detail = page.getByRole('dialog')
  // Full street address here, unlike the list row.
  await expect(detail.getByText('12 Wattle Street')).toBeVisible()
  // Short labels (not "Hold to call") since Call/Text/Email now share one
  // row — the hold-to-confirm behaviour itself is unchanged (§2.3).
  await expect(detail.getByRole('button', { name: /^Call /i })).toBeVisible()

  // Status is changed from a menu on the pill itself, not a dedicated button.
  await detail.getByRole('button', { name: 'Change job status' }).click()
  await page.getByRole('menuitem', { name: 'Completed' }).click()

  await expect(detail.getByText('Completed')).toBeVisible()

  // --- and analytics reflects it ------------------------------------------
  await page.goto(`/${slug}/analytics`)
  await expect(page.getByText('$380')).toBeVisible()
  await expect(
    page.getByText('1 job completed and not yet billed'),
  ).toBeVisible()
})

test('a subcontractor sees only their own day', async ({ page }) => {
  const ownerEmail = uniqueEmail('scope-owner')
  const subEmail = uniqueEmail('scope-sub')
  const owner = await signUpActor(ownerEmail, FIXTURE_PASSWORD, 'Terence')
  const sub = await signUpActor(subEmail, FIXTURE_PASSWORD, 'Kevin')

  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `Scope ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )

  await inviteAndJoin(owner, sub, businessId)

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
  const ownerMembershipId = members.find((m) => m.role === 'owner')!._id

  await owner.client.mutation(api.jobs.create, {
    businessId,
    propertyId,
    assignedMembershipId: ownerMembershipId,
    jobType: 'Termite Inspection',
    price: 38000,
    scheduledAt: Date.now(),
    durationMinutes: 90,
  })

  // The subcontractor's schedule is empty: the owner's job is never sent to
  // their client, not merely hidden once it arrives.
  await signInViaUi(page, subEmail)
  await page.goto(`/${slug}/schedule`)
  await expect(page.getByText('Nothing booked')).toBeVisible()
  await expect(page.getByText('Termite Inspection')).toHaveCount(0)
})

/** One owner, one property, one job today — the setup both card tests need. */
async function seedOneJob(prefix: string) {
  const email = uniqueEmail(prefix)
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `${prefix} ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    },
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
  const ownerMembershipId = members.find((m) => m.role === 'owner')!._id

  await owner.client.mutation(api.jobs.create, {
    businessId,
    propertyId,
    assignedMembershipId: ownerMembershipId,
    jobType: 'Termite Inspection',
    price: 38000,
    scheduledAt: Date.now(),
    durationMinutes: 90,
  })

  return { email, slug }
}

/**
 * Pins §2.3 as amended in Phase 4: the card and the table row both show the
 * suburb alone. The street address is not lost — the card's Map button takes
 * it to the maps app, and the detail sheet prints it in full — but it is no
 * longer read off the card.
 */
test('the job card and the table row both show the suburb alone', async ({
  page,
}) => {
  const { email, slug } = await seedOneJob('cardvariant')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)

  const view = page.getByRole('tablist', { name: 'View' })
  const card = page.getByRole('button', { name: /Termite Inspection/ })
  await expect(card).toBeVisible()

  // "Job" — the cards — is the default; the others are the table and, since
  // Phase 4.4, the week.
  await expect(view.getByRole('tab', { name: 'Job' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(view.getByRole('tab')).toHaveCount(3)
  await expect(view.getByRole('tab', { name: 'List' })).toHaveCount(0)
  await expect(card).toContainText('Bayswater')
  await expect(page.getByText('12 Wattle Street')).toHaveCount(0)
  // Not dropped: one tap from the card, in the maps app.
  await expect(
    page.getByRole('link', { name: 'Map of 12 Wattle Street, Bayswater' }),
  ).toBeVisible()

  // A tab click that lands on server-rendered markup is swallowed, and the
  // view never switches — "New job" enables on hydration, the signal the
  // other schedule tests wait on too.
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  await view.getByRole('tab', { name: 'Table' }).click()
  // Scoped to the table: the desktop day panel prints the same suburb in its
  // weather banner.
  await expect(page.getByRole('table').getByText('Bayswater')).toBeVisible()
  await expect(page.getByText('12 Wattle Street')).toHaveCount(0)
})

/**
 * The chosen view lives in a search param rather than component state (§5.1),
 * so it has to survive a reload — the same promise `?date=` already makes.
 */
test('the chosen card view is kept in the URL and survives a reload', async ({
  page,
}) => {
  const { email, slug } = await seedOneJob('cardview')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)

  await clickUntil(
    page
      .getByRole('tablist', { name: 'View' })
      .getByRole('tab', { name: 'Table' }),
    () => expect(page).toHaveURL(/view=table/, { timeout: 2_000 }),
  )

  await page.reload()
  await expect(
    page.getByRole('button', { name: /Termite Inspection/ }),
  ).toBeVisible()
  // Still the table. Card and row both show the suburb alone now, so the
  // table itself is what tells the two views apart.
  await expect(page.getByRole('table')).toBeVisible()

  // A link to the retired List view must not leave the page blank; it opens
  // the default view instead.
  await page.goto(`/${slug}/schedule?view=list`)
  await expect(
    page.getByRole('button', { name: /Termite Inspection/ }),
  ).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
})

/**
 * Deliberately tolerant: the forecast comes from a live third-party API, so
 * this asserts the strip reaches one of its two defined states rather than a
 * particular temperature. `e2e/weather.spec.ts` covers the forecast itself.
 */
test('a job card renders a weather panel for its own suburb', async ({
  page,
}) => {
  const { email, slug } = await seedOneJob('cardweather')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)

  const card = page.getByRole('button', { name: /Termite Inspection/ })
  // The forecast now arrives asynchronously behind a placeholder rather than
  // rendering "No forecast" synchronously on first paint, so wait for the
  // placeholder to resolve before asserting. Without this the assertion races
  // a live geocode + forecast round trip and passes or fails on timing.
  await expect(card.getByTestId('weather-pending')).toHaveCount(0)
  await expect(card).toContainText(/\d+°|No forecast/)
})

/** A Perth day, as the schedule's `?date=` names it. */
function perthKey(ts: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts))
}

/** "YYYY-MM-DD" plus `days`, by the calendar. */
function plusDays(dayKey: string, days: number) {
  const d = new Date(`${dayKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Next week, Monday to Sunday — wholly ahead of today whatever day the suite
 * runs, so every projection in it is a future one: counted apart, not drawn.
 * Monday holds a daily series' hand-booked first visit, and Tuesday a job
 * booked by hand; the series projects one visit onto each of Tuesday to
 * Sunday.
 */
async function seedNextWeek(prefix: string) {
  const email = uniqueEmail(prefix)
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `${prefix} ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    },
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
  const ownerMembershipId = members.find((m) => m.role === 'owner')!._id

  const today = perthKey(Date.now())
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7
  const monday = plusDays(today, 7 - weekday)
  const tuesday = plusDays(monday, 1)
  const perthAt = (dayKey: string, hour: number) =>
    Date.parse(`${dayKey}T${String(hour).padStart(2, '0')}:00:00+08:00`)

  await owner.client.mutation(api.recurrences.create, {
    businessId,
    propertyId,
    assignedMembershipId: ownerMembershipId,
    intervalCount: 1,
    intervalUnit: 'day',
    jobType: 'Rodent Baiting',
    price: 12000,
    anchorDate: perthAt(monday, 10),
    durationMinutes: 30,
  })
  await owner.client.mutation(api.jobs.create, {
    businessId,
    propertyId,
    assignedMembershipId: ownerMembershipId,
    jobType: 'Termite Inspection',
    price: 38000,
    scheduledAt: perthAt(tuesday, 14),
    durationMinutes: 90,
  })

  return { email, slug, monday, tuesday }
}

/**
 * Phase 4.4: the week, with booked jobs and projected visits as two numbers
 * that are never added together.
 */
test('the week view lists the week’s jobs and counts recurring visits apart', async ({
  page,
}) => {
  const s = await seedNextWeek('weekview')
  await signInViaUi(page, s.email)
  await page.goto(`/${s.slug}/schedule?view=week&date=${s.monday}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()

  // The week's totals, side by side: the Monday visit and the Tuesday job,
  // then Tuesday to Sunday's six projections — never "8".
  await expect(page.getByText('2 jobs', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('· 6 recurring visits')).toBeVisible()

  const tuesday = page.locator(`#week-day-${s.tuesday}`)
  await expect(tuesday.getByText('1 job', { exact: true })).toBeVisible()
  await expect(
    tuesday.getByRole('link', { name: '1 recurring visit not yet booked' }),
  ).toBeVisible()
  // Booked work is drawn; a projection still ahead of its day is not.
  await expect(
    tuesday.getByRole('button', { name: /Termite Inspection/ }),
  ).toBeVisible()
  await expect(tuesday.getByText('Rodent Baiting')).toHaveCount(0)

  // On a phone the strip says the same, as the day's description.
  if (test.info().project.name === 'mobile') {
    await expect(
      page.getByRole('button', { name: s.tuesday, exact: true }),
    ).toHaveAccessibleDescription('1 job, 1 recurring visit not yet booked')
  }
})

test('a block opens its job, and a day opens its own view with Back returning to the week', async ({
  page,
}) => {
  const s = await seedNextWeek('weeknav')
  await signInViaUi(page, s.email)
  await page.goto(`/${s.slug}/schedule?view=week&date=${s.monday}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()

  const tuesday = page.locator(`#week-day-${s.tuesday}`)
  await clickUntil(
    tuesday.getByRole('button', { name: /Termite Inspection/ }),
    () => expect(page.getByRole('dialog')).toBeVisible({ timeout: 2_000 }),
  )
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await tuesday.locator(`#week-day-${s.tuesday}-heading`).click()
  await expect(page).toHaveURL(new RegExp(`date=${s.tuesday}`))
  await expect(page).toHaveURL(/view=job/)
  await expect(
    page
      .getByRole('tablist', { name: 'View' })
      .getByRole('tab', { name: 'Job' }),
  ).toHaveAttribute('aria-selected', 'true')

  await page.goBack()
  await expect(page).toHaveURL(/view=week/)
  await expect(page.locator(`#week-day-${s.monday}`)).toBeVisible()
})

test('the week is kept in the URL, and a view that does not exist falls back', async ({
  page,
}) => {
  const s = await seedNextWeek('weekurl')
  await signInViaUi(page, s.email)
  await page.goto(`/${s.slug}/schedule?view=week&date=${s.monday}`)

  const week = page
    .getByRole('tablist', { name: 'View' })
    .getByRole('tab', { name: 'Week' })
  await expect(week).toHaveAttribute('aria-selected', 'true')
  await page.reload()
  await expect(week).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator(`#week-day-${s.monday}`)).toBeVisible()

  await page.goto(`/${s.slug}/schedule?view=weekly&date=${s.monday}`)
  await expect(
    page
      .getByRole('tablist', { name: 'View' })
      .getByRole('tab', { name: 'Job' }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator(`#week-day-${s.monday}`)).toHaveCount(0)
})

/**
 * The strip sits under a sticky header whose height viewMenu.spec.ts pins, at
 * a hard-coded offset — so a strip that grew to hold the recurring number
 * would slide under it. Same height in the week as in the day.
 */
test('the phone’s sticky strip is the same height in the week as in the day', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'mobile', 'phone layout only')
  const s = await seedNextWeek('weekstrip')
  await signInViaUi(page, s.email)

  const chrome = page.locator('[data-schedule-chrome]')
  await page.goto(`/${s.slug}/schedule?view=job&date=${s.monday}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  const dayHeight = (await chrome.boundingBox())!.height

  await page.goto(`/${s.slug}/schedule?view=week&date=${s.monday}`)
  await expect(page.locator(`#week-day-${s.monday}`)).toBeVisible()
  const weekHeight = (await chrome.boundingBox())!.height

  expect(Math.abs(weekHeight - dayHeight)).toBeLessThanOrEqual(0.5)
})
