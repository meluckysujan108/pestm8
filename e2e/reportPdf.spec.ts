import { expect, test } from '@playwright/test'
import {
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

  // Page 1 is the cover: landscape, carrying the photo as an embedded image.
  // The source form asks for "1 Landscape Photo"; the photo having a page of
  // its own is what makes that instruction mean something.
  const first = await doc.getPage(1)
  const [, , width, height] = first.view
  expect(width).toBeGreaterThan(height)
  const ops = await first.getOperatorList()
  expect(ops.fnArray).toContain(pdfjs.OPS.paintImageXObject)

  // And it is not printed a second time down in the photo grid.
  let laterImages = 0
  for (let p = 2; p <= doc.numPages; p++) {
    const later = await (await doc.getPage(p)).getOperatorList()
    laterImages += later.fnArray.filter((op) => op === pdfjs.OPS.paintImageXObject).length
  }
  expect(laterImages).toBe(0)

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
