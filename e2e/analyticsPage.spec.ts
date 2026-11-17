import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  clickUntil,
  signInViaUi,
  signUpActor,
  skipNearPerthMidnight,
  uniqueEmail,
} from './fixtures'

/**
 * The Analytics page through the UI: its figures for the range it opens on,
 * narrowing by a service from its card, changing the range and what it is
 * compared with, and the spreadsheet. `analytics.spec.ts` asks the old
 * `analytics.overview` query directly; this is the page people use, on the
 * queries behind it (`analytics.report`, `breakdowns`, `paperwork`,
 * `payments`).
 */

const DAY = 24 * 60 * 60 * 1000

test('an owner reads a range, narrows it to a service, changes the range and exports it', async ({
  page,
}) => {
  // Jobs are booked a few days back from now, and the page counts in the
  // business's days: either side of Perth's midnight the two would disagree
  // about which days those are.
  skipNearPerthMidnight('books jobs relative to now')

  const email = uniqueEmail('analytics-page')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `Figures ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    },
  )
  const home = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const cafe = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Harbour Kitchen',
    addressLine: '3 Quay Street',
    suburb: 'Fremantle',
    state: 'WA',
    postcode: '6160',
  })
  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  const ownerMembershipId = members.find((m) => m.role === 'owner')!._id

  async function book(
    propertyId: typeof home,
    jobType: string,
    price: number,
    daysAgo: number,
    complete: boolean,
  ) {
    const jobId = await owner.client.mutation(api.jobs.create, {
      businessId,
      propertyId,
      assignedMembershipId: ownerMembershipId,
      jobType,
      price,
      scheduledAt: Date.now() - daysAgo * DAY,
      durationMinutes: 60,
    })
    if (complete)
      await owner.client.mutation(api.jobs.complete, { businessId, jobId })
  }
  // All inside the last 7 days, so the range changed to below still holds
  // them. $200 + $300 finished; $900 only booked, which is no revenue.
  await book(home, 'General Pest Control', 20000, 3, true)
  await book(cafe, 'Rodents', 30000, 5, true)
  await book(home, 'General Pest Control', 90000, 4, false)

  await signInViaUi(page, email, FIXTURE_PASSWORD, `/${slug}/analytics`)
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible()

  // --- the range it opens on: the last 30 days against the 30 before -----
  await expect(page.getByRole('button', { name: /Date range/ })).toContainText(
    'Last 30 days',
  )
  await expect(page.getByText(/compared with/)).toBeVisible()
  // Revenue is the two finished jobs; the booked $900 is not in it anywhere.
  await expect(page.getByText('$500').first()).toBeVisible()
  await expect(page.getByText('$900')).toHaveCount(0)
  await expect(page.getByText('$1,400')).toHaveCount(0)

  // --- the cards under it ------------------------------------------------
  const rodents = page.getByRole('button', { name: /^Rodents/ })
  await expect(rodents).toBeVisible()
  await expect(rodents).toContainText('$300')
  await expect(page.getByRole('heading', { name: 'Suburbs' })).toBeVisible()
  await expect(page.getByText('Fremantle').first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Paperwork' })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'How you were paid' }),
  ).toBeVisible()

  // --- a service tapped in its card narrows the whole page ---------------
  await clickUntil(rodents, () => expect(page).toHaveURL(/[?&]service=Rodents/))
  await expect(rodents).toHaveAttribute('aria-pressed', 'true')
  await expect(
    page.getByRole('button', { name: 'Filters, 1 on' }),
  ).toBeVisible()
  // Only the café's job is left: Bayswater's suburb row goes with its job.
  await expect(page.getByText('Bayswater')).toHaveCount(0)
  await expect(page.getByText('$500')).toHaveCount(0)
  // Tapped again, it clears.
  await rodents.click()
  await expect(page).not.toHaveURL(/service=/)
  await expect(page.getByText('Bayswater').first()).toBeVisible()

  // --- the range, and what it is compared with ---------------------------
  await page.getByRole('button', { name: /Date range/ }).click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'Last 7 days' }).click()
  await expect(page).toHaveURL(/[?&]range=7d/)
  await sheet.getByRole('radio', { name: 'Nothing' }).click()
  await expect(page).toHaveURL(/[?&]compare=none/)
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('button', { name: /Date range/ })).toContainText(
    'Last 7 days',
  )
  await expect(page.getByText(/not compared/)).toBeVisible()
  // The same two jobs are inside seven days.
  await expect(page.getByText('$500').first()).toBeVisible()

  // --- a refresh keeps the view: it is all in the address ----------------
  await page.reload()
  await expect(page.getByRole('button', { name: /Date range/ })).toContainText(
    'Last 7 days',
  )
  await expect(page.getByText(/not compared/)).toBeVisible()

  // --- the spreadsheet ----------------------------------------------------
  const exportButton = page.getByRole('button', {
    name: 'Export as a spreadsheet',
  })
  await expect(exportButton).toBeEnabled()
  const download = page.waitForEvent('download')
  await exportButton.click()
  expect((await download).suggestedFilename()).toMatch(
    /^analytics-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/,
  )
})
