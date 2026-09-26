import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft,
  ChevronRight,
  ImageOff,
  LoaderCircle,
  Share,
} from 'lucide-react'
import { pageIsZoomed, usePageZoomed } from '#/components/pdf/pageZoom'
import { isAbortError } from '#/lib/pdfFiles'
import {
  IDENTITY,
  clampTransform,
  doubleTap,
  fittedBox,
  panBy,
  zoomBy,
} from './imageZoom'
import type { Box, Point, Size, StageTransform } from './imageZoom'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type {
  DocumentSource,
  LoadProgress,
  ViewerPager,
} from '#/components/pdf/types'

/**
 * A picture, full screen, inside the app: the image half of "opened in the
 * app, never downloaded" (Phase 8.1), for a licence photographed rather than
 * scanned. The PDF half is the Products viewer (`DocumentViewer`).
 *
 * It takes the same `DocumentSource` the PDF viewer does, so whoever opens it
 * decides where the bytes come from — the copy kept on the phone, memory, the
 * network — and the viewer only ever holds a Blob. It is shown from an object
 * URL, never from the file's own URL: nothing here can be long-pressed into
 * "Open in new tab", and nothing links out of the app.
 *
 * Gestures, all from pointer events so a finger, a pen and a mouse behave the
 * same: two fingers pinch about their midpoint and pan as they move; one
 * finger pans a zoomed picture; a double tap zooms in on the point tapped, or
 * back out; a trackpad pinch (a wheel with ctrl) zooms and a scroll pans.
 * Keys: + and − zoom, 0 fits, Escape closes. While the whole app is already
 * pinch-zoomed a pinch is left to the browser (`pageIsZoomed` has why).
 *
 * Share is offered only when the opener passes it — the holder's own licence,
 * never someone else's the owner is looking at.
 *
 * A picture that is one of several (a licence's front and back, `pager`)
 * gets a bar along the bottom to step between them, the arrow keys, and a
 * sideways swipe while the picture is not zoomed — a swipe on a zoomed one
 * pans it, as before.
 */

export type ImageViewerProps = {
  /** Shown in the top bar. */
  title: string
  /** What the file is called when it is shared. */
  fileName: string
  /** The picture's type, for the file a share hands over. */
  contentType: string
  source: DocumentSource
  onClose: () => void
  /** The system share sheet, for the file itself. Absent: no Share. */
  share?: (file: File) => Promise<unknown>
  /** What to say when the bytes arrive but are not a picture a browser can
   * draw — worded by the opener, who knows whether the person looking can
   * do anything about it. */
  brokenMessage?: string
  /** The other files this one belongs with; absent for a single picture. */
  pager?: ViewerPager
}

type Phase =
  | { phase: 'loading'; progress: LoadProgress | null }
  | { phase: 'ready'; blob: Blob }
  | { phase: 'failed'; message: string }

const TAP_SLOP = 10
const DOUBLE_TAP_MS = 300
/** How far a finger must travel sideways, mostly sideways, to be a swipe to
 * the next picture rather than a tap that wandered. */
const SWIPE_MIN = 60

