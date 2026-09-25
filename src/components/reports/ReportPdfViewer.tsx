import { useMemo } from 'react'
import { ViewerHost } from '#/components/pdf/host/ViewerHost'
import { useShareSupport } from '#/components/pdf/host/useShareSupport'
import { savePdf, sharePdf } from '#/lib/pdfFiles'
import { reportPdfSource } from './reportPdfSources'
import { useReportMarkup } from './useReportMarkup'
import type { ViewerActions } from '#/components/pdf/types'
import type { ReportPdf } from './useReportPdf'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * A finalised report's PDF, full-screen in the app's own viewer, with the
 * team's marks over it.
 *
 * Share and Save hand over the report exactly as it was finalised and stored.
 * The marks are the team's working notes — a circled bait station, "check
 * this again" — and never burned into the file: a client who is sent the
 * report gets the document they are owed, not the office's scribbles. The
 * palette says so, and so does the viewer once a report with marks is shared
 * or saved (`MARKUP_NOTE`, `MARKUP_SHARE_NOTE`, `MARKUP_SAVE_NOTE`).
 *
 * Mounted only once hydrated and only while the address says `?view=pdf`
 * (the route decides); the viewer's own code arrives lazily through
 * `ViewerHost`, never in this page's chunk.
 */
export function ReportPdfViewer({
  businessId,
  reportId,
  title,
  fileName,
  pdf,
  badge,
  onClose,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  title: string
  fileName: string
  pdf: ReportPdf
  /** "Replaced by version 2", for a document a correction has replaced. */
  badge?: string
  onClose: () => void
}) {
  const support = useShareSupport()
  const markup = useReportMarkup({ businessId, reportId })

  // Keyed by the report, not by whatever URL the page holds this render —
  // see `reportPdfSource`. `ensure` reads the current URL when it is called.
  const { ensure } = pdf
  const source = useMemo(
    () => reportPdfSource(reportId, ensure),
    [reportId, ensure],
  )

  const actions = useMemo(
    (): ViewerActions => ({
      share: support.files ? (file) => sharePdf(file, { title }) : undefined,
      save: savePdf,
      saveLabel: support.saveLabel,
    }),
    [support, title],
  )

  return (
    <ViewerHost
      title={title}
      fileName={fileName}
      source={source}
      actions={actions}
      markup={markup}
      badge={badge}
      onClose={onClose}
    />
  )
}
