// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs'
import { renderToBuffer } from '@react-pdf/renderer'
import { describe, expect, test } from 'vitest'
import { getTemplate } from '../../../lib/reportTemplates'
import { ReportPdf } from './ReportPdf'
import { SIZES } from './theme'
import type { PdfReport } from './ReportPdf'

/**
 * The document, rendered and read back.
 *
 * Every other test in this repo checks a rule about the document; this one
 * checks the document. It renders the real component through the real
 * renderer under Node — the same path the Convex action takes — and reads the
 * text layer with pdfjs, so a change that makes a heading vanish, drops the
 * footer, or quietly stops printing an answer fails here rather than in
 * someone's inbox.
 *
 * `PDF_OUT=/tmp/x.pdf pnpm vitest run ReportPdf` writes the file out, which is
 * how the layout itself gets looked at.
 */

const BUSINESS = {
  name: 'Pest M8 Pest Control',
  tradingName: 'Pest M8 South',
  brandName: 'Pest M8',
  website: 'www.pestm8.com.au',
  phone: '+61 1800 737 868',
  email: 'info@pestm8.com.au',
  licenceNumber: 'PMT 4132',
}

const PROPERTY = {
  client: { name: 'J. Nguyen' },
  addressLine: '12 Wattle Street',
  suburb: 'Bayswater',
  state: 'WA',
  postcode: '6053',
}

/** Midday on a fixed day, so the footer's stamp is the same in every run. */
const FINALISED_AT = Date.UTC(2026, 7, 28, 3, 35, 53)

function serviceReport(overrides: Partial<PdfReport> = {}): PdfReport {
  return {
    template: 'serviceReport',
    // Without this every render falls back to v1 — the wording the app has
    // already stopped issuing.
    templateVersion: getTemplate('serviceReport').version,
    legalBasis: 'APVMA · AEPMA',
    finalised: true,
    finalisedAt: FINALISED_AT,
    reportNumber: 142,
    version: 1,
    submittedBy: 'Terence Van Der Walt',
    businessName: BUSINESS.name,
    business: BUSINESS,
    property: PROPERTY,
    context: {
      client: {
        name: 'J. Nguyen',
        phone: '0408 000 000',
        email: 'client@example.com',
      },
      property: { address: '12 Wattle Street, Bayswater WA 6053' },
      business: BUSINESS,
      roster: { m1: 'Kevin Edgar (Licence 4132)' },
    },
    data: {
      serviceDate: '2026-08-28',
      startTime: '10:25',
      finishTime: '11:10',
      weather: ['Sunny'],
      treatments: [
        {
          _id: 'r1',
          treatment: ['General Pest Control'],
          product: ['Biflex Ultra (100 g/L Bifenthrin)'],
          quantity: ['100ml/10L'],
          method: ['Hand Compression Sprayer'],
        },
      ],
      risks: ['No Risk Safe Access Given'],
      spillKit: true,
      msds: true,
      ppe: true,
      chemicalsSecured: true,
      firstAid: true,
      signage: true,
      safeToStart: true,
      housekeeping: ['Regular Maintenance required to keep under control'],
      comments: 'Cans in the garage, and the trees touching the roof.',
      nextVisit: '6 Months',
      technician: 'm1',
      technicianSignature: { signedAt: FINALISED_AT, signedBy: 'Kevin Edgar' },
    },
    ...overrides,
  }
}

async function textOf(buffer: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise
  let text = ''
  for (let page = 1; page <= doc.numPages; page++) {
    const content = await (await doc.getPage(page)).getTextContent()
    text += content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
  }
  // react-pdf's letter-spacing splits glyphs, so collapse before matching.
  return text.replace(/\s+/g, ' ')
}

async function render(report: PdfReport) {
  const buffer = await renderToBuffer(<ReportPdf report={report} />)
  // One file per test, named after it, so the layout of each form can be
  // looked at rather than only asserted about.
  const out = process.env.PDF_OUT
  if (out) {
    mkdirSync(out, { recursive: true })
    const name = (expect.getState().currentTestName ?? 'report')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 60)
    writeFileSync(`${out}/${name}.pdf`, buffer)
  }
  return { buffer, text: await textOf(buffer) }
}

