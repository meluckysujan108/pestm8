import { expect, test } from '@playwright/test'
import {
  licenceSelf,
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  setupBusinessWithSub,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { createReport, finaliseReport } from './fixtures/reportPayloads'
import { fieldsOf, getTemplate } from '../src/lib/reportTemplates'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('the front-page photo becomes its own landscape first page', async () => {
  const email = uniqueEmail('reportpdf-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { businessId } = await owner.client.mutation(api.businesses.create, {
    name: `PDF Photos Co ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
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
    'serviceReport',
  )

  const uploadUrl = await owner.client.mutation(api.reports.generateUploadUrl, {
    businessId,
  })
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG,
  })
  const { storageId } = (await uploadRes.json()) as { storageId: string }
  // The field the form declares as its front page, looked up rather than
  // assumed — the key has to stay 'coverPhoto', because photos already
  // uploaded to v1 drafts are stored under it.
  const coverKey = fieldsOf(getTemplate('serviceReport')).find(
    (field) => field.kind === 'cover',
  )!.key
  expect(coverKey).toBe('coverPhoto')
  await owner.client.mutation(api.reports.addGalleryPhoto, {
    businessId,
    reportId,
    fieldKey: coverKey,
    storageId: storageId as never,
  })

  await finaliseReport(owner.client, { businessId }, reportId, 'serviceReport')

  const result = await owner.client.action(api.reportPdf.generate, {
    businessId,
    reportId,
  })
  expect(result.url).toBeTruthy()

  const res = await fetch(result.url!)
  const buf = Buffer.from(await res.arrayBuffer())

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise

  // Page 1 is the cover, and it carries the photo. A portrait page with the
  // landscape shot banded across its top, which is the anatomy of the document
  // the client already receives — the form asks for "1 Landscape Photo"
  // because of that band, and the photo having a page of its own is what makes
  // the instruction mean something.
  const first = await doc.getPage(1)
  const [, , width, height] = first.view
  expect(height).toBeGreaterThan(width)
  const ops = await first.getOperatorList()
  expect(ops.fnArray).toContain(pdfjs.OPS.paintImageXObject)

  // And it is not printed a second time down in the photo grid. The document
  // carries exactly one other image — the technician's signature, drawn in its
  // own row — so the count after the cover is the signature count, not zero.
  let laterImages = 0
  for (let p = 2; p <= doc.numPages; p++) {
    const later = await (await doc.getPage(p)).getOperatorList()
    laterImages += later.fnArray.filter((op) => op === pdfjs.OPS.paintImageXObject).length
  }
  expect(laterImages).toBe(1)

  // Cached on the report so a second download never re-renders.
  const cached = await owner.client.query(api.reports.get, {
    businessId,
    reportId,
  })
  expect(cached?.pdfUrl).toBeTruthy()
})

test('generating a PDF is rejected for a draft report or a non-member', async () => {
  const s = await setupBusinessWithSub('reportpdf-lock')

  const draftReportId = await createReport(s.owner.client, s, 'serviceReport')

  await expectRejected(
    () =>
      s.owner.client.action(api.reportPdf.generate, {
        businessId: s.businessId,
        reportId: draftReportId,
      }),
    'REPORT_NOT_FINALISED',
  )

  await finaliseReport(s.owner.client, s, draftReportId, 'serviceReport')

  const outsider = await signUpActor(
    uniqueEmail('reportpdf-outsider'),
    FIXTURE_PASSWORD,
    'Nadia',
  )
  await expectRejected(
    () =>
      outsider.client.action(api.reportPdf.generate, {
        businessId: s.businessId,
        reportId: draftReportId,
      }),
    'NO_ACCESS',
  )
})

test('a signature prints as the mark that was made, not as a sentence about it', async () => {
  const s = await setupBusinessWithSub('reportpdf-signature')
  const reportId = await createReport(s.owner.client, s, 'serviceReport')

  // No cover photo this time, so every image in the file has to be a
  // signature. Without that the two are indistinguishable in an operator
  // list, and "the signature prints" would pass on a document that only
  // printed the photo.
  await finaliseReport(s.owner.client, s, reportId, 'serviceReport')

  const result = await s.owner.client.action(api.reportPdf.generate, {
    businessId: s.businessId,
    reportId,
  })
  const buf = Buffer.from(await (await fetch(result.url!)).arrayBuffer())

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise

  const first = await doc.getPage(1)
  const [, , width, height] = first.view
  // Portrait: with nothing declared for the front page there is no cover.
  expect(height).toBeGreaterThan(width)

  let images = 0
  for (let p = 1; p <= doc.numPages; p++) {
    const ops = await (await doc.getPage(p)).getOperatorList()
    images += ops.fnArray.filter((op) => op === pdfjs.OPS.paintImageXObject).length
  }
  expect(images).toBe(1)
})

test.describe('the render pipeline', () => {
  test('a locked report already has its PDF before anyone asks', async () => {
    const s = await setupBusinessWithSub('pdf-pipeline')
    const reportId = await createReport(s.owner.client, s, 'serviceReport')
    await finaliseReport(s.owner.client, s, reportId, 'serviceReport')

    // Scheduled by `finalise`, so the technician who locked it is not the one
    // who waits for it to draw.
    await expect
      .poll(
        async () => {
          const report = await s.owner.client.query(api.reports.get, {
            businessId: s.businessId,
            reportId,
          })
          return report?.pdfStatus
        },
        { timeout: 30_000 },
      )
      .toBe('ready')

    const before = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(before?.pdfUrl).toBeTruthy()

    // And asking again does not draw a second one: the claim is what stops
    // two tabs both rendering and orphaning a file in storage.
    const again = await s.owner.client.action(api.reportPdf.generate, {
      businessId: s.businessId,
      reportId,
    })
    const after = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(again.storageId).toBe(before?.pdfStorageId)
    expect(after?.pdfGeneratedAt).toBe(before?.pdfGeneratedAt)
  })
})

test.describe('previewing a draft', () => {
  test('is watermarked, and thrown away once the real document exists', async () => {
    const s = await setupBusinessWithSub('pdf-preview')
    const reportId = await createReport(s.owner.client, s, 'serviceReport')

    const result = await s.owner.client.action(api.reportPdf.preview, {
      businessId: s.businessId,
      reportId,
    })
    const bytes = Buffer.from(await (await fetch(result.url!)).arrayBuffer())
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
    }).promise
    const content = await (await doc.getPage(1)).getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
    // Stamped on every page: a PDF is a thing people forward, and a draft that
    // cannot be told from the signed document is worse than no draft at all.
    expect(text).toContain('DRAFT')

    const drafted = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(drafted?.previewStorageId).toBeTruthy()

    await finaliseReport(s.owner.client, s, reportId, 'serviceReport')

    // The guess is discarded the moment the document it guessed at exists.
    const locked = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(locked?.previewStorageId).toBeUndefined()
    await expectRejected(
      () =>
        s.owner.client.action(api.reportPdf.preview, {
          businessId: s.businessId,
          reportId,
        }),
      'REPORT_FINALISED',
    )
  })
})
