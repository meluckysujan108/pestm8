import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { builderReady, createReport } from './fixtures/reportPayloads'

/**
 * Filling a report, the way a technician does it: an overview of the form, one
 * section at a time, and a lock that says what is missing instead of refusing
 * silently.
 *
 * Runs at phone width because that is where the work happens — standing in
 * someone's back garden, not at a desk.
 */

test.use({ viewport: { width: 390, height: 844 } })

async function startJobReport(label: string) {
  const email = uniqueEmail(label)
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(api.businesses.create, {
    name: `${label} ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const members = await owner.client.query(api.memberships.listForBusiness, { businessId })
  const jobId = await owner.client.mutation(api.jobs.create, {
    businessId,
    propertyId,
    assignedMembershipId: members.find((m) => m.role === 'owner')!._id,
    jobType: 'General Pest Control',
    price: 21000,
    scheduledAt: Date.now(),
    durationMinutes: 60,
  })
  const reportId = await createReport(owner.client, { businessId, propertyId, jobId }, 'serviceReport')
  return { email, owner, businessId, slug, reportId }
}

test('a report opens on its sections, and is filled one at a time', async ({ page }) => {
  const { email, slug, reportId } = await startJobReport('fill-sections')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports/${reportId}`)
  await builderReady(page)

  // The overview is the whole form at a glance: every section of the Service
  // Report, with what each still wants.
  for (const title of [
    'CLIENT & SITE DETAILS',
    'TREATMENT, PRODUCT(S) AND QUANTITIES APPLIED',
    'RISK ASSESSMENT',
    "TECHNICIAN'S RECOMMENDATIONS & COMMENTS",
  ]) {
    await expect(page.getByRole('button', { name: new RegExp(title.slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first()).toBeVisible()
  }

  // Opening one shows that section, and not the rest of the form.
  await page.getByRole('button', { name: /CLIENT & SITE DETAILS/ }).first().click()
  await expect(page.getByRole('heading', { name: '1. CLIENT & SITE DETAILS' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /RISK ASSESSMENT/ })).toHaveCount(0)
  // And says where it sits, in the form's own numbering.
  await expect(page.getByText('Section 1 of 4')).toBeVisible()

  // The section it is on survives a refresh: a technician who locks their
  // phone mid-job comes back to the question they were on.
  await page.reload()
  await builderReady(page)
  await expect(page.getByRole('heading', { name: '1. CLIENT & SITE DETAILS' })).toBeVisible()

  await page.getByRole('button', { name: /^Next:/ }).click()
  await expect(
    page.getByRole('heading', { name: '2. TREATMENT, PRODUCT(S) AND QUANTITIES APPLIED' }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { name: '1. CLIENT & SITE DETAILS' })).toBeVisible()
})

test('a suggested answer is marked, and confirmed by moving on', async ({ page }) => {
  const { email, owner, businessId, slug, reportId } = await startJobReport('fill-confirm')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports/${reportId}`)
  await builderReady(page)

  // The start time came from the booking, so the form says so rather than
  // passing it off as something the technician recorded.
  await expect(page.getByText('1 answer to confirm').or(page.getByText('2 answers to confirm'))).toBeVisible()
  await page.getByRole('button', { name: /CLIENT & SITE DETAILS/ }).first().click()
  await expect(page.getByText('Suggested').first()).toBeVisible()

  // Reading the section and moving on IS the confirmation.
  await page.getByRole('button', { name: /^Next:/ }).click()
  await expect(page.getByRole('heading', { name: /2\./ })).toBeVisible()

  await expect
    .poll(async () => {
      const report = await owner.client.query(api.reports.get, { businessId, reportId })
      return report!.prefill!.startTime.confirmedAt !== undefined
    })
    .toBe(true)
})

test('finalising an unfinished report says what is missing, and jumps there', async ({ page }) => {
  const { email, slug, reportId } = await startJobReport('fill-blocked')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports/${reportId}`)
  await builderReady(page)

  // Never greyed out: pressing it is how a technician finds out what is left.
  await page.getByRole('button', { name: 'Finalise & lock' }).first().click()

  // Each entry is the form's own words for what is wrong, not a field name.
  const outstanding = page.getByRole('alert')
  await expect(outstanding).toContainText('to finish')
  const safety = outstanding.getByRole('button', {
    name: /Record whether it is safe to commence work/,
  })
  await expect(safety).toBeVisible()

  // And each one is a way into the section that asks it.
  await safety.click()
  await expect(page.getByRole('heading', { name: '3. RISK ASSESSMENT' })).toBeVisible()
  await expect(
    page.getByRole('group', { name: 'Is it safe to commence work?' }),
  ).toBeVisible()
})
