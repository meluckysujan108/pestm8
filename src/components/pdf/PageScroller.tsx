import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { PageMarkup } from './PageMarkup'
import { PageRenderer } from './pageRenderer'
import { scrolledAt } from './markupInput'
import { pageIsZoomed, usePageZoomed } from './pageZoom'
import { isStylus, useMarkupInput } from './useMarkupInput'
import {
  IDENTITY,
  MAX_ZOOM,
  MIN_ZOOM,
  PAN_ONLY_STRETCH,
  anchorAt,
  canvasLimits,
  clampZoom,
  computeLayout,
  contentPointUnder,
  contentSize,
  currentPageAt,
  pageBox,
  pagesNear,
  pinchTransform,
  planDetail,
  revealScroll,
  scrollForAnchor,
  settleTransform,
  transformFor,
  zoomAbout,
  zoomTransformAround,
} from './layout'
import type { Ref, RefObject } from 'react'
import type { OwnScroll } from './markupInput'
import type { PDFDocumentProxy } from './pdfjs'
import type {
  Anchor,
  Insets,
  Layout,
  PageSize,
  Point,
  StageTransform,
} from './layout'
import type { PendingMark } from './pendingMarks'
import type { ReadingPosition } from './readingPosition'
import type { PageRect } from './textSearch'
import type { MarkupPoint, MarkupStroke } from './types'

/**
 * The pages: one continuous vertical scroll, pinch and double-tap to zoom,
 * as Quick Look does it.
 *
 * Scrolling is the browser's own — one finger, momentum, the rubber band —
 * because nothing written in JavaScript feels as right on an iPhone as the
 * real thing (`touch-action: pan-x pan-y`). Zoom is ours: iOS ignores
 * `user-scalable=no`, so two fingers would otherwise zoom the whole app, bars
 * and all. The one exception is an app that is already zoomed when the viewer
 * opens (`pageIsZoomed`): its pinches stay the browser's until it is back at
 * 1x, or it could never be zoomed back out.
 *
 * A zoom never re-lays-out the page list while fingers are moving. During a
 * pinch the stack of pages is scaled with a CSS transform around the fingers'
 * midpoint (which may move — that is a pan), which costs the compositor a
 * matrix per frame. When the fingers lift, the zoom is committed: the pages
 * are laid out at the new size and the scroll set so the words that were under
 * the fingers are still under them, and the transform is dropped in the same
 * frame (a layout effect, before paint) so nothing jumps. A release outside
 * 1x–5x first animates back into range, to exactly where the commit will
 * land (`transformFor`).
 *
 * Canvases are the renderer's business (`pageRenderer.ts`); this component
 * tells it which pages are near the screen, how big they are, and — once a
 * scroll or zoom has been still for 150 ms — which parts need a sharp detail
 * layer.
 *
 * Each page slot is laid out in page-relative fractions inside, so anything
 * drawn over a page — the search highlights, a report's marks — is a child of
 * the slot positioned in percentages and follows every zoom for free.
 *
 * In markup mode one finger draws instead of scrolling (`useMarkupInput`),
 * and two fingers are the only way to move: the pinch below is then also the
 * pan, and one that barely changed the fingers' spread keeps its zoom
 * (`PAN_ONLY_STRETCH`).
 */

export type Highlight = { rect: PageRect; current: boolean }

export type ScrollKey =
  'up' | 'down' | 'left' | 'right' | 'pageUp' | 'pageDown' | 'home' | 'end'

export type ScrollerHandle = {
  /** Shows page `index` (0-based) from its top. */
  scrollToPage: (index: number) => void
  /**
   * Scrolls just enough to show `rect` on page `index` between the bars,
   * centring it if it is off screen. Anything else covering the bottom of the
   * screen — the software keyboard — must already be in `insets.bottom`, so
   * that the scroll can reach far enough to clear it (`revealScroll`).
   */
  revealRect: (index: number, rect: PageRect) => void
  /** Zooms around the middle of the screen, animated. */
  zoomBy: (factor: number) => void
  zoomTo: (zoom: number) => void
  scrollByKey: (key: ScrollKey) => void
}

