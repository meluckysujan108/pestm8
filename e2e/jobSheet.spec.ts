import { expect, test } from '@playwright/test'
import { api, clickUntil, setupBusinessWithSub, signInViaUi } from './fixtures'
import { createReport } from './fixtures/reportPayloads'
import type { Locator, Page } from '@playwright/test'

/**
 * The job sheet, re-ordered (30 Sept 2026): who is going under the title,
 * then Property, Notes, Report & photos, Details and History; and a History
 * of visits that happened, each with its report, where "Other visits at this
 * property" used to show the furthest projections.
 */

const DAY = 24 * 60 * 60 * 1000

/** The tenant's own day, not the runner's. */
function perthDayKey(ts: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
  }).format(new Date(ts))
}

async function openJob(page: Page, slug: string, at: number, name: RegExp) {
  await page.goto(`/${slug}/schedule?date=${perthDayKey(at)}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  const sheet = page.getByRole('dialog')
  await clickUntil(page.getByRole('button', { name }).first(), () =>
    expect(
      sheet.getByRole('heading', { name: 'Property', exact: true }),
    ).toBeVisible({ timeout: 3_000 }),
  )
  return sheet
}

function section(sheet: Locator, heading: string) {
  return sheet.locator('section').filter({
    has: sheet.page().getByRole('heading', { name: heading, exact: true }),
  })
}

test('the job sheet says who is going, and reads in the order of a visit', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('sheet-order')
  const anchor = Date.now() + 2 * DAY
  await s.owner.client.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.subMembershipId,
    intervalCount: 1,
    intervalUnit: 'week',
    jobType: 'General Pest Control',
    price: 18500,
    anchorDate: anchor,
    durationMinutes: 60,
  })

  await signInViaUi(page, s.owner.email)
  const sheet = await openJob(page, s.slug, anchor, /General Pest Control/)

  // Who, and that it repeats, without opening Edit.
  await expect(sheet.getByText('Technician:')).toBeAttached()
  await expect(sheet.getByText('Kevin', { exact: true })).toBeVisible()
  await expect(sheet.getByText('Every week').first()).toBeVisible()

  const headings = await sheet.locator('h3').allInnerTexts()
  expect(
    headings
      .map((h) => h.trim().toLowerCase())
      .filter((h) =>
        [
          'property',
          'notes',
          'report & photos',
          'details',
          'history at this property',
        ].includes(h),
      ),
  ).toEqual([
    'property',
    'notes',
    'report & photos',
    'details',
    'history at this property',
  ])

  // Details, one row each: the price, and the series with its next visit.
  const details = section(sheet, 'Details')
  await expect(details.getByRole('term').nth(0)).toHaveText('Price')
  await expect(details.getByRole('term').nth(1)).toHaveText('Repeats')
  await expect(details).toContainText('$185')
  await expect(details).toContainText(/Every week\s*Next \w{3} \d+ \w+/)

  // A first visit: nothing earlier, said so.
  await expect(section(sheet, 'History at this property')).toContainText(
    'No earlier visits here.',
  )
})

test('history is what happened here, each visit with its report', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('sheet-history')
  const owner = s.owner.client
  const book = (jobType: string, at: number) =>
    owner.mutation(api.jobs.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      jobType,
      price: 20000,
      scheduledAt: at,
      durationMinutes: 60,
    })

  const termite = await book('Termite Inspection', Date.now() - 30 * DAY)
  const gpc = await book('General Pest Control', Date.now() - 14 * DAY)
  const wasps = await book('Wasps', Date.now() - 20 * DAY)
  // Booked ahead: never history, however recently it was booked.
  await book('Rodents', Date.now() + 10 * DAY)
  for (const jobId of [termite, gpc]) {
    await owner.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId,
    })
  }
  await owner.mutation(api.jobs.cancel, {
    businessId: s.businessId,
    jobId: wasps,
  })
  await createReport(
    owner,
    { businessId: s.businessId, propertyId: s.propertyId, jobId: termite },
    'timberPestInspection',
  )
  // Started from Reports, for no visit.
  await createReport(
    owner,
    { businessId: s.businessId, propertyId: s.propertyId },
    'serviceReport',
  )

  await signInViaUi(page, s.owner.email)
  // The fixture's own job: a Termite Inspection, today.
  const sheet = await openJob(page, s.slug, Date.now(), /Termite Inspection/)
  const history = section(sheet, 'History at this property')

  // The last visit for this service leads, with its report under it.
  const last = history
    .locator('div')
    .filter({
      has: page.getByRole('heading', { name: 'Last Termite Inspection here' }),
    })
    .last()
  await expect(last).toContainText('Termite Inspection')
  await expect(last).toContainText('Completed')
  await expect(
    last.getByRole('link', { name: /Timber Pest Inspection/ }),
  ).toContainText('Draft')

  // Then what else happened; not the cancelled visit, not the booked one.
  await expect(history).toContainText('General Pest Control')
  await expect(history).not.toContainText('Wasps')
  await expect(history).not.toContainText('Rodents')
  await expect(
    history.getByRole('heading', { name: 'Other reports here' }),
  ).toBeVisible()
  await expect(history).toContainText('Pest Service Report')

  // Every earlier visit, the cancelled one too.
  await history.getByRole('button', { name: 'See all 3' }).click()
  const all = page.getByRole('dialog', { name: 'History at this property' })
  await expect(all).toContainText('Wasps')
  await expect(all).toContainText('Cancelled')
  await expect(all).not.toContainText('Rodents')

  // A visit opens in place of this one, and the page is still usable after.
  await all.getByRole('link', { name: /General Pest Control/ }).click()
  await expect(all).toHaveCount(0)
  await expect(
    page
      .getByRole('dialog')
      .getByRole('heading', { name: 'General Pest Control', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'New job' }).click()
  await expect(
    page.getByRole('dialog').getByText('New job').first(),
  ).toBeVisible()
})

test('an invoiced job says why it is locked, under its status', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('sheet-invoiced')
  await s.owner.client.mutation(api.jobs.update, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    status: 'invoiced',
  })

  await signInViaUi(page, s.owner.email)
  const sheet = await openJob(page, s.slug, Date.now(), /Termite Inspection/)
  const notice = sheet.getByText(/This job has been invoiced/)
  await expect(notice).toBeVisible()
  await expect(
    sheet.getByRole('button', { name: 'Edit job details' }),
  ).toHaveCount(0)

  // Above the property, not under everything else.
  const noticeTop = (await notice.boundingBox())!.y
  const propertyTop = (await sheet
    .getByRole('heading', { name: 'Property', exact: true })
    .boundingBox())!.y
  expect(noticeTop).toBeLessThan(propertyTop)
})
