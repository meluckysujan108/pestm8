import { useEffect } from 'react'
import {
  Check,
  ChevronRight,
  Download,
  LoaderCircle,
  RotateCcw,
  Send,
  Share,
  TriangleAlert,
} from 'lucide-react'
import { prefetchViewer } from '#/components/pdf/host/viewerChunk'
import { useShareSupport } from '#/components/pdf/host/useShareSupport'
import {
  LINK_BUTTON_COMPACT,
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { FormAlert } from '#/components/forms/FormAlert'
import { useReportHandOver } from './useReportHandOver'
import type { ReportPdf, ReportPdfStatus } from './useReportPdf'

/**
 * The finished report's document, at the top of its page: a likeness of the
 * PDF's first page that opens the real one, and the two things done with a
 * finished report most — send it, and hand it to another app.
 *
 * The likeness is drawn, not rendered from the file. A report's PDF can be
 * several megabytes of photos (the emailed copy exists because some are over
 * six), and this is the first thing on a page opened on a doorstep: it must
 * not cost a download to show. Like set-up's `ReportPreview`, it follows the
 * printed page's shape — logo, the red band, lines of text — and says nothing
 * the file does not.
 *
 * Opening the page is what asks the server for the PDF, once hydrated (a
 * finalised report is server-rendered, and the server has no business
 * starting a render for a page nobody may look at). The viewer joins the same
 * render when it opens, so View PDF works while this still says Preparing: it
 * simply waits there instead.
 */
export function ReportCover({
  logoUrl,
  pdf,
  title,
  fileName,
  hydrated,
  onView,
  onSend,
}: {
  logoUrl?: string | null
  pdf: ReportPdf
  /** The document's own title, for the share sheet. */
  title: string
  fileName: string
  hydrated: boolean
  onView: () => void
  onSend: () => void
}) {
  const { status, ensure } = pdf
  const failed = status.phase === 'failed'
  const ready = status.phase === 'ready'
  const support = useShareSupport()
  // Where the phone's share sheet takes files, Share; elsewhere a download,
  // which is all a computer's browser can do with it.
  const purpose = support.files ? 'share' : 'save'
  const handOver = useReportHandOver({ pdf, fileName, title, purpose })

  // Asked for once per failure, never in a loop: after one the person
  // decides, with Try again (or View PDF, which tries again as it loads).
  useEffect(() => {
    if (!hydrated || ready || failed) return
    void ensure().catch(() => {})
  }, [hydrated, ready, failed, ensure])

  // The viewer's code, fetched while the person is still reading the page.
  useEffect(() => {
    if (hydrated) prefetchViewer()
  }, [hydrated])

  return (
    <section aria-label="PDF" className="flex flex-col gap-2.5">
      <button
        type="button"
        // The finalised report is server-rendered: a tap before hydration
        // would land on a button with no handler.
        disabled={!hydrated}
        onClick={onView}
        className="flex w-full items-center gap-3.5 rounded-2xl border border-hairline bg-surface p-3 text-left shadow-elevation transition active:scale-[.99] focus-visible:ring-2 focus-visible:ring-blue outline-none"
      >
        <PageLikeness logoUrl={logoUrl} />
        <span className="min-w-0 flex-1">
          <span className="block text-row-title text-ink">View PDF</span>
          <StatusLine status={status} />
        </span>
        <ChevronRight
          aria-hidden
          size={18}
          strokeWidth={2}
          className="shrink-0 text-muted-2"
        />
      </button>

      {failed && (
        <div className="flex flex-col gap-2">
          <FormAlert>{status.problem}</FormAlert>
          <button
            type="button"
            disabled={!hydrated}
            onClick={() => void ensure().catch(() => {})}
            className={`${SECONDARY_BUTTON_COMPACT} flex items-center justify-center gap-2`}
          >
            <RotateCcw size={16} strokeWidth={2} />
            Try again
          </button>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={!hydrated}
          onClick={onSend}
          className={`${NEUTRAL_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-2 px-3`}
        >
          <Send size={16} strokeWidth={2} />
          Send this report
        </button>
        <button
          type="button"
          disabled={!hydrated}
          onClick={handOver.run}
          aria-busy={handOver.preparing || undefined}
          className={`${LINK_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-2 px-3`}
        >
          {purpose === 'share' ? (
            <Share size={16} strokeWidth={2} />
          ) : (
            <Download size={16} strokeWidth={2} />
          )}
          {handOver.label(purpose === 'share' ? 'Share' : support.saveLabel)}
        </button>
      </div>
      {handOver.problem && (
        <p role="alert" className="text-caption text-amber-ink">
          {handOver.problem}
        </p>
      )}
    </section>
  )
}

/**
 * The first page, small: the printed page's logo corner, its red band and a
 * few lines. Paper in both themes, as the PDF is.
 */
function PageLikeness({ logoUrl }: { logoUrl?: string | null }) {
  return (
    <span
      aria-hidden
      data-theme="light"
      className="flex aspect-[210/297] w-14 shrink-0 flex-col overflow-hidden rounded-sm border border-hairline bg-paper p-1.5 shadow-paper"
    >
      <span className="flex h-3 items-center">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt=""
            className="max-h-full max-w-[60%] object-contain object-left"
          />
        ) : (
          <span className="h-2 w-5 rounded-[2px] bg-surface-3" />
        )}
      </span>
      <span className="mt-1.5 h-1.5 w-full bg-red-fill" />
      <span className="mt-1.5 flex flex-col gap-1">
        <span className="h-0.5 w-full rounded-full bg-surface-3" />
        <span className="h-0.5 w-4/5 rounded-full bg-surface-3" />
        <span className="h-0.5 w-full rounded-full bg-surface-3" />
        <span className="h-0.5 w-3/5 rounded-full bg-surface-3" />
        <span className="h-0.5 w-full rounded-full bg-surface-3" />
      </span>
    </span>
  )
}

function StatusLine({ status }: { status: ReportPdfStatus }) {
  return (
    <span
      role="status"
      className={`mt-0.5 flex items-center gap-1.5 text-caption ${status.phase === 'failed' ? 'text-amber-ink' : 'text-grey-ink'}`}
    >
      {status.phase === 'ready' ? (
        <>
          <Check
            aria-hidden
            size={13}
            strokeWidth={2.2}
            className="shrink-0 text-green"
          />
          Ready · as your client gets it
        </>
      ) : status.phase === 'preparing' ? (
        <>
          <LoaderCircle
            aria-hidden
            size={13}
            strokeWidth={2}
            className="shrink-0 animate-spin"
          />
          Preparing…
        </>
      ) : (
        <>
          <TriangleAlert
            aria-hidden
            size={13}
            strokeWidth={2}
            className="shrink-0"
          />
          Could not prepare the PDF
        </>
      )}
    </span>
  )
}
