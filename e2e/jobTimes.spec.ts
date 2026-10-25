import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  chooseJobTypes,
  chooseProperty,
  clickUntil,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import type { Page } from '@playwright/test'

/**
 * A job's time is a start and an end, picked the same way (asked for
 * 25 Oct 2026: "a bit difficult to add hours" in a Minutes box, for the jobs
 * that run a few hours). The server still keeps a length in minutes; the form
 * works it out, and says it back under the two.
 */

/** The tenant's own day, not the runner's. */
function perthToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
  }).format(new Date())
}

/** A wall-clock time on a Perth day, which has no daylight saving. */
function perthAt(day: string, time: string) {
  return Date.parse(`${day}T${time}:00+08:00`)
}

async function setup(label: string) {
  const owner = await signUpActor(
    uniqueEmail(label),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `${label} ${Date.now()}`,
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
  return { owner, businessId, slug, propertyId }
}

async function openNewJob(page: Page, slug: string, day: string) {
  await page.goto(`/${slug}/schedule?date=${day}`)
  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()
  const sheet = page.getByRole('dialog')
  await chooseProperty(page, sheet, 'Nguyen', /J\. Nguyen/)
  await chooseJobTypes(page, sheet, ['Termite Inspection'])
  return sheet
}

test('a job of a few hours is booked by its start and its end', async ({
  page,
}) => {
  const s = await setup('times-book')
  const day = perthToday()
  await signInViaUi(page, s.owner.email)
  const sheet = await openNewJob(page, s.slug, day)

  const start = sheet.getByLabel('Start', { exact: true })
  const end = sheet.getByLabel('End', { exact: true })
  // An hour from nine to begin with, and the end keeps that hour as the
  // start moves.
  await expect(start).toHaveValue('09:00')
  await expect(end).toHaveValue('10:00')
  await start.fill('08:00')
  await expect(end).toHaveValue('09:00')

  await end.fill('12:30')
  // Said back as the card will say it, the length worked out.
  await expect(sheet.getByText('8:00am – 12:30pm · 4 hr 30 min')).toBeVisible()
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()

  const [job] = await s.owner.client.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey: day,
  })
  expect(job.scheduledAt).toBe(perthAt(day, '08:00'))
  expect(job.durationMinutes).toBe(270)
  await expect(page.getByText('8:00am – 12:30pm · 4 hr 30 min')).toBeVisible()
})

test('an end before the start is not booked, and says so', async ({ page }) => {
  const s = await setup('times-refuse')
  const day = perthToday()
  await signInViaUi(page, s.owner.email)
  const sheet = await openNewJob(page, s.slug, day)

  const end = sheet.getByLabel('End', { exact: true })
  await end.fill('08:30')
  await sheet.getByRole('button', { name: 'Book job' }).click()

  // Nothing booked: the sheet stays, says why, and is at the end to fix it.
  await expect(
    sheet.getByText('Choose an end time after the start.'),
  ).toBeVisible()
  await expect(end).toBeFocused()
  await expect(end).toHaveAttribute('aria-invalid', 'true')
  expect(
    await s.owner.client.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: day,
    }),
  ).toHaveLength(0)

  // Put right, it goes no further than the one line it was.
  await end.fill('11:00')
  await expect(
    sheet.getByText('Choose an end time after the start.'),
  ).toHaveCount(0)
  await expect(sheet.getByText('9:00am – 11:00am · 2 hr')).toBeVisible()
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()
  const [job] = await s.owner.client.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey: day,
  })
  expect(job.durationMinutes).toBe(120)
})

test('editing a job: the end follows the start until it is set by hand', async ({
  page,
}) => {
  const s = await setup('times-edit')
  const day = perthToday()
  const members = await s.owner.client.query(api.memberships.listForBusiness, {
    businessId: s.businessId,
  })
  const jobId = await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: members[0]._id,
    jobType: 'Termite Inspection',
    price: 38000,
    scheduledAt: perthAt(day, '10:00'),
    durationMinutes: 90,
  })
  const saved = () =>
    s.owner.client.query(api.jobs.get, { businessId: s.businessId, jobId })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${day}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  const detail = page.getByRole('dialog')
  const edit = detail.getByRole('button', { name: 'Edit job details' })
  await clickUntil(page.getByText('Termite Inspection').first(), () =>
    expect(edit).toBeVisible({ timeout: 2_000 }),
  )

  // Moved to the afternoon, it keeps its hour and a half.
  await edit.click()
  const start = detail.getByLabel('Start', { exact: true })
  const end = detail.getByLabel('End', { exact: true })
  await expect(start).toHaveValue('10:00')
  await expect(end).toHaveValue('11:30')
  await start.fill('13:00')
  await expect(end).toHaveValue('14:30')
  await detail.getByRole('button', { name: 'Save' }).click()
  await expect(edit).toBeVisible()
  await expect
    .poll(async () => (await saved())?.scheduledAt)
    .toBe(perthAt(day, '13:00'))
  expect((await saved())?.durationMinutes).toBe(90)

  // An end set by hand stays put when the start is moved after it.
  await edit.click()
  await end.fill('17:00')
  await start.fill('09:00')
  await expect(end).toHaveValue('17:00')
  await expect(detail.getByText('9:00am – 5:00pm · 8 hr')).toBeVisible()
  await detail.getByRole('button', { name: 'Save' }).click()
  await expect(edit).toBeVisible()
  await expect.poll(async () => (await saved())?.durationMinutes).toBe(480)
  expect((await saved())?.scheduledAt).toBe(perthAt(day, '09:00'))
})