type Props = {
  doc: PDFDocumentProxy
  /** Every page's size; estimates until the real ones arrive. */
  sizes: PageSize[]
  /** The bars' heights: pages start below the top one and end above the
      bottom one, and scroll beneath both. The bottom one includes the
      software keyboard while it is up under the search bar. */
  insets: Insets
  /** Where to open, once, if anywhere. */
  initial: ReadingPosition | null
  highlights: ReadonlyMap<number, Highlight[]>
  onTap: () => void
  onPageChange: (index: number) => void
  onScrollActivity: () => void
  onPosition: (position: ReadingPosition) => void
  handleRef: Ref<ScrollerHandle>
  /** While something covers the pages (the page grid). */
  inert?: boolean
  /**
   * The marks over the pages, by 0-based page. The slots are memoised on
   * this Map: a new one only when the marks change. Absent: no markup layer.
   */
  markStrokes?: ReadonlyMap<number, ReadonlyArray<MarkupStroke>>
  /** Drawn strokes still saving, by page, drawn as the viewer's own. */
  pendingMarks?: ReadonlyMap<number, ReadonlyArray<PendingMark>>
  /** Markup mode: one finger draws. */
  marking?: boolean
  /** A stroke finished on page `index`; see `useMarkupInput`. */
  onStroke?: (index: number, points: Array<MarkupPoint>) => void
}

const noStroke = () => {}

/** Double-tap target, from fit width. */
const DOUBLE_TAP_ZOOM = 2.5
/** How long a double-tap or a snap back into range takes. */
const ZOOM_MS = 200
/**
 * A finger down again within this long of a tap, near it, is a double-tap —
 * and how long a single tap waits before it toggles the bars, so the first
 * half of a double-tap never does.
 */
const DOUBLE_TAP_MS = 250
/** Detail canvases wait for the view to be still this long. */
const SETTLE_MS = 150

type Pinch = {
  kind: 'pinch'
  layout: Layout
  zoom: number
  /** The transform when the fingers landed (identity unless interrupted). */
  start: StageTransform
  /** The content point under the fingers' first midpoint. */
  p0: Point
  dist0: number
  lastMid: Point
  /** The furthest the fingers' spread has strayed from `dist0`, as a fraction. */
  stretch: number
}

/** Desktop Safari's trackpad pinch, which arrives as GestureEvents. */
type TrackpadPinch = {
  kind: 'trackpad'
  layout: Layout
  zoom: number
  start: StageTransform
  p0: Point
  q: Point
}

type WheelZoom = {
  kind: 'wheel'
  layout: Layout
  zoom: number
  q: Point
  timer: number
}

type Animation = { kind: 'animation'; finish: () => void }

type Gesture = Pinch | TrackpadPinch | WheelZoom | Animation

/** Safari's non-standard GestureEvent, which TypeScript's DOM types omit. */
type SafariGestureEvent = Event & {
  scale: number
  clientX: number
  clientY: number
}

/** Fingers can take the zoom a little past either end, against resistance. */
function rubberBand(zoom: number): number {
  if (zoom > MAX_ZOOM) return MAX_ZOOM * Math.pow(zoom / MAX_ZOOM, 0.35)
  if (zoom < MIN_ZOOM) return MIN_ZOOM * Math.pow(zoom / MIN_ZOOM, 0.35)
  return zoom
}

function isTouchDevice(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
  } catch {
    return false
  }
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function devicePixelRatio(): number {
  try {
    return Math.max(1, window.devicePixelRatio || 1)
  } catch {
    return 1
  }
}

function transformCss(t: StageTransform): string {
  return t.s === 1 && t.tx === 0 && t.ty === 0
    ? ''
    : `translate3d(${t.tx}px, ${t.ty}px, 0) scale(${t.s})`
}

const pct = (n: number) => `${n * 100}%`

/**
 * Remembers where the scroll was just set, and when, so the `scroll` event
 * that follows is known for this component's own (`isOwnScroll`). Read back
 * rather than taken from the target: the browser clamps a scroll past the
 * end, and the event reports where it actually went.
 */
function noteOwnScroll(
  el: HTMLElement,
  own: RefObject<OwnScroll | null>,
): void {
  own.current = { x: el.scrollLeft, y: el.scrollTop, at: performance.now() }
}

