import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import {
  createCustomReport,
  createReport,
  customTemplateArgs,
  finaliseReport,
} from './fixtures/reportPayloads'
import { getTemplate } from '../src/lib/reportTemplates'

// Row names come from the templates themselves, matched exactly: Playwright's
// default is a case-insensitive substring, which would let a renamed form pass.
const CERTIFICATE = getTemplate('termiteManagementCert').name
const TIMBER = getTemplate('timberPestInspection').name
const SERVICE = getTemplate('serviceReport').name
const WALKTHROUGH = 'Site Walkthrough'
const exact = { exact: true } as const

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
  await createReport(
    owner.client,
    { businessId, propertyId: nguyen },
    'termiteManagementCert',
  )
  await createReport(
    owner.client,
    { businessId, propertyId: nguyen },
    'timberPestInspection',
  )
  // A business-authored form for Roberts, so every draft has a distinct name.
  const walkthrough = await owner.client.mutation(api.customTemplates.create, {
    businessId,
    ...customTemplateArgs({ name: WALKTHROUGH }),
  })
  await createCustomReport(
    owner.client,
    { businessId, propertyId: roberts },
    walkthrough,
  )
  const finalisedReportId = await createReport(
    owner.client,
    { businessId, propertyId: nguyen },
    'serviceReport',
  )
  await finaliseReport(
    owner.client,
    { businessId },
    finalisedReportId, 'serviceReport',
  )

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
  // this assertion pass by accident). The counts above are server-rendered, so
  // they are no readiness signal; the tabs stay disabled until hydration.
  await expect(page.getByRole('tab', { name: 'Draft' })).toBeEnabled()
  await page.getByRole('tab', { name: 'Draft' }).click()
  await expect(page.getByText(CERTIFICATE, exact)).toBeVisible()
  await expect(page.getByText(TIMBER, exact)).toBeVisible()
  await expect(page.getByText(WALKTHROUGH, exact)).toBeVisible()
  await expect(page.getByText(SERVICE, exact)).toHaveCount(0)

  // Filter tab: Finalised shows the one locked report.
  await page.getByRole('tab', { name: 'Finalised', exact: true }).click()
  await expect(page.getByText(TIMBER, exact)).toHaveCount(0)
  await expect(page.getByText(SERVICE, exact)).toBeVisible()

  // Back to All, then search narrows across client/suburb/template together.
  await page.getByRole('tab', { name: 'All' }).click()
  await page.getByPlaceholder('Client, street, form or #number').fill('Morley')
  await expect(page.getByText(WALKTHROUGH, exact)).toBeVisible()
  await expect(page.getByText(TIMBER, exact)).toHaveCount(0)
  await expect(page.getByText(SERVICE, exact)).toHaveCount(0)

  // Search + filter compose: Nguyen text search while on the Draft tab
  // excludes Nguyen's *finalised* report and Roberts entirely.
  await page.getByPlaceholder('Client, street, form or #number').fill('Nguyen')
  await page.getByRole('tab', { name: 'Draft' }).click()
  await expect(page.getByText(TIMBER, exact)).toBeVisible()
  await expect(page.getByText(WALKTHROUGH, exact)).toHaveCount(0)
  await expect(page.getByText(SERVICE, exact)).toHaveCount(0)

  // No matches — the empty state, not a blank list.
  await page.getByPlaceholder('Client, street, form or #number').fill('nobody-lives-here')
  await expect(page.getByText('No matches')).toBeVisible()
})

