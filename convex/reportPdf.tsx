'use node'

import { ConvexError, v } from 'convex/values'
import { action } from './_generated/server'
import { api, internal } from './_generated/api'

/** `toBuffer()` resolves to a Node `ReadableStream`, not a `Buffer` — this
 * collects it, shared by both actions below. */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Array<Buffer> = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Proves `@react-pdf/renderer` actually bundles and runs inside a Convex Node
 * action before the real template is ported onto it — see the plan's Phase 5
 * risk note. `toBuffer()` (not `toBlob()`) is the Node-only half of this
 * library's API, unavailable in the browser build `DownloadPdfButton` used to
 * use.
 */
export const ping = action({
  args: {},
  handler: async () => {
    const { pdf, Document, Page, Text } = await import('@react-pdf/renderer')
    const stream = await pdf(
      <Document>
        <Page size="A4">
          <Text>ping</Text>
        </Page>
      </Document>,
    ).toBuffer()
    const buffer = await streamToBuffer(stream)
    return buffer.length
  },
})

/**
 * Renders a finalised report to PDF and stores it. Only runs once per report
 * in practice — a finalised report's data never changes, so `reports.get`'s
 * `pdfUrl` is a cache the caller checks before ever invoking this.
 *
 * Every fetch below goes through the existing public queries (`reports.get`,
 * `galleryPhotos`, `photoUrls`) rather than `ctx.db` directly — actions don't
 * have database access, and reusing them means this action inherits the same
 * membership/visibility checks as the on-screen document for free, instead of
 * re-deriving them.
 */
export const generate = action({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const report = await ctx.runQuery(api.reports.get, { businessId, reportId })
    if (!report) throw new ConvexError('NOT_FOUND')
    if (report.status !== 'finalised') {
      throw new ConvexError('REPORT_NOT_FINALISED')
    }

    const [galleryPhotos, photoUrls] = await Promise.all([
      ctx.runQuery(api.reports.galleryPhotos, { businessId, reportId }),
      ctx.runQuery(api.reports.photoUrls, { businessId, reportId }),
    ])

    const { pdf } = await import('@react-pdf/renderer')
    const { ReportPdf } =
      await import('../src/components/reports/pdf/ReportPdf')

    const stream = await pdf(
      <ReportPdf
        report={{
          template: report.template,
          customTemplate: report.customTemplate,
          legalBasis: report.legalBasis,
          finalisedAt: report.finalisedAt,
          data: (report.data ?? {}) as Record<string, unknown>,
          businessName: report.businessName,
          business: report.business,
          property: report.property,
          licenceNumber: report.author?.licenceNumber,
          photos: photoUrls as Record<string, string>,
          galleryPhotos,
        }}
      />,
    ).toBuffer()
    const buffer = await streamToBuffer(stream)

    const storageId = await ctx.storage.store(
      new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }),
    )
    await ctx.runMutation(internal.reports.setPdfStorageId, {
      reportId,
      storageId,
    })

    return { storageId, url: await ctx.storage.getUrl(storageId) }
  },
})
