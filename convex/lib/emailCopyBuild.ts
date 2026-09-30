'use node'

import { createHash } from 'node:crypto'
import { internal } from '../_generated/api'
import { drawReportPdf } from './drawReportPdf'
import { decodeJpeg, encodeJpeg, resizeRgba } from './imageCodecs'
import {
  EMAIL_BUDGET_BYTES,
  FIXED_MARGIN_BYTES,
  KEEP_ORIGINAL_RATIO,
  PHOTO_TIERS,
  REFERENCE_TIER,
  chooseTier,
  countImageMarkers,
  expectedCopyImages,
  fitWithin,
  pickSample,
} from './emailFit'
import { imageSize } from './imageSize'
import type { RenderablePhotos, RenderableReport } from './drawReportPdf'
import type { Rgba } from './imageCodecs'
import type { PhotoMeasure, PhotoTier } from './emailFit'
import type { ActionCtx } from '../_generated/server'
import type { Id } from '../_generated/dataModel'

/**
 * Making the lighter copy of a report too big to email (convex/emailCopy.ts
 * decides when one is needed and keeps it).
 *
 * The copy is the same document, drawn by the same function
 * (`drawReportPdf`) from the same record, with every photo but the cover
 * handed over as smaller bytes:
 *
 * 1. Every picture the report prints is fetched once.
 * 2. A sample of up to eight is encoded at the reference size, which
 *    predicts every tier (`lib/emailFit.ts`); the lightest touch predicted to
 *    fit is chosen.
 * 3. One pass makes every photo at that tier — upright, scaled down (never
 *    up), re-encoded — stepping down a tier only if it runs over.
 * 4. The copy is drawn from those bytes, weighed, and checked to hold every
 *    picture the original holds: react-pdf skips one it cannot read without
 *    a word, and a copy missing a photo, a signature or the logo is not sent.
 *
 * Anything that goes wrong returns a reason instead of a copy, and the send
 * fails as it did before copies existed.
 */

/** Everything a copy is made from, gathered for one report. */
export async function buildEmailCopy(
  ctx: ActionCtx,
  reportId: Id<'reports'>,
  sourceStorageId: Id<'_storage'>,
): Promise<CopyResult> {
  const report = await ctx.runQuery(internal.reports.getForRender, {
    reportId,
  })
  const canonicalBytes = await ctx.runQuery(internal.emailCopies.fileSize, {
    storageId: sourceStorageId,
  })
  const canonicalUrl = await ctx.storage.getUrl(sourceStorageId)
  if (!report || canonicalBytes === null || !canonicalUrl) {
    return failed('the report or its PDF has gone', emptyStats())
  }
  const photos = await ctx.runQuery(internal.reports.photosForRender, {
    reportId,
  })

  const { resolveReportTemplate } =
    await import('../../src/lib/reportTemplates/resolve')
  const { coverFieldKeys, printedGalleryKeys, sectionsOf } =
    await import('../../src/lib/reportTemplates')
  // The wording the report was signed on names its cover field and says which
  // photo sets print, as it did when the original was drawn.
  const template = resolveReportTemplate({
    template: report.template,
    customTemplate: report.customTemplate,
    templateSnapshot: report.templateSnapshot,
    templateVersion: report.templateVersion,
  })

  return makeEmailCopy(
    {
      report,
      photos,
      canonicalBytes,
      coverKeys: coverFieldKeys(template),
      printedKeys: printedGalleryKeys(
        sectionsOf(template),
        (report.data ?? {}) as Record<string, unknown>,
      ),
    },
    {
      fetchBytes,
      draw: drawReportPdf,
      countOriginalImages: () => countImagesAt(canonicalUrl),
    },
  )
}

// ---------------------------------------------------------------------------
// Making the copy. Everything below takes what it needs as arguments, so a
// test can run it with real photos and the real painter and no deployment.
// ---------------------------------------------------------------------------

export type CopyInput = {
  report: RenderableReport
  photos: RenderablePhotos
  /** The report's own PDF, in bytes. */
  canonicalBytes: number
  /** Photo fields that are the front page: drawn full-bleed, never reduced. */
  coverKeys: Set<string>
  /**
   * Photo fields that print (`printedGalleryKeys`, as the painter decides).
   * A set whose question was answered No is not in the original, so it is
   * neither fetched nor counted against the budget.
   */
  printedKeys: Set<string>
}

