import { expect, test } from '@playwright/test'
import {
  api,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
} from './fixtures'
import {
  createReport,
  finaliseReport,
  signReport,
  versionOf,
} from './fixtures/reportPayloads'
import type { Id } from '../convex/_generated/dataModel'

async function pdfText(url: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await (await fetch(url)).arrayBuffer())
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise
  let text = ''
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent()
    text += content.items.map((i) => ('str' in i ? i.str : '')).join(' ')
  }
  // react-pdf letter-spacing splits glyphs, so collapse before matching.
  return text.replace(/\s+/g, ' ')
}

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
  await finaliseReport(
    s.owner.client,
    { businessId: s.businessId },
    reportId,
    'serviceReport',
    {
      comments: 'Treated the perimeter.',
    },
  )
  return { ...s, reportId }
}

type Setup = Awaited<ReturnType<typeof finalisedReport>>

/** Signs and locks a correction — the step that actually replaces the original. */
async function issueAmendment(s: Setup, amendmentId: Id<'reports'>) {
  await signReport(
    s.owner.client,
    { businessId: s.businessId },
    amendmentId,
    'technician',
  )
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

  // Until the correction is issued, the original is still the document the
  // client holds — it links to the correction under way rather than calling
  // itself replaced by a draft that may yet be abandoned.
  const during = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId: s.reportId,
  })
  expect(during!.supersededByReportId).toBeUndefined()
  expect(during!.openAmendmentId).toBe(amendmentId)
  expect(during!.canAmend).toBe(false)
  // Still finalised, still a record. Amending never unlocks anything.
  expect(during!.status).toBe('finalised')
})

test('the cover photo comes with it, like the rest of the evidence', async () => {
  const s = await setupBusinessWithSub('amend-cover')
  const reportId = await createReport(s.owner.client, s, 'serviceReport')
  const uploadUrl = await s.owner.client.mutation(
    api.reports.generateUploadUrl,
    {
      businessId: s.businessId,
    },
  )
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  })
  const { storageId } = (await res.json()) as { storageId: Id<'_storage'> }
  await s.owner.client.mutation(api.reports.attachPhoto, {
    businessId: s.businessId,
    reportId,
    storageId,
    slot: 'coverPhoto',
  })
  await finaliseReport(
    s.owner.client,
    { businessId: s.businessId },
    reportId,
    'serviceReport',
  )

  const amendmentId = await s.owner.client.mutation(api.reports.amend, {
    businessId: s.businessId,
    reportId,
    reason: 'Corrected the treatment.',
  })
  const photos = await s.owner.client.query(api.reports.photoUrls, {
    businessId: s.businessId,
    reportId: amendmentId,
  })
  // The same day, the same site, the same photograph on the front.
  expect(Object.keys(photos)).toContain('coverPhoto')
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
  await issueAmendment(s, amendmentId)

  const locked = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId: amendmentId,
  })
  expect(locked!.status).toBe('finalised')
  // The same number the client already has, at the next issue — not a new
  // number from the sequence.
  expect(locked!.reportNumber).toBe(original!.reportNumber)
  expect(locked!.version).toBe(2)

  // And the paper says so. The footer's `Version:` is the one line that tells
  // a correction from the document it replaced — it used to print 1 on both.
  const printed = async (reportId: Id<'reports'>) => {
    const { url } = await s.owner.client.action(api.reportPdf.generate, {
      businessId: s.businessId,
      reportId,
    })
    return pdfText(url!)
  }
  const amendedText = await printed(amendmentId)
  expect(amendedText).toContain('Version: 2')
  expect(amendedText).toContain(`Submission ID: ${original!.reportNumber}`)
  expect(await printed(s.reportId)).toContain('Version: 1')

  // Issuing it is what replaces the original, and the original says so.
  const replaced = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId: s.reportId,
  })
  expect(replaced!.supersededByReportId).toBe(amendmentId)
  expect(replaced!.status).toBe('finalised')
  expect(replaced!.canAmend).toBe(false)
  expect(replaced!.openAmendmentId).toBeNull()
})

