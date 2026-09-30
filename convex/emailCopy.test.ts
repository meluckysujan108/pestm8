// @vitest-environment node
import { createElement } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { getTemplate } from '../src/lib/reportTemplates'
import { ReportPdf } from '../src/components/reports/pdf/ReportPdf'
import { photoLike } from '../test/photos'
import { makeEmailCopy } from './lib/emailCopyBuild'
import { encodeJpeg } from './lib/imageCodecs'
import { countImageMarkers } from './lib/emailFit'
import type { CopyDeps, CopyInput } from './lib/emailCopyBuild'
import type { PdfReport } from '../src/components/reports/pdf/ReportPdf'
import type { RenderablePhotos, RenderableReport } from './lib/drawReportPdf'

/**
 * A big report's lighter email copy, made for real: the real codecs, the
 * real painter, real JPEGs. Only the report's record is a fixture, and the
 * budget is scaled down with the number of photos so a run takes seconds.
 *
 * What it holds the copy to: the same pages, the same pictures in the same
 * boxes, the cover untouched — and small enough to send. The document is the
 * one the client would have had; only its photos weigh less.
 */

const FINALISED_AT = Date.UTC(2026, 8, 30, 2, 54, 45)

/** A service report as the painter takes it, with these photos in it. */
function serviceReport(photos: RenderablePhotos): PdfReport {
  const business = {
    name: 'Pest M8 Pest Control',
    phone: '+61 1800 737 868',
    email: 'info@pestm8.com.au',
    licenceNumber: 'PMT 4132',
  }
  return {
    template: 'serviceReport',
    templateVersion: getTemplate('serviceReport').version,
    legalBasis: 'APVMA · AEPMA',
    finalised: true,
    finalisedAt: FINALISED_AT,
    reportNumber: 7,
    version: 1,
    submittedBy: 'Terence Van Der Walt',
    businessName: business.name,
    business,
    property: {
      client: { name: 'A school' },
      addressLine: '1 College Road',
      suburb: 'Perth',
      state: 'WA',
      postcode: '6000',
    },
    data: {
      serviceDate: '2026-09-30',
      safeToStart: true,
      treatments: [],
      addPhotos: true,
      technicianSignature: { signedAt: FINALISED_AT },
    },
    galleryPhotos: photos.gallery,
    photos: photos.slots,
  }
}

async function draw(
  _report: RenderableReport,
  photos: RenderablePhotos,
): Promise<Uint8Array> {
  // `<ReportPdf/>` as the Convex action renders it; created without JSX
  // because vitest only collects `.ts` tests under convex/.
  const document = createElement(ReportPdf, {
    report: serviceReport(photos),
  }) as unknown as Parameters<typeof renderToBuffer>[0]
  return renderToBuffer(document)
}

/** A photo row as `reports.photosForRender` hands it to the painter. */
function row(
  fieldKey: string,
  order: number,
  url: string,
  size: { width: number; height: number } = { width: 1200, height: 1600 },
): RenderablePhotos['gallery'][number] {
  return { fieldKey, order, isCover: false, caption: undefined, url, ...size }
}

/** Where each picture lives, as storage URLs do. */
const files = new Map<string, Uint8Array>()
const urlFor = (name: string) => `https://storage.test/${name}`

/** A tiny PNG: a picture that is not a JPEG, which the copy leaves alone. */
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

/** Every report here fetches its pictures from `files`, by URL. */
function fetchBytes(url: string): Promise<Uint8Array> {
  const bytes = files.get(url)
  return bytes
    ? Promise.resolve(bytes)
    : Promise.reject(new Error(`no file at ${url}`))
}

/** A report's photos, and its own PDF drawn from them. */
type Report = { photos: RenderablePhotos; original: Uint8Array }

/**
 * A report of `count` phone photos behind a cover, one of them named twice
 * (as a photo moved between two sets would be) and a picture that is not a
 * JPEG at all. Its own PDF is drawn once, the way Convex draws it: react-pdf
 * fetches each picture by its URL.
 */
const reports = new Map<number, Promise<Report>>()
function reportOf(count: number): Promise<Report> {
  let report = reports.get(count)
  if (!report) {
    const gallery = [row('coverPhoto', 0, urlFor('cover'))]
    for (let n = 0; n < count; n++)
      gallery.push(row('photos', n, urlFor(`p${n}`)))
    gallery.push({ ...gallery[1], order: count })
    gallery.push(
      row('photos', count + 1, urlFor('png'), { width: 1, height: 1 }),
    )
    const photos = { gallery, slots: {} }
    report = draw({} as RenderableReport, photos).then((original) => ({
      photos,
      original,
    }))
    reports.set(count, report)
  }
  return report
}

/** The eight-photo report's copy: made once, looked at by two tests. */
const BIG = 8
/** Over four times smaller than its photos: the same squeeze as 53 photos
 * against 6 MiB, in a sixth of the work. */
const BUDGET = 1.4 * 1024 * 1024

let coverBytes: Uint8Array

beforeAll(async () => {
  // As the phone saves them: 1200×1600, at about quality 94.
  coverBytes = await encodeJpeg(photoLike(1200, 1600, 100), 94)
  files.set(urlFor('cover'), coverBytes)
  for (let n = 0; n < BIG; n++) {
    files.set(urlFor(`p${n}`), await encodeJpeg(photoLike(1200, 1600, n), 94))
  }
  files.set(urlFor('png'), PNG)
  vi.stubGlobal('fetch', async (url: string) => {
    const bytes = files.get(url)
    return bytes
      ? new Response(new Uint8Array(bytes))
      : new Response('not found', { status: 404 })
  })
}, 120_000)

