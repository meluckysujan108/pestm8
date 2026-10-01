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
import type { Ref } from 'react'
import type { ReportPdf, ReportPdfStatus } from './useReportPdf'

/**
 * The finished report's document, near the top of its page: one card with
 * the PDF (a likeness of its first page, which opens the real one) and the
 * Answers (the form as recorded), and under it the two things done with a
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
  shareText,
  fileName,
  hydrated,
  replaced,
  onView,
  onAnswers,
  onSend,
  sendRef,
}: {
  logoUrl?: string | null
  pdf: ReportPdf
  /** The document's own title, for the share sheet. */
  title: string
  /** The words that go with it into Messages or WhatsApp. */
  shareText: string
  fileName: string
  hydrated: boolean
  /** A later version is the current one: sending this is not the default. */
  replaced: boolean
  onView: () => void
  onAnswers: () => void
  onSend: () => void
  /** The Send button, for the sheet to give focus back to. */
  sendRef?: Ref<HTMLButtonElement>
}) {
  const { status, ensure } = pdf
  const failed = status.phase === 'failed'
  const ready = status.phase === 'ready'
  const support = useShareSupport()
  // Where the phone's share sheet takes files, Share; elsewhere a download,
  // which is all a computer's browser can do with it.
  const purpose = support.files ? 'share' : 'save'
  const handOver = useReportHandOver({
    pdf,
    fileName,
    title,
    text: shareText,
    purpose,
  })

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
    <section aria-labelledby="report-document">
      <h2 id="report-document" className="section-label mb-2">
        Document
      </h2>
      <div className="divide-y divide-hairline rounded-2xl border border-hairline bg-surface shadow-elevation">
        <button
          type="button"
          // The finalised report is server-rendered: a tap before hydration
          // would land on a button with no handler.
          disabled={!hydrated}
          onClick={onView}
          className="flex w-full items-center gap-3.5 rounded-t-2xl px-3.5 py-3 text-left outline-none transition active:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue"
        >
          <PageLikeness logoUrl={logoUrl} />
          <span className="min-w-0 flex-1">
            <span className="block text-body font-semibold text-ink">
              View PDF
            </span>
            <StatusLine status={status} />
          </span>
          <ChevronRight
            aria-hidden
            size={18}
            strokeWidth={2}
            className="shrink-0 text-muted-2"
          />
        </button>
        <button
          type="button"
          disabled={!hydrated}
          onClick={onAnswers}
          className="flex min-h-[52px] w-full items-center gap-3 rounded-b-2xl px-3.5 py-2.5 text-left outline-none transition active:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-body font-semibold text-ink">
              Answers
            </span>
            <span className="block text-caption text-grey-ink">
              The form as recorded, without the PDF
            </span>
          </span>
          <ChevronRight
            aria-hidden
            size={18}
            strokeWidth={2}
            className="shrink-0 text-muted-2"
          />
        </button>
      </div>
      {/* Said once, apart from the button: a status inside a button is read
          as part of its name, not announced when it changes. */}
      <p aria-live="polite" className="sr-only">
        {ready ? 'PDF ready' : failed ? 'Could not prepare the PDF' : ''}
      </p>

      <div className="mt-2.5 flex gap-2">
        <button
          ref={sendRef}
          type="button"
          disabled={!hydrated}
          onClick={onSend}
          className={`${replaced ? LINK_BUTTON_COMPACT : NEUTRAL_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-2 whitespace-nowrap px-3`}
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
          {/* What this phone does with it is known only once hydrated; until
              then the button keeps its place and says nothing, rather than
              "Download" on the iPhone that will say "Share". */}
          <span
            className={`flex items-center gap-2 ${hydrated ? '' : 'invisible'}`}
          >
            {purpose === 'share' ? (
              <Share size={16} strokeWidth={2} />
            ) : (
              <Download size={16} strokeWidth={2} />
            )}
            {handOver.label(purpose === 'share' ? 'Share' : support.saveLabel)}
          </span>
        </button>
      </div>

      {/* Below the buttons, not above them: this can arrive a few seconds
          after the page opens, and must not push down what a thumb is
          already reaching for. */}
      {failed && (
        <div className="mt-2.5 flex flex-col gap-2">
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
      {handOver.problem && (
        <p role="alert" className="mt-2 text-caption text-amber-ink">
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
      className="flex aspect-[210/297] w-12 shrink-0 flex-col overflow-hidden rounded-sm border border-hairline bg-paper p-1.5 shadow-paper"
    >
      <span className="flex h-2.5 items-center">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt=""
            className="max-h-full max-w-[60%] object-contain object-left"
          />
        ) : (
          <span className="h-1.5 w-4 rounded-[2px] bg-surface-3" />
        )}
      </span>
      <span className="mt-1.5 h-1.5 w-full bg-red-fill" />
      <span className="mt-1.5 flex flex-col gap-1">
        <span className="h-0.5 w-full rounded-full bg-surface-3" />
        <span className="h-0.5 w-4/5 rounded-full bg-surface-3" />
        <span className="h-0.5 w-full rounded-full bg-surface-3" />
        <span className="h-0.5 w-3/5 rounded-full bg-surface-3" />
      </span>
    </span>
  )
}

function StatusLine({ status }: { status: ReportPdfStatus }) {
  return (
    <span
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
          Not ready
        </>
      )}
    </span>
  )
}
