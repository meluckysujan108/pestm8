import { expect, test } from '@playwright/test'
import { FIXTURE_PASSWORD, api, signInViaUi, signUpActor, uniqueEmail } from './fixtures'

/**
 * The reports list page's dashboard cards, search, and status filter
 * (`src/routes/$businessSlug/reports/index.tsx`) — all computed client-side
 * from the same `reports.listForBusiness` payload, so this is really testing
 * one thing: that "Draft" / "Finalised" / "Sent" bucketing and the free-text
 * search over client/suburb/template compose correctly, not three separate
 * features. "Sent" itself (finalised + `emailedAt`) isn't exercised here —
 * that needs a real Resend send, which needs `RESEND_API_KEY` configured
 * (see `e2e/email.spec.ts`), so this sticks to what's reachable without it.
 */
test('the reports list buckets by status and searches across client, suburb, and form name', async ({
  page,
}) => {
  const email = uniqueEmail('reportslist-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { businessId, slug } = await owner.client.mutation(api.businesses.create, {
    name: `Reports List Co ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  const nguyen = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const roberts = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'M. Roberts',
    addressLine: '9 Banksia Road',
    suburb: 'Morley',
    state: 'WA',
    postcode: '6062',
  })

  // Two drafts for Nguyen, one draft for Roberts, one finalised for Nguyen —
  // deliberately uneven so the counts can't pass by accident (e.g. 2 and 2).
  await owner.client.mutation(api.reports.create, {
    businessId,
    propertyId: nguyen,
    template: 'termiteManagementCert',
    legalBasis: 'AS 3660.2-2017',
    data: {},
  })
  await owner.client.mutation(api.reports.create, {
    businessId,
    propertyId: nguyen,
    template: 'timberPestInspection',
    legalBasis: 'AS 4349.3-2010',
    data: {},
  })
  await owner.client.mutation(api.reports.create, {
    businessId,
    propertyId: roberts,
    template: 'treatmentRecord',
    legalBasis: 'APVMA',
    data: {},
  })
  const finalisedReportId = await owner.client.mutation(api.reports.create, {
    businessId,
    propertyId: nguyen,
    template: 'serviceReport',
    legalBasis: 'APVMA · AEPMA',
    data: {},
  })
  await owner.client.mutation(api.reports.finalise, {
    businessId,
    reportId: finalisedReportId,
    data: { safeToStart: true, treatments: [] },
  })

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports`)

  // Dashboard cards — scoped to `.section-label` since "Draft"/"Finalised"
  // also appear as status pill text and Segmented tab labels elsewhere on
  // this same page.
  const draftCard = page.locator('.section-label', { hasText: 'Draft' }).locator('..')
  await expect(draftCard.getByText('3', { exact: true })).toBeVisible()
  const finalisedCard = page
    .locator('.section-label', { hasText: 'Finalised' })
    .locator('..')
  await expect(finalisedCard.getByText('1', { exact: true })).toBeVisible()

  // Filter tab: Draft shows exactly the 3 unfinalised reports, and excludes
  // the finalised report even though it shares a template name with none of
  // the drafts (deliberately — a same-named draft/finalised pair would make
  // this assertion pass by accident).
  await page.getByRole('tab', { name: 'Draft' }).click()
  await expect(page.getByText('Termite Management Certificate')).toBeVisible()
  await expect(page.getByText('Timber Pest Inspection')).toBeVisible()
  await expect(page.getByText('Treatment Record')).toBeVisible()
  await expect(page.getByText('Pest Service Report')).toHaveCount(0)

  // Filter tab: Finalised shows the one locked report.
  await page.getByRole('tab', { name: 'Finalised', exact: true }).click()
  await expect(page.getByText('Timber Pest Inspection')).toHaveCount(0)
  await expect(page.getByText('Pest Service Report')).toBeVisible()

  // Back to All, then search narrows across client/suburb/template together.
  await page.getByRole('tab', { name: 'All' }).click()
  await page.getByPlaceholder('Search by client, suburb or form').fill('Morley')
  await expect(page.getByText('Treatment Record')).toBeVisible()
  await expect(page.getByText('Timber Pest Inspection')).toHaveCount(0)
  await expect(page.getByText('Pest Service Report')).toHaveCount(0)

  // Search + filter compose: Nguyen text search while on the Draft tab
  // excludes Nguyen's *finalised* report and Roberts entirely.
  await page.getByPlaceholder('Search by client, suburb or form').fill('Nguyen')
  await page.getByRole('tab', { name: 'Draft' }).click()
  await expect(page.getByText('Timber Pest Inspection')).toBeVisible()
  await expect(page.getByText('Treatment Record')).toHaveCount(0)
  await expect(page.getByText('Pest Service Report')).toHaveCount(0)

  // No matches — the empty state, not a blank list.
  await page.getByPlaceholder('Search by client, suburb or form').fill('nobody-lives-here')
  await expect(page.getByText('No matches')).toBeVisible()
})