afterEach(() => {
  vi.restoreAllMocks()
})

function inputFor({ photos, original }: Report): CopyInput {
  return {
    report: {} as RenderableReport,
    photos,
    canonicalBytes: original.length,
    coverKeys: new Set(['coverPhoto']),
  }
}

function depsFor(
  { original }: Report,
  overrides: Partial<CopyDeps> = {},
): CopyDeps {
  return {
    fetchBytes,
    draw,
    countOriginalImages: async () => countImageMarkers(original).count,
    ...overrides,
  }
}

/** Every page's pictures, as the boxes they are drawn in. */
async function drawnBoxes(pdf: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf) }).promise
  const boxes: Array<Array<number>> = []
  for (let page = 1; page <= doc.numPages; page++) {
    const ops = await (await doc.getPage(page)).getOperatorList()
    let last: Array<number> | null = null
    ops.fnArray.forEach((op, i) => {
      if (op === pdfjs.OPS.transform) last = ops.argsArray[i] as Array<number>
      if (op === pdfjs.OPS.paintImageXObject && last) {
        boxes.push([page, ...last.map((n) => Math.round(n * 100) / 100)])
      }
    })
  }
  return { pages: doc.numPages, boxes }
}

const contains = (haystack: Uint8Array, needle: Uint8Array) =>
  Buffer.from(haystack).indexOf(Buffer.from(needle)) !== -1

describe('the lighter copy of a report too big to email', () => {
  let copy: ReturnType<typeof makeEmailCopy> | undefined
  const madeCopy = async () => {
    const report = await reportOf(BIG)
    copy ??= makeEmailCopy(inputFor(report), depsFor(report), {
      budget: BUDGET,
    })
    return { report, made: await copy }
  }

  test('fits, and is the same document', async () => {
    const { report, made } = await madeCopy()
    expect(report.original.length).toBeGreaterThan(BUDGET * 4)
    if (!made.ok) throw new Error(made.reason)

    expect(made.pdf.length).toBeLessThanOrEqual(BUDGET)
    // Made smaller only as far as it needed to be.
    expect(made.tier.edge).toBeLessThan(1600)
    expect(made.tier.edge).toBeGreaterThanOrEqual(600)
    expect(made.stats.shrunk).toBe(BIG)
    // The sample predicts the tier, and a miss costs one step down, not a
    // walk down the ladder. (This grain grows faster than its pixel count
    // when scaled up; the 30 Sept photos were within 5% of it, a little under.)
    expect(made.stats.passes).toBeLessThanOrEqual(2)

    // The same pages, the same pictures in the same boxes on them.
    const before = await drawnBoxes(report.original)
    const after = await drawnBoxes(made.pdf)
    expect(after.pages).toBe(before.pages)
    expect(after.boxes).toEqual(before.boxes)
    expect(countImageMarkers(made.pdf).count).toBe(
      countImageMarkers(report.original).count,
    )
  }, 120_000)

  test('leaves the cover and what is not a JPEG exactly as they were', async () => {
    const { made } = await madeCopy()
    if (!made.ok) throw new Error(made.reason)
    // react-pdf embeds a JPEG's bytes as they are, so the cover's own bytes
    // are in the copy whole…
    expect(contains(made.pdf, coverBytes)).toBe(true)
    // …and no original gallery photo is.
    expect(contains(made.pdf, files.get(urlFor('p0'))!)).toBe(false)
    expect(made.stats.cover).toBe(1)
  }, 120_000)

  // The ways it gives up, on a report of two photos: the same code, a
  // fraction of the work.
  test('gives up, rather than send less, when a picture does not survive the drawing', async () => {
    const report = await reportOf(2)
    const made = await makeEmailCopy(
      inputFor(report),
      depsFor(report, {
        // A painter that loses a photo the way react-pdf loses a picture it
        // cannot read: silently.
        draw: (record, lighter) =>
          draw(record, {
            ...lighter,
            gallery: lighter.gallery.map((photo, i) =>
              i === 2
                ? { ...photo, url: 'data:image/jpeg;base64,AAAA' }
                : photo,
            ),
          }),
      }),
      { budget: report.original.length - 1 },
    )
    expect(made).toMatchObject({
      ok: false,
      reason: 'a picture went missing from the copy',
    })
  }, 120_000)

  test('gives up at once when even the floor cannot fit', async () => {
    const report = await reportOf(2)
    // Room for the pages and the cover, and next to nothing for the photos.
    const sources =
      coverBytes.length +
      PNG.length +
      files.get(urlFor('p0'))!.length +
      files.get(urlFor('p1'))!.length
    const pages = report.original.length - sources
    const made = await makeEmailCopy(inputFor(report), depsFor(report), {
      budget: pages + coverBytes.length + PNG.length + 64 * 1024 + 8 * 1024,
    })
    expect(made).toMatchObject({
      ok: false,
      reason: 'too many photos to fit an email, even at the floor',
    })
    // Decided from the sample, before a single full pass.
    expect(made.stats.passes).toBe(0)
  }, 120_000)

  test('gives up when a photo cannot be fetched', async () => {
    const report = await reportOf(2)
    const made = await makeEmailCopy(
      inputFor(report),
      depsFor(report, {
        fetchBytes: (url) =>
          url === urlFor('p1')
            ? Promise.reject(new Error('storage answered 500'))
            : fetchBytes(url),
      }),
      { budget: report.original.length - 1 },
    )
    expect(made.ok).toBe(false)
  }, 120_000)
})
