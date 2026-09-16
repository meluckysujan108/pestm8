'use node'

import { ConvexError, v } from 'convex/values'
import { action } from './_generated/server'
import { api, internal } from './_generated/api'
import { renderIfNeeded, streamToBuffer } from './reportPipeline'

/**
 * Renders a finalised report to PDF, or hands back the one already rendered.
 *
 * The work itself lives in `reportPipeline`, behind a claim, so this and the
 * pipeline scheduled at finalise cannot both render the same report. What
 * stays here is the caller-facing contract: the access check, and a URL.
 *
 * The check goes through the public `reports.get` rather than `ctx.db` —
 * actions have no database access, and reusing that query means this inherits
 * the same membership and visibility rules as the on-screen document instead
 * of re-deriving them.
 */
export const generate = action({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const report = await ctx.runQuery(api.reports.get, { businessId, reportId })
    if (!report) throw new ConvexError('NOT_FOUND')
    if (report.status !== 'finalised') {
      throw new ConvexError('REPORT_NOT_FINALISED')
    }

    const storageId = await renderIfNeeded(ctx, reportId)
    if (!storageId) throw new ConvexError('PDF_UNAVAILABLE')

    return { storageId, url: await ctx.storage.getUrl(storageId) }
  },
})

/**
 * A watermarked PDF of a draft, so a technician can read the document before
 * they lock it.
 *
 * Every other render is of a finalised report, and deliberately so — a PDF is
 * a thing people forward. This one is stamped DRAFT across every page, kept
 * one-per-report, and deleted the moment the real document exists.
 *
 * Gated through `reports.get`, so whoever can open the report can preview it:
 * an owner checking a subcontractor's work has the same need as its author.
 */
export const preview = action({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const report = await ctx.runQuery(api.reports.get, { businessId, reportId })
    if (!report) throw new ConvexError('NOT_FOUND')
    if (report.status === 'finalised') {
      // The real thing exists; a watermarked copy of it would be a worse
      // version of a document someone might forward.
      throw new ConvexError('REPORT_FINALISED')
    }

    const photos = await ctx.runQuery(internal.reports.photosForRender, { reportId })

    const { pdf } = await import('@react-pdf/renderer')
    const { ReportPdf } = await import('../src/components/reports/pdf/ReportPdf')

    const stream = await pdf(
      <ReportPdf
        report={{
          template: report.template,
          customTemplate: report.customTemplate,
          templateSnapshot: report.templateSnapshot,
          templateVersion: report.templateVersion,
          context: report.context,
          legalBasis: report.legalBasis,
          finalised: false,
          data: (report.data ?? {}) as Record<string, unknown>,
          businessName: report.businessName,
          business: report.business,
          property: report.property,
          licenceNumber: report.author?.licenceNumber,
          photos: photos.slots,
          galleryPhotos: photos.gallery,
          watermark: 'DRAFT',
        }}
      />,
    ).toBuffer()

    const buffer = await streamToBuffer(stream)
    const storageId = await ctx.storage.store(
      new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }),
    )
    await ctx.runMutation(internal.reports.setPreview, { reportId, storageId })

    return { url: await ctx.storage.getUrl(storageId) }
  },
})