export type CopyDeps = {
  fetchBytes: (url: string) => Promise<Uint8Array>
  draw: (
    report: RenderableReport,
    photos: RenderablePhotos,
  ) => Promise<Uint8Array>
  /** How many images the report's own PDF holds (`countImageMarkers`). */
  countOriginalImages: () => Promise<number>
  now?: () => number
}

export type CopyStats = {
  /** Distinct pictures the report prints: its photos and its cover. */
  photos: number
  cover: number
  sampled: number
  tier: PhotoTier | null
  passes: number
  /** Photos decoded and re-encoded, the sample included: the work done. */
  encoded: number
  /** Made smaller, and sent as they came (already light, or unreadable). */
  shrunk: number
  kept: number
  photoBytesBefore: number
  photoBytesAfter: number
  canonicalBytes: number
  copyBytes: number | null
  images: { original: number; copy: number; expected: number } | null
  ms: Record<string, number>
}

export type CopyResult =
  | { ok: true; pdf: Uint8Array; tier: PhotoTier; stats: CopyStats }
  | { ok: false; reason: string; stats: CopyStats }

/**
 * About four minutes: long enough for a very big report on a slow day, and
 * well inside a Node action's ten, so a copy that is taking too long gives up
 * with time left for the send to say so.
 */
const DEADLINE_MS = 4 * 60_000

/** Photos fetched at once from storage. */
const FETCH_AT_ONCE = 6

/**
 * A pass is judged by where it is heading once this many photos are made,
 * and given up when that is more than the budget by `PROJECT_SLACK`: a
 * little over is left to finish, since the next photos may be lighter.
 */
const PROJECT_AFTER = 4
const PROJECT_SLACK = 1.05

type Kind = 'jpeg' | 'png' | 'other'

/** A picture the report prints, by the URL the original fetched it from. */
type Source = {
  url: string
  /** A cover field's photo: printed full-bleed, so never reduced. */
  cover: boolean
  original: Uint8Array
  kind: Kind
}

