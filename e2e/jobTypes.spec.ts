import { expect, test } from '@playwright/test'
import {
  api,
  chooseProperty,
  setupBusinessWithSub,
  signInViaUi,
} from './fixtures'
import type { Page } from '@playwright/test'

/**
 * Settings → Job types: the services New Job offers are the owner's own list
 * (convex/jobTypes.ts). Added, renamed, tidied and deleted here, and what the
 * rest of the app then offers and shows follows.
 */

async function openJobTypes(page: Page, slug: string) {
  await page.goto(`/${slug}/settings`)
  const row = page.getByRole('link', { name: /^Job types/ })
  await expect(row).toBeVisible()
  await row.click()
  await expect(page).toHaveURL(new RegExp(`/${slug}/settings/job-types$`))
  await expect(
    page.getByRole('heading', { name: 'Offered on new jobs' }),
  ).toBeVisible()
}

test('a job type added in Settings is offered by New Job', async ({ page }) => {
  const s = await setupBusinessWithSub('jobtypes-add')
  await signInViaUi(page, s.owner.email)
  await openJobTypes(page, s.slug)

  const add = page.getByRole('button', { name: 'Add a job type' })
  await expect(add).toBeEnabled()
  await add.click()
  const sheet = page.getByRole('dialog', { name: 'New job type' })
  await sheet.getByLabel('Name').fill('Possum Removal')
  await sheet.getByRole('radio', { name: 'No report' }).click()
  await sheet.getByRole('button', { name: 'Add job type' }).click()
  await expect(sheet).toBeHidden()
  await expect(
    page.getByRole('button', { name: /^Possum Removal No report/ }),
  ).toBeVisible()

  // Everyone who books work reads the list, a subcontractor included.
  const list = await s.sub.client.query(api.jobTypes.list, {
    businessId: s.businessId,
  })
  expect(list.find((e) => e.name === 'Possum Removal')).toMatchObject({
    offered: true,
    report: 'none',
  })

  // And New Job offers it, as a tick rather than something to type.
  await page.goto(`/${s.slug}/schedule`)
  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()
  const form = page.getByRole('dialog')
  await chooseProperty(page, form, 'Nguyen', /J\. Nguyen/)
  await form.getByLabel('Job type').click()
  const picker = page.getByRole('dialog', { name: 'Job type' })
  await expect(
    picker.getByRole('checkbox', { name: 'Possum Removal', exact: true }),
  ).toBeVisible()
})

test('a rename changes the job type on the jobs that have it', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('jobtypes-rename')
  await signInViaUi(page, s.owner.email)
  await openJobTypes(page, s.slug)

  await page.getByRole('button', { name: /^Termite Inspection Timber/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Termite Inspection' })
  await expect(sheet.getByText('On 1 job.')).toBeVisible()
  await sheet.getByLabel('Name').fill('Termite & Timber Inspection')
  // Says what it will touch before it is saved.
  await expect(
    sheet.getByText(/Renaming changes it everywhere it’s used: 1 job/),
  ).toBeVisible()
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet).toBeHidden()

  await expect
    .poll(async () => {
      const job = await s.owner.client.query(api.jobs.get, {
        businessId: s.businessId,
        jobId: s.ownerJobId,
      })
      return job?.jobType
    })
    .toBe('Termite & Timber Inspection')
})

test('a service typed into a job is swapped for ones on the list', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('jobtypes-swap')
  const jobId = await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.subMembershipId,
    jobType: 'Gpc & Tpi',
    price: 30000,
    scheduledAt: Date.now() + 24 * 60 * 60 * 1000,
    durationMinutes: 60,
  })
  await signInViaUi(page, s.owner.email)
  await openJobTypes(page, s.slug)

  await expect(
    page.getByRole('heading', { name: 'Typed into jobs · 1' }),
  ).toBeVisible()
  await page.getByRole('button', { name: /^Gpc & Tpi/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Gpc & Tpi' })
  await sheet.getByRole('checkbox', { name: 'General Pest Control' }).click()
  await sheet.getByRole('checkbox', { name: 'Termite Inspection' }).click()
  await sheet.getByRole('button', { name: 'Swap for these 2' }).click()
  await expect(sheet).toBeHidden()

  await expect
    .poll(async () => {
      const job = await s.owner.client.query(api.jobs.get, {
        businessId: s.businessId,
        jobId,
      })
      return job?.jobType
    })
    .toBe('General Pest Control, Termite Inspection')
  await expect(
    page.getByRole('heading', { name: /^Typed into jobs/ }),
  ).toBeHidden()
})

test('a deleted job type is no longer offered, and can be offered again', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('jobtypes-delete')
  await signInViaUi(page, s.owner.email)
  await openJobTypes(page, s.slug)

  await page.getByRole('button', { name: /^Wasps/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Wasps' })
  await sheet.getByRole('button', { name: 'Delete job type' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Delete Wasps?' })
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(sheet).toBeHidden()

  await expect(
    page.getByRole('heading', { name: 'No longer offered' }),
  ).toBeVisible()
  let list = await s.owner.client.query(api.jobTypes.list, {
    businessId: s.businessId,
  })
  expect(list.find((e) => e.name === 'Wasps')?.offered).toBe(false)

  await page.getByRole('button', { name: 'Offer again Wasps' }).click()
  await expect(
    page.getByRole('heading', { name: 'No longer offered' }),
  ).toBeHidden()
  list = await s.owner.client.query(api.jobTypes.list, {
    businessId: s.businessId,
  })
  expect(list.find((e) => e.name === 'Wasps')?.offered).toBe(true)
})

test('a subcontractor has no Job types row and cannot change the list', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('jobtypes-sub')
  await signInViaUi(page, s.sub.email)
  await page.goto(`/${s.slug}/settings`)
  await expect(page.getByRole('link', { name: /^My details/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /^Job types/ })).toHaveCount(0)

  await page.goto(`/${s.slug}/settings/job-types`)
  await expect(page.getByText('Owners only', { exact: true })).toBeVisible()
  await expect(
    s.sub.client.mutation(api.jobTypes.create, {
      businessId: s.businessId,
      name: 'Possum Removal',
      report: 'none',
    }),
  ).rejects.toThrow(/NO_ACCESS/)
})