test.describe('retiring a draft', () => {
  test('a draft goes to Deleted and comes back, and a finalised report cannot', async () => {
    const s = await setupBusinessWithSub('list-delete')
    const draftId = await createReport(s.owner.client, s, 'serviceReport')
    const lockedId = await createReport(s.owner.client, s, 'serviceReport')
    await finaliseReport(s.owner.client, s, lockedId, 'serviceReport')

    await s.owner.client.mutation(api.reports.softDelete, {
      businessId: s.businessId,
      reportId: draftId,
    })

    // Out of the list, into Deleted — with its photos, which are evidence
    // that somebody stood somewhere and took them.
    const drafts = await s.owner.client.query(api.reports.list, {
      businessId: s.businessId,
      filter: 'draft',
      paginationOpts: { numItems: 25, cursor: null },
    })
    expect(drafts.page.map((r) => r._id)).not.toContain(draftId)

    const trash = await s.owner.client.query(api.reports.list, {
      businessId: s.businessId,
      filter: 'trash',
      paginationOpts: { numItems: 25, cursor: null },
    })
    expect(trash.page.map((r) => r._id)).toContain(draftId)

    await s.owner.client.mutation(api.reports.restore, {
      businessId: s.businessId,
      reportId: draftId,
    })
    const back = await s.owner.client.query(api.reports.list, {
      businessId: s.businessId,
      filter: 'draft',
      paginationOpts: { numItems: 25, cursor: null },
    })
    expect(back.page.map((r) => r._id)).toContain(draftId)

    // A finalised report is a record the business is required to keep — WA's
    // pesticide regulations say three years, ten with a termite certificate —
    // so there is deliberately no way to delete one.
    await expectRejected(
      () =>
        s.owner.client.mutation(api.reports.softDelete, {
          businessId: s.businessId,
          reportId: lockedId,
        }),
      'REPORT_FINALISED',
    )
  })

  test('an owner can clear a subcontractor’s abandoned draft; a stranger cannot', async () => {
    const s = await setupBusinessWithSub('list-delete-access')
    const draftId = await createReport(s.sub.client, s, 'serviceReport')

    const outsider = await signUpActor(
      uniqueEmail('list-delete-outsider'),
      FIXTURE_PASSWORD,
      'Nadia',
    )
    await expectRejected(
      () =>
        outsider.client.mutation(api.reports.softDelete, {
          businessId: s.businessId,
          reportId: draftId,
        }),
      'NO_ACCESS',
    )

    // The owner can: an abandoned draft on someone else's name still clutters
    // the business's own list.
    await s.owner.client.mutation(api.reports.softDelete, {
      businessId: s.businessId,
      reportId: draftId,
    })
    const trash = await s.owner.client.query(api.reports.list, {
      businessId: s.businessId,
      filter: 'trash',
      paginationOpts: { numItems: 25, cursor: null },
    })
    expect(trash.page.map((r) => r._id)).toContain(draftId)
  })

  test('deleting permanently only works from Deleted', async () => {
    const s = await setupBusinessWithSub('list-remove')
    const draftId = await createReport(s.owner.client, s, 'serviceReport')

    await expectRejected(
      () =>
        s.owner.client.mutation(api.reports.remove, {
          businessId: s.businessId,
          reportId: draftId,
        }),
      'NOT_IN_TRASH',
    )

    await s.owner.client.mutation(api.reports.softDelete, {
      businessId: s.businessId,
      reportId: draftId,
    })
    await s.owner.client.mutation(api.reports.remove, {
      businessId: s.businessId,
      reportId: draftId,
    })
    expect(
      await s.owner.client.query(api.reports.get, {
        businessId: s.businessId,
        reportId: draftId,
      }),
    ).toBeNull()
  })
})

test('a finalised report is findable by the number the client quotes', async () => {
  const s = await setupBusinessWithSub('list-search-number')
  const reportId = await createReport(s.owner.client, s, 'serviceReport')
  await finaliseReport(s.owner.client, s, reportId, 'serviceReport')

  const report = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId,
  })
  expect(typeof report!.reportNumber).toBe('number')

  // The number on the printed footer is the only thing a client is likely to
  // have in front of them on the phone.
  const found = await s.owner.client.query(api.reports.search, {
    businessId: s.businessId,
    term: `#${report!.reportNumber}`,
    filter: 'all',
  })
  expect(found.map((r) => r._id)).toContain(reportId)
})

test('a subcontractor sees their own reports even when newer ones are not theirs', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('list-sub-paging')

  // The sub's report first, then enough of the owner's to fill a page on top
  // of it. Visibility is applied after the page is drawn, so the sub's first
  // page is entirely other people's reports — and a list that stopped there
  // would tell them they have none.
  const theirs = await createReport(s.sub.client, s, 'serviceReport')
  // In parallel: twenty-six sequential creates is a minute of setup under
  // worker contention, and this test is about the paging, not the seeding.
  await Promise.all(
    Array.from({ length: 26 }, () => createReport(s.owner.client, s, 'serviceReport')),
  )

  await signInViaUi(page, s.sub.email)
  await page.goto(`/${s.slug}/reports`)

  await expect(page.getByRole('tab', { name: 'All' })).toBeEnabled()
  await expect(
    page.getByRole('link', { name: new RegExp(SERVICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }),
  ).toHaveCount(1, { timeout: 25_000 })

  const visible = await s.sub.client.query(api.reports.list, {
    businessId: s.businessId,
    filter: 'all',
    paginationOpts: { numItems: 25, cursor: null },
  })
  expect(visible.page.every((r) => r._id === theirs || false)).toBe(true)
})

test('a report left unfinished is said so, where somebody is looking', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('list-stale')
  const stale = await createReport(s.owner.client, s, 'serviceReport')

  // Asked for with a threshold of nothing, because no test can wait four days
  // and a backdating mutation would be a production endpoint that exists only
  // for tests. The threshold is a real argument: "drafts older than a day" is
  // a question worth being able to ask.
  const flagged = await s.owner.client.query(api.reports.staleDrafts, {
    businessId: s.businessId,
    olderThanMs: 0,
  })
  expect(flagged.count).toBe(1)
  expect(flagged.oldest).toBe(stale)

  // And a draft made this minute is not nagged about: WA's Pesticides
  // Regulations give an operator two business days, and a banner that fires
  // immediately is one nobody reads by the end of the week.
  const quiet = await s.owner.client.query(api.reports.staleDrafts, {
    businessId: s.businessId,
  })
  expect(quiet.count).toBe(0)

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/reports`)
  await expect(page.getByRole('tab', { name: 'All' })).toBeEnabled()
  await expect(page.getByText(/left unfinished/)).toHaveCount(0)
})
