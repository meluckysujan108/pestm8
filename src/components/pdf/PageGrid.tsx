import { useEffect, useLayoutEffect, useRef } from 'react'
import { releaseCanvas } from './pageRenderer'
import type { PDFDocumentProxy, RenderTask } from './pdfjs'
import type { Insets, PageSize } from './layout'

/**
 * Every page at a glance, to jump to one — the thumbnail grid Quick Look and
 * Files show. Three across on a phone, more on anything wider.
 *
 * A thumbnail is drawn only when it scrolls near the screen (an
 * IntersectionObserver) and released when it scrolls well away, so a
 * 200-page manual costs a screenful of small canvases rather than 200 of
 * them; and every one is released when the grid closes.
 */
export function PageGrid({
  doc,
  sizes,
  current,
  insets,
  onPick,
}: {
  doc: PDFDocumentProxy
  sizes: PageSize[]
  /** 0-based. */
  current: number
  insets: Insets
  onPick: (index: number) => void
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)

  // Open on the page being read, not on page 1.
  useLayoutEffect(() => {
    scrollerRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'center' })
    // Only when the grid opens; tapping a page closes it.
  }, [])

  useEffect(() => {
    const root = scrollerRef.current
    if (!root) return
    return drawThumbnails(doc, root)
  }, [doc])

  return (
    <div
      ref={scrollerRef}
      data-viewer-scroll
      className="absolute inset-0 overflow-y-auto overscroll-contain bg-viewer-backdrop [touch-action:pan-y]"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <ul
        aria-label="Pages"
        className="mx-auto grid max-w-5xl grid-cols-3 gap-x-4 gap-y-5 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6"
      >
        {sizes.map((size, index) => {
          const isCurrent = index === current
          return (
            <li key={index}>
              <button
                type="button"
                aria-label={`Page ${index + 1}`}
                aria-current={isCurrent ? 'page' : undefined}
                onClick={() => onPick(index)}
                className="flex w-full flex-col items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-blue"
              >
                <span
                  data-thumb={index}
                  className={[
                    'relative block w-full overflow-hidden bg-paper shadow-paper',
                    isCurrent
                      ? 'ring-[3px] ring-blue ring-offset-2 ring-offset-viewer-backdrop'
                      : '',
                  ].join(' ')}
                  style={{ aspectRatio: `${size.width} / ${size.height}` }}
                />
                <span
                  className={
                    isCurrent
                      ? 'rounded-full bg-blue px-2 text-caption font-semibold text-on-tint'
                      : 'px-2 text-caption text-muted'
                  }
                >
                  {index + 1}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

type Thumb = {
  index: number
  el: HTMLElement
  wanted: boolean
  queued: boolean
  /** Bumped whenever a draw in flight stops being wanted. */
  generation: number
  canvas: HTMLCanvasElement | null
  task: RenderTask | null
}

/**
 * Draws thumbnails into every `[data-thumb]` under `root` as they come near
 * the screen, two at a time. Returns the cleanup, which frees them all.
 */
function drawThumbnails(doc: PDFDocumentProxy, root: HTMLElement): () => void {
  const thumbs = new Map<Element, Thumb>()
  const queue: Thumb[] = []
  let running = 0
  let destroyed = false
  // 2x is plenty for a thumbnail, and a third less memory than 3x.
  let dpr = 1
  try {
    dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  } catch {
    // Keep 1x.
  }

  const draw = async (thumb: Thumb) => {
    const generation = thumb.generation
    const stale = () => destroyed || thumb.generation !== generation
    let canvas: HTMLCanvasElement | null = null
    try {
      const page = await doc.getPage(thumb.index + 1)
      if (stale()) return
      const width = Math.max(1, thumb.el.clientWidth)
      const scale = (width * dpr) / page.getViewport({ scale: 1 }).width
      const viewport = page.getViewport({ scale })
      canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      const task = page.render({ canvas, viewport })
      thumb.task = task
      await task.promise
      if (stale()) return
      canvas.setAttribute('aria-hidden', 'true')
      canvas.style.cssText =
        'position:absolute;left:0;top:0;width:100%;height:100%;display:block'
      thumb.el.appendChild(canvas)
      thumb.canvas = canvas
      canvas = null
    } catch {
      // Cancelled, or a page that will not draw: the white sheet stays.
    } finally {
      if (canvas) releaseCanvas(canvas)
      if (thumb.generation === generation) thumb.task = null
    }
  }

  const pump = () => {
    while (running < 2 && queue.length > 0 && !destroyed) {
      const thumb = queue.shift()
      if (!thumb) break
      thumb.queued = false
      if (!thumb.wanted || thumb.canvas || thumb.task) continue
      running++
      void draw(thumb).finally(() => {
        running--
        pump()
      })
    }
  }

  const want = (thumb: Thumb) => {
    thumb.wanted = true
    if (thumb.canvas || thumb.task || thumb.queued) return
    thumb.queued = true
    queue.push(thumb)
  }

  const unwant = (thumb: Thumb) => {
    thumb.wanted = false
    thumb.generation++
    thumb.task?.cancel()
    thumb.task = null
    if (thumb.canvas) {
      releaseCanvas(thumb.canvas)
      thumb.canvas = null
    }
  }

  for (const el of root.querySelectorAll<HTMLElement>('[data-thumb]')) {
    thumbs.set(el, {
      index: Number(el.dataset.thumb),
      el,
      wanted: false,
      queued: false,
      generation: 0,
      canvas: null,
      task: null,
    })
  }

  let observer: IntersectionObserver | null = null
  if (typeof IntersectionObserver === 'undefined') {
    for (const thumb of thumbs.values()) want(thumb)
    pump()
  } else {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const thumb = thumbs.get(entry.target)
          if (!thumb) continue
          if (entry.isIntersecting) want(thumb)
          else if (thumb.wanted) unwant(thumb)
        }
        pump()
      },
      // Half a screen ahead in each direction, drawn before it is scrolled to.
      { root, rootMargin: '50% 0px' },
    )
    for (const el of thumbs.keys()) observer.observe(el)
  }

  return () => {
    destroyed = true
    observer?.disconnect()
    queue.length = 0
    for (const thumb of thumbs.values()) unwant(thumb)
  }
}
