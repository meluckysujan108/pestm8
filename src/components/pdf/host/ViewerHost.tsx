import { Component, Suspense, lazy, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { FileWarning, LoaderCircle } from 'lucide-react'
import { loadViewer } from './viewerChunk'
import type { ErrorInfo, ReactNode } from 'react'
import type { DocumentViewerProps } from '#/components/pdf/types'
import {
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'

/**
 * The PDF viewer, as every page opens it — a product's PDF, a finalised
 * report, a draft's preview: fetched on first use (see `viewerChunk.ts`),
 * with a stand-in that looks like the viewer while it arrives and a way out
 * if it never does. The one door to the viewer: a page imports this, never
 * `DocumentViewer` itself, which would pull pdf.js into its chunk and crash
 * the server render.
 *
 * Both stand-ins draw the viewer's own backdrop and its Done button in the
 * viewer's place, so opening a PDF looks like one motion however long the
 * chunk takes — and so a technician on one bar of signal is never left with
 * a blank screen and no way back. Neither is a Radix dialog: nothing else is
 * open (every page closes its sheet while the viewer is up), so there is no
 * focus trap to share and nothing to fight over the body's pointer events.
 */

const DocumentViewer = lazy(loadViewer)

export function ViewerHost(props: DocumentViewerProps) {
  return (
    <ViewerBoundary title={props.title} onClose={props.onClose}>
      <Suspense
        fallback={
          <ViewerShell title={props.title} onClose={props.onClose}>
            <LoaderCircle
              aria-hidden
              size={30}
              strokeWidth={1.7}
              className="animate-spin text-muted"
            />
            <p className="sr-only" role="status">
              Opening the PDF
            </p>
          </ViewerShell>
        }
      >
        <DocumentViewer {...props} />
      </Suspense>
    </ViewerBoundary>
  )
}

/** The viewer's frame without the viewer: backdrop, top bar, Done. */
function ViewerShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const done = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    done.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${title} PDF`}
      className="fixed inset-0 z-[80] flex flex-col bg-viewer-backdrop text-ink"
    >
      <header className="chrome-blur shrink-0 border-b border-hairline pt-[env(safe-area-inset-top)]">
        <div className="grid h-11 grid-cols-[minmax(0,1fr)_minmax(0,2.6fr)_minmax(0,1fr)] items-center pl-[max(0.25rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))]">
          <div className="flex justify-start">
            <button
              ref={done}
              type="button"
              onClick={onClose}
              className="h-11 rounded-lg px-3 text-[17px] font-semibold text-blue outline-none transition active:opacity-50 focus-visible:ring-2 focus-visible:ring-blue"
            >
              Done
            </button>
          </div>
          <p className="truncate text-center text-body font-semibold text-ink">
            {title}
          </p>
          <div />
        </div>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-[env(safe-area-inset-bottom)] text-center">
        {children}
      </div>
    </div>,
    document.body,
  )
}

/**
 * Catches the one failure the viewer cannot report itself: its own code not
 * arriving — no signal on first open, or a deploy since this page loaded that
 * replaced the chunk it asks for. React.lazy remembers a failed import, so
 * only a reload tries again; Close leaves the page as it was.
 */
class ViewerBoundary extends Component<
  { title: string; onClose: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('The PDF viewer failed to load', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <ViewerShell title={this.props.title} onClose={this.props.onClose}>
        <FileWarning
          aria-hidden
          size={34}
          strokeWidth={1.7}
          className="text-muted"
        />
        <p role="alert" className="max-w-[300px] text-body text-ink-2">
          The PDF viewer didn’t load. Check your signal, then reload the app.
        </p>
        <div className="mt-2 flex w-full max-w-[300px] gap-2">
          <button
            type="button"
            onClick={this.props.onClose}
            className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className={`${NEUTRAL_BUTTON_COMPACT} flex-1`}
          >
            Reload
          </button>
        </div>
      </ViewerShell>
    )
  }
}

/**
 * A line of status above the open viewer — "Uploading new PDF…", a keep that
 * failed — just under its top bar, so it never covers Done.
 *
 * Not interactive, on purpose: the viewer is a modal Radix dialog, and a tap
 * on anything outside it counts as a tap outside, which closes the viewer.
 * It goes away on its own instead.
 */
export function ViewerStatusPill({
  text,
  tone,
}: {
  text: string
  tone: 'info' | 'problem'
}) {
  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+52px)] z-[90] flex justify-center px-4"
      role={tone === 'problem' ? 'alert' : 'status'}
    >
      <p
        className={`chrome-blur max-w-[440px] rounded-2xl px-3.5 py-1.5 text-center text-caption font-semibold shadow-elevation ${tone === 'problem' ? 'text-amber-ink' : 'text-ink'}`}
      >
        {text}
      </p>
    </div>,
    document.body,
  )
}