export async function makeEmailCopy(
  input: CopyInput,
  deps: CopyDeps,
  { budget = EMAIL_BUDGET_BYTES, deadlineMs = DEADLINE_MS } = {},
): Promise<CopyResult> {
  const now = deps.now ?? Date.now
  const started = now()
  const stats = emptyStats()
  stats.canonicalBytes = input.canonicalBytes
  const lap = (name: string, since: number) => {
    stats.ms[name] = now() - since
  }

  // Every picture the report prints, once each. A file used twice is fetched
  // and made once, as the original embedded it once; one that is the cover
  // anywhere stays full size everywhere. A photo in a set that does not print
  // is left alone: the painter draws nothing of it, here or in the original.
  const covers = new Map<string, boolean>()
  for (const photo of input.photos.gallery) {
    if (!photo.url || !input.printedKeys.has(photo.fieldKey)) continue
    const cover = input.coverKeys.has(photo.fieldKey)
    covers.set(photo.url, (covers.get(photo.url) ?? false) || cover)
  }
  for (const url of Object.values(input.photos.slots)) {
    if (!covers.has(url)) covers.set(url, false)
  }

  let since = now()
  let sources: Array<Source>
  try {
    sources = await mapLimit(
      [...covers],
      FETCH_AT_ONCE,
      async ([url, cover]) => {
        const original = await deps.fetchBytes(url)
        return { url, cover, original, kind: kindOf(original) }
      },
    )
  } catch (error) {
    return failed(`a photo could not be fetched: ${message(error)}`, stats)
  }
  lap('fetch', since)

  const shrinkable = sources.filter((s) => !s.cover && s.kind === 'jpeg')
  const fixedSources = sources.filter((s) => !shrinkable.includes(s))
  const allSourceBytes = sum(sources.map((s) => s.original.length))
  stats.photos = sources.length
  stats.cover = sources.filter((s) => s.cover).length
  const allShrinkableBytes = sum(shrinkable.map((s) => s.original.length))
  stats.photoBytesBefore = allShrinkableBytes

  // What the copy cannot shed: the pages themselves (the original's size
  // less every picture in it), the cover, and anything that is not a JPEG.
  const pages = Math.max(0, input.canonicalBytes - allSourceBytes)
  const photoBudget =
    budget -
    pages -
    sum(fixedSources.map((s) => s.original.length)) -
    FIXED_MARGIN_BYTES
  if (photoBudget <= 0 || shrinkable.length === 0) {
    return failed('nothing left to make smaller', stats)
  }

  // A sample, encoded once at the reference tier, predicts every tier.
  since = now()
  const measures: Array<PhotoMeasure> = shrinkable.map((s) => {
    const size = imageSize(s.original)
    return {
      originalBytes: s.original.length,
      width: size?.width ?? 1200,
      height: size?.height ?? 1600,
    }
  })
  const atReference = new Map<string, Uint8Array>()
  for (const index of pickSample(measures)) {
    stats.encoded++
    const made = await shrinkOne(shrinkable[index].original, REFERENCE_TIER)
    if (made === null) {
      measures[index].keep = true
      continue
    }
    measures[index].referenceBytes = made.bytes.length
    measures[index].width = made.width
    measures[index].height = made.height
    atReference.set(shrinkable[index].url, made.bytes)
  }
  stats.sampled = atReference.size
  lap('sample', since)

  const first = chooseTier(measures, photoBudget)
  if (first === null) {
    return failed('too many photos to fit an email, even at the floor', stats)
  }

  const deadline = started + deadlineMs
  const encodeStarted = now()
  let tierIndex = first
  while (tierIndex < PHOTO_TIERS.length) {
    const tier = PHOTO_TIERS[tierIndex]
    const atReferenceTier =
      tier.edge === REFERENCE_TIER.edge &&
      tier.quality === REFERENCE_TIER.quality
    // The floor has nowhere lower to go, so it is finished and weighed rather
    // than given up on a projection: a report that fits there must be sent.
    const atFloor = tierIndex === PHOTO_TIERS.length - 1
    stats.tier = tier
    stats.passes++

    // One pass: every photo at this tier, abandoned as soon as it is plainly
    // over — by what it has made so far, scaled to the whole set by the
    // originals' sizes — so the next tier down starts after a few photos,
    // not after a pass that could never fit.
    const outputs = new Map<string, Uint8Array>()
    let total = 0
    let shrunk = 0
    let over = false
    let doneOriginal = 0
    for (const source of shrinkable) {
      if (now() > deadline) return failed('took too long', stats)
      const reused = atReferenceTier ? atReference.get(source.url) : undefined
      if (!reused) stats.encoded++
      const made =
        reused ?? (await shrinkOne(source.original, tier))?.bytes ?? null
      const smaller =
        made !== null &&
        made.length < source.original.length * KEEP_ORIGINAL_RATIO
      const bytes = smaller ? made : source.original
      if (smaller) shrunk++
      outputs.set(source.url, bytes)
      total += bytes.length
      doneOriginal += source.original.length
      const projected = total * (allShrinkableBytes / doneOriginal)
      if (
        total > photoBudget ||
        (!atFloor &&
          outputs.size >= PROJECT_AFTER &&
          projected > photoBudget * PROJECT_SLACK)
      ) {
        over = true
        break
      }
    }
    if (over) {
      tierIndex++
      continue
    }
    lap('encode', encodeStarted)
    stats.shrunk = shrunk
    stats.kept = shrinkable.length - shrunk
    stats.photoBytesAfter = total

    // Drawn from bytes in hand: no photo is fetched while the copy is drawn,
    // so none can go missing to a moment's lost connection.
    const drawStarted = now()
    const keys = new Map<string, string>()
    const handedOver = new Map<string, string>()
    for (const source of sources) {
      const bytes = outputs.get(source.url) ?? source.original
      if (source.kind === 'other') {
        // Not a picture react-pdf can draw; the original could not either.
        keys.set(source.url, `url:${source.url}`)
        continue
      }
      keys.set(source.url, createHash('sha256').update(bytes).digest('hex'))
      handedOver.set(
        source.url,
        `data:image/${source.kind};base64,${Buffer.from(bytes).toString('base64')}`,
      )
    }
    const lighterPhotos: RenderablePhotos = {
      gallery: input.photos.gallery.map((photo) => ({
        ...photo,
        url: (photo.url && handedOver.get(photo.url)) ?? photo.url,
      })),
      slots: Object.fromEntries(
        Object.entries(input.photos.slots).map(([slot, url]) => [
          slot,
          handedOver.get(url) ?? url,
        ]),
      ),
    }
    let pdf: Uint8Array
    try {
      pdf = await deps.draw(input.report, lighterPhotos)
    } catch (error) {
      return failed(`the copy could not be drawn: ${message(error)}`, stats)
    }
    lap('draw', drawStarted)
    stats.copyBytes = pdf.length
    if (pdf.length > budget) {
      // The prediction held for the photos and not the pages: one tier down.
      tierIndex++
      continue
    }

    // Every picture the original holds must be in the copy — react-pdf
    // skips one it cannot read without a word.
    const verifyStarted = now()
    let original: number
    try {
      original = await deps.countOriginalImages()
    } catch (error) {
      return failed(
        `the original could not be checked: ${message(error)}`,
        stats,
      )
    }
    const copy = countImageMarkers(pdf).count
    const expected = expectedCopyImages(
      original,
      sources.map((source) => ({
        url: source.url,
        contentKey: keys.get(source.url) ?? source.url,
      })),
    )
    stats.images = { original, copy, expected }
    lap('verify', verifyStarted)
    if (copy !== expected) {
      return failed('a picture went missing from the copy', stats)
    }
    lap('total', started)
    return { ok: true, pdf, tier, stats }
  }
  return failed('too many photos to fit an email, even at the floor', stats)
}

