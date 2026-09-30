import { expect, test } from '@playwright/test'
import {
  api,
  chooseJobTypes,
  clickUntil,
  setupBusinessWithSub,
  signInViaUi,
} from './fixtures'
import { createReport } from './fixtures/reportPayloads'
import type { Locator, Page } from '@playwright/test'

/**
 * The client sheet, Release 4 (30 Sept 2026): when they are next and last
 * visited under their name, "Book a job for this client", and three tabs —
 * Jobs (coming up, each recurring service as one row that opens to its
 * visits, one-offs, each visit with its reports), Notes (by what each is
 * for) and Details. And a report started from Reports asks which visit it
 * is for.
 */

const DAY = 24 * 60 * 60 * 1000

/** The tenant's own day, not the runner's. */
function perthDayKey(ts: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
  }).format(new Date(ts))
}

async function openClient(page: Page, slug: string) {
  await page.goto(`/${slug}/clients`)
  const sheet = page.getByRole('dialog')
  // Settled on what the tap itself does: once the sheet is open the list
  // behind it is hidden, and a retried tap could never land.
  await clickUntil(
    page.getByRole('button', { name: /J\. Nguyen/ }).first(),
    () => expect(sheet).toBeVisible({ timeout: 2_000 }),
  )
  await expect(sheet.getByRole('tab', { name: 'Jobs' })).toBeEnabled()
  return sheet
}

function section(sheet: Locator, heading: RegExp | string) {
  return sheet.locator('section').filter({
    has: sheet.page().getByRole('heading', { name: heading }),
  })
}

type Setup = Awaited<ReturnType<typeof setupBusinessWithSub>>

function book(s: Setup, jobType: string, at: number) {
  return s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    jobType,
    price: 20000,
    scheduledAt: at,
    durationMinutes: 60,
  })
}

test('the Jobs tab: what is coming up, each service as one row, and each visit with its report', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('client-jobs')
  await s.owner.client.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    intervalCount: 1,
    intervalUnit: 'week',
    jobType: 'General Pest Control',
    price: 18500,
    anchorDate: Date.now() + 2 * DAY,
    durationMinutes: 60,
  })
  const wasps = await book(s, 'Wasps', Date.now() - 20 * DAY)
  await s.owner.client.mutation(api.jobs.complete, {
    businessId: s.businessId,
    jobId: wasps,
  })
  await createReport(
    s.owner.client,
    { businessId: s.businessId, propertyId: s.propertyId, jobId: wasps },
    'serviceReport',
  )
  // Started from Reports, for no visit.
  await createReport(
    s.owner.client,
    { businessId: s.businessId, propertyId: s.propertyId },
    'timberPestInspection',
  )

  await signInViaUi(page, s.owner.email)
  const sheet = await openClient(page, s.slug)

  // Under the name: next (the fixture's Termite Inspection, today) and last.
  const glance = sheet.locator('dl').first()
  await expect(glance).toContainText('Termite Inspection')
  await expect(glance).toContainText('Wasps')
  await expect(glance).toContainText('1 recurring')
  await expect(glance).toContainText('2 reports')

  const coming = section(sheet, 'Coming up')
  await expect(coming).toContainText('Termite Inspection')
  await expect(coming).toContainText('General Pest Control')

  // The service is one row, and opens to its visits.
  const services = section(sheet, /^Recurring services · 1$/)
  const service = services.getByRole('button', {
    name: /^General Pest Control Every week/,
  })
  await expect(service).toHaveAttribute('aria-expanded', 'false')
  await expect(service).toContainText(/Next \w{3} \d+ \w+/)
  await service.click()
  await expect(service).toHaveAttribute('aria-expanded', 'true')
  await expect(services.getByRole('heading', { name: 'Done' })).toBeVisible()

  // A one-off with its report under it; the report from no visit last.
  const oneOffs = section(sheet, /^One-off jobs · 2$/)
  await expect(oneOffs).toContainText('Wasps')
  await expect(
    oneOffs.getByRole('link', { name: /Pest Service Report/ }),
  ).toContainText('Draft')
  await expect(section(sheet, /^Other reports · 1$/)).toContainText(
    'Timber Pest Inspection',
  )
})

