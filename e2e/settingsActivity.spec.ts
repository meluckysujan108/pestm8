import { expect, test } from '@playwright/test'
import {
  api,
  clickUntil,
  setupBusinessWithSub,
  signInViaUi,
  skipNearPerthMidnight,
} from './fixtures'
import type { Page } from '@playwright/test'

/**
 * The owner's Settings → Activity (convex/jobActivity.ts `feed`): every
 * change to every job, newest first, each line the job's own Activity line
 * under the job it is about. A line opens its job's sheet; one person's
 * changes are a filter away; a job in the Recycle bin is named and opens
 * nothing; and nobody but the owner reads it.
 *
 * The fixture's owner is Terence, who reads his own changes as "You", and
 * Kevin is his subcontractor.
 */

type Setup = Awaited<ReturnType<typeof setupBusinessWithSub>>

const HOUR = 60 * 60 * 1000

/** Kevin's own job, which he lengthens; then the owner reprices his. */
async function changeTwoJobs(s: Setup) {
  const kevinsJob = await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.subMembershipId,
    jobType: 'General Pest Control',
    price: 19500,
    scheduledAt: s.ownerJobAt + 2 * HOUR,
    durationMinutes: 60,
  })
  await s.sub.client.mutation(api.jobs.update, {
    businessId: s.businessId,
    jobId: kevinsJob,
    durationMinutes: 120,
  })
  await s.owner.client.mutation(api.jobs.update, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    price: 42000,
  })
  return kevinsJob
}

/** The page's lines: inside `main`, away from the sidebar's own list. */
function feedLines(page: Page) {
  return page.getByRole('main').getByRole('listitem')
}

/** Signed in as the owner, from the Settings hub's Activity row. */
async function openActivity(page: Page, s: Setup) {
  await signInViaUi(page, s.owner.email, undefined, `/${s.slug}/settings`)
  await clickUntil(
    page.getByRole('link', { name: 'Activity', exact: true }),
    () =>
      expect(page).toHaveURL(new RegExp(`/${s.slug}/settings/activity`), {
        timeout: 3_000,
      }),
  )
  await expect(
    page.getByRole('heading', { name: 'Activity', level: 1 }),
  ).toBeVisible()
}

test('the owner reads every change, newest first, and opens a job from it', async ({
  page,
}) => {
  skipNearPerthMidnight('today’s changes are under “Today”')
  const s = await setupBusinessWithSub('activity')
  await changeTwoJobs(s)

  await openActivity(page, s)
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()

  // Each line is who, the job it is about, and what they did to it — in the
  // job sheet's own words — the newest at the top.
  const lines = feedLines(page)
  const repriced = lines.filter({
    hasText: 'Changed the price from $380 to $420',
  })
  const lengthened = lines.filter({
    hasText: 'Changed the length from 1 hr to 2 hr',
  })
  await expect(repriced).toContainText('You')
  await expect(repriced).toContainText('Termite Inspection · J. Nguyen')
  await expect(lengthened).toContainText('Kevin')
  await expect(lengthened).toContainText('General Pest Control · J. Nguyen')
  await expect(lines.first()).toContainText('Changed the price')
  // Two bookings, a lengthening and a new price; and as the business began
  // with its history, that's all there is.
  await expect(lines).toHaveCount(4)
  await expect(page.getByText('That’s every change.')).toBeVisible()

  // A line opens its job's sheet over the list, and closing it comes back.
  const sheet = page.getByRole('dialog')
  await clickUntil(repriced.getByRole('link'), () =>
    expect(
      sheet.getByRole('heading', { name: 'Notes', exact: true }),
    ).toBeVisible({ timeout: 3_000 }),
  )
  await expect(page).toHaveURL(new RegExp(`jobId=${s.ownerJobId}`))
  await expect(sheet.getByText('Termite Inspection').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(page).not.toHaveURL(/jobId=/)
  await expect(repriced).toBeVisible()
})

test('narrowed to one person, only the changes they made', async ({ page }) => {
  skipNearPerthMidnight('today’s changes are under “Today”')
  const s = await setupBusinessWithSub('activity-person')
  await changeTwoJobs(s)

  await openActivity(page, s)
  const lines = feedLines(page)
  await expect(lines).toHaveCount(4)

  const filters = page.getByRole('button', { name: 'Filters' })
  await expect(filters).toBeEnabled()
  await filters.click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'Kevin', exact: true }).click()
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toBeHidden()

  await expect(page).toHaveURL(new RegExp(`staff=${s.subMembershipId}`))
  await expect(
    page.getByText('Changes made by Kevin, newest first.'),
  ).toBeVisible()
  await expect(lines).toHaveCount(1)
  await expect(lines.first()).toContainText(
    'Changed the length from 1 hr to 2 hr',
  )
  await expect(page.getByText('Nothing earlier by Kevin.')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Filters, 1 on' }),
  ).toBeVisible()

  // Opened again from the address, it is still Kevin's.
  await page.reload()
  await expect(lines).toHaveCount(1)

  // "all" is what the filter sheet calls everyone, so an address saying so
  // is everyone's changes, not nobody's.
  await page.goto(`/${s.slug}/settings/activity?staff=all`)
  await expect(lines).toHaveCount(4)
  await expect(
    page.getByText('Every change to every job, newest first.'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible()
})

test('a job in the Recycle bin is named, and opens nothing', async ({
  page,
}) => {
  skipNearPerthMidnight('today’s changes are under “Today”')
  const s = await setupBusinessWithSub('activity-bin')
  const kevinsJob = await changeTwoJobs(s)
  await s.owner.client.mutation(api.bin.deleteJob, {
    businessId: s.businessId,
    jobId: kevinsJob,
  })

  await openActivity(page, s)
  const deleted = feedLines(page).filter({ hasText: 'Deleted this job' })
  await expect(deleted).toContainText(
    'General Pest Control · J. Nguyen, Bayswater',
  )
  await expect(deleted).toContainText('In the Recycle bin')
  await expect(deleted.getByRole('link')).toHaveCount(0)
  // Every line of it says so, and none of them opens it.
  const lengthened = feedLines(page).filter({
    hasText: 'Changed the length from 1 hr to 2 hr',
  })
  await expect(lengthened).toContainText('In the Recycle bin')
  await expect(lengthened.getByRole('link')).toHaveCount(0)
})

test('nobody but the owner', async ({ page }) => {
  const s = await setupBusinessWithSub('activity-owner-only')
  await changeTwoJobs(s)

  await signInViaUi(page, s.sub.email, undefined, `/${s.slug}/settings`)
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1 }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Activity', exact: true }),
  ).toHaveCount(0)

  await page.goto(`/${s.slug}/settings/activity`)
  await expect(page.getByText('Owners only')).toBeVisible()
  await expect(page.getByText('Changed the length')).toHaveCount(0)
})