export function ImageViewer({
  title,
  fileName,
  contentType,
  source,
  onClose,
  share,
  brokenMessage = 'This picture can’t be shown.',
  pager,
}: ImageViewerProps) {
  const paged = pager !== undefined && pager.count > 1
  const [state, setState] = useState<Phase>({
    phase: 'loading',
    progress: null,
  })
  const [attempt, setAttempt] = useState(0)

  // ---- The bytes --------------------------------------------------------

  const { key, load } = source
  useEffect(() => {
    const abort = new AbortController()
    setState({ phase: 'loading', progress: null })
    load((progress) => {
      if (!abort.signal.aborted) setState({ phase: 'loading', progress })
    }, abort.signal).then(
      (blob) => {
        if (!abort.signal.aborted) setState({ phase: 'ready', blob })
      },
      (error: unknown) => {
        if (abort.signal.aborted || isAbortError(error)) return
        setState({
          phase: 'failed',
          message:
            error instanceof Error && error.message
              ? error.message
              : 'The picture didn’t load.',
        })
      },
    )
    return () => abort.abort()
    // Not on `load`, which the opener may make afresh every render: the key
    // is what names these bytes.
  }, [key, attempt])

  const blob = state.phase === 'ready' ? state.blob : null
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) {
      setSrc(null)
      return
    }
    const made = URL.createObjectURL(blob)
    setSrc(made)
    return () => URL.revokeObjectURL(made)
  }, [blob])
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])

  // ---- Sizes and the transform ------------------------------------------

  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 })
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 })
  // Another picture (the next of several): unmeasured until it has loaded,
  // so it is never drawn for a moment in the last one's shape.
  useEffect(() => setNatural({ width: 0, height: 0 }), [key])
  const fitted: Box = fittedBox(stage, natural)
  const transform = useRef<StageTransform>(IDENTITY)
  // Read by the gesture handlers, which must see the sizes of the render
  // that is on screen, not the one that bound them.
  const geometry = useRef({ stage, fitted })
  useLayoutEffect(() => {
    geometry.current = { stage, fitted }
  })

  const apply = useCallback((next: StageTransform) => {
    transform.current = next
    const layer = layerRef.current
    if (layer) {
      layer.style.transform = `translate(${next.tx}px, ${next.ty}px) scale(${next.s})`
    }
  }, [])

  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const measure = () =>
      setStage({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // A new picture, or a new screen size (a phone turned round): start from
  // the whole picture again rather than a zoom that no longer fits. The key
  // too: the back of a card is often the front's exact size, and would
  // otherwise open at the zoom the front was left at.
  useEffect(() => {
    const { stage: size, fitted: box } = geometry.current
    apply(clampTransform(IDENTITY, size, box))
  }, [apply, stage.width, stage.height, natural.width, natural.height, key])

  // ---- Gestures ---------------------------------------------------------

  const pointers = useRef(new Map<number, Point>())
  const pinch = useRef<{
    distance: number
    mid: Point
    from: StageTransform
  } | null>(null)
  const pan = useRef<Point | null>(null)
  const tap = useRef<{ at: number; start: Point; moved: boolean } | null>(null)
  const lastTap = useRef<{ at: number; point: Point } | null>(null)

  const local = (event: { clientX: number; clientY: number }): Point => {
    const rect = stageRef.current?.getBoundingClientRect()
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    }
  }

  const startPinch = () => {
    const [a, b] = [...pointers.current.values()]
    pinch.current = {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      from: transform.current,
    }
    pan.current = null
  }

  /*
   * `will-change: transform` only while something is moving. Left on, the
   * browser keeps the layer's bitmap at the size it was first painted — the
   * picture fitted to the screen — and a zoom only scales that bitmap up: a
   * licence number photographed at arm's length stays a blur at 4× on an
   * Android phone. Off once the fingers lift, the layer is redrawn from the
   * full-size picture at the zoom it came to rest at. The PDF viewer's page
   * scroller does the same.
   */
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const moving = (on: boolean) => {
    clearTimeout(settleTimer.current)
    const layer = layerRef.current
    if (layer) layer.style.willChange = on ? 'transform' : ''
  }
  // For a wheel or trackpad, which has no "lift": at rest after a pause.
  const movingBriefly = () => {
    moving(true)
    settleTimer.current = setTimeout(() => moving(false), 200)
  }
  useEffect(() => () => clearTimeout(settleTimer.current), [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    moving(true)
    const point = local(event)
    pointers.current.set(event.pointerId, point)
    if (pointers.current.size === 2 && !pageIsZoomed()) {
      startPinch()
      tap.current = null
    } else if (pointers.current.size === 1) {
      pan.current = point
      tap.current = { at: event.timeStamp, start: point, moved: false }
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    const point = local(event)
    pointers.current.set(event.pointerId, point)
    const { stage: size, fitted: box } = geometry.current

    if (tap.current && !tap.current.moved) {
      const { start } = tap.current
      if (Math.hypot(point.x - start.x, point.y - start.y) > TAP_SLOP) {
        tap.current.moved = true
      }
    }

    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const factor =
        Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.distance
      const { from, mid: startMid } = pinch.current
      const zoomed = zoomBy(from, startMid, factor, size, box)
      apply(
        panBy(
          zoomed,
          { x: mid.x - startMid.x, y: mid.y - startMid.y },
          size,
          box,
        ),
      )
      return
    }

    if (pan.current && transform.current.s > 1) {
      const delta = { x: point.x - pan.current.x, y: point.y - pan.current.y }
      pan.current = point
      apply(panBy(transform.current, delta, size, box))
    } else {
      pan.current = point
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    const point = local(event)
    pointers.current.delete(event.pointerId)

    if (pointers.current.size < 2) pinch.current = null
    // One finger left of a pinch carries on as a pan from where it is.
    pan.current =
      pointers.current.size > 0 ? [...pointers.current.values()][0] : null
    if (pointers.current.size === 0) moving(false)

    const pressed = tap.current
    tap.current = null

    // A sideways swipe across a picture at its fitted size steps to the next
    // one. Only one finger, all the way through (a pinch clears `tap`), and
    // only unzoomed: on a zoomed picture the same movement is a pan.
    if (
      paged &&
      event.type === 'pointerup' &&
      pressed?.moved &&
      pointers.current.size === 0 &&
      transform.current.s <= 1.01
    ) {
      const dx = point.x - pressed.start.x
      const dy = point.y - pressed.start.y
      if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0 && pager.index < pager.count - 1) pager.onNext()
        else if (dx > 0 && pager.index > 0) pager.onPrevious()
        return
      }
    }

    if (
      event.type !== 'pointerup' ||
      !pressed ||
      pressed.moved ||
      pointers.current.size > 0 ||
      event.timeStamp - pressed.at > DOUBLE_TAP_MS
    ) {
      return
    }
    const previous = lastTap.current
    if (
      previous &&
      event.timeStamp - previous.at < DOUBLE_TAP_MS &&
      Math.hypot(point.x - previous.point.x, point.y - previous.point.y) <
        TAP_SLOP * 3
    ) {
      lastTap.current = null
      const { stage: size, fitted: box } = geometry.current
      apply(doubleTap(transform.current, point, size, box))
    } else {
      lastTap.current = { at: event.timeStamp, point }
    }
  }

  // A trackpad pinch arrives as a wheel with ctrl held; a two-finger scroll
  // as a plain wheel. Listened to directly: React's wheel listener is
  // passive, and the page must not zoom or scroll behind the viewer.
  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      movingBriefly()
      const { stage: size, fitted: box } = geometry.current
      if (event.ctrlKey) {
        apply(
          zoomBy(
            transform.current,
            local(event),
            Math.exp(-event.deltaY / 100),
            size,
            box,
          ),
        )
      } else if (transform.current.s > 1) {
        apply(
          panBy(
            transform.current,
            { x: -event.deltaX, y: -event.deltaY },
            size,
            box,
          ),
        )
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
    // `movingBriefly` only touches refs, so it need not re-bind this.
  }, [apply])

  // ---- The page behind --------------------------------------------------

  const pageZoomed = usePageZoomed()
  useBodyLock(root)
  useModalFocus(root)

  const done = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    done.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { stage: size, fitted: box } = geometry.current
      const centre = { x: size.width / 2, y: size.height / 2 }
      if (event.key === 'Escape') {
        onClose()
      } else if (event.key === '+' || event.key === '=') {
        apply(zoomBy(transform.current, centre, 1.5, size, box))
      } else if (event.key === '-' || event.key === '_') {
        apply(zoomBy(transform.current, centre, 1 / 1.5, size, box))
      } else if (event.key === '0') {
        apply(clampTransform(IDENTITY, size, box))
      } else if (paged && event.key === 'ArrowLeft' && pager.index > 0) {
        pager.onPrevious()
      } else if (
        paged &&
        event.key === 'ArrowRight' &&
        pager.index < pager.count - 1
      ) {
        pager.onNext()
      } else {
        return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [apply, onClose, paged, pager])

  // ---- Share ------------------------------------------------------------

  const [shareProblem, setShareProblem] = useState<string | null>(null)
  useEffect(() => setShareProblem(null), [key])
  const onShare = () => {
    if (!blob || !share) return
    setShareProblem(null)
    // Nothing awaited before this call: Safari opens the share sheet only
    // from inside the tap that asked for it.
    share(new File([blob], fileName, { type: contentType })).catch(() =>
      setShareProblem('Couldn’t share this picture.'),
    )
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={setRoot}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[80] flex flex-col bg-viewer-backdrop text-ink"
    >
      <header className="chrome-blur relative z-10 shrink-0 border-b border-hairline pt-[env(safe-area-inset-top)]">
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
          <p className="truncate text-center text-[15px] font-semibold text-ink">
            {title}
          </p>
          <div className="flex justify-end">
            {share && (
              <button
                type="button"
                aria-label="Share"
                disabled={!blob}
                onClick={onShare}
                className="flex size-11 items-center justify-center rounded-full text-blue outline-none transition active:opacity-50 focus-visible:ring-2 focus-visible:ring-blue disabled:text-muted-2"
              >
                <Share size={22} strokeWidth={1.8} />
              </button>
            )}
          </div>
        </div>
      </header>

      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 overflow-hidden select-none"
        style={{ touchAction: pageZoomed ? 'pinch-zoom' : 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {src && !broken && (
          <div ref={layerRef} className="absolute inset-0 origin-top-left">
            <img
              src={src}
              alt={title}
              draggable={false}
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={() => setBroken(true)}
              // Placed where `fittedBox` says, so the maths and the pixels
              // agree; invisible until its size is known.
              style={{
                position: 'absolute',
                left: fitted.x,
                top: fitted.y,
                width: fitted.width,
                height: fitted.height,
                maxWidth: 'none',
                visibility: fitted.width > 0 ? 'visible' : 'hidden',
              }}
            />
          </div>
        )}

        {(state.phase !== 'ready' || broken) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 pb-[env(safe-area-inset-bottom)] text-center">
            {state.phase === 'loading' ? (
              <>
                <LoaderCircle
                  aria-hidden
                  size={30}
                  strokeWidth={2}
                  className="animate-spin text-muted"
                />
                <p role="status" className="text-caption text-muted">
                  {state.progress?.total
                    ? `Loading… ${Math.min(
                        99,
                        Math.round(
                          (state.progress.loaded / state.progress.total) * 100,
                        ),
                      )}%`
                    : 'Loading…'}
                </p>
              </>
            ) : (
              <>
                <ImageOff
                  aria-hidden
                  size={34}
                  strokeWidth={1.75}
                  className="text-muted"
                />
                <p role="alert" className="max-w-[300px] text-body text-ink-2">
                  {broken
                    ? brokenMessage
                    : state.phase === 'failed'
                      ? state.message
                      : ''}
                </p>
                <div className="mt-2 flex w-full max-w-[300px] gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="h-11 flex-1 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.975]"
                  >
                    Close
                  </button>
                  {!broken && (
                    <button
                      type="button"
                      onClick={() => setAttempt((n) => n + 1)}
                      className="h-11 flex-1 rounded-xl bg-blue text-[15px] font-semibold text-on-tint transition active:scale-[.975]"
                    >
                      Try again
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {paged && (
        <footer className="chrome-blur relative z-10 shrink-0 border-t border-hairline pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
          <div className="flex h-[52px] items-center justify-between px-2">
            <button
              type="button"
              aria-label="Previous file"
              disabled={pager.index <= 0}
              onClick={pager.onPrevious}
              className="flex size-11 items-center justify-center rounded-full text-blue outline-none transition active:opacity-50 focus-visible:ring-2 focus-visible:ring-blue disabled:text-muted-2"
            >
              <ChevronLeft size={24} strokeWidth={1.8} />
            </button>
            <p
              aria-live="polite"
              className="text-caption font-semibold text-ink-2"
            >
              File {pager.index + 1} of {pager.count}
            </p>
            <button
              type="button"
              aria-label="Next file"
              disabled={pager.index >= pager.count - 1}
              onClick={pager.onNext}
              className="flex size-11 items-center justify-center rounded-full text-blue outline-none transition active:opacity-50 focus-visible:ring-2 focus-visible:ring-blue disabled:text-muted-2"
            >
              <ChevronRight size={24} strokeWidth={1.8} />
            </button>
          </div>
        </footer>
      )}

      {shareProblem && (
        <p
          role="alert"
          // Above the file bar, when there is one, rather than over it.
          className={`chrome-blur pointer-events-none absolute inset-x-4 mx-auto max-w-sm rounded-2xl px-3.5 py-2 text-center text-caption font-semibold text-orange-ink shadow-elevation ${paged ? 'bottom-[calc(env(safe-area-inset-bottom)+68px)]' : 'bottom-[calc(env(safe-area-inset-bottom)+16px)]'}`}
        >
          {shareProblem}
        </p>
      )}
    </div>,
    document.body,
  )
}

/**
 * What the PDF viewer gets from Radix Dialog, for this hand-rolled one: the
 * page behind can be neither tabbed to nor read out while the picture is open
 * (every other child of <body> is made `inert` — Tab and Switch Control stay
 * in the viewer, and VoiceOver does not wander into Profile behind it), and
 * closing puts focus back on whatever opened it, so VoiceOver keeps its place
 * instead of starting again from the top of the page.
 */
function useModalFocus(root: HTMLElement | null) {
  // Read while rendering the first time, before the viewer moves focus to
  // its own Done button: by the time `root` is known, that has happened.
  const openerRef = useRef<HTMLElement | null | undefined>(undefined)
  if (openerRef.current === undefined && typeof document !== 'undefined') {
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
  }
  useEffect(() => {
    if (typeof document === 'undefined' || !root) return
    const opener = openerRef.current
    const made: Array<HTMLElement> = []
    for (const child of Array.from(document.body.children)) {
      if (child === root || !(child instanceof HTMLElement) || child.inert) {
        continue
      }
      child.inert = true
      made.push(child)
    }
    return () => {
      for (const child of made) child.inert = false
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [root])
}

/**
 * Holds the page still behind the viewer: no scrolling, and — unless the app
 * is already pinch-zoomed — no browser pinch, which iOS would otherwise apply
 * to the whole app on top of the viewer's own. A smaller copy of the PDF
 * viewer's lock (DocumentViewer's `useBodyLock`), which has the detail.
 */
function useBodyLock(root: HTMLElement | null) {
  useEffect(() => {
    if (typeof document === 'undefined' || !root) return
    const { documentElement: html, body } = document
    const previous = [html.style.overflow, body.style.overflow]
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'

    let gestureZoomed = false
    const onGestureStart = (event: Event) => {
      gestureZoomed = pageIsZoomed()
      if (!gestureZoomed) event.preventDefault()
    }
    const onGestureChange = (event: Event) => {
      if (!gestureZoomed) event.preventDefault()
    }
    document.addEventListener('gesturestart', onGestureStart, {
      passive: false,
    })
    document.addEventListener('gesturechange', onGestureChange, {
      passive: false,
    })
    return () => {
      html.style.overflow = previous[0]
      body.style.overflow = previous[1]
      document.removeEventListener('gesturestart', onGestureStart)
      document.removeEventListener('gesturechange', onGestureChange)
    }
  }, [root])
}
