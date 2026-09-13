import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
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

/**
 * §6.5 counts a report as delivered only once it leaves the app, so the export
 * is asserted on its extracted text rather than on the button being clickable.
 * The scope limits and the no-access reasons are the parts that make an
 * AS 4349.3 report defensible — if they are missing from the PDF, the on-screen
 * document being correct is worth nothing.
 */
async function pdfText(path: string): Promise<string> {
  return textOf(new Uint8Array(await readFile(path)))
}

async function pdfTextFromUrl(url: string): Promise<string> {
  const res = await fetch(url)
  return textOf(new Uint8Array(await res.arrayBuffer()))
}

async function textOf(data: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
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
  const reportId = await createReport(
    owner.client,
    { businessId, propertyId },
    'timberPestInspection',
  )
  await finaliseReport(owner.client, { businessId }, reportId, 'timberPestInspection', {
    // The locked "12 Monthly…" item is deliberately NOT in the stored answer:
    // it is what this document is, so it must print regardless.
    inspectionTypeWarranty: ['Year 3'],
    hinderedAccess: true,
    hinderedAccessComments: 'Insufficient clearance beneath bearers',
    termiteWorkings: true,
    termiteWorkingsPhotoComments: 'Mud tubes on veranda post',
    inspectionFrequency: '6 months',
    // One conducive condition flagged, one clear: only the flagged one's
    // guidance belongs on the client's copy.
    siteDrainage: 'Inadequate',
    ventilation: 'Adequate',
    sendCopyToClient: true,
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
  const timber = getTemplate('timberPestInspection')

  // Identity and provenance.
  expect(text).toContain(timber.name)
  expect(text).toContain('TIMBER PEST WARRANTY INSPECTION')
  expect(text).toContain('Bayside Pest Control')
  // Full street address, as every legal document requires.
  expect(text).toContain('12 Wattle Street')
  // Section labels are letter-spaced, which splits their glyphs in the text
  // layer ("1 . C L I E N T"), so compare them with the spaces taken out.
  const squashed = text.replace(/\s/g, '')
  expect(squashed).toContain('1.CLIENTDETAILS')
  // Unanswered questions are left off a signed document (fidelity rule 8),
  // and the words the form prints whole are not hyphenated across lines.
  expect(text).not.toContain('Inspection Time —')
  expect(text).not.toMatch(/prop- erty|In- spection/)

  expect(text).toContain('12 Monthly Timber Pest Visual Inspection')
  expect(text).toContain('Year 3')

  // A hindered area without its explanation is the defect this product exists
  // to prevent, so the explanation has to survive into the delivered file.
  expect(text).toContain('Insufficient clearance beneath bearers')
  expect(text).toContain('Mud tubes on veranda post')
  expect(text).toContain('6 months')

  // The source form's own scope limits, verbatim. The paraphrase this replaced
  // said "seven days" where the form says thirty, and invented a line about
  // structural inspections the form never contained.
  expect(text).toContain('visual inspection only')
  expect(text).toContain('more than thirty days')
  expect(text).not.toContain('seven days')
  expect(text).not.toContain('NOT a structural inspection')
  // Interim terms, pending the owner's export of the Formitize terms body.
  expect(text).toContain('Purpose Of Termite Management Systems')

  // Guidance prints for the flagged condition only.
  expect(text).toContain('require effective site drainage')
  expect(text).not.toContain('Subfloor ventilation keeps floor frame dry')
  // A control that drives delivery never prints.
  expect(text).not.toContain('Send a copy of the Report')

  // Provenance footer — this went missing silently once already, because the
  // absolute/`fixed` footer pattern only renders under Node.
  expect(text).toContain(`Bayside Pest Control · ${timber.name}`)
  expect(text).toMatch(/Finalised \d{1,2}\/\d{1,2}\/\d{4}/)
  expect(text).toMatch(/Page \d+ of \d+/)
})

test('a custom template PDF prints areas in declared order with their reasons', async () => {
  const s = await setupBusinessWithSub('pdf-areas')
  const templateId = await s.owner.client.mutation(api.customTemplates.create, {
    businessId: s.businessId,
    ...customTemplateArgs(),
  })
  const reportId = await createCustomReport(s.owner.client, s, templateId)
  await s.owner.client.mutation(api.reports.finalise, {
    businessId: s.businessId,
    reportId,
    data: {
      areas: {
        'Roof void': { status: 'inspected' },
        Subfloor: {
          status: 'noAccess',
          reason: 'Insufficient clearance beneath bearers',
        },
        Interior: { status: 'inspected' },
      },
    },
  })

  const { url } = await s.owner.client.action(api.reportPdf.generate, {
    businessId: s.businessId,
    reportId,
  })
  const text = await pdfTextFromUrl(url!)

  expect(text).toContain('Insufficient clearance beneath bearers')
  // Declared order, not storage order: Convex returns object keys sorted,
  // which once listed the areas alphabetically.
  expect(text.indexOf('Roof void')).toBeLessThan(text.indexOf('Subfloor'))
  expect(text.indexOf('Subfloor')).toBeLessThan(text.indexOf('Interior'))
})