describe('the service report a client receives', () => {
  test('prints the form, in the form’s own words', async () => {
    const { text } = await render(serviceReport())

    // The title band: the brand, the form's own name, and the year.
    expect(text).toContain('Pest M8 Service Report for 2026')
    // The header block — who issued it, and how to reach them.
    expect(text).toContain('Pest M8 South')
    expect(text).toContain('www.pestm8.com.au')

    // Section 1 prints no heading of its own; its labels carry their verbatim
    // punctuation, colons and all.
    expect(text).toContain('Date:')
    expect(text).toContain('Client Phone:')
    expect(text).toContain('Start Time:')
    expect(text).toContain('Weather Details')

    // The records it never asked for, printed anyway.
    expect(text).toContain('J. Nguyen')
    expect(text).toContain('12 Wattle Street, Bayswater WA 6053')

    // Each section under the heading the client received, not the one the
    // technician filled it in under.
    expect(text).toContain('Treatment, Product(s) and Quantities Applied')
    expect(text).toContain('Risk Assessment')
    expect(text).toContain("Technician's Recommendations")
    expect(text).not.toContain("TECHNICIAN'S RECOMMENDATIONS & COMMENTS")

    // The treatment table, under its own column headings.
    expect(text).toContain('Product & Active Ingredient')
    expect(text).toContain('Biflex Ultra (100 g/L Bifenthrin)')
    expect(text).toContain('Hand Compression Sprayer')

    // The technician, named as the form names them.
    expect(text).toContain('Kevin Edgar (Licence 4132)')

    // And the warranty pages, verbatim.
    expect(text).toContain('PLEASE GIVE IT 6 WEEKS FOR YOUR TREATMENT TO WORK')
    expect(text).toContain('IT DOES NOT WORK BY SMELL')
  })

  test('the footer carries the form’s own provenance labels', async () => {
    const { text } = await render(serviceReport())

    expect(text).toContain('Service Report')
    expect(text).toMatch(/Page \d+ of \d+/)
    expect(text).toContain('Submitted by: Terence Van Der Walt @')
    expect(text).toContain('Submission ID: 142')
    expect(text).toContain('Version: 1')
    // The vendor's own advertising line is not ours to print.
    expect(text).not.toContain('formitize')
  })

  test('a question nobody answered is left out, not printed empty', async () => {
    const { text } = await render(
      serviceReport({ data: { ...serviceReport().data, finishTime: undefined } }),
    )
    expect(text).toContain('Start Time:')
    expect(text).not.toContain('Finish Time:')
  })

  test('the controls that drive delivery never reach the page', async () => {
    const { text } = await render(
      serviceReport({
        data: {
          ...serviceReport().data,
          sendCopy: true,
          emailReportTo: ['office@example.com'],
          addPhotos: true,
        },
      }),
    )
    expect(text).not.toContain('Send copy of the report')
    expect(text).not.toContain('office@example.com')
    expect(text).not.toContain('Add Photos?')
    // The screen-only sub-heading over the safety checks is the same kind of
    // thing: a way to fill the form in, not part of the document.
    expect(text).not.toContain('Safety & Compliance Checklists')
  })

  test('no word is broken across a line', async () => {
    // react-pdf hyphenates by default, which splits product names and
    // addresses a reader may need to copy exactly.
    const { text } = await render(serviceReport())
    expect(text).not.toMatch(/Recommenda- tions|Bifen- thrin|prop- erty/)
  })

  test('a report with no front-page photo opens on the report itself', async () => {
    const { buffer } = await render(serviceReport())
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
    const [, , width, height] = (await doc.getPage(1)).view
    expect(height).toBeGreaterThan(width)
  })
})

