import { expect, test } from '@playwright/test'
import { api, clickUntil, setupBusinessWithSub, signInViaUi } from './fixtures'

/**
 * The Recurring Job page by service (30 Sept 2026): one card per running
 * service that opens to its visits, a visit opening its job on the page, and
 * "By date" keeping the list of visits. The Schedule's Recurring view (6 Nov
 * 2026) is the same view, beside its Week.
 */

const DAY = 24 * 60 * 60 * 1000

test('the Recurring Job page lists each service, and opens it to its visits', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('recurring-services')
  const service = (unit: 'week' | 'year', jobType: string, anchor: number) =>
    s.owner.client.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      intervalCount: 1,
      intervalUnit: unit,
      jobType,
      price: 18500,
      anchorDate: anchor,
      durationMinutes: 60,
    })
  await service('week', 'General Pest Control', Date.now() + DAY)
  // Nothing of it within the six months the engine books: still a card.
  await service('year', 'Termite Inspection', Date.now() - 30 * DAY)

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/job/recurring`)
  await expect(
    page.getByText('2 Recurring Jobs', { exact: true }),
  ).toBeVisible()
  const byService = page.getByRole('tab', { name: 'By service' })
  await expect(byService).toHaveAttribute('aria-selected', 'true')

  const weekly = page.getByRole('button', {
    name: /^J\. Nguyen General Pest Control · Every week/,
  })
  const yearly = page.getByRole('button', {
    name: /^J\. Nguyen Termite Inspection · Every year/,
  })
  await expect(weekly).toContainText(/Next \w{3} \d+ \w+/)
  await expect(yearly).toContainText(/Due \w{3} \d+ \w+/)

  // Opened, it lists what is coming; a visit opens its job here. Enabled
  // once the page has hydrated: a tap before that would open nothing.
  await expect(weekly).toBeEnabled()
  await weekly.click()
  await expect(weekly).toHaveAttribute('aria-expanded', 'true')
  const card = page.locator('li').filter({ has: weekly })
  await expect(card.getByRole('heading', { name: 'Coming up' })).toBeVisible()
  await card
    .getByRole('button', { name: /Booked|Pending|Recurring/ })
    .first()
    .click()
  await expect(page).toHaveURL(/\/job\/recurring\?.*jobId=/)
  await expect(
    page
      .getByRole('dialog')
      .getByRole('heading', { name: 'General Pest Control', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // By date: the visits themselves, as cards.
  await page.getByRole('tab', { name: 'By date' }).click()
  await expect(page).toHaveURL(/[?&]view=date/)
  await expect(
    page.getByRole('button', { name: /General Pest Control/ }).first(),
  ).toContainText('Every week')
})

test('the Schedule’s Recurring view is the Recurring Job page, beside its Week', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('schedule-recurring')
  await s.owner.client.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    intervalCount: 1,
    intervalUnit: 'week',
    jobType: 'General Pest Control',
    price: 18500,
    anchorDate: Date.now() + DAY,
    durationMinutes: 60,
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()

  const view = page.getByRole('tablist', { name: 'View' })
  await clickUntil(view.getByRole('tab', { name: 'Recurring' }), () =>
    expect(page).toHaveURL(/view=recurring/, { timeout: 2_000 }),
  )
  await expect(page.getByText('1 Recurring Job', { exact: true })).toBeVisible()
  // The phone's week strip stays, so switching views moves nothing.
  const strip = page.getByRole('button', { name: 'Previous week' })
  const phone = test.info().project.name === 'mobile'
  if (phone) await expect(strip).toBeVisible()
  const weekly = page.getByRole('button', {
    name: /^J\. Nguyen General Pest Control · Every week/,
  })
  await expect(weekly).toContainText(/Next \w{3} \d+ \w+/)

  // A visit opens its job over the view, which stays put under it.
  await expect(weekly).toBeEnabled()
  await weekly.click()
  const card = page.locator('li').filter({ has: weekly })
  await card
    .getByRole('button', { name: /Booked|Pending|Recurring/ })
    .first()
    .click()
  await expect(page).toHaveURL(/view=recurring.*jobId=|jobId=.*view=recurring/)
  await expect(
    page
      .getByRole('dialog')
      .getByRole('heading', { name: 'General Pest Control', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // By date in the URL, through a reload; gone on the way to another view.
  await page.getByRole('tab', { name: 'By date' }).click()
  await expect(page).toHaveURL(/[?&]by=date/)
  await page.reload()
  await expect(page.getByRole('tab', { name: 'By date' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(
    page.getByRole('button', { name: /General Pest Control/ }).first(),
  ).toContainText('Every week')
  await clickUntil(view.getByRole('tab', { name: 'Week' }), () =>
    expect(page).toHaveURL(/view=week/, { timeout: 2_000 }),
  )
  await expect(page).not.toHaveURL(/by=date/)
  if (phone) await expect(strip).toBeVisible()
})

/**
 * The phone's week strip stays above the Recurring view (6 Nov 2026), so
 * switching views never moves the page. Its arrows page the strip and stay
 * in Recurring; a day tapped on it opens that day's list, and Back returns
 * to Recurring.
 */
test('the phone’s strip stays over the Recurring view, and a day tapped on it opens that day', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'mobile', 'phone layout only')
  const s = await setupBusinessWithSub('recurring-strip')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?view=recurring`)
  await expect(
    page.getByText('No Recurring Jobs yet', { exact: true }),
  ).toBeVisible()

  // A week on: the strip moves, the view stays.
  await clickUntil(page.getByRole('button', { name: 'Next week' }), () =>
    expect(page).toHaveURL(/[?&]date=\d{4}-\d{2}-\d{2}/, { timeout: 2_000 }),
  )
  await expect(page).toHaveURL(/[?&]view=recurring/)
  await expect(
    page.getByText('No Recurring Jobs yet', { exact: true }),
  ).toBeVisible()
  const dayKey = new URL(page.url()).searchParams.get('date')!

  // A day tapped opens that day's list; Back returns to Recurring.
  await page
    .locator('[data-schedule-chrome]')
    .getByRole('button', { name: dayKey, exact: true })
    .click()
  await expect(page).toHaveURL(/[?&]view=job/)
  await expect(page).toHaveURL(new RegExp(`[?&]date=${dayKey}`))
  await expect(
    page
      .getByRole('tablist', { name: 'View' })
      .getByRole('tab', { name: 'Job' }),
  ).toHaveAttribute('aria-selected', 'true')
  await page.goBack()
  await expect(page).toHaveURL(/[?&]view=recurring/)
  await expect(
    page.getByText('No Recurring Jobs yet', { exact: true }),
  ).toBeVisible()
})