test('a job is booked from the client’s sheet, for them, on the day chosen', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('client-book')
  await signInViaUi(page, s.owner.email)
  const sheet = await openClient(page, s.slug)

  const bookButton = sheet.getByRole('button', {
    name: 'Book a job for this client',
  })
  // Opened and left alone, it closes without asking: their property being
  // chosen is not a change.
  await bookButton.click()
  let newJob = page.getByRole('dialog').filter({ hasText: 'New job' })
  await expect(newJob.getByLabel('Date')).toBeVisible()
  await expect(newJob.getByRole('button', { name: 'Property' })).toContainText(
    'J. Nguyen',
  )
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(newJob).toHaveCount(0)

  await bookButton.click()
  newJob = page.getByRole('dialog').filter({ hasText: 'New job' })
  const day = perthDayKey(Date.now() + 3 * DAY)
  await newJob.getByLabel('Date').fill(day)
  await chooseJobTypes(page, newJob, ['Cockroaches'])
  await newJob.getByLabel('Start').fill('10:00')
  await newJob.getByLabel('Price (AUD)').fill('150')
  await newJob.getByRole('button', { name: 'Book job' }).click()
  await expect(newJob).toHaveCount(0)

  await expect(section(sheet, 'Coming up')).toContainText('Cockroaches')
  const jobs = await s.owner.client.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey: day,
  })
  expect(jobs.map((j) => [j.jobType, j.clientName])).toEqual([
    ['Cockroaches', 'J. Nguyen'],
  ])
})

test('the Notes tab sorts notes by what each is for', async ({ page }) => {
  const s = await setupBusinessWithSub('client-notes')
  await signInViaUi(page, s.owner.email)
  const sheet = await openClient(page, s.slug)
  await sheet.getByRole('tab', { name: 'Notes' }).click()

  const before = section(sheet, 'Before you arrive')
  await expect(before).toContainText('Nothing on file for this site yet')
  await expect(section(sheet, 'About this client')).toContainText(
    'Billing quirks',
  )

  // A site note, under its site, headed by the address.
  await before
    .getByRole('button', { name: 'Site note for 12 Wattle Street' })
    .click()
  await expect
    .poll(
      async () =>
        (
          await s.owner.client.query(api.notes.listForProperty, {
            businessId: s.businessId,
            propertyId: s.propertyId,
          })
        ).site.map((n) => n.title),
      { timeout: 15_000 },
    )
    .toEqual(['12 Wattle Street'])
  await expect(
    before.getByRole('button', { name: /^12 Wattle Street/ }),
  ).toBeVisible()

  // A note about the client starts empty, the caret on its title.
  await section(sheet, 'About this client')
    .getByRole('button', { name: 'Add note about J. Nguyen' })
    .click()
  await expect(sheet.getByLabel('Note body')).toBeFocused()
  await page.keyboard.type('Pays by invoice')
  await expect
    .poll(
      async () =>
        (
          await s.owner.client.query(api.notes.listForClient, {
            businessId: s.businessId,
            clientId: (
              await s.owner.client.query(api.properties.list, {
                businessId: s.businessId,
              })
            )[0].clientId,
          })
        )
          .filter((n) => n.kind === 'client')
          .map((n) => n.title),
      { timeout: 15_000 },
    )
    .toEqual(['Pays by invoice'])
})

test('a report started from Reports asks which visit it is for', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('report-visit')
  const past = await book(s, 'General Pest Control', Date.now() - 3 * DAY)
  await s.owner.client.mutation(api.jobs.complete, {
    businessId: s.businessId,
    jobId: past,
  })
  // Booked ahead: its report isn't due, so it isn't offered.
  await book(s, 'Rodents', Date.now() + 3 * DAY)

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/reports/new`)
  const visit = page.getByLabel('Visit')
  await expect(visit).toBeEnabled()
  // Today's one visit there (the fixture's Termite Inspection) is chosen,
  // and the form it produces is suggested.
  await expect(visit).toHaveValue(s.ownerJobId)
  await expect(page.getByText(/Suggested for Termite Inspection/)).toBeVisible()
  await expect(visit.locator('option')).toHaveText([
    'Not for a visit',
    /^Today .* · Termite Inspection/,
    /General Pest Control/,
  ])

  await visit.selectOption('')
  await expect(page.getByText(/^Suggested for/)).toHaveCount(0)

  await visit.selectOption(past)
  await expect(
    page.getByText(/Suggested for General Pest Control/),
  ).toBeVisible()
  await page
    .getByRole('button', { name: /Pest Service Report/ })
    .first()
    .click()
  // Off the picker and onto the report, which is for that visit.
  await expect(page).not.toHaveURL(/\/reports\/new(\?|$)/)
  const clientId = (
    await s.owner.client.query(api.properties.list, {
      businessId: s.businessId,
    })
  )[0].clientId
  await expect
    .poll(async () =>
      (
        await s.owner.client.query(api.clients.visitReports, {
          businessId: s.businessId,
          clientId,
        })
      )?.reports.map((r) => r.jobId),
    )
    .toEqual([past])
})
