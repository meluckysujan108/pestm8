'use node'

import type { RegisteredQuery } from 'convex/server'
import type { getForRender, photosForRender } from '../reports'

/**
 * Draws a finalised report as a PDF: the one drawing both of its files come
 * from — the report's own PDF (`reportPipeline.renderIfNeeded`) and, when
 * that is too big to email, its lighter copy (`convex/emailCopy.ts`).
 *
 * One function so the two cannot drift. The copy is the same document, drawn
 * from the same record, with its photos handed over as smaller bytes; a
 * second drawing kept in step by hand is how an emailed copy comes to say
 * something its original does not.
 */

/**
 * What a query returns, read from the query itself. Not through `internal`:
 * this module is part of the generated API, and a type that went through the
 * API to describe the API would be defined in terms of itself.
 */
type Returns<TQuery> =
  TQuery extends RegisteredQuery<'internal', never, infer Value>
    ? Awaited<Value>
    : never

export type RenderableReport = NonNullable<Returns<typeof getForRender>>

export type RenderablePhotos = Returns<typeof photosForRender>

/** `toBuffer()` resolves to a Node `ReadableStream`, not a `Buffer`. */
export async function streamToBuffer(
  stream: NodeJS.ReadableStream,
): Promise<Buffer> {
  const chunks: Array<Buffer> = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export async function drawReportPdf(
  report: RenderableReport,
  photos: RenderablePhotos,
): Promise<Buffer> {
  const { pdf } = await import('@react-pdf/renderer')
  const { ReportPdf } =
    await import('../../src/components/reports/pdf/ReportPdf')

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
        // rewritten, so the version is the issue of this number — 2 for the
        // first correction. It is the one line on paper that tells a
        // correction from the document it replaced.
        version: report.version ?? 1,
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

  return streamToBuffer(stream)
}
