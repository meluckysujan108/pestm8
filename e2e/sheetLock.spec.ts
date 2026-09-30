import { expect, test } from '@playwright/test'
import { api, clickUntil, setupBusinessWithSub, signInViaUi } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * A sheet being edited does not go away by accident (asked for 30 Sept 2026:
 * "an accidental swipe down removes all the work done"). While a job or a
 * client is being edited the sheet is locked; ✕, Escape and the phone's Back
 * ask before throwing a change away, and close straight away when nothing
 * has changed.
 */

async function openJob(page: Page, slug: string) {
  await page.goto(`/${slug}/schedule`)
  const detail = page.getByRole('dialog')
  await clickUntil(page.getByText('Termite Inspection').first(), () =>
    expect(detail).toBeVisible({ timeout: 2_000 }),
  )
  return detail
}

const discard = (page: Page) =>
  page.getByRole('alertdialog').filter({ hasText: 'Discard your changes?' })

test('editing a job: Escape and ✕ ask before a change is thrown away', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('lock-job')
  await signInViaUi(page, s.owner.email)
  const detail = await openJob(page, s.slug)

  await detail.getByRole('button', { name: 'Edit job details' }).click()
  // Edit mode is the form alone: the rest of the job steps aside.
  await expect(detail.getByText('Editing job #')).toBeVisible()
  await expect(detail.getByRole('button', { name: 'Delete job' })).toHaveCount(
    0,
  )

  await detail.getByLabel('Minutes').fill('120')

  // Escape asks; Keep editing keeps what was typed.
  await page.keyboard.press('Escape')
  await expect(discard(page)).toBeVisible()
  await discard(page).getByRole('button', { name: 'Keep editing' }).click()
  await expect(discard(page)).toHaveCount(0)
  await expect(detail.getByLabel('Minutes')).toHaveValue('120')

  // A tap outside does nothing: it is how a phone's keyboard is put away.
  await page.mouse.click(5, 5)
  await expect(discard(page)).toHaveCount(0)
  await expect(detail.getByLabel('Minutes')).toHaveValue('120')

  // ✕ asks too; Discard closes the job, and nothing was saved.
  await detail.getByRole('button', { name: 'Close' }).click()
  await discard(page).getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(job?.durationMinutes).toBe(90)
})

test('editing a job with nothing changed closes without asking', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('lock-clean')
  await signInViaUi(page, s.owner.email)
  const detail = await openJob(page, s.slug)
  await detail.getByRole('button', { name: 'Edit job details' }).click()
  await expect(detail.getByText('Editing job #')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(discard(page)).toHaveCount(0)
})

test('the phone’s Back asks before leaving a job with unsaved changes', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('lock-back')
  await signInViaUi(page, s.owner.email)
  // Arrive at the schedule from inside the app, so Back stays in the app —
  // once the page has hydrated, or the link is a full page load and Back
  // leaves the document, which no page can stop.
  await page.goto(`/${s.slug}/clients`)
  await expect(page.getByRole('button', { name: 'New client' })).toBeEnabled()
  await page.getByRole('link', { name: 'Schedule' }).first().click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/schedule`))
  const detail = page.getByRole('dialog')
  await clickUntil(page.getByText('Termite Inspection').first(), () =>
    expect(detail).toBeVisible({ timeout: 2_000 }),
  )
  await detail.getByRole('button', { name: 'Edit job details' }).click()
  await detail.getByLabel('Minutes').fill('45')

  await page.goBack()
  await expect(discard(page)).toBeVisible()
  await discard(page).getByRole('button', { name: 'Keep editing' }).click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/schedule`))
  await expect(detail.getByLabel('Minutes')).toHaveValue('45')
})

test('New Job asks before throwing away what was filled in, and not before', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('lock-newjob')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  const add = page.getByRole('button', { name: 'New job' })
  const sheet = page.getByRole('dialog')
  await clickUntil(add, () =>
    expect(sheet.getByText('New job').first()).toBeVisible({ timeout: 2_000 }),
  )

  // Untouched: ✕ just closes.
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await clickUntil(add, () =>
    expect(sheet.getByText('New job').first()).toBeVisible({ timeout: 2_000 }),
  )
  await sheet.getByLabel('Price (AUD)').fill('150')
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(discard(page)).toBeVisible()
  await discard(page).getByRole('button', { name: 'Keep editing' }).click()
  await expect(sheet.getByLabel('Price (AUD)')).toHaveValue('150')
})
