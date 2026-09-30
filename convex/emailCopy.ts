'use node'

import { ConvexError, v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { buildEmailCopy } from './lib/emailCopyBuild'
import {
  decodeJpeg,
  encodeJpeg,
  loadCodecs,
  resizeRgba,
} from './lib/imageCodecs'
import { EMAIL_BUDGET_BYTES, REFERENCE_TIER, fitWithin } from './lib/emailFit'
import type { CopyStats } from './lib/emailCopyBuild'
import type { EmailCopyRow } from './emailCopies'
import type { ActionCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'

/**
 * The lighter copy of a report too big to email.
 *
 * On 30 Sept 2026 a 53-photo service report came to a 33.7 MiB PDF, and
 * both attempts to email it failed: the photos were the whole of it, saved
 * by the phone at about quality 94. So when a report's own PDF is over
 * `EMAIL_BUDGET_BYTES`, the email carries this instead — the same document,
 * drawn by the same function from the same record, with each photo made
 * smaller: re-encoded, and scaled down only as far as the budget needs
 * (`lib/emailFit.ts`). The report's own PDF, and the photos it was made
 * from, are never touched; the PDF tab still shows every pixel.
 *
 * Made once per original and kept (`reportPdfs`, `variant: 'email'`), so a
 * second recipient gets the same file and a retried send sends the same
 * bytes — which is what Resend's idempotency key needs to recognise a retry.
 *
 * When a copy cannot be made — too many photos even at the floor, a photo
 * that cannot be fetched, a picture that did not survive the drawing — the
 * send fails exactly as it did before this existed: "too large to email,
 * share it from the PDF tab". Nothing is ever sent that was not checked.
 *
 * The making itself is `lib/emailCopyBuild.ts`; this is when, and keeping it.
 */

/** What a send attaches. */
export type Attachment = {
  storageId: Id<'_storage'>
  /** The `reportPdfs` row it is, for the delivery's record; null for a file
   * drawn before the rows existed. */
  pdfId: Id<'reportPdfs'> | null
  /** Set when it is the lighter copy rather than the report's own PDF. */
  lighter: { photoEdge: number | null } | null
}

/**
 * Which file an email of this report attaches: its own PDF when that fits,
 * or else its lighter copy, made now if nobody has made it yet.
 *
 * Decided from the stored file's size, not by downloading it: 35 MB is a lot
 * to fetch only to find it cannot go. Throws `PDF_TOO_LARGE` when no copy
 * can be made.
 */
export async function emailAttachment(
  ctx: ActionCtx,
  reportId: Id<'reports'>,
  storageId: Id<'_storage'>,
): Promise<Attachment> {
  const bytes = await ctx.runQuery(internal.emailCopies.fileSize, {
    storageId,
  })
  // A file with no size on record is left to fail where it always did, when
  // it is fetched.
  if (bytes === null || bytes <= EMAIL_BUDGET_BYTES) {
    return {
      storageId,
      pdfId: await ctx.runQuery(internal.emailCopies.rowFor, {
        reportId,
        storageId,
      }),
      lighter: null,
    }
  }
  const copy = await ensureEmailCopy(ctx, reportId, storageId)
  if (!copy) throw new ConvexError('PDF_TOO_LARGE')
  return {
    storageId: copy.storageId,
    pdfId: copy.pdfId,
    lighter: { photoEdge: copy.photoEdge },
  }
}

/** The copy made of this original, making and recording it if need be. */
export async function ensureEmailCopy(
  ctx: ActionCtx,
  reportId: Id<'reports'>,
  sourceStorageId: Id<'_storage'>,
): Promise<EmailCopyRow | null> {
  const existing = await ctx.runQuery(internal.emailCopies.forSource, {
    reportId,
    sourceStorageId,
  })
  if (existing) return existing

  const made = await buildEmailCopy(ctx, reportId, sourceStorageId)
  if (!made.ok) {
    console.warn(
      'emailCopy: not made',
      reportId,
      made.reason,
      JSON.stringify(made.stats),
    )
    return null
  }
  const storageId = await ctx.storage.store(
    new Blob([new Uint8Array(made.pdf)], { type: 'application/pdf' }),
  )
  const row = await ctx.runMutation(internal.emailCopies.record, {
    reportId,
    sourceStorageId,
    storageId,
    bytes: made.pdf.length,
    photoEdge: made.tier.edge,
  })
  console.log('emailCopy: made', reportId, JSON.stringify(made.stats))
  return row
}

// ---------------------------------------------------------------------------
// For checking a deployment before anyone presses Send. Both read, neither
// stores anything, and neither is reachable from the app.
// ---------------------------------------------------------------------------

/**
 * Proves the codecs load and run where this is deployed, on a picture made
 * here — no report, no client's photo.
 *
 *   npx convex run emailCopy:engineCheck
 */
export const engineCheck = internalAction({
  args: {},
  handler: async (): Promise<{
    node: string
    arch: string
    bytes: { phoneLike: number; atReference: number }
    ms: Record<string, number>
  }> => {
    const started = Date.now()
    await loadCodecs()
    const loaded = Date.now()

    const width = 1200
    const height = 1600
    const data = new Uint8ClampedArray(width * height * 4)
    let seed = 7
    for (let i = 0; i < data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const grain = (seed / 0x7fffffff - 0.5) * 38
      const light = 100 + 60 * Math.sin(i / 9000)
      data[i] = light + grain
      data[i + 1] = light + grain - 10
      data[i + 2] = light * 0.8 + grain
      data[i + 3] = 255
    }
    const phone = await encodeJpeg({ data, width, height }, 94)
    const encodedAt94 = Date.now()
    const pixels = await decodeJpeg(phone)
    const decoded = Date.now()
    const size = fitWithin(pixels.width, pixels.height, REFERENCE_TIER.edge)
    const scaled = await resizeRgba(pixels, size.width, size.height)
    const resized = Date.now()
    const copy = await encodeJpeg(scaled, REFERENCE_TIER.quality)
    const done = Date.now()

    return {
      node: process.version,
      arch: process.arch,
      bytes: { phoneLike: phone.length, atReference: copy.length },
      ms: {
        load: loaded - started,
        encodePhoneLike: encodedAt94 - loaded,
        decode: decoded - encodedAt94,
        resize: resized - decoded,
        encode: done - resized,
      },
    }
  },
})

/**
 * What a copy of this report would be — its tier, its size, how long it took
 * and whether every picture survived — without storing it or sending it.
 *
 *   npx convex run emailCopy:dryRun '{"reportId": "…"}'
 */
export const dryRun = internalAction({
  args: { reportId: v.id('reports') },
  handler: async (
    ctx,
    { reportId },
  ): Promise<{
    ok: boolean
    reason?: string
    bytes?: number
    stats?: CopyStats
  }> => {
    const pointer = await ctx.runQuery(internal.reports.pdfPointer, {
      reportId,
    })
    if (!pointer?.storageId || pointer.status !== 'ready') {
      return { ok: false, reason: 'no PDF drawn yet' }
    }
    const bytes = await ctx.runQuery(internal.emailCopies.fileSize, {
      storageId: pointer.storageId,
    })
    if (bytes !== null && bytes <= EMAIL_BUDGET_BYTES) {
      return { ok: true, reason: 'fits as it is', bytes }
    }
    const made = await buildEmailCopy(ctx, reportId, pointer.storageId)
    return made.ok
      ? { ok: true, stats: made.stats }
      : { ok: false, reason: made.reason, stats: made.stats }
  },
})