/**
 * One photo at one tier: upright, scaled down to the tier's edge (never up),
 * and re-encoded. Null when it cannot be read or made, in which case it goes
 * as it came — a photo is evidence, and one that cannot be made smaller is
 * still sent rather than dropped. If none can be made, the copy does not fit
 * and the send says the report is too large, which is what it is.
 */
async function shrinkOne(
  original: Uint8Array,
  tier: PhotoTier,
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  let pixels: Rgba
  try {
    pixels = await decodeJpeg(original)
  } catch {
    return null
  }
  try {
    const size = fitWithin(pixels.width, pixels.height, tier.edge)
    const scaled = await resizeRgba(pixels, size.width, size.height)
    const bytes = await encodeJpeg(scaled, tier.quality)
    return { bytes, width: pixels.width, height: pixels.height }
  } catch (error) {
    // Unlike a photo that will not decode, this is the codec's fault, and
    // worth someone's attention.
    console.warn('emailCopy: a photo could not be re-encoded', message(error))
    return null
  }
}

function kindOf(bytes: Uint8Array): Kind {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'png'
  return 'other'
}

/** A stored file's bytes, asked for twice before giving up. */
async function fetchBytes(url: string): Promise<Uint8Array> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`storage answered ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/** The images in a stored PDF, counted as it streams past. */
async function countImagesAt(url: string): Promise<number> {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`storage answered ${response.status}`)
  }
  const reader = response.body.getReader()
  let count = 0
  let carry: Uint8Array = new Uint8Array(0)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const counted = countImageMarkers(value, carry)
    count += counted.count
    carry = counted.carry
  }
  return count
}

async function mapLimit<TItem, TResult>(
  items: ReadonlyArray<TItem>,
  limit: number,
  work: (item: TItem) => Promise<TResult>,
): Promise<Array<TResult>> {
  const results = new Array<TResult>(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await work(items[index])
      }
    },
  )
  await Promise.all(workers)
  return results
}

function sum(values: ReadonlyArray<number>): number {
  return values.reduce((total, value) => total + value, 0)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emptyStats(): CopyStats {
  return {
    photos: 0,
    cover: 0,
    sampled: 0,
    tier: null,
    passes: 0,
    encoded: 0,
    shrunk: 0,
    kept: 0,
    photoBytesBefore: 0,
    photoBytesAfter: 0,
    canonicalBytes: 0,
    copyBytes: null,
    images: null,
    ms: {},
  }
}

function failed(reason: string, stats: CopyStats): CopyResult {
  return { ok: false, reason, stats }
}