describe('the AS forms', () => {
  test('print their own header lines and standard, not a title band', async () => {
    const timber = getTemplate('timberPestInspection')
    const { text } = await render(
      serviceReport({
        template: 'timberPestInspection',
        templateVersion: timber.version,
        legalBasis: timber.legalBasis,
        data: {
          inspectionDate: '2026-08-28',
          inspectionTypeWarranty: [
            '12 Monthly Timber Pest Visual Inspection to maintain Warranty',
            'Year 3',
          ],
          susceptibilityRating: 'LOW',
        },
      }),
    )

    expect(text).toContain('TIMBER PEST WARRANTY INSPECTION')
    expect(text).toContain('AS 4349.3-2010')
    // A band would repeat the title the form already prints for itself.
    expect(text).not.toContain('Pest M8 Timber Pest Inspection for 2026')
    // Numbered sections, in the form's own case.
    expect(text.replace(/\s/g, '')).toContain('1.CLIENTDETAILS')
    // A locked option prints whether or not the answer holds it.
    expect(text).toContain('12 Monthly Timber Pest Visual Inspection')
    expect(text).toContain('Year 3')
  })

  test('the certificate prints its terms under the form’s own heading', async () => {
    const { text } = await render(
      serviceReport({
        template: 'termiteManagementCert',
        templateVersion: getTemplate('termiteManagementCert').version,
        legalBasis: 'AS 3660.2-2017',
        data: {
          installDate: '2026-08-28',
          systemType: 'Chemical Soil Barrier',
          reinspectionInterval: '12 months',
        },
      }),
    )

    expect(text).toContain('EXISTING STRUCTURE CERTIFICATE OF INSTALLATION')
    expect(text).toContain('9. TERMS AND CONDITIONS OF CERTIFICATE')
    expect(text).toContain('Purpose Of Termite Management Systems')
    expect(text).toContain('Chemical Soil Barrier')
    // The app's own durable-notice extra is off unless a template opts in.
    expect(text).not.toContain('DO NOT REMOVE THIS NOTICE')
  })
})

/**
 * A real PNG of a given size, as a data URI.
 *
 * react-pdf measures nothing about an image — it draws it into whatever box
 * the style gives it — so the aspect ratio under test is the one the model
 * carries, not the one in the bytes. The bytes still have to be a decodable
 * image, which is why this is not a stub.
 */