export const PageScroller = memo(function PageScroller({
  doc,
  sizes,
  insets,
  initial,
  highlights,
  onTap,
  onPageChange,
  onScrollActivity,
  onPosition,
  handleRef,
  inert,
  markStrokes,
  pendingMarks,
  marking = false,
  onStroke = noStroke,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<{
    width: number
    height: number
  } | null>(null)
  const [zoom, setZoom] = useState(() => clampZoom(initial?.zoom ?? 1))
  const [near, setNear] = useState<[number, number]>([0, 0])

  const layout = useMemo(
    () =>
      viewport
        ? computeLayout(sizes, viewport, {
            top: insets.top,
            bottom: insets.bottom,
          })
        : null,
    [sizes, viewport, insets.top, insets.bottom],
  )
  const size = layout ? contentSize(layout, zoom) : null

  // What the native event handlers read. Updated before any other layout
  // effect, so a commit's own layout effect already sees the new zoom.
  const live = useRef({ layout, zoom, sizes, marking })
  const callbacks = useRef({
    onTap,
    onPageChange,
    onScrollActivity,
    onPosition,
  })
  useLayoutEffect(() => {
    live.current = { layout, zoom, sizes, marking }
    callbacks.current = { onTap, onPageChange, onScrollActivity, onPosition }
  })

  const [limits] = useState(() => canvasLimits(isTouchDevice()))
  // The browser may pinch here only while the app itself is zoomed.
  const appZoomed = usePageZoomed()
  const rendererRef = useRef<PageRenderer | null>(null)
  const anchorRef = useRef<Anchor>(
    initial
      ? { page: initial.page - 1, fy: initial.fraction, fx: 0 }
      : { page: 0, fy: 0, fx: 0 },
  )
  /** An exact scroll for the next layout, set by a zoom commit. */
  const pendingRef = useRef<Point | null>(null)
  const transformRef = useRef<StageTransform>(IDENTITY)
  const gestureRef = useRef<Gesture | null>(null)
  const pageRef = useRef(-1)
  const detailTimer = useRef(0)
  /** The zoom the renderer last heard about. */
  const syncedZoomRef = useRef<number | null>(null)
  /** Where this component last put the scroll itself: see `isOwnScroll`. */
  const ownScrollRef = useRef<OwnScroll | null>(null)

  const applyTransform = useCallback((t: StageTransform) => {
    transformRef.current = t
    const stage = stageRef.current
    if (stage) stage.style.transform = transformCss(t)
  }, [])

  const clearTransform = useCallback(() => {
    const stage = stageRef.current
    if (stage) {
      stage.style.transition = ''
      stage.style.willChange = ''
    }
    applyTransform(IDENTITY)
  }, [applyTransform])

  /**
   * Brings everything that follows the scroll position up to date: the
   * remembered place, the current page, which pages hold canvases, and —
   * after a pause — the detail layer.
   */
  const sync = useCallback(() => {
    const el = scrollerRef.current
    const { layout: at, zoom: z, sizes: pages } = live.current
    if (!el || !at || gestureRef.current) return
    const scroll = { x: el.scrollLeft, y: el.scrollTop }
    const anchor = anchorAt(at, z, scroll)
    anchorRef.current = anchor

    const page = currentPageAt(at, z, scroll)
    if (page !== pageRef.current) {
      pageRef.current = page
      callbacks.current.onPageChange(page)
    }

    // A detail render still drawing for the zoom before is drawing at the
    // wrong scale; stop it now rather than let it finish and be replaced.
    if (z !== syncedZoomRef.current) {
      syncedZoomRef.current = z
      rendererRef.current?.cancelDetailRenders()
    }

    // Canvases for everything within a screen of the screen.
    const [first, last] = pagesNear(at, z, scroll, at.viewportHeight)
    const keep = []
    for (let index = first; index <= last; index++) {
      const box = pageBox(at, z, index)
      const top = box.y - scroll.y
      const bottom = top + box.height
      const distance =
        bottom < 0
          ? -bottom
          : top > at.viewportHeight
            ? top - at.viewportHeight
            : 0
      keep.push({ index, cssWidth: box.width, distance })
    }
    rendererRef.current?.update(keep, pages, devicePixelRatio())
    setNear((prev) =>
      prev[0] === first && prev[1] === last ? prev : [first, last],
    )

    window.clearTimeout(detailTimer.current)
    detailTimer.current = window.setTimeout(() => {
      const now = scrollerRef.current
      const { layout: l, zoom: zz, sizes: s } = live.current
      if (!now || !l || gestureRef.current) return
      rendererRef.current?.updateDetail(
        planDetail(
          l,
          zz,
          { x: now.scrollLeft, y: now.scrollTop },
          s,
          devicePixelRatio(),
          limits,
        ),
      )
    }, SETTLE_MS)

    callbacks.current.onPosition({
      page: anchor.page + 1,
      fraction: Math.min(1, Math.max(0, anchor.fy)),
      zoom: z,
    })
  }, [limits])

  /**
   * Ends a gesture at `next`: re-layout at its zoom, scroll, no transform.
   * `from` is the layout `next` was worked out in — the one the gesture
   * started with.
   */
  const commit = useCallback(
    (next: { zoom: number; scroll: Point }, from: Layout) => {
      gestureRef.current = null
      // The layout can change under a gesture — page 7's real size arriving,
      // the phone turning — while the layout effect below waits for the
      // gesture to end. A scroll worked out in the old layout is then carried
      // across as a place in a page rather than as a pixel.
      const at = live.current.layout
      const scroll =
        at && at !== from
          ? scrollForAnchor(
              at,
              next.zoom,
              anchorAt(from, next.zoom, next.scroll),
            )
          : next.scroll
      if (next.zoom !== live.current.zoom) {
        pendingRef.current = scroll
        // Synchronously, so the layout effect drops the transform and sets
        // the scroll before the browser paints either half.
        flushSync(() => setZoom(next.zoom))
        return
      }
      const el = scrollerRef.current
      if (el) {
        el.scrollLeft = scroll.x
        el.scrollTop = scroll.y
        noteOwnScroll(el, ownScrollRef)
      }
      clearTransform()
      sync()
    },
    [clearTransform, sync],
  )

  /** Animates the stage to `target`, then runs `then` (a commit). */
  const animateTo = useCallback(
    (target: StageTransform, then: () => void) => {
      const stage = stageRef.current
      const from = transformRef.current
      const still =
        Math.abs(from.s - target.s) < 1e-3 &&
        Math.abs(from.tx - target.tx) < 0.5 &&
        Math.abs(from.ty - target.ty) < 0.5
      if (!stage || still || reducedMotion()) {
        then()
        return
      }
      let done = false
      let timer = 0
      const finish = () => {
        if (done) return
        done = true
        stage.removeEventListener('transitionend', onEnd)
        window.clearTimeout(timer)
        stage.style.transition = ''
        then()
      }
      const onEnd = (event: TransitionEvent) => {
        if (event.target === stage) finish()
      }
      gestureRef.current = { kind: 'animation', finish }
      stage.style.willChange = 'transform'
      stage.style.transition = `transform ${ZOOM_MS}ms cubic-bezier(0.25, 0.8, 0.25, 1)`
      applyTransform(target)
      stage.addEventListener('transitionend', onEnd)
      // transitionend never comes if nothing actually changed on screen.
      timer = window.setTimeout(finish, ZOOM_MS + 80)
    },
    [applyTransform],
  )

  /** Finishes an animation or a wheel zoom now, so a new gesture can start. */
  const settleNow = useCallback(() => {
    const g = gestureRef.current
    if (g?.kind === 'animation') g.finish()
    else if (g?.kind === 'wheel') {
      window.clearTimeout(g.timer)
      const el = scrollerRef.current
      if (!el) return
      commit(
        settleTransform(
          g.layout,
          g.zoom,
          transformRef.current,
          { x: el.scrollLeft, y: el.scrollTop },
          g.q,
        ),
        g.layout,
      )
    }
  }, [commit])

  /** Zooms to `target` keeping screen point `q` still, animated. */
  const zoomToward = useCallback(
    (target: number, q: Point) => {
      settleNow()
      const el = scrollerRef.current
      const { layout: at, zoom: z } = live.current
      if (!el || !at || gestureRef.current) return
      const scroll = { x: el.scrollLeft, y: el.scrollTop }
      const next = zoomAbout(
        at,
        z,
        contentPointUnder(IDENTITY, scroll, q),
        q,
        target,
      )
      animateTo(transformFor(at, z, scroll, next.zoom, next.scroll), () =>
        commit(next, at),
      )
    },
    [animateTo, commit, settleNow],
  )

  // The renderer lives as long as the document. A layout effect, declared
  // before the one below, so the very first sync already has it.
  useLayoutEffect(() => {
    const renderer = new PageRenderer(
      doc,
      (index) => {
        const slot = stageRef.current?.querySelector<HTMLElement>(
          `[data-page-index="${index}"]`,
        )
        const base = slot?.querySelector<HTMLElement>('[data-layer="base"]')
        const detail = slot?.querySelector<HTMLElement>('[data-layer="detail"]')
        return base && detail ? { base, detail } : null
      },
      limits,
    )
    rendererRef.current = renderer
    return () => {
      renderer.destroy()
      rendererRef.current = null
    }
  }, [doc, limits])

  // The size of the screen, now and whenever it changes (rotation, split
  // view, a desktop window resized).
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const measure = () => {
      const width = el.clientWidth
      const height = el.clientHeight
      if (width === 0 || height === 0) return
      setViewport((prev) =>
        prev && prev.width === width && prev.height === height
          ? prev
          : { width, height },
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Every new layout or zoom: put the view where it belongs — the exact
  // scroll a zoom asked for, or else the same place in the same page (after
  // a rotation, or once page 7's real size replaces the estimate) — and drop
  // any gesture transform, all before paint.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el || !layout || gestureRef.current) return
    const target =
      pendingRef.current ?? scrollForAnchor(layout, zoom, anchorRef.current)
    pendingRef.current = null
    // Only when it moves: writing scrollTop stops a momentum scroll dead.
    const moveX = Math.abs(el.scrollLeft - target.x) > 0.5
    const moveY = Math.abs(el.scrollTop - target.y) > 0.5
    if (moveX) el.scrollLeft = target.x
    if (moveY) el.scrollTop = target.y
    if (moveX || moveY) noteOwnScroll(el, ownScrollRef)
    clearTransform()
    sync()
  }, [layout, zoom, clearTransform, sync])

  // Scroll, touch, wheel and tap handling, as native listeners: React's are
  // passive for touch and wheel, and both need to be able to preventDefault.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let frame = 0
    let lastScrollAt = 0
    let lastPinchEndAt = 0
    let touches = 0
    let tap: {
      id: number
      x: number
      y: number
      at: number
      momentum: boolean
      /** The second press of a double-tap. */
      second: boolean
    } | null = null
    let lastTap: { q: Point; at: number } | null = null
    let singleTapTimer = 0
    // The app itself zoomed, as the touch or the gesture started: see
    // `pageIsZoomed`. Pinches are then the browser's.
    let touchZoomed = false
    let gestureZoomed = false

    const local = (clientX: number, clientY: number): Point => {
      const rect = el.getBoundingClientRect()
      return { x: clientX - rect.left, y: clientY - rect.top }
    }
    const scroll = (): Point => ({ x: el.scrollLeft, y: el.scrollTop })

    const onScroll = () => {
      // Only the browser's own scrolling can be momentum a touch then stops;
      // a zoom just committed is not (`scrolledAt`).
      lastScrollAt = scrolledAt(
        lastScrollAt,
        ownScrollRef.current,
        scroll(),
        performance.now(),
      )
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        sync()
        callbacks.current.onScrollActivity()
      })
    }

    const onTouchStart = (event: TouchEvent) => {
      touches = event.touches.length
      touchZoomed = pageIsZoomed()
      if (event.touches.length !== 2 || touchZoomed) return
      const [a, b] = [event.touches[0], event.touches[1]]
      // A pencil and the hand resting beside it are not a pinch: the pen is
      // drawing (`markupInput.ts` lets that stroke go on).
      if (isStylus(a) || isStylus(b)) return
      settleNow()
      const { layout: at, zoom: z } = live.current
      if (!at || gestureRef.current) return
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      if (dist < 1) return
      const mid = local(
        (a.clientX + b.clientX) / 2,
        (a.clientY + b.clientY) / 2,
      )
      tap = null
      if (stageRef.current) stageRef.current.style.willChange = 'transform'
      gestureRef.current = {
        kind: 'pinch',
        layout: at,
        zoom: z,
        start: transformRef.current,
        p0: contentPointUnder(transformRef.current, scroll(), mid),
        dist0: dist,
        lastMid: mid,
        stretch: 0,
      }
    }

    const onTouchMove = (event: TouchEvent) => {
      // Two fingers never scroll or zoom the page natively, anywhere here —
      // unless the app is zoomed already, and this pinch is to undo that.
      if (event.touches.length >= 2 && event.cancelable && !touchZoomed) {
        event.preventDefault()
      }
      const g = gestureRef.current
      if (g?.kind !== 'pinch' || event.touches.length < 2) return
      const [a, b] = [event.touches[0], event.touches[1]]
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      const mid = local(
        (a.clientX + b.clientX) / 2,
        (a.clientY + b.clientY) / 2,
      )
      const shown = rubberBand(g.zoom * g.start.s * (dist / g.dist0))
      const s = shown / g.zoom
      // Whatever was under the first midpoint is under the current one:
      // spreading zooms, moving both fingers pans.
      applyTransform(pinchTransform(g.p0, mid, scroll(), s))
      g.lastMid = mid
      g.stretch = Math.max(g.stretch, Math.abs(dist / g.dist0 - 1))
    }

    const onTouchEnd = (event: TouchEvent) => {
      touches = event.touches.length
      const g = gestureRef.current
      if (g?.kind !== 'pinch' || event.touches.length >= 2) return
      lastPinchEndAt = performance.now()
      const now = scroll()
      // In markup mode, two fingers that kept their spread were panning: the
      // same pan, at the scale the gesture started with.
      const panned =
        live.current.marking && g.stretch <= PAN_ONLY_STRETCH
          ? pinchTransform(g.p0, g.lastMid, now, g.start.s)
          : transformRef.current
      const next = settleTransform(g.layout, g.zoom, panned, now, g.lastMid)
      gestureRef.current = null
      animateTo(
        transformFor(g.layout, g.zoom, now, next.zoom, next.scroll),
        () => commit(next, g.layout),
      )
    }

    // Desktop Safari: a trackpad pinch is a GestureEvent, not a ctrl-wheel.
    // On iOS the same events accompany the touches handled above, so they
    // are only prevented there (or Safari zooms the whole app).
    const onGestureStart = (event: Event) => {
      gestureZoomed = pageIsZoomed()
      if (gestureZoomed) return
      event.preventDefault()
      const e = event as SafariGestureEvent
      if (touches > 0) return
      settleNow()
      const { layout: at, zoom: z } = live.current
      if (!at || gestureRef.current) return
      const q = local(e.clientX, e.clientY)
      gestureRef.current = {
        kind: 'trackpad',
        layout: at,
        zoom: z,
        start: transformRef.current,
        p0: contentPointUnder(transformRef.current, scroll(), q),
        q,
      }
    }
    const onGestureChange = (event: Event) => {
      if (gestureZoomed) return
      event.preventDefault()
      const g = gestureRef.current
      if (g?.kind !== 'trackpad') return
      const e = event as SafariGestureEvent
      const s = clampZoom(g.zoom * g.start.s * e.scale) / g.zoom
      const now = scroll()
      applyTransform({
        s,
        tx: g.q.x + now.x - s * g.p0.x,
        ty: g.q.y + now.y - s * g.p0.y,
      })
    }
    const onGestureEnd = (event: Event) => {
      if (gestureZoomed) return
      event.preventDefault()
      const g = gestureRef.current
      if (g?.kind !== 'trackpad') return
      const now = scroll()
      const next = settleTransform(
        g.layout,
        g.zoom,
        transformRef.current,
        now,
        g.q,
      )
      gestureRef.current = null
      animateTo(
        transformFor(g.layout, g.zoom, now, next.zoom, next.scroll),
        () => commit(next, g.layout),
      )
    }

    // Ctrl/cmd + wheel, which is also how Chrome and Firefox deliver a
    // trackpad pinch: zoom around the pointer.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      // Chrome's trackpad pinch-zoom of the whole app, being undone.
      if (gestureRef.current?.kind !== 'wheel' && pageIsZoomed()) return
      event.preventDefault()
      let g = gestureRef.current
      if (g?.kind === 'animation') {
        g.finish()
        g = null
      }
      if (g && g.kind !== 'wheel') return
      const { layout: at, zoom: z } = live.current
      if (!at) return
      const q = local(event.clientX, event.clientY)
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? at.viewportHeight
            : 1
      const dy = Math.max(-30, Math.min(30, event.deltaY * unit))
      const baseZoom = g?.zoom ?? z
      const current = transformRef.current
      const wanted = clampZoom(baseZoom * current.s * Math.exp(-dy / 120))
      if (stageRef.current) stageRef.current.style.willChange = 'transform'
      applyTransform(
        zoomTransformAround(
          current,
          scroll(),
          q,
          wanted / (baseZoom * current.s),
        ),
      )
      if (g) window.clearTimeout(g.timer)
      const wheel: WheelZoom = {
        kind: 'wheel',
        layout: g?.layout ?? at,
        zoom: baseZoom,
        q,
        timer: 0,
      }
      wheel.timer = window.setTimeout(() => {
        if (gestureRef.current !== wheel) return
        const now = scroll()
        const next = settleTransform(
          wheel.layout,
          wheel.zoom,
          transformRef.current,
          now,
          wheel.q,
        )
        gestureRef.current = null
        animateTo(
          transformFor(wheel.layout, wheel.zoom, now, next.zoom, next.scroll),
          () => commit(next, wheel.layout),
        )
      }, SETTLE_MS)
      gestureRef.current = wheel
    }

    // Taps. One toggles the bars — after a pause, so the first half of a
    // double-tap does not — and two zoom.
    const onPointerDown = (event: PointerEvent) => {
      if (
        !event.isPrimary ||
        (event.pointerType === 'mouse' && event.button !== 0)
      ) {
        tap = null
        return
      }
      // A press on a desktop scrollbar is not a tap on the page.
      if (
        event.target === el &&
        (event.offsetX >= el.clientWidth || event.offsetY >= el.clientHeight)
      ) {
        tap = null
        return
      }
      const now = performance.now()
      const q = local(event.clientX, event.clientY)
      // A finger coming down again soon after a tap, near it, starts a
      // double-tap: the first tap's bar toggle is called off now, on the way
      // down, however long this press then takes to lift.
      const second =
        lastTap !== null &&
        now - lastTap.at < DOUBLE_TAP_MS &&
        Math.hypot(q.x - lastTap.q.x, q.y - lastTap.q.y) < 40
      if (second) window.clearTimeout(singleTapTimer)
      tap = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: now,
        // A touch that stops a fling is not a tap, as on iOS.
        momentum: now - lastScrollAt < 100,
        second,
      }
    }
    const onPointerMove = (event: PointerEvent) => {
      if (
        tap &&
        event.pointerId === tap.id &&
        Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10
      ) {
        tap = null
      }
    }
    const onPointerUp = (event: PointerEvent) => {
      const t = tap
      tap = null
      if (!t || event.pointerId !== t.id) return
      if (t.second) lastTap = null
      if (t.momentum) return
      const now = performance.now()
      if (now - t.at > 500) return
      if (Math.hypot(event.clientX - t.x, event.clientY - t.y) > 10) return
      if (now - lastPinchEndAt < 350 || gestureRef.current) return
      const q = local(event.clientX, event.clientY)
      if (t.second) {
        // 1x to 2.5x around the tap; anything else back to fit width.
        const z = live.current.zoom
        zoomToward(z > MIN_ZOOM + 0.01 ? MIN_ZOOM : DOUBLE_TAP_ZOOM, q)
        return
      }
      lastTap = { q, at: now }
      window.clearTimeout(singleTapTimer)
      singleTapTimer = window.setTimeout(() => {
        lastTap = null
        callbacks.current.onTap()
      }, DOUBLE_TAP_MS)
    }
    const onPointerCancel = () => {
      tap = null
    }

    const active = { passive: false } as const
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, active)
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    el.addEventListener('gesturestart', onGestureStart, active)
    el.addEventListener('gesturechange', onGestureChange, active)
    el.addEventListener('gestureend', onGestureEnd, active)
    el.addEventListener('wheel', onWheel, active)
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerCancel)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('gesturestart', onGestureStart)
      el.removeEventListener('gesturechange', onGestureChange)
      el.removeEventListener('gestureend', onGestureEnd)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerCancel)
      cancelAnimationFrame(frame)
      window.clearTimeout(singleTapTimer)
    }
  }, [animateTo, applyTransform, commit, settleNow, sync, zoomToward])

  // Nothing left running once the viewer closes.
  useEffect(
    () => () => {
      window.clearTimeout(detailTimer.current)
      const g = gestureRef.current
      if (g?.kind === 'wheel') window.clearTimeout(g.timer)
      gestureRef.current = null
    },
    [],
  )

  useImperativeHandle(handleRef, () => {
    const readable = () => {
      const { layout: at } = live.current
      if (!at) return null
      return {
        x: at.viewportWidth / 2,
        y:
          at.insets.top +
          (at.viewportHeight - at.insets.top - at.insets.bottom) / 2,
      }
    }
    return {
      scrollToPage(index) {
        settleNow()
        const el = scrollerRef.current
        const { layout: at, zoom: z } = live.current
        if (!el || !at || gestureRef.current) return
        const target = scrollForAnchor(at, z, {
          page: index,
          fy: 0,
          fx: anchorRef.current.fx,
        })
        el.scrollTo(target.x, target.y)
        noteOwnScroll(el, ownScrollRef)
        sync()
      },
      revealRect(index, rect) {
        settleNow()
        const el = scrollerRef.current
        const { layout: at, zoom: z } = live.current
        if (!el || !at || gestureRef.current || index >= at.tops.length) return
        const target = revealScroll(at, z, index, rect, {
          x: el.scrollLeft,
          y: el.scrollTop,
        })
        el.scrollTo(target.x, target.y)
        noteOwnScroll(el, ownScrollRef)
        sync()
      },
      zoomBy(factor) {
        const q = readable()
        if (q) zoomToward(clampZoom(live.current.zoom * factor), q)
      },
      zoomTo(next) {
        const q = readable()
        if (q) zoomToward(clampZoom(next), q)
      },
      scrollByKey(key) {
        const el = scrollerRef.current
        const { layout: at } = live.current
        if (!el || !at) return
        const line = 48
        const screen = Math.max(
          line,
          at.viewportHeight - at.insets.top - at.insets.bottom - line,
        )
        const moves: Record<ScrollKey, [number, number]> = {
          up: [0, -line],
          down: [0, line],
          left: [-line, 0],
          right: [line, 0],
          pageUp: [0, -screen],
          pageDown: [0, screen],
          home: [0, -el.scrollHeight],
          end: [0, el.scrollHeight],
        }
        const [dx, dy] = moves[key]
        el.scrollBy(dx, dy)
      },
    }
  }, [settleNow, sync, zoomToward])

  useMarkupInput({
    stageRef,
    scrollerRef,
    ownScrollRef,
    enabled: marking,
    onStroke,
  })

  const n = layout?.tops.length ?? 0
  const slots = useMemo(() => {
    if (!layout) return null
    return layout.tops.map((_, index) => {
      const box = pageBox(layout, zoom, index)
      // Only pages near the screen carry anything drawn over them: a finger
      // can only land on one of those, and a long report's marks on page 40
      // are DOM nobody is looking at.
      const isNear = index >= near[0] && index <= near[1]
      const marks = isNear ? highlights.get(index) : undefined
      return (
        <div
          key={index}
          data-page-index={index}
          role="img"
          aria-label={`Page ${index + 1} of ${n}`}
          className="absolute bg-paper shadow-paper"
          style={{
            left: box.x,
            top: box.y,
            width: box.width,
            height: box.height,
          }}
        >
          {/* Filled by the renderer, never by React. */}
          <div data-layer="base" className="absolute inset-0 overflow-hidden" />
          <div
            data-layer="detail"
            className="absolute inset-0 overflow-hidden"
          />
          {marks && marks.length > 0 && (
            <div className="pointer-events-none absolute inset-0">
              {marks.map((mark, k) => (
                <div
                  key={k}
                  data-search-hit={mark.current ? 'current' : 'match'}
                  className={
                    mark.current
                      ? 'absolute rounded-[2px] bg-search-hit-current mix-blend-multiply'
                      : 'absolute rounded-[2px] bg-search-hit mix-blend-multiply'
                  }
                  style={{
                    left: pct(mark.rect.x),
                    top: pct(mark.rect.y),
                    width: pct(mark.rect.w),
                    height: pct(mark.rect.h),
                  }}
                />
              ))}
            </div>
          )}
          {markStrokes && isNear && (
            <PageMarkup
              index={index}
              strokes={markStrokes.get(index)}
              pending={pendingMarks?.get(index)}
              marking={marking}
            />
          )}
        </div>
      )
    })
  }, [layout, zoom, near, highlights, n, markStrokes, pendingMarks, marking])

  return (
    <div
      ref={scrollerRef}
      inert={inert}
      // One-finger drags here are the browser's to scroll: the viewer's body
      // lock (`useBodyLock`) cancels them everywhere else.
      data-viewer-scroll
      data-zoom={Math.round(zoom * 100) / 100}
      className={`absolute inset-y-0 left-[env(safe-area-inset-left)] right-[env(safe-area-inset-right)] overflow-y-auto overscroll-contain outline-none select-none [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none] ${appZoomed ? '[touch-action:manipulation]' : '[touch-action:pan-x_pan-y]'}`}
      // Sideways only when there is something to the side: at fit width a
      // diagonal swipe should not wobble the page left and right.
      style={{ overflowX: zoom > MIN_ZOOM ? 'auto' : 'hidden' }}
    >
      <div
        className="relative"
        style={size ? { width: size.width, height: size.height } : undefined}
      >
        {/* The stage is what a gesture transforms. The box around it keeps
            its un-transformed size, so pinching out below the current zoom
            never shrinks the scroll range under the fingers and makes the
            browser clamp the scroll mid-gesture. */}
        <div
          ref={stageRef}
          className="absolute left-0 top-0 origin-top-left"
          style={size ? { width: size.width, height: size.height } : undefined}
        >
          {slots}
        </div>
      </div>
    </div>
  )
})
