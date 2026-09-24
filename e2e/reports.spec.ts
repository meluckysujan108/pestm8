import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  licenceSelf,
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
  builderReady,
  createCustomReport,
  createReport,
  customSectionUrl,
  customTemplateArgs,
  finaliseReport,
  saveReportDraft,
  signReport,
  versionOf,
} from './fixtures/reportPayloads'
import {
  downloadFromViewer,
  drawOnPage,
  openReportPdf,
  reportViewer,
} from './fixtures/reportViewer'
import { getTemplate } from '../src/lib/reportTemplates'
import type { Id } from '../convex/_generated/dataModel'

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
    await licenceSelf(owner, businessId)
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
    // export is asserted as a real file rather than an enabled button. It
    // leaves from the app's viewer: the action bar's "PDF" tab, View PDF,
    // then Save in the viewer's More menu.
    const viewer = await openReportPdf(page)
    const download = await downloadFromViewer(page, viewer)

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
    await licenceSelf(owner, businessId)
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
    // A draft is a form: no action bar, so no PDF tab and no way to the viewer.
    await expect(page.getByRole('button', { name: 'Finalise & lock' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'PDF' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'View PDF' })).toHaveCount(0)

    // Nor does the address open one: `?view=pdf` belongs to a finalised
    // report, and a draft's page ignores it.
    await page.goto(`/${slug}/reports/${reportId}?view=pdf`)
    await builderReady(page)
    await expect(reportViewer(page)).toHaveCount(0)
  })

  test('a mark drawn in the viewer is kept on the page it was drawn on, for the team only', async ({
    page,
  }) => {
    const email = uniqueEmail('markup-owner')
    const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

    const { businessId, slug } = await owner.client.mutation(
      api.businesses.create,
      { name: `Markup ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
    )
    await licenceSelf(owner, businessId)
    const propertyId = await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'J. Nguyen',
      addressLine: '4 Jarrah Close',
      suburb: 'Bassendean',
      state: 'WA',
      postcode: '6054',
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
    const viewer = await openReportPdf(page)

    // The pen appears once the marks have loaded, and says who sees them.
    await viewer.getByRole('button', { name: 'Markup', exact: true }).click()
    const palette = viewer.getByRole('group', { name: 'Markup' })
    await expect(
      palette.getByText(
        'Marks are for your team. Share sends the report without them.',
      ),
    ).toBeVisible()
    // Nothing of yours yet: nothing to take back.
    await expect(
      palette.getByRole('button', { name: 'Undo my last mark' }),
    ).toBeDisabled()

    await drawOnPage(page, viewer, 1)
    await expect(viewer.locator('[data-markup-stroke="mine"]')).toHaveCount(1)

    // Stored on page 1 — the viewer counts its pages from 0 and the table
    // from 1, and a slip there moves every mark onto the next page.
    await expect
      .poll(async () => {
        const marks = await owner.client.query(
          api.reportAnnotations.listForReport,
          { businessId, reportId },
        )
        return marks.map((mark) => ({ page: mark.page, mine: mark.mine }))
      })
      .toEqual([{ page: 1, mine: true }])

    // Undo takes it back, on the screen and on the server.
    await palette.getByRole('button', { name: 'Undo my last mark' }).click()
    await expect(viewer.locator('[data-markup-stroke="mine"]')).toHaveCount(0)
    await expect
      .poll(async () =>
        (
          await owner.client.query(api.reportAnnotations.listForReport, {
            businessId,
            reportId,
          })
        ).length,
      )
      .toBe(0)
  })
})

test.describe('finalise refuses an unfinished report', () => {
  test('server-side, not just on the screen', async () => {
    const s = await setupBusinessWithSub('report-incomplete')
    const reportId = await createReport(s.owner.client, s, 'serviceReport')

    // The browser is not the guard: a stale tab, a replayed request or any
    // future non-browser caller must not be able to lock an undated,
    // unsigned document.
    await expectRejected(
      () =>
        s.owner.client.mutation(api.reports.finalise, {
          businessId: s.businessId,
          reportId,
          data: { comments: 'all done' },
          templateVersion: versionOf('serviceReport'),
        }),
      'REPORT_INCOMPLETE',
    )

    const report = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(report!.status).toBe('draft')
  })

  test('and says which questions, so the form can point at them', async () => {
    const s = await setupBusinessWithSub('report-incomplete-issues')
    const reportId = await createReport(s.owner.client, s, 'serviceReport')

    let data: unknown
    try {
      await s.owner.client.mutation(api.reports.finalise, {
        businessId: s.businessId,
        reportId,
        data: {},
        templateVersion: versionOf('serviceReport'),
      })
    } catch (error) {
      data = (error as { data?: unknown }).data
    }

    const payload = data as { code?: string; issues?: Array<{ key: string; message: string }> }
    expect(payload.code).toBe('REPORT_INCOMPLETE')
    expect(payload.issues?.map((issue) => issue.key)).toContain('safeToStart')
    expect(payload.issues?.every((issue) => issue.message.length > 0)).toBe(true)
  })

  test('a signature is an image, not a timestamp in the answers', async () => {
    const s = await setupBusinessWithSub('report-unsigned')
    const reportId = await createReport(s.owner.client, s, 'serviceReport')

    // Everything the form asks for, including a `signedAt` — but nothing was
    // ever drawn, so there is no signature to print.
    await expectRejected(
      () =>
        s.owner.client.mutation(api.reports.finalise, {
          businessId: s.businessId,
          reportId,
          data: {
            serviceDate: '2026-08-28',
            safeToStart: true,
            treatments: [],
            technicianSignature: { signedAt: Date.now() },
          },
          templateVersion: versionOf('serviceReport'),
        }),
      'REPORT_INCOMPLETE',
    )

    // Signed for real, it locks.
    await signReport(s.owner.client, s, reportId, 'technician')
    await finaliseReport(s.owner.client, s, reportId, 'serviceReport')
    const report = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(report!.status).toBe('finalised')
  })
})

test.describe('the number a client quotes over the phone', () => {
  test('is handed out when a report is finished, in the order they were finished', async () => {
    const s = await setupBusinessWithSub('report-numbers')
    const first = await createReport(s.owner.client, s, 'serviceReport')
    const second = await createReport(s.owner.client, s, 'serviceReport')

    // Finished in the opposite order to the one they were started in. A number
    // allocated at create would leave the first-issued report numbered 2 — and
    // a draft abandoned in a van would burn a number out of the sequence
    // entirely, so the business's records would read 1, 3, 4 with no 2 to
    // produce if anyone ever asked for it.
    await signReport(s.owner.client, s, second, 'technician')
    await finaliseReport(s.owner.client, s, second, 'serviceReport')
    await signReport(s.owner.client, s, first, 'technician')
    await finaliseReport(s.owner.client, s, first, 'serviceReport')

    const numberOf = async (reportId: Id<'reports'>) =>
      (await s.owner.client.query(api.reports.get, { businessId: s.businessId, reportId }))!
        .reportNumber

    expect(await numberOf(second)).toBe(1)
    expect(await numberOf(first)).toBe(2)
  })

  test('counts per business, not across the app', async () => {
    // Two businesses' first reports are both #1: the sequence is the thing a
    // client is told, and it belongs to whoever issued the document.
    const a = await setupBusinessWithSub('report-numbers-a')
    const b = await setupBusinessWithSub('report-numbers-b')

    for (const s of [a, b]) {
      const reportId = await createReport(s.owner.client, s, 'serviceReport')
      await signReport(s.owner.client, s, reportId, 'technician')
      await finaliseReport(s.owner.client, s, reportId, 'serviceReport')
      const report = await s.owner.client.query(api.reports.get, {
        businessId: s.businessId,
        reportId,
      })
      expect(report!.reportNumber).toBe(1)
    }
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
    await licenceSelf(owner, businessId)
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

    // The overview lists every numbered section of the source form, in its own
    // words — the form is answered one section at a time, so this is where the
    // whole of it is visible at once.
    for (const section of timber.sections ?? []) {
      if (section.number === undefined) continue
      await expect(
        page.getByRole('button', { name: new RegExp(escapeForRegExp(section.title)) }).first(),
      ).toBeVisible()
    }

    // And opening one shows that section's own questions and notices. The
    // source's recommendation notice is the paraphrase this replaced: it said
    // "seven days" where the form says thirty.
    await page.getByRole('button', { name: /CLIENT DETAILS/ }).first().click()
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
    await licenceSelf(owner, businessId)
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
    await page.goto(customSectionUrl(slug, reportId))

    // The builder is server-rendered, and a tap before hydration is dropped.
    await builderReady(page)

    // Mark the roof void inaccessible without saying why.
    await page.getByRole('button', { name: 'Roof void: No access' }).click()
    await expect(
      page.getByLabel('Roof void — reason for no access'),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Finalise & lock' }).click()

    // Said twice on purpose: against the field, and in the list of what is
    // still outstanding at the foot of the form.
    await expect(
      page.getByText('A reason is required when an area was not inspected').first(),
    ).toBeVisible()
    // Still a draft: the form is still on screen rather than a locked document.
    await expect(
      page.getByRole('button', { name: 'Finalise & lock' }),
    ).toBeVisible()
  })
})

/** A section title is prose: brackets and dots in it are not pattern syntax. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test.describe('a business’s own settings for a form it did not write', () => {
  test('changes who has to sign, and the server agrees', async () => {
    const s = await setupBusinessWithSub('settings-signers')

    // By default the technician must sign — the app's own rule, not the
    // form's, and wrong for a business whose office locks reports the next
    // morning.
    const before = await createReport(s.owner.client, s, 'serviceReport')
    await expectRejected(
      () =>
        s.owner.client.mutation(api.reports.finalise, {
          businessId: s.businessId,
          reportId: before,
          data: { ...FINALISE.serviceReport },
          templateVersion: versionOf('serviceReport'),
        }),
      'REPORT_INCOMPLETE',
    )

    await s.owner.client.mutation(api.templateSettings.set, {
      businessId: s.businessId,
      templateRef: 'serviceReport',
      requiredSigners: [],
    })

    // Same payload, no signature attached, and now it locks.
    const after = await createReport(s.owner.client, s, 'serviceReport')
    await s.owner.client.mutation(api.reports.finalise, {
      businessId: s.businessId,
      reportId: after,
      data: { ...FINALISE.serviceReport },
      templateVersion: versionOf('serviceReport'),
    })
    const report = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId: after,
    })
    expect(report!.status).toBe('finalised')
  })

  test('only an owner may set them', async () => {
    const s = await setupBusinessWithSub('settings-owner-only')
    await expectRejected(
      () =>
        s.sub.client.mutation(api.templateSettings.set, {
          businessId: s.businessId,
          templateRef: 'serviceReport',
          formName: 'Anything',
        }),
      'NO_ACCESS',
    )
  })

  test('the cover follows the settings, and a signed report keeps its own', async () => {
    const s = await setupBusinessWithSub('settings-cover')
    await s.owner.client.mutation(api.templateSettings.set, {
      businessId: s.businessId,
      templateRef: 'serviceReport',
      coverTitle: 'Pest Control Service Record',
      formName: 'Service Record',
    })

    const reportId = await createReport(s.owner.client, s, 'serviceReport')
    const draft = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(draft!.settings?.print?.formName).toBe('Service Record')

    await finaliseReport(s.owner.client, s, reportId, 'serviceReport')

    // Frozen with the wording: the settings are baked into the snapshot, and
    // the report stops reading live ones so a later rename cannot relabel a
    // document somebody already received.
    const locked = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(locked!.settings).toBeNull()
    expect(locked!.templateSnapshot?.print?.formName).toBe('Service Record')
    expect(locked!.templateSnapshot?.print?.cover?.title).toBe(
      'Pest Control Service Record',
    )
  })
})

test('a rodent treatment says when the label wants somebody back', async ({ page }) => {
  const s = await setupBusinessWithSub('sgar-notice')
  const reportId = await createReport(s.owner.client, s, 'serviceReport')
  await finaliseReport(s.owner.client, s, reportId, 'serviceReport', {
    treatments: [
      {
        _id: 'r1',
        treatment: ['Rodents'],
        product: ['Ditrac All Weather Blox (0.05 g/kg Bromadiolone)'],
        quantity: ['Bait Blocks'],
        method: ['SGARS in compliance with the new 35 day ruling'],
      },
    ],
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/reports/${reportId}`)

  // A suspension with replacement label instructions — the copy must never
  // call it a ban or new legislation (docs/reports/fidelity.md).
  const notice = page.getByText(/APVMA label instructions require an evaluation/)
  await expect(notice).toBeVisible()
  await expect(page.getByText(/\bban\b/i)).toHaveCount(0)
  await expect(page.getByText(/new legislation/i)).toHaveCount(0)
  // It points at the week, and books nothing: a visit has a price and a
  // person attached, and the report knows neither.
  await expect(page.getByRole('link', { name: 'Open that week' })).toBeVisible()
})

test('a report that used no rodenticide says nothing about one', async ({ page }) => {
  const s = await setupBusinessWithSub('sgar-quiet')
  const reportId = await createReport(s.owner.client, s, 'serviceReport')
  await finaliseReport(s.owner.client, s, reportId, 'serviceReport')

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/reports/${reportId}`)
  await expect(page.getByRole('tab', { name: 'PDF' })).toBeEnabled()
  await expect(page.getByText(/APVMA label instructions/)).toHaveCount(0)
})