function pngDataUri(): string {
  return (
    'data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  )
}

describe('evidence', () => {
  const photos = (shape: 'portrait' | 'landscape', count: number) =>
    Array.from({ length: count }, (_, index) => ({
      fieldKey: 'photos',
      order: index,
      isCover: false,
      url: pngDataUri(),
      caption: `Photo ${index + 1}`,
      width: shape === 'portrait' ? 1200 : 1600,
      height: shape === 'portrait' ? 1600 : 1200,
    }))

  test('a photo set prints inside the section that asked for it', async () => {
    const { text } = await render(
      serviceReport({
        data: { ...serviceReport().data, addPhotos: true },
        galleryPhotos: photos('portrait', 6),
      }),
    )

    // The form's own label for the set, and each photo's caption beneath it.
    expect(text).toContain('Report Photos')
    expect(text).toContain('Photo 1')
    expect(text).toContain('Photo 6')
  })

  test('a photo set whose question was answered No prints nothing', async () => {
    // The photos live in their own table, outside the answers, so hiding the
    // question does not remove them — only this rule does.
    const { text } = await render(
      serviceReport({
        data: { ...serviceReport().data, addPhotos: false },
        galleryPhotos: photos('portrait', 3),
      }),
    )
    expect(text).not.toContain('Report Photos')
    expect(text).not.toContain('Photo 1')
  })

  test('twelve photos all reach the page', async () => {
    // The old grid put a whole set in one unbreakable block, so a set taller
    // than a page was pushed off it and clipped.
    const { buffer, text } = await render(
      serviceReport({
        data: { ...serviceReport().data, addPhotos: true },
        galleryPhotos: photos('portrait', 12),
      }),
    )
    for (let n = 1; n <= 12; n++) expect(text).toContain(`Photo ${n}`)

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
    let drawn = 0
    for (let page = 1; page <= doc.numPages; page++) {
      const ops = await (await doc.getPage(page)).getOperatorList()
      drawn += ops.fnArray.filter((op) => op === pdfjs.OPS.paintImageXObject).length
    }
    // Twelve photos, and nothing else: this report has no cover photo and its
    // signature is a timestamp rather than an image.
    expect(drawn).toBe(12)
  })

  test('every photo is drawn at its own shape, never cropped to a box', async () => {
    // The failure this exists to stop: `objectFit: 'contain'` becoming
    // `'cover'`, or a fixed tile height returning. On evidence a centre-crop
    // can remove the very thing the photo was taken to show — the termite
    // damage at the edge of the frame — and it does it silently, so nothing
    // in the text layer or the image count would notice.
    const { buffer } = await render(
      serviceReport({
        data: { ...serviceReport().data, addPhotos: true },
        galleryPhotos: photos('portrait', 14),
      }),
    )

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise

    // An image's drawn box is the CTM in force when it is painted: react-pdf
    // emits `transform(w, 0, 0, h, x, y)` immediately before each
    // paintImageXObject, so the matrix's a and d ARE the width and height on
    // the page, in points.
    const boxes: Array<{ w: number; h: number }> = []
    for (let page = 1; page <= doc.numPages; page++) {
      const ops = await (await doc.getPage(page)).getOperatorList()
      let last: number[] | null = null
      ops.fnArray.forEach((op, i) => {
        if (op === pdfjs.OPS.transform) last = ops.argsArray[i] as number[]
        if (op === pdfjs.OPS.paintImageXObject && last) {
          boxes.push({ w: Math.abs(last[0]), h: Math.abs(last[3]) })
        }
      })
    }

    expect(boxes).toHaveLength(14)

    // The arithmetic, because the numbers are what make this a real test.
    //
    // Fourteen photos declaring 1200x1600 are portrait-heavy, so the grid is
    // 3-up: each tile is (595.28 - 40*2)/3 - 8 = 163.76pt wide, and
    // `tileHeight` gives it (1600/1200) * 163.76 = 218.35pt of height, under
    // the 240pt cap.
    //
    // The fixture's actual pixels are a 1x1 PNG, and that is what makes the
    // check sharp rather than incidental. Fitting a square source into a
    // 163.76 x 218.35 tile draws it at 163.76 square under `contain` — bounded
    // by the SHORTER side — and at 218.35 square under `cover`, overflowing
    // the tile and cropping. So the drawn width alone separates the two.
    const TILE_WIDTH = (595.28 - SIZES.pageX * 2) / 3 - 8
    const TILE_HEIGHT = (1600 / 1200) * TILE_WIDTH
    expect(TILE_HEIGHT).toBeLessThan(240)

    for (const box of boxes) {
      expect(box.w).toBeCloseTo(TILE_WIDTH, 1)
      // Square, because the source is. Were this the tile's height instead,
      // the image would be filling the box and losing its edges.
      expect(box.h).toBeCloseTo(TILE_WIDTH, 1)
      expect(box.h).not.toBeCloseTo(TILE_HEIGHT, 1)
    }
  })
})

describe('a table longer than a page', () => {
  test('carries its column headings onto the second one, and only there', async () => {
    // The treatment table's header row is marked `fixed`, which in react-pdf
    // means "draw on every page". That is right for a table that breaks and
    // wrong for the document — so this checks both halves: the headings
    // reappear where the table continues, and do not appear on the pages that
    // are nothing but warranty prose.
    const rows = Array.from({ length: 45 }, (_, index) => ({
      _id: `row-${index}`,
      treatment: ['General Pest Control'],
      product: [`Biflex Ultra (100 g/L Bifenthrin) — drum ${index + 1}`],
      quantity: ['100ml/10L'],
      method: ['Hand Compression Sprayer'],
    }))

    const { buffer } = await render(
      serviceReport({ data: { ...serviceReport().data, treatments: rows } }),
    )

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
    }).promise

    const pages: Array<string> = []
    for (let page = 1; page <= doc.numPages; page++) {
      const content = await (await doc.getPage(page)).getTextContent()
      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' '),
      )
    }

    const withHeadings = pages.filter((text) =>
      text.includes('Product & Active Ingredient'),
    )
    // More than one: the table is long enough to break, and a client should
    // not have to guess which column held the product.
    expect(withHeadings.length).toBeGreaterThan(1)
    // But not every page: the warranty pages are not part of the table.
    expect(withHeadings.length).toBeLessThan(doc.numPages)

    // Every row reaches the page, none dropped at a break.
    expect(pages.join(' ').match(/— drum \d+/g)).toHaveLength(45)
  })
})
