'use node'

import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import type { ActionCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'

/**
 * What happens after a report is locked, away from the technician's thumb.
 *
 * Rendering used to be lazy: the first person to open the PDF tab paid for it,
 * standing in a driveway on mobile data, watching a spinner. Worse, nothing
 * coordinated the callers — the tab, the download button and an email send
 * could each start their own render of the same report, and the last one to
 * finish won while the others' files stayed in storage forever with nothing
 * pointing at them.
 *
 * So the render is claimed, done once, and scheduled the moment the report
 * locks. By the time anyone taps Download, the file is already there.
 */

/** `toBuffer()` resolves to a Node `ReadableStream`, not a `Buffer`. */
export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Array<Buffer> = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/**
 * Renders one report and records the file, or gives up quietly if someone
 * else is already doing it.
 *
 * Returns the storage id of the current file either way, so a caller that
 * wants the PDF right now can use the result instead of polling.
 */
export async function renderIfNeeded(
  ctx: ActionCtx,
  reportId: Id<'reports'>,
): Promise<Id<'_storage'> | null> {
  const claim = await ctx.runMutation(internal.reports.claimPdf, { reportId })
  if (!claim.claimed) {
    // Someone else has it — the pipeline scheduled at finalise, usually, since
    // a technician can tap Download a second after locking. Waiting for their
    // render is the whole point of the claim; failing here would make the
    // fast path the broken one.
    return claim.reason === 'busy'
      ? await waitForRender(ctx, reportId)
      : (claim.storageId ?? null)
  }

  try {
    const report = await ctx.runQuery(internal.reports.getForRender, { reportId })
    if (!report) {
      await ctx.runMutation(internal.reports.failPdf, { reportId })
      return null
    }

    // Through the internal projection, not the public queries: those start
    // with a membership check and this runs with no caller to check.
    const photos = await ctx.runQuery(internal.reports.photosForRender, {
      reportId,
    })

    const { pdf } = await import('@react-pdf/renderer')
    const { ReportPdf } = await import('../src/components/reports/pdf/ReportPdf')

    const stream = await pdf(
      <ReportPdf
        report={{
          template: report.template,
          customTemplate: report.customTemplate,
          // This only ever runs on a finalised report, so it is the surface
          // that most needs the frozen wording rather than today's.
          templateSnapshot: report.templateSnapshot,
          templateVersion: report.templateVersion,
          context: report.context,
          legalBasis: report.legalBasis,
          finalised: true,
          finalisedAt: report.finalisedAt,
          reportNumber: report.reportNumber,
          // Amendments, not resubmissions: a finalised report is never
          // rewritten, so until the amend flow exists every document is v1.
          version: 1,
          submittedBy: report.author?.name,
          data: (report.data ?? {}) as Record<string, unknown>,
          businessName: report.businessName,
          business: report.business,
          property: report.property,
          licenceNumber: report.author?.licenceNumber,
          photos: photos.slots,
          galleryPhotos: photos.gallery,
        }}
      />,
    ).toBuffer()

    const buffer = await streamToBuffer(stream)
    const storageId = await ctx.storage.store(
      new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }),
    )
    await ctx.runMutation(internal.reports.setPdf, {
      reportId,
      storageId,
      bytes: buffer.length,
    })
    return storageId
  } catch (error) {
    // The claim has to be released whatever went wrong, or this report can
    // never be rendered again — a failed render must not become a permanent
    // one.
    await ctx.runMutation(internal.reports.failPdf, { reportId })
    throw error
  }
}

/**
 * Waits out a render someone else is doing. Bounded: a render takes a second
 * or two, and a caller left hanging on a dead action is worse than one told
 * to try again.
 */
async function waitForRender(
  ctx: ActionCtx,
  reportId: Id<'reports'>,
): Promise<Id<'_storage'> | null> {
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const pointer = await ctx.runQuery(internal.reports.pdfPointer, { reportId })
    if (!pointer) return null
    if (pointer.status === 'ready' && pointer.storageId) return pointer.storageId
    if (pointer.status === 'failed') return null
  }
  return null
}

/**
 * Scheduled by `reports.finalise`. Failures are swallowed: a report that
 * locked is locked, and a render that did not happen is retried by the next
 * person who opens it.
 */
export const afterFinalise = internalAction({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    try {
      await renderIfNeeded(ctx, reportId)
    } catch (error) {
      console.error('afterFinalise render failed', reportId, error)
    }
  },
})
