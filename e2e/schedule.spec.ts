import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  chooseStatus,
  chooseJobTypes,
  chooseProperty,
  clickUntil,
  inviteAndJoin,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  skipNearPerthMidnight,
  uniqueEmail,
} from './fixtures'
import { weatherKeyOf } from '../convex/lib/forecastWindow'

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

  await chooseProperty(page, jobSheet, 'Nguyen', /J\. Nguyen/)
  await chooseJobTypes(page, jobSheet, ['Termite Inspection'])
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

  // Status is changed from the pill itself, not a dedicated button.
  await chooseStatus(page, 'Completed')

  await expect(detail.getByText('Completed')).toBeVisible()

  // --- and analytics reflects it ------------------------------------------
  await page.goto(`/${slug}/analytics`)
  // Revenue, the average job and the work still to bill all say it.
  await expect(page.getByText('$380').first()).toBeVisible()
  await expect(
    page.getByText('1 job finished and not yet billed.'),
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
 * Pins §2.3 as amended in Phase 4: the card shows the suburb alone. The street
 * address is not lost — the card's Map button takes it to the maps app, and
 * the detail sheet prints it in full — but it is no longer read off the card.
 * The day reads one way now, as cards: the Table view was retired.
 */
test('the job card shows the suburb alone, and the views are Job, Week and Recurring', async ({
  page,
}) => {
  const { email, slug } = await seedOneJob('cardvariant')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)

  const view = page.getByRole('tablist', { name: 'View' })
  const card = page.getByRole('button', { name: /Termite Inspection/ })
  await expect(card).toBeVisible()

  await expect(view.getByRole('tab', { name: 'Job' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(view.getByRole('tab')).toHaveCount(3)
  await expect(view.getByRole('tab', { name: 'Week' })).toBeVisible()
  await expect(view.getByRole('tab', { name: 'Recurring' })).toBeVisible()
  await expect(view.getByRole('tab', { name: 'Table' })).toHaveCount(0)
  await expect(view.getByRole('tab', { name: 'List' })).toHaveCount(0)
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(card).toContainText('Bayswater')
  await expect(page.getByText('12 Wattle Street')).toHaveCount(0)
  // Not dropped: a hold away, in the maps app.
  await expect(
    page.getByRole('button', { name: 'Map of 12 Wattle Street, Bayswater' }),
  ).toBeVisible()
})

/**
 * The switch itself, clicked: the view lives in a search param rather than
 * component state (§5.1), so it goes into the URL and survives a reload, and
 * switching back returns the cards.
 */
test('the Job | Week switch is kept in the URL and survives a reload', async ({
  page,
}) => {
  const { email, slug } = await seedOneJob('viewswitch')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()

  const view = page.getByRole('tablist', { name: 'View' })
  await clickUntil(view.getByRole('tab', { name: 'Week' }), () =>
    expect(page).toHaveURL(/view=week/, { timeout: 2_000 }),
  )

  await page.reload()
  await expect(view.getByRole('tab', { name: 'Week' })).toHaveAttribute(
    'aria-selected',
    'true',
  )

  await clickUntil(view.getByRole('tab', { name: 'Job' }), () =>
    expect(page).toHaveURL(/view=job/, { timeout: 2_000 }),
  )
  await expect(view.getByRole('tab', { name: 'Job' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
})

/**
 * A bookmark or a shared link to a retired view must not leave the page blank
 * or fail validation: it opens the cards.
 */
test('a link to a retired view opens the cards', async ({ page }) => {
  const { email, slug } = await seedOneJob('cardview')

  await signInViaUi(page, email)
  for (const retired of ['table', 'list']) {
    await page.goto(`/${slug}/schedule?view=${retired}`)
    await expect(
      page.getByRole('button', { name: /Termite Inspection/ }),
    ).toBeVisible()
    await expect(
      page
        .getByRole('tablist', { name: 'View' })
        .getByRole('tab', { name: 'Job' }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('table')).toHaveCount(0)
  }
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

/**
 * A card is as tall while its forecast is on the way as once it has landed,
 * so nothing below it moves when the forecast arrives, or when signal comes
 * back to a phone that had none. At 390px the placeholder was one row (62px)
 * and the forecast wrapped to two, so every card grew 49px.
 *
 * The forecast is held on the socket until the placeholder is measured, then
 * answered here with the longest words a strip can hold: the live one might
 * be "No forecast", and its words change from day to day.
 */
test('a job card keeps its height when its forecast lands', async ({
  page,
}) => {
  const { email, slug } = await seedOneJob('cardweatherheight')

  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  const convexHost = new URL(process.env.VITE_CONVEX_URL!).host
  await page.routeWebSocket(
    (url) => url.host === convexHost,
    (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => {
        const sent = typeof message === 'string' ? JSON.parse(message) : null
        if (sent?.type !== 'Action' || sent.udfPath !== 'weather:forDays') {
          server.send(message)
          return
        }
        const { days } = sent.args[0] as {
          days: Array<{ dayKey: string; suburb: string; postcode: string }>
        }
        const result = Object.fromEntries(
          days.map((d) => [
            weatherKeyOf(d.suburb, d.postcode, d.dayKey),
            {
              suburb: d.suburb,
              code: 85,
              partial: true,
              maxTempC: 38,
              minTempC: 24,
              rainMm: 12.5,
              windKmh: 46,
            },
          ]),
        )
        void released.then(() =>
          ws.send(
            JSON.stringify({
              type: 'ActionResponse',
              requestId: sent.requestId,
              success: true,
              result,
              logLines: [],
            }),
          ),
        )
      })
      server.onMessage((message) => ws.send(message))
    },
  )

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)

  const card = page.getByRole('button', { name: /Termite Inspection/ })
  await expect(card.getByTestId('weather-pending')).toBeVisible()
  const pending = (await card.boundingBox())!.height

  release()
  await expect(card).toContainText('Snow showers · rest of today')
  await expect(card.getByTestId('weather-pending')).toHaveCount(0)
  expect((await card.boundingBox())!.height).toBeCloseTo(pending, 1)
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

  // Nowhere is the week, or a day, one summed number.
  await expect(page.getByText(/\b8 jobs\b/)).toHaveCount(0)
  await expect(tuesday.getByText('2 jobs', { exact: true })).toHaveCount(0)

  // On a phone the strip says the same: the job count and the recurring
  // number drawn apart, and read out as a sentence.
  if (test.info().project.name === 'mobile') {
    const cell = page.getByRole('button', { name: s.tuesday, exact: true })
    await expect(cell.getByTestId('strip-jobs')).toHaveText('1')
    await expect(cell.getByTestId('strip-recurring')).toHaveText('1')
    await expect(cell).toHaveAccessibleDescription(
      '1 job, 1 recurring visit not yet booked',
    )
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
 * A strip that grew to hold the recurring number would shift the day below it
 * as the reader pages between weeks. Measured on a week that has recurring
 * numbers and on one that has none, so the number's own height is what is
 * compared.
 */
test('the phone’s week strip is no taller for holding recurring numbers', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'mobile', 'phone layout only')
  const s = await seedNextWeek('weekstrip')
  await signInViaUi(page, s.email)

  const chrome = page.locator('[data-schedule-chrome]')
  const heightOf = async (dayKey: string) => {
    await page.goto(`/${s.slug}/schedule?view=week&date=${dayKey}`)
    await expect(page.locator(`#week-day-${dayKey}`)).toBeVisible()
    return (await chrome.boundingBox())!.height
  }

  const withRecurring = await heightOf(s.monday)
  await expect(page.getByTestId('strip-recurring').first()).toBeVisible()
  // Thirty weeks out is past the six-month projection horizon: no jobs and
  // no projected visits, so no numbers in the strip at all.
  const empty = plusDays(s.monday, 30 * 7)
  const without = await heightOf(empty)
  await expect(page.getByTestId('strip-recurring')).toHaveCount(0)

  expect(Math.abs(withRecurring - without)).toBeLessThanOrEqual(0.5)
})

/**
 * Changing view or filter moves nothing (6 Nov 2026). The View switch keeps
 * its place on every view, and the heading with its one line keeps its
 * place and height, so the cards start where they did; the day's filters
 * are one icon, its choices kept in the address through a reload and a
 * change of view. Chips beside the switch had changed width with the word
 * chosen and, on a phone, taken a row the other views didn't have.
 */
test('changing view or filter moves nothing, and the filters are kept in the address', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('schedule-filters')
  // Kevin's job beside the owner's, so the filters have someone to choose.
  await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.subMembershipId,
    jobType: 'General Pest Control',
    price: 19500,
    scheduledAt: s.ownerJobAt,
    durationMinutes: 60,
  })
  const ownJob = page.getByRole('button', { name: /Termite Inspection/ })
  const kevinsJob = page.getByRole('button', { name: /General Pest Control/ })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${s.ownerJobDay}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  await expect(ownJob).toBeVisible()

  // Where the switch and the heading are on the page, from its top: the
  // week scrolls to its day on arrival, which is not a move of the layout.
  const place = async () => {
    await page.evaluate(() => window.scrollTo(0, 0))
    return page.evaluate(() => {
      const at = (selector: string) => {
        const box = document.querySelector(selector)!.getBoundingClientRect()
        return {
          x: Math.round(box.x),
          top: Math.round(box.top + window.scrollY),
          bottom: Math.round(box.bottom + window.scrollY),
        }
      }
      return {
        view: at('[role="tablist"][aria-label="View"]'),
        heading: at('[data-view-heading]'),
      }
    })
  }
  const start = await place()

  // The filters, behind their icon: a status and a person, as chosen.
  const filters = page.getByRole('button', { name: /^Filter and sort/ })
  await clickUntil(filters, () =>
    expect(page.getByRole('dialog')).toBeVisible({ timeout: 2_000 }),
  )
  const sheet = page.getByRole('dialog')
  await sheet
    .getByRole('group', { name: 'Status' })
    .getByRole('button')
    .nth(1)
    .click()
  await expect(page).toHaveURL(/[?&]status=\w+/)
  await sheet.getByRole('button', { name: /Kevin/ }).click()
  await expect(page).toHaveURL(/[?&]staff=\w+/)
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(ownJob).toBeHidden()
  await expect(kevinsJob).toBeVisible()
  await expect(filters).toHaveAccessibleName('Filter and sort, 2 on')
  expect(await place()).toEqual(start)

  // Through a reload.
  await page.reload()
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  await expect(kevinsJob).toBeVisible()
  await expect(ownJob).toBeHidden()
  await expect(filters).toHaveAccessibleName('Filter and sort, 2 on')

  // Every view: the switch and the heading where they were.
  const view = page.getByRole('tablist', { name: 'View' })
  await clickUntil(view.getByRole('tab', { name: 'Week' }), () =>
    expect(page).toHaveURL(/[?&]view=week/, { timeout: 2_000 }),
  )
  await expect(page.locator(`#week-day-${s.ownerJobDay}`)).toBeVisible()
  expect(await place()).toEqual(start)
  await view.getByRole('tab', { name: 'Recurring' }).click()
  await expect(
    page.getByText('No Recurring Jobs yet', { exact: true }),
  ).toBeVisible()
  expect(await place()).toEqual(start)

  // Back on the day, the filters are as they were; Clear filters clears
  // them from the address too.
  await view.getByRole('tab', { name: 'Job' }).click()
  await expect(kevinsJob).toBeVisible()
  await expect(page).toHaveURL(/[?&]status=\w+/)
  expect(await place()).toEqual(start)
  await filters.click()
  await sheet.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page).not.toHaveURL(/[?&](status|staff)=/)
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(ownJob).toBeVisible()
  await expect(filters).toHaveAccessibleName('Filter and sort')
})

/**
 * Release 2 of the filters (6 Nov 2026): the day sorts by suburb and filters
 * by service, both kept in the address; the person chosen is the week's and
 * the Recurring view's filter too, and the Recurring view sorts its
 * services.
 */
test('the day sorts by suburb and filters by service; the week and Recurring filter by person', async ({
  page,
}) => {
  // Kevin's job is half an hour after the fixture's, on the same day.
  skipNearPerthMidnight('books a job after the fixture’s', 30 * 60_000)
  const s = await setupBusinessWithSub('schedule-sorts')
  const armadale = await s.owner.client.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: 'A. Avery',
    addressLine: '3 Church Avenue',
    suburb: 'Armadale',
    state: 'WA',
    postcode: '6112',
  })
  await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: armadale,
    assignedMembershipId: s.subMembershipId,
    jobType: 'General Pest Control',
    price: 19500,
    scheduledAt: s.ownerJobAt + 30 * 60_000,
    durationMinutes: 60,
  })
  // A service each: the owner's at J. Nguyen's from tomorrow, Kevin's at A.
  // Avery's three days on, so the soonest is not the first A–Z.
  const service = (
    propertyId: typeof armadale,
    assignedMembershipId: typeof s.subMembershipId,
    jobType: string,
    days: number,
  ) =>
    s.owner.client.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId,
      assignedMembershipId,
      intervalCount: 1,
      intervalUnit: 'week',
      jobType,
      price: 18500,
      anchorDate: Date.now() + days * 24 * 60 * 60_000,
      durationMinutes: 60,
    })
  await service(s.propertyId, s.ownerMembershipId, 'Rodents', 1)
  await service(armadale, s.subMembershipId, 'Wasps', 3)

  const nguyen = page.getByRole('button', { name: /Termite Inspection/ })
  const avery = page.getByRole('button', { name: /General Pest Control/ })
  // Which card comes first in the list: by the page's order, since a
  // desktop lays two cards side by side.
  const before = async (a: typeof nguyen, b: typeof nguyen) =>
    a.evaluate(
      (el, other) =>
        (el.compareDocumentPosition(other) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
      await b.elementHandle(),
    )

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${s.ownerJobDay}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  await expect(nguyen).toBeVisible()
  await expect(avery).toBeVisible()
  // By time, as the day opens.
  expect(await before(nguyen, avery)).toBe(true)

  const filters = page.getByRole('button', { name: /^Filter/ })
  const sheet = page.getByRole('dialog')
  const open = () =>
    clickUntil(filters, () => expect(sheet).toBeVisible({ timeout: 2_000 }))
  const done = async () => {
    await sheet.getByRole('button', { name: 'Done' }).click()
    await expect(sheet).toHaveCount(0)
  }

  // By suburb: Armadale before Bayswater. A sort is no filter.
  await open()
  await sheet
    .getByRole('radiogroup', { name: 'Sort by' })
    .getByRole('radio', { name: 'Suburb' })
    .click()
  await expect(page).toHaveURL(/[?&]sort=suburb/)
  await done()
  expect(await before(avery, nguyen)).toBe(true)
  await expect(filters).toHaveAccessibleName('Filter and sort')

  // A service: only the jobs for it.
  await open()
  await sheet
    .getByRole('group', { name: 'Service' })
    .getByRole('button', { name: /Termite Inspection/ })
    .click()
  await expect(page).toHaveURL(/[?&]service=Termite/)
  await done()
  await expect(avery).toBeHidden()
  await expect(nguyen).toBeVisible()
  await expect(filters).toHaveAccessibleName('Filter and sort, 1 on')

  // Through a reload.
  await page.reload()
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  await expect(nguyen).toBeVisible()
  await expect(avery).toBeHidden()

  // The week: only the person filters it, so the service hides nothing.
  const view = page.getByRole('tablist', { name: 'View' })
  await clickUntil(view.getByRole('tab', { name: 'Week' }), () =>
    expect(page).toHaveURL(/[?&]view=week/, { timeout: 2_000 }),
  )
  const day = page.locator(`#week-day-${s.ownerJobDay}`)
  await expect(day.getByRole('button', { name: /A\. Avery/ })).toBeVisible()
  await expect(day.getByRole('button', { name: /J\. Nguyen/ })).toBeVisible()
  await open()
  await expect(sheet.getByRole('heading', { name: 'Filters' })).toBeVisible()
  await sheet.getByRole('button', { name: /Kevin/ }).click()
  await expect(page).toHaveURL(/[?&]staff=\w+/)
  await done()
  await expect(day.getByRole('button', { name: /A\. Avery/ })).toBeVisible()
  await expect(day.getByRole('button', { name: /J\. Nguyen/ })).toBeHidden()
  await expect(filters).toHaveAccessibleName('Filters, 1 on')

  // Recurring: Kevin's services, then everyone's by client.
  await view.getByRole('tab', { name: 'Recurring' }).click()
  await expect(
    page.getByText('1 of 2 Recurring Jobs', { exact: true }),
  ).toBeVisible()
  const wasps = page.getByRole('button', { name: /^A\. Avery Wasps/ })
  const rodents = page.getByRole('button', { name: /^J\. Nguyen Rodents/ })
  await expect(wasps).toBeVisible()
  await expect(rodents).toBeHidden()
  await open()
  await sheet.getByRole('button', { name: /Everyone/ }).click()
  await done()
  await expect(rodents).toBeVisible()
  // What is to book first, then the soonest: tomorrow's before Kevin's.
  expect(await before(rodents, wasps)).toBe(true)
  await open()
  await sheet
    .getByRole('radiogroup', { name: 'Sort by' })
    .getByRole('radio', { name: 'Client A–Z' })
    .click()
  await expect(page).toHaveURL(/[?&]sort=client/)
  await done()
  expect(await before(wasps, rodents)).toBe(true)

  // Jobs → Recurring Job: the same filters, at the end of its switch's row,
  // in its own address.
  await page.goto(`/${s.slug}/job/recurring`)
  await expect(rodents).toBeVisible()
  await expect(wasps).toBeVisible()
  expect(await before(rodents, wasps)).toBe(true)
  await open()
  await sheet.getByRole('button', { name: /Kevin/ }).click()
  await expect(page).toHaveURL(/\/job\/recurring\?.*staff=\w+/)
  await sheet
    .getByRole('radiogroup', { name: 'Sort by' })
    .getByRole('radio', { name: 'Client A–Z' })
    .click()
  await expect(page).toHaveURL(/[?&]sort=client/)
  await done()
  await expect(filters).toHaveAccessibleName('Filter and sort, 1 on')
  await expect(rodents).toBeHidden()
  await expect(wasps).toBeVisible()
})
