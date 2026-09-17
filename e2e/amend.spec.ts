import { expect, test } from '@playwright/test'
import { api, expectRejected, setupBusinessWithSub, signInViaUi } from './fixtures'
import {
  createReport,
  finaliseReport,
  signReport,
  versionOf,
} from './fixtures/reportPayloads'

/**
 * Correcting a document that has already been signed.
 *
 * A finalised report is never edited — that is the whole point of finalising,
 * and a compliance record that can be changed afterwards is worth nothing. So
 * a correction is a NEW document carrying the same report number at the next
 * version, and the one it replaces says so.
 *
 * What is deliberately not carried is the interesting part: a signature was
 * applied to a specific document, and moving it to a different one is forgery
 * with extra steps.
 */

async function finalisedReport(label: string) {
  const s = await setupBusinessWithSub(label)
  const reportId = await createReport(s.owner.client, s, 'serviceReport')
  await finaliseReport(s.owner.client, { businessId: s.businessId }, reportId, 'serviceReport', {
    comments: 'Treated the perimeter.',
  })
  return { ...s, reportId }
}

test('an amendment is a new document with the same number and the next version', async () => {
  const s = await finalisedReport('amend-basic')

  const before = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId: s.reportId,
  })
  expect(before!.version).toBe(1)
  expect(before!.reportNumber).toBeGreaterThan(0)

  const amendmentId = await s.owner.client.mutation(api.reports.amend, {
    businessId: s.businessId,
    reportId: s.reportId,
    reason: 'Wrong product recorded against the second treatment.',
  })

  const amendment = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId: amendmentId,
  })
  expect(amendment!.reportNumber).toBe(before!.reportNumber)
  expect(amendment!.version).toBe(2)
  expect(amendment!.status).toBe('draft')
  expect(amendment!.supersedesReportId).toBe(s.reportId)
  expect(amendment!.amendmentReason).toBe(
    'Wrong product recorded against the second treatment.',
  )
  // The answers come forward, so the correction is the edit and not the form
  // again.
  expect((amendment!.data as Record<string, unknown>).comments).toBe(
    'Treated the perimeter.',
  )

  // And the document it replaces says so.
  const after = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId: s.reportId,
  })
  expect(after!.supersededByReportId).toBe(amendmentId)
  // Still finalised, still a record. Amending never unlocks anything.
  expect(after!.status).toBe('finalised')
})

test('the signature does not come with it', async () => {
  const s = await finalisedReport('amend-signature')

  const signed = await s.owner.client.query(api.reports.signatureUrls, {
    businessId: s.businessId,
    reportId: s.reportId,
  })
  expect(Object.keys(signed)).toContain('technician')

  const amendmentId = await s.owner.client.mutation(api.reports.amend, {
    businessId: s.businessId,
    reportId: s.reportId,
    reason: 'Corrected the finish time.',
  })

  // A signature was applied to a specific document; carrying it to a different
  // one is forgery with extra steps. The amendment is signed again.
  expect(
    Object.keys(
      await s.owner.client.query(api.reports.signatureUrls, {
        businessId: s.businessId,
        reportId: amendmentId,
      }),
    ),
  ).toEqual([])

  // Which means it cannot be locked until somebody does.
  await expectRejected(
    () =>
      s.owner.client.mutation(api.reports.finalise, {
        businessId: s.businessId,
        reportId: amendmentId,
        data: { serviceDate: '2026-08-28', safeToStart: true, treatments: [] },
        templateVersion: versionOf('serviceReport'),
      }),
    'REPORT_INCOMPLETE',
  )
})

test('an amendment locks as the next issue of the same number', async () => {
  const s = await finalisedReport('amend-finalise')
  const original = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId: s.reportId,
  })

  const amendmentId = await s.owner.client.mutation(api.reports.amend, {
    businessId: s.businessId,
    reportId: s.reportId,
    reason: 'Corrected the product.',
  })
  await signReport(s.owner.client, { businessId: s.businessId }, amendmentId, 'technician')
  await s.owner.client.mutation(api.reports.finalise, {
    businessId: s.businessId,
    reportId: amendmentId,
    data: {
      serviceDate: '2026-08-28',
      safeToStart: true,
      treatments: [],
      addPhotos: true,
      technicianSignature: { signedAt: 1789000000000 },
    },
    templateVersion: versionOf('serviceReport'),
  })

  const locked = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId: amendmentId,
  })
  expect(locked!.status).toBe('finalised')
  // The same number the client already has, at the next issue — not a new
  // number from the sequence.
  expect(locked!.reportNumber).toBe(original!.reportNumber)
  expect(locked!.version).toBe(2)
})

test('a number cannot fork into two live documents', async () => {
  const s = await finalisedReport('amend-fork')
  await s.owner.client.mutation(api.reports.amend, {
    businessId: s.businessId,
    reportId: s.reportId,
    reason: 'First correction.',
  })

  await expectRejected(
    () =>
      s.owner.client.mutation(api.reports.amend, {
        businessId: s.businessId,
        reportId: s.reportId,
        reason: 'Second correction of the same document.',
      }),
    'ALREADY_SUPERSEDED',
  )
})

test('a draft cannot be amended, and a reason is required', async () => {
  const s = await setupBusinessWithSub('amend-guards')
  const draftId = await createReport(s.owner.client, s, 'serviceReport')

  await expectRejected(
    () =>
      s.owner.client.mutation(api.reports.amend, {
        businessId: s.businessId,
        reportId: draftId,
        reason: 'It is still a draft.',
      }),
    'REPORT_NOT_FINALISED',
  )

  const s2 = await finalisedReport('amend-reason')
  await expectRejected(
    () =>
      s2.owner.client.mutation(api.reports.amend, {
        businessId: s2.businessId,
        reportId: s2.reportId,
        reason: '   ',
      }),
    'AMENDMENT_REASON_REQUIRED',
  )
})

test('both ends of the pair say so on screen', async ({ page }) => {
  const s = await finalisedReport('amend-ui')
  await signInViaUi(page, s.owner.email)

  await page.goto(`/${s.slug}/reports/${s.reportId}`)
  await page.getByRole('button', { name: 'Issue a correction' }).click()

  const sheet = page.getByRole('dialog')
  await sheet
    .getByLabel('What was wrong?')
    .fill('Wrong product recorded against the second treatment')
  await sheet.getByRole('button', { name: 'Start the correction' }).click()

  // Lands on the correction, which says what it replaces and why.
  await expect(page.getByText(/Version 2 of #/)).toBeVisible()
  await expect(
    page.getByText(/Wrong product recorded against the second treatment/),
  ).toBeVisible()

  // And the document it replaced says it was replaced, rather than silently
  // becoming the wrong one to work from.
  await page.goto(`/${s.slug}/reports/${s.reportId}`)
  await expect(page.getByText('Replaced.')).toBeVisible()
  // With no way to fork the number again.
  await expect(page.getByRole('button', { name: 'Issue a correction' })).toHaveCount(0)
})
