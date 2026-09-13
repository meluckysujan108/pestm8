import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  api,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
  FIXTURE_PASSWORD,
} from './fixtures'
import {
  FINALISE,
  createCustomReport,
  createReport,
  customTemplateArgs,
  finaliseReport,
  saveReportDraft,
  versionOf,
} from './fixtures/reportPayloads'
import { getTemplate } from '../src/lib/reportTemplates'

/**
 * The compliance layer (§5.3). The property that matters most is immutability:
 * a finalised report that can still be edited is not evidence of anything.
 */
test.describe('report immutability', () => {
  test('a finalised report rejects further edits server-side', async () => {
    const s = await setupBusinessWithSub('report-lock')

    const reportId = await createReport(s.owner.client, s, 'serviceReport')

    await saveReportDraft(s.owner.client, s, reportId, 'serviceReport', {
      ...FINALISE.serviceReport,
      comments: 'Termidor',
    })

    await finaliseReport(s.owner.client, s, reportId, 'serviceReport', {
      comments: 'Termidor',
    })

    // Rejected at the function, not merely hidden by rendering a document view.
    await expectRejected(
      () =>
        saveReportDraft(s.owner.client, s, reportId, 'serviceReport', {
          comments: 'Something else',
        }),
      'REPORT_FINALISED',
    )

    await expectRejected(
      () =>
        finaliseReport(s.owner.client, s, reportId, 'serviceReport', {
          comments: 'Something else',
        }),
      'REPORT_FINALISED',
    )

    const report = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(report!.status).toBe('finalised')
    expect(report!.canEdit).toBe(false)
    expect((report!.data as { comments: string }).comments).toBe('Termidor')
  })

  test('a report cannot be edited by someone who did not author it', async () => {
    const s = await setupBusinessWithSub('report-author')

    const reportId = await createReport(s.owner.client, s, 'serviceReport')

    await s.owner.client.mutation(api.memberships.setCanViewAllJobs, {
      businessId: s.businessId,
      membershipId: s.subMembershipId,
      canViewAllJobs: true,
    })

    // Visibility does not confer authorship.
    await expectRejected(
      () =>
        saveReportDraft(s.sub.client, s, reportId, 'serviceReport', {
          comments: 'Tampered',
        }),
      'NO_ACCESS',
    )
  })

  test('a report is invisible from another tenant', async () => {
    const s = await setupBusinessWithSub('report-tenant')
    const outsider = await signUpActor(
      uniqueEmail('outsider'),
      FIXTURE_PASSWORD,
      'Outsider',
    )

    const reportId = await createReport(s.owner.client, s, 'serviceReport')

    await expectRejected(
      () =>
        outsider.client.query(api.reports.get, {
          businessId: s.businessId,
          reportId,
        }),
      'NO_ACCESS',
    )
  })
})

test.describe('template revisions', () => {
  test('a retired template can no longer be started or cloned', async () => {
    const s = await setupBusinessWithSub('report-retired')

    // Every Treatment Record already written keeps rendering; there is simply
    // no source form behind a new one.
    await expectRejected(
      () =>
        s.owner.client.mutation(api.reports.create, {
          businessId: s.businessId,
          propertyId: s.propertyId,
          template: 'treatmentRecord',
          legalBasis: 'APVMA',
          data: {},
        }),
      'TEMPLATE_RETIRED',
    )
    await expectRejected(
      () =>
        s.owner.client.mutation(api.customTemplates.cloneBuiltin, {
          businessId: s.businessId,
          sourceTemplateId: 'treatmentRecord',
          name: 'Treatment Record (Ours)',
        }),
      'TEMPLATE_RETIRED',
    )
  })

  test('a write shaped for a different revision of the form is refused', async () => {
    const s = await setupBusinessWithSub('report-stale-tab')
    const reportId = await createReport(s.owner.client, s, 'serviceReport')

    // A stale tab still running yesterday's bundle declares no revision, which
    // means v1 — it must not save v1-shaped answers into a v2 draft.
    await expectRejected(
      () =>
        s.owner.client.mutation(api.reports.saveDraft, {
          businessId: s.businessId,
          reportId,
          data: { comments: 'from an old tab' },
        }),
      'TEMPLATE_VERSION_MISMATCH',
    )

    const report = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(report!.templateVersion).toBe(versionOf('serviceReport'))
    expect(report!.upgrade).toBeNull()
  })
})