test('a number cannot fork into two live documents', async () => {
  const s = await finalisedReport('amend-fork')
  const first = await s.owner.client.mutation(api.reports.amend, {
    businessId: s.businessId,
    reportId: s.reportId,
    reason: 'First correction.',
  })

  // Two open corrections of one document: whichever is issued first would
  // leave the other correcting a document that is no longer current.
  await expectRejected(
    () =>
      s.owner.client.mutation(api.reports.amend, {
        businessId: s.businessId,
        reportId: s.reportId,
        reason: 'Second correction of the same document.',
      }),
    'AMENDMENT_IN_PROGRESS',
  )

  // And once the first is issued, the original is history — correct the
  // current version instead.
  await issueAmendment(s, first)
  await expectRejected(
    () =>
      s.owner.client.mutation(api.reports.amend, {
        businessId: s.businessId,
        reportId: s.reportId,
        reason: 'Correcting the replaced one.',
      }),
    'ALREADY_SUPERSEDED',
  )
})

test('an abandoned correction leaves the original current and its signature intact', async () => {
  const s = await setupBusinessWithSub('amend-abandon')
  const reportId = await createReport(s.owner.client, s, 'serviceReport')
  // One stored image under the signature of both documents — what a reused
  // saved signature is.
  const signature = await signReport(
    s.owner.client,
    { businessId: s.businessId },
    reportId,
    'technician',
  )
  await finaliseReport(
    s.owner.client,
    { businessId: s.businessId },
    reportId,
    'serviceReport',
    {},
    signature,
  )

  const amendmentId = await s.owner.client.mutation(api.reports.amend, {
    businessId: s.businessId,
    reportId,
    reason: 'Started on the wrong report.',
  })
  await signReport(
    s.owner.client,
    { businessId: s.businessId },
    amendmentId,
    'technician',
    signature,
  )
  // Binned and then removed for good — the path the nightly purge takes.
  await s.owner.client.mutation(api.reports.softDelete, {
    businessId: s.businessId,
    reportId: amendmentId,
  })
  await s.owner.client.mutation(api.reports.remove, {
    businessId: s.businessId,
    reportId: amendmentId,
  })

  const original = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId,
  })
  // Never marked replaced by a correction that was never issued…
  expect(original!.supersededByReportId).toBeUndefined()
  expect(original!.openAmendmentId).toBeNull()
  // …so it can be corrected properly now.
  expect(original!.canAmend).toBe(true)

  // And the signed certificate still has its signature. Purging a draft
  // deletes no stored file, because a draft's files can be the very files a
  // finalised document prints.
  const signed = await s.owner.client.query(api.reports.signatureUrls, {
    businessId: s.businessId,
    reportId,
  })
  expect(signed.technician).toBeTruthy()
  const image = await fetch(signed.technician)
  expect(image.status).toBe(200)
})

test('correcting a document is for whoever signed it, or the owner', async () => {
  const s = await finalisedReport('amend-who')

  // The owner's certificate is not the subcontractor's to reissue.
  await expectRejected(
    () =>
      s.sub.client.mutation(api.reports.amend, {
        businessId: s.businessId,
        reportId: s.reportId,
        reason: 'Not mine to correct.',
      }),
    'NO_ACCESS',
  )

  // The subcontractor's own is theirs — and the owner's too.
  const theirs = await createReport(s.sub.client, s, 'serviceReport')
  await finaliseReport(
    s.sub.client,
    { businessId: s.businessId },
    theirs,
    'serviceReport',
  )
  const asSeen = await s.sub.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId: theirs,
  })
  expect(asSeen!.canAmend).toBe(true)
  const byOwner = await s.owner.client.mutation(api.reports.amend, {
    businessId: s.businessId,
    reportId: theirs,
    reason: 'Owner correcting the product.',
  })
  expect(byOwner).toBeTruthy()
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

  // While it is being written, the original points at it instead of offering
  // a second one.
  const amendmentId = page
    .url()
    .split('/')
    .pop()!
    .split('?')[0] as Id<'reports'>
  await page.goto(`/${s.slug}/reports/${s.reportId}`)
  await expect(page.getByText('A correction is under way.')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Issue a correction' }),
  ).toHaveCount(0)

  // Once it is issued, the document it replaced says it was replaced, rather
  // than silently becoming the wrong one to work from.
  await issueAmendment(s, amendmentId)
  await page.reload()
  await expect(page.getByText('Replaced.')).toBeVisible()
  // With no way to fork the number again.
  await expect(
    page.getByRole('button', { name: 'Issue a correction' }),
  ).toHaveCount(0)
})
