'use node'

import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { emailConfigured } from './lib/emailConfig'
import { drawReportPdf } from './lib/drawReportPdf'
import { emailAttachment } from './emailCopy'
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
    const report = await ctx.runQuery(internal.reports.getForRender, {
      reportId,
    })
    if (!report) {
      await ctx.runMutation(internal.reports.failPdf, { reportId })
      return null
    }

    // Through the internal projection, not the public queries: those start
    // with a membership check and this runs with no caller to check.
    const photos = await ctx.runQuery(internal.reports.photosForRender, {
      reportId,
    })

    const buffer = await drawReportPdf(report, photos)
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
    const pointer = await ctx.runQuery(internal.reports.pdfPointer, {
      reportId,
    })
    if (!pointer) return null
    if (pointer.status === 'ready' && pointer.storageId)
      return pointer.storageId
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
    let storageId: Id<'_storage'> | null
    try {
      storageId = await renderIfNeeded(ctx, reportId)
    } catch (error) {
      console.error('afterFinalise render failed', reportId, error)
      // Without a file there is nothing to attach, and a delivery that goes
      // out empty is worse than one that waits. The rows stay queued; the
      // send sheet can retry them.
      return
    }

    // Nothing can be sent until the business has email set up. The rows stay
    // queued and the history says why; scheduling sends that can only throw
    // would put an error in the logs for every report finalised meanwhile.
    if (!emailConfigured()) return

    // A report too big to email gets its lighter copy now, once — whether or
    // not the form asked for an email. The sends below then find it waiting
    // rather than each making their own, and a Send pressed later goes at
    // once instead of after a minute's work in a driveway. A copy that cannot
    // be made is not this function's failure: the send that needs it says so.
    if (storageId) {
      try {
        await emailAttachment(ctx, reportId, storageId)
      } catch (error) {
        console.error('afterFinalise email copy failed', reportId, error)
      }
    }

    // Whatever the form asked for at finalise. Each is its own scheduled
    // action: one recipient's provider failure must not stop the next.
    const queued = await ctx.runQuery(internal.deliveries.readyForReport, {
      reportId,
    })
    for (const deliveryId of queued) {
      await ctx.scheduler.runAfter(0, internal.email.deliver, { deliveryId })
    }
  },
})