test.describe('report document', () => {
  test('a finalised certificate prints the verbatim answers and no invented notice', async ({
    page,
  }) => {
    const email = uniqueEmail('doc-owner')
    const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

    const { businessId, slug } = await owner.client.mutation(
      api.businesses.create,
      { name: `Doc ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
    )
    const propertyId = await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'J. Nguyen',
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })
    const reportId = await createReport(
      owner.client,
      { businessId, propertyId },
      'termiteManagementCert',
    )
    await finaliseReport(
      owner.client,
      { businessId },
      reportId,
      'termiteManagementCert',
    )

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/${reportId}`)

    await expect(page.getByText('Finalised and locked')).toBeVisible()
    // Stored as the words the AS 3660.2 form uses, and printed exactly — exact
    // matching, because Playwright's default is a case-insensitive substring
    // and a re-cased answer would otherwise pass.
    await expect(
      page.getByText('Chemical Soil Barrier', { exact: true }).first(),
    ).toBeVisible()
    await expect(page.getByText('12 months', { exact: true }).first()).toBeVisible()
    // The form's own terms print from the template, not an invented summary.
    await expect(
      page.getByText('Purpose Of Termite Management Systems', { exact: true }),
    ).toBeVisible()
    // The durable notice was app-invented; the verbatim certificate has none.
    await expect(page.getByText('DO NOT REMOVE THIS NOTICE')).toHaveCount(0)
    // Full street address, as every legal document requires.
    await expect(page.getByText('12 Wattle Street').first()).toBeVisible()

    // §6.5 counts a report as delivered only if it leaves the app, so the
    // export is asserted as a real file rather than an enabled button. The
    // download lives behind the action bar's "PDF" tab (Phase 6).
    await page.getByRole('tab', { name: 'PDF' }).click()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download PDF' }).click()
    const download = await downloadPromise

    expect(download.suggestedFilename()).toMatch(/\.pdf$/)

    const path = await download.path()
    const bytes = await readFile(path)
    // %PDF- magic number: proves a real document, not an empty or HTML blob.
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(bytes.byteLength).toBeGreaterThan(1000)
  })

  test('a draft offers no PDF export', async ({ page }) => {
    const email = uniqueEmail('draft-owner')
    const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

    const { businessId, slug } = await owner.client.mutation(
      api.businesses.create,
      { name: `Draft ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
    )
    const propertyId = await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'J. Nguyen',
      addressLine: '9 Banksia Road',
      suburb: 'Morley',
      state: 'WA',
      postcode: '6062',
    })
    const reportId = await createReport(
      owner.client,
      { businessId, propertyId },
      'serviceReport',
    )

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/${reportId}`)

    // A PDF of a draft would circulate as though it were the finished record.
    await expect(page.getByRole('button', { name: 'Finalise & lock' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download PDF' })).toHaveCount(0)
  })
})

test.describe('report builder', () => {
  test('the Timber picker opens the verbatim AS 4349.3 form', async ({ page }) => {
    const email = uniqueEmail('builder-owner')
    const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

    const { businessId, slug } = await owner.client.mutation(
      api.businesses.create,
      { name: `Builder ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
    )
    await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'J. Nguyen',
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/new`)

    const timber = getTemplate('timberPestInspection')
    // Retired: no longer offered, though its reports still render.
    await expect(page.getByText('Treatment Record', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: new RegExp(timber.name) }).click()

    await expect(page.getByText(timber.legalBasis, { exact: true }).first()).toBeVisible()
    // Every numbered section of the source form, in its own words.
    for (const section of timber.sections ?? []) {
      if (section.number === undefined) continue
      await expect(
        page.getByRole('heading', { name: `${section.number}. ${section.title}`, exact: true }),
      ).toBeVisible()
    }
    // The source's own recommendation notice — the paraphrase this replaced
    // said "seven days" where the form says thirty.
    await expect(
      page.getByText('more than thirty days after the Inspection Date', { exact: false }),
    ).toBeVisible()
    await expect(page.getByText('seven days')).toHaveCount(0)
  })

  test('an area marked no-access cannot be finalised without a reason', async ({
    page,
  }) => {
    const email = uniqueEmail('builder-areas')
    const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
    const { businessId, slug } = await owner.client.mutation(
      api.businesses.create,
      { name: `Areas ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
    )
    const propertyId = await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'J. Nguyen',
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })
    // The area-by-area checklist lives on in business-authored templates; the
    // built-in that used it was a paraphrase of a form the business never issued.
    const templateId = await owner.client.mutation(
      api.customTemplates.create,
      { businessId, ...customTemplateArgs() },
    )
    const reportId = await createCustomReport(
      owner.client,
      { businessId, propertyId },
      templateId,
    )

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/${reportId}`)

    // Mark the roof void inaccessible without saying why.
    await page.getByRole('button', { name: 'Roof void: No access' }).click()
    await expect(
      page.getByLabel('Roof void — reason for no access'),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Finalise & lock' }).click()

    await expect(
      page.getByText('A reason is required when an area was not inspected'),
    ).toBeVisible()
    // Still a draft: the form is still on screen rather than a locked document.
    await expect(
      page.getByRole('button', { name: 'Finalise & lock' }),
    ).toBeVisible()
  })
})
