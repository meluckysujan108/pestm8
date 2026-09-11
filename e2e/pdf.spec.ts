import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/**
 * §6.5 counts a report as delivered only once it leaves the app, so the export
 * is asserted on its extracted text rather than on the button being clickable.
 * The scope limits and the no-access reasons are the parts that make an
 * AS 4349.3 report defensible — if they are missing from the PDF, the on-screen
 * document being correct is worth nothing.
 */
async function pdfText(path: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(path))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise

  let text = ''
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent()
    text += content.items.map((i) => ('str' in i ? i.str : '')).join(' ')
  }
  // react-pdf letter-spacing splits glyphs, so collapse before matching.
  return text.replace(/\s+/g, ' ')
}

test('an exported inspection PDF carries its findings and scope limits', async ({
  page,
}) => {
  const email = uniqueEmail('pdf-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: 'Bayside Pest Control',
      state: 'WA',
      timezone: 'Australia/Perth',
    },
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
    template: 'timberPestInspection',
    legalBasis: 'AS 4349.3-2010',
    data: {},
  })
  await owner.client.mutation(api.reports.finalise, {
    businessId,
    reportId,
    data: {
      areas: {
        'Roof void': { status: 'inspected' },
        Subfloor: {
          status: 'noAccess',
          reason: 'Insufficient clearance beneath bearers',
        },
        Interior: { status: 'inspected' },
        'Exterior cladding': { status: 'inspected' },
        'Decking and fencing': { status: 'inspected' },
        Grounds: { status: 'inspected' },
      },
      activityEvidence:
        'Live subterranean termite activity in the veranda post.',
      damageEvidence: 'Moderate damage to the veranda post.',
      conduciveConditions: 'Timber-to-ground contact at veranda posts.',
      reinspectionInterval: '6',
      recommendations: 'Install a termite management system to AS 3660.2.',
    },
  })

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports/${reportId}`)

  // The download lives behind the action bar's "PDF" tab (Phase 6), not on
  // the document itself.
  await page.getByRole('tab', { name: 'PDF' }).click()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download PDF' }).click()
  const download = await downloadPromise
  const path = await download.path()

  const text = await pdfText(path)

  // Identity and provenance.
  expect(text).toContain('Timber Pest Inspection')
  expect(text).toContain('Bayside Pest Control')
  // Full street address, as every legal document requires.
  expect(text).toContain('12 Wattle Street')

  // A no-access area without its reason is the defect this product exists to
  // prevent, so the reason has to survive into the delivered file.
  expect(text).toContain('Insufficient clearance beneath bearers')

  // Labels, not storage codes.
  expect(text).toContain('6 months')

  // The scope limits are what make the report defensible.
  expect(text).toContain('visual inspection only')
  expect(text).toContain('NOT a structural inspection')

  // Provenance footer — this went missing silently once already, because the
  // absolute/`fixed` footer pattern only renders under Node. Generation moved
  // server-side in Phase 5 specifically to make this possible at all.
  expect(text).toContain('Bayside Pest Control · Timber Pest Inspection')
  expect(text).toMatch(/Finalised \d{1,2}\/\d{1,2}\/\d{4}/)
  // Real page numbers, likewise impossible before the server-side move.
  expect(text).toMatch(/Page \d+ of \d+/)

  // Areas print in the template's declared order, not storage order: Convex
  // returns object keys sorted, which listed them alphabetically.
  expect(text.indexOf('Roof void')).toBeLessThan(text.indexOf('Subfloor'))
  expect(text.indexOf('Subfloor')).toBeLessThan(text.indexOf('Interior'))
})
