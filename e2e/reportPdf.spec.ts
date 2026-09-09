import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  setupBusinessWithSub,
  signUpActor,
  uniqueEmail,
} from './fixtures'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('a gallery photo on a finalised report is embedded in the generated PDF', async () => {
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
  const reportId = await owner.client.mutation(api.reports.create, {
    businessId,
    propertyId,
    template: 'serviceReport',
    legalBasis: 'APVMA · AEPMA',
    data: {},
  })

  const uploadUrl = await owner.client.mutation(api.reports.generateUploadUrl, {
    businessId,
  })
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG,
  })
  const { storageId } = (await uploadRes.json()) as { storageId: string }
  await owner.client.mutation(api.reports.addGalleryPhoto, {
    businessId,
    reportId,
    fieldKey: 'coverPhoto',
    storageId: storageId as never,
  })

  await owner.client.mutation(api.reports.finalise, {
    businessId,
    reportId,
    data: { safeToStart: true, treatments: [] },
  })

  const result = await owner.client.action(api.reportPdf.generate, {
    businessId,
    reportId,
  })
  expect(result.url).toBeTruthy()

  const res = await fetch(result.url!)
  const buf = Buffer.from(await res.arrayBuffer())

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
  // A full serviceReport spans several pages, so the photo isn't necessarily
  // on page 1 — check the whole document rather than assuming placement.
  let hasImage = false
  for (let p = 1; p <= doc.numPages; p++) {
    const ops = await (await doc.getPage(p)).getOperatorList()
    if (ops.fnArray.includes(pdfjs.OPS.paintImageXObject)) hasImage = true
  }

  // The cover photo prints as an actual embedded image somewhere in the
  // document, not merely a reference to it — this is the first PDF surface
  // to carry photos at all.
  expect(hasImage).toBe(true)

  // Cached on the report so a second download never re-renders.
  const cached = await owner.client.query(api.reports.get, {
    businessId,
    reportId,
  })
  expect(cached?.pdfUrl).toBeTruthy()
})

test('generating a PDF is rejected for a draft report or a non-member', async () => {
  const s = await setupBusinessWithSub('reportpdf-lock')

  const draftReportId = await s.owner.client.mutation(api.reports.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    template: 'serviceReport',
    legalBasis: 'APVMA · AEPMA',
    data: {},
  })

  await expectRejected(
    () =>
      s.owner.client.action(api.reportPdf.generate, {
        businessId: s.businessId,
        reportId: draftReportId,
      }),
    'REPORT_NOT_FINALISED',
  )

  await s.owner.client.mutation(api.reports.finalise, {
    businessId: s.businessId,
    reportId: draftReportId,
    data: { safeToStart: true, treatments: [] },
  })

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
