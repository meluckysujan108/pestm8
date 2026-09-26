import { useEffect } from 'react'
import {
  Check,
  FileText,
  LoaderCircle,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react'
import { prefetchViewer } from '#/components/pdf/host/viewerChunk'
import { ReplacedNotice } from './AmendmentNotice'
import type { ReportPdf, ReportPdfStatus } from './useReportPdf'
import type { Id } from '../../../convex/_generated/dataModel'
import {
  NEUTRAL_BUTTON,
  SECONDARY_BUTTON,
} from '#/components/primitives/buttons'
import { FormAlert } from '#/components/forms/FormAlert'

/**
 * The PDF tab: what the document is, whether it is ready, and the one way in —
 * View PDF, which opens it full-screen in the app's own viewer (search, zoom,
 * the team's marks, Share and Save). The tab used to draw a small viewer of
 * its own inside the page, one page at a time behind arrows, with a Download
 * button under it that on an installed iPhone app had nowhere to download to.
 *
 * Opening the tab is what asks the server for the PDF, once hydrated (a
 * finalised report is server-rendered, and the server has no business
 * starting a render for a page nobody may look at). The viewer joins the
 * same render when it opens, so View PDF works while this still says
 * Preparing: it simply waits there instead.
 */
export function ReportPdfCard({
  businessSlug,
  title,
  pdf,
  hydrated,
  onView,
  replaced,
}: {
  businessSlug: string
  /** The document's own title — the form, and the site it is for. */
  title: string
  pdf: ReportPdf
  hydrated: boolean
  onView: () => void
  /** Set when a correction has replaced this document. */
  replaced?: { supersededBy: Id<'reports'>; reportNumber?: number }
}) {
  const { status, ensure } = pdf
  const failed = status.phase === 'failed'
  const ready = status.phase === 'ready'

  // Asked for once per failure, never in a loop: after one the person
  // decides, with Try again (or View PDF, which tries again as it loads).
  useEffect(() => {
    if (!hydrated || ready || failed) return
    void ensure().catch(() => {})
  }, [hydrated, ready, failed, ensure])

  // The viewer's code, fetched while the person is still reading this card.
  useEffect(() => {
    if (hydrated) prefetchViewer()
  }, [hydrated])

  return (
    <div className="px-4 pb-8 pt-5">
      {replaced && (
        <div className="mb-3">
          <ReplacedNotice
            businessSlug={businessSlug}
            supersededBy={replaced.supersededBy}
            reportNumber={replaced.reportNumber}
          />
        </div>
      )}

      <section
        aria-label="PDF"
        className="rounded-2xl border border-hairline bg-surface p-4 shadow-elevation"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2"
          >
            <FileText size={20} strokeWidth={1.7} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-body font-semibold text-ink">{title}</p>
            <StatusLine status={status} />
          </div>
        </div>

        {failed && <FormAlert className="mt-3">{status.problem}</FormAlert>}

        <div className="mt-4 flex gap-2">
          {failed && (
            <button
              type="button"
              disabled={!hydrated}
              onClick={() => void ensure().catch(() => {})}
              className={`${SECONDARY_BUTTON} flex flex-1 items-center justify-center gap-2`}
            >
              <RotateCcw size={16} strokeWidth={2} />
              Try again
            </button>
          )}
          <button
            type="button"
            // The finalised report is server-rendered: a tap before
            // hydration would land on a button with no handler.
            disabled={!hydrated}
            onClick={onView}
            className={`${NEUTRAL_BUTTON} flex flex-1 items-center justify-center gap-2`}
          >
            <FileText size={17} strokeWidth={2} />
            View PDF
          </button>
        </div>
      </section>
    </div>
  )
}

function StatusLine({ status }: { status: ReportPdfStatus }) {
  return (
    <p
      role="status"
      className={`mt-0.5 flex items-center gap-1.5 text-caption ${status.phase === 'failed' ? 'text-amber-ink' : 'text-muted'}`}
    >
      {status.phase === 'ready' ? (
        <>
          <Check
            aria-hidden
            size={14}
            strokeWidth={2.2}
            className="shrink-0 text-green"
          />
          Ready
        </>
      ) : status.phase === 'preparing' ? (
        <>
          <LoaderCircle
            aria-hidden
            size={14}
            strokeWidth={2}
            className="shrink-0 animate-spin"
          />
          Preparing…
        </>
      ) : (
        <>
          <TriangleAlert
            aria-hidden
            size={14}
            strokeWidth={2}
            className="shrink-0"
          />
          Could not prepare the PDF
        </>
      )}
    </p>
  )
}
