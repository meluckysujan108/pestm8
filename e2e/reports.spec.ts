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

/**
 * The compliance layer (§5.3). The property that matters most is immutability:
 * a finalised report that can still be edited is not evidence of anything.
 */
test.describe('report immutability', () => {
  test('a finalised report rejects further edits server-side', async () => {
    const s = await setupBusinessWithSub('report-lock')

    const reportId = await s.owner.client.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      template: 'treatmentRecord',
      legalBasis: 'APVMA',
      data: {},
    })

    await s.owner.client.mutation(api.reports.saveDraft, {
      businessId: s.businessId,
      reportId,
      data: { product: 'Termidor', targetPest: 'Termites' },
    })

    await s.owner.client.mutation(api.reports.finalise, {
      businessId: s.businessId,
      reportId,
      data: { product: 'Termidor', targetPest: 'Termites' },
    })

    // Rejected at the function, not merely hidden by rendering a document view.
    await expectRejected(
      () =>
        s.owner.client.mutation(api.reports.saveDraft, {
          businessId: s.businessId,
          reportId,
          data: { product: 'Something else' },
        }),
      'REPORT_FINALISED',
    )

    await expectRejected(
      () =>
        s.owner.client.mutation(api.reports.finalise, {
          businessId: s.businessId,
          reportId,
          data: { product: 'Something else' },
        }),
      'REPORT_FINALISED',
    )

    const report = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(report!.status).toBe('finalised')
    expect(report!.canEdit).toBe(false)
    expect((report!.data as { product: string }).product).toBe('Termidor')
  })

  test('a report cannot be edited by someone who did not author it', async () => {
    const s = await setupBusinessWithSub('report-author')

    const reportId = await s.owner.client.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      template: 'treatmentRecord',
      legalBasis: 'APVMA',
      data: {},
    })

    await s.owner.client.mutation(api.memberships.setCanViewAllJobs, {
      businessId: s.businessId,
      membershipId: s.subMembershipId,
      canViewAllJobs: true,
    })

    // Visibility does not confer authorship.
    await expectRejected(
      () =>
        s.sub.client.mutation(api.reports.saveDraft, {
          businessId: s.businessId,
          reportId,
          data: { product: 'Tampered' },
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

    const reportId = await s.owner.client.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      template: 'treatmentRecord',
      legalBasis: 'APVMA',
      data: {},
    })

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

test.describe('durable notice', () => {
  test('finalising a termite certificate raises a manual follow-up', async () => {
    const s = await setupBusinessWithSub('durable-notice')

    const reportId = await s.owner.client.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      template: 'termiteManagementCert',
      legalBasis: 'AS 3660.2-2017',
      data: {},
    })

    const before = await s.owner.client.query(api.tasks.listOpen, {
      businessId: s.businessId,
    })
    expect(before).toHaveLength(0)

    await s.owner.client.mutation(api.reports.finalise, {
      businessId: s.businessId,
      reportId,
      data: { systemType: 'chemical', product: 'Termidor' },
      // The template supplies this; the test asserts it is persisted, because
      // the physical notice is the step the app genuinely cannot perform.
      tasks: [
        {
          kind: 'durableNotice',
          label: 'Fix durable notice in meter box',
          detail: 'AS 3660.2 / NCC require a physical notice.',
        },
      ],
    })

    const after = await s.owner.client.query(api.tasks.listOpen, {
      businessId: s.businessId,
    })
    expect(after).toHaveLength(1)
    expect(after[0].kind).toBe('durableNotice')
    expect(after[0].done).toBe(false)
    expect(after[0].reportId).toBe(reportId)
  })

  test('the outstanding notice is visible on the dashboard and dismissable', async ({
    page,
  }) => {
    const email = uniqueEmail('notice-owner')
    const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

    const { businessId, slug } = await owner.client.mutation(
      api.businesses.create,
      { name: `Notice ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
    )
    const propertyId = await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'J. Nguyen',
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })
    const reportId = await owner.client.mutation(api.reports.create, {
      businessId,
      propertyId,
      template: 'termiteManagementCert',
      legalBasis: 'AS 3660.2-2017',
      data: {},
    })
    await owner.client.mutation(api.reports.finalise, {
      businessId,
      reportId,
      data: { systemType: 'chemical', product: 'Termidor' },
      tasks: [
        {
          kind: 'durableNotice',
          label: 'Fix durable notice in meter box',
          detail: 'AS 3660.2 / NCC require a physical notice.',
        },
      ],
    })

    await signInViaUi(page, email)
    await page.goto(`/${slug}/dashboard`)

    // A tracked task nobody sees is not tracked.
    const notice = page.getByText('Fix durable notice in meter box')
    await expect(notice).toBeVisible()

    await page
      .getByRole('button', { name: 'Mark done: Fix durable notice in meter box' })
      .click()

    await expect(notice).toHaveCount(0)
  })
})

test.describe('report document', () => {
  test('a finalised certificate reads as prose, not stored codes', async ({
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
    const reportId = await owner.client.mutation(api.reports.create, {
      businessId,
      propertyId,
      template: 'termiteManagementCert',
      legalBasis: 'AS 3660.2-2017',
      data: {},
    })
    await owner.client.mutation(api.reports.finalise, {
      businessId,
      reportId,
      data: {
        systemType: 'chemical',
        product: 'Termidor HE',
        apvmaNumber: '62873',
        batchNumber: 'TH-2026-118',
        lifeExpectancy: '8 years',
        installDate: '17/08/2026',
        reinspectionInterval: '12',
        treatedZones: 'Full external perimeter.',
      },
    })

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/${reportId}`)

    await expect(page.getByText('Finalised and locked')).toBeVisible()
    // "chemical" and "12" are storage codes; a certificate has to say what it
    // means, both to a client and to whoever inspects it in eight years.
    await expect(page.getByText('Chemical soil barrier').first()).toBeVisible()
    await expect(page.getByText('12 months').first()).toBeVisible()
    // Full street address, as every legal document requires.
    await expect(page.getByText('12 Wattle Street').first()).toBeVisible()

    // §6.5 counts a report as delivered only if it leaves the app, so the
    // export is asserted as a real file rather than an enabled button.
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
    const reportId = await owner.client.mutation(api.reports.create, {
      businessId,
      propertyId,
      template: 'treatmentRecord',
      legalBasis: 'APVMA',
      data: {},
    })

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/${reportId}`)

    // A PDF of a draft would circulate as though it were the finished record.
    await expect(page.getByRole('button', { name: 'Finalise & lock' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download PDF' })).toHaveCount(0)
  })
})

test.describe('report builder', () => {
  test('an inspection cannot be finalised with a no-access area lacking a reason', async ({
    page,
  }) => {
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

    await page
      .getByRole('button', { name: /Timber Pest Inspection/ })
      .click()

    await expect(page.getByText('AS 4349.3-2010')).toBeVisible()
    // The locked scope limits must be visible, not buried behind a link.
    await expect(page.getByText('Standard terms — not editable')).toBeVisible()
    await expect(page.getByText(/visual inspection only/i)).toBeVisible()

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
