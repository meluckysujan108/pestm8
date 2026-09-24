import { isRenderCancelled } from './pdfjs'
import { baseRenderScale, withinBudget } from './layout'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from './pdfjs'
import type { CanvasLimits, DetailPlan, FracRect, PageSize } from './layout'

/**
 * Draws pages onto canvases, and — as much as anything — takes them away.
 *
 * Outside React on purpose. A canvas that took 200 ms to draw must not be
 * thrown away because a component re-rendered, and a scroll must not cost a
 * render of the page list; so React lays out empty page slots and this puts
 * canvases into them, straight into the DOM, and out again.
 *
 * Two layers per page:
 *
 * - The base: the whole page, at the screen's density if the canvas budget
 *   allows (see `canvasLimits`) and capped if not. It is stretched to fill its
 *   slot, so a zoom is instantly right, only blurry until it is redrawn.
 * - The detail: when the base was capped — zoomed in past what one canvas may
 *   hold — a second canvas over just the part of the page on screen, at full
 *   density, drawn once the pinch or scroll has settled.
 *
 * A new canvas is drawn off-screen and swapped in when finished, so a redraw
 * never flashes a blank page. A canvas that leaves is emptied (`width` and
 * `height` to 0) before it is dropped: iOS Safari frees a canvas's memory then
 * and not on garbage collection, and a viewer that leaves it to the collector
 * runs into Safari's total canvas limit — after which every new page is
 * silently white — within a few minutes of scrolling.
 */

/** Two at once: one for the page on screen, one for what comes next. */
const CONCURRENCY = 2

/** Close enough that redrawing would not be noticed. */
function close(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a / b - 1) < tolerance
}

function contains(outer: FracRect, inner: FracRect): boolean {
  const slack = 1e-3
  return (
    outer.x0 <= inner.x0 + slack &&
    outer.y0 <= inner.y0 + slack &&
    outer.x1 >= inner.x1 - slack &&
    outer.y1 >= inner.y1 - slack
  )
}

/** Frees a canvas's backing store, which is the only way iOS lets it go. */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
  canvas.remove()
}

type Drawn = {
  canvas: HTMLCanvasElement
  scale: number
  /** Detail only: the part of the page it covers. */
  region?: FracRect
}

type Job = {
  kind: 'base' | 'detail'
  index: number
  scale: number
  /** Detail only: the region wanted, including its margin… */
  region?: FracRect
  /** …and the part that must be covered for it to be worth keeping. */
  visible?: FracRect
  priority: number
  canvas: HTMLCanvasElement | null
  task: RenderTask | null
  cancelled: boolean
}

type PageState = {
  base: Drawn | null
  detail: Drawn | null
  baseJob: Job | null
  detailJob: Job | null
  /** A scale that failed to draw, so it is not retried on every scroll. */
  failedScale: number | null
}

export type Layers = { base: HTMLElement; detail: HTMLElement }

export type KeepRequest = {
  index: number
  /** How wide the page is drawn right now, in CSS pixels. */
  cssWidth: number
  /** 0 for a page on screen, otherwise how far off it is. */
  distance: number
}

export class PageRenderer {
  private readonly pages = new Map<number, PageState>()
  private readonly proxies = new Map<number, PDFPageProxy>()
  private queue: Job[] = []
  private readonly running = new Set<Job>()
  private destroyed = false

  constructor(
    private readonly doc: PDFDocumentProxy,
    private readonly layers: (index: number) => Layers | null,
    private readonly limits: CanvasLimits,
  ) {}

  /**
   * The pages that should hold a canvas, nearest first, with the size each is
   * drawn at. Everything else is released.
   */
  update(keep: KeepRequest[], sizes: PageSize[], dpr: number): void {
    if (this.destroyed) return
    const wanted = keep
      .filter(({ index }) => index >= 0 && index < sizes.length)
      .map((request) => {
        const size = sizes[request.index]
        const scale = baseRenderScale(size, request.cssWidth, dpr, this.limits)
        return {
          ...request,
          scale,
          pixels: size.width * scale * (size.height * scale),
        }
      })
      .sort((a, b) => a.distance - b.distance)
    const kept = new Set(withinBudget(wanted, this.limits.totalPixels))

    for (const index of [...this.pages.keys()]) {
      if (!kept.has(index)) this.release(index)
    }

    for (const request of wanted) {
      if (!kept.has(request.index)) continue
      const state = this.state(request.index)
      // On screen first, then the detail layer (priority 1), then the rest.
      const priority = request.distance === 0 ? 0 : 2 + request.distance
      const { scale } = request
      if (state.base && close(state.base.scale, scale, 0.15)) {
        if (state.baseJob) this.cancel(state.baseJob)
        continue
      }
      if (state.baseJob && close(state.baseJob.scale, scale, 0.15)) {
        state.baseJob.priority = priority
        continue
      }
      if (state.failedScale !== null && close(state.failedScale, scale, 0.15)) {
        continue
      }
      if (state.baseJob) this.cancel(state.baseJob)
      state.baseJob = this.enqueue({
        kind: 'base',
        index: request.index,
        scale,
        priority,
      })
    }
    this.pump()
  }

  /**
   * The sharp detail canvases wanted now the view has settled. A page not in
   * `plans` loses its detail canvas; one that already covers what is on
   * screen at the right scale is left alone.
   */
  updateDetail(plans: DetailPlan[]): void {
    if (this.destroyed) return
    const wanted = new Map(plans.map((plan) => [plan.index, plan]))
    for (const [index, state] of this.pages) {
      if (wanted.has(index)) continue
      if (state.detailJob) this.cancel(state.detailJob)
      if (state.detail) {
        releaseCanvas(state.detail.canvas)
        state.detail = null
      }
    }
    for (const plan of plans) {
      const state = this.pages.get(plan.index)
      if (!state) continue
      const covers = (drawn: { scale: number; region?: FracRect } | null) =>
        !!drawn?.region &&
        close(drawn.scale, plan.scale, 0.05) &&
        contains(drawn.region, plan.visible)
      if (covers(state.detail)) {
        if (state.detailJob) this.cancel(state.detailJob)
        continue
      }
      if (state.detailJob && covers(state.detailJob)) continue
      if (state.detailJob) this.cancel(state.detailJob)
      state.detailJob = this.enqueue({
        kind: 'detail',
        index: plan.index,
        scale: plan.scale,
        region: plan.region,
        visible: plan.visible,
        priority: 1,
      })
    }
    this.pump()
  }

  /**
   * Stops the detail renders still drawing for a zoom that has just changed:
   * their scale is wrong now, and the plan for the new zoom comes once the
   * view has settled. Detail canvases already placed stay until then —
   * stretched with their page they are blurrier than they were, but still
   * sharper than the base beneath them.
   */
  cancelDetailRenders(): void {
    if (this.destroyed) return
    for (const state of this.pages.values()) {
      if (state.detailJob) this.cancel(state.detailJob)
    }
    this.pump()
  }

  /** Stops every render and frees every canvas. The renderer is done. */
  destroy(): void {
    this.destroyed = true
    for (const index of [...this.pages.keys()]) this.release(index)
    for (const job of this.queue) job.cancelled = true
    this.queue = []
    this.proxies.clear()
  }

  private state(index: number): PageState {
    let state = this.pages.get(index)
    if (!state) {
      state = {
        base: null,
        detail: null,
        baseJob: null,
        detailJob: null,
        failedScale: null,
      }
      this.pages.set(index, state)
    }
    return state
  }

  private release(index: number): void {
    const state = this.pages.get(index)
    if (!state) return
    if (state.baseJob) this.cancel(state.baseJob)
    if (state.detailJob) this.cancel(state.detailJob)
    if (state.base) releaseCanvas(state.base.canvas)
    if (state.detail) releaseCanvas(state.detail.canvas)
    this.pages.delete(index)
    const layers = this.layers(index)
    if (layers) delete layers.base.dataset.rendered
    // Lets pdf.js drop the page's parsed drawing commands and images too.
    // It waits for any render still running (a thumbnail) before it does.
    this.proxies.get(index)?.cleanup()
    this.proxies.delete(index)
  }

  private enqueue(job: Omit<Job, 'canvas' | 'task' | 'cancelled'>): Job {
    const full: Job = { ...job, canvas: null, task: null, cancelled: false }
    this.queue.push(full)
    return full
  }

  private cancel(job: Job): void {
    job.cancelled = true
    // Rejects the render's promise with RenderingCancelledException, which
    // `run` expects and frees the canvas on.
    job.task?.cancel()
    const state = this.pages.get(job.index)
    if (state?.baseJob === job) state.baseJob = null
    if (state?.detailJob === job) state.detailJob = null
  }

  private pump(): void {
    if (this.destroyed) return
    this.queue = this.queue.filter((job) => !job.cancelled)
    this.queue.sort((a, b) => a.priority - b.priority)
    while (this.running.size < CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()
      if (!job) break
      this.running.add(job)
      void this.run(job)
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      const page = await this.doc.getPage(job.index + 1)
      if (this.stale(job)) return
      this.proxies.set(job.index, page)

      const viewport = page.getViewport({ scale: job.scale })
      const canvas = document.createElement('canvas')
      job.canvas = canvas
      let transform: number[] | undefined
      let region: FracRect | undefined

      if (job.kind === 'base') {
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))
      } else if (job.region) {
        // Whole device pixels, so the canvas lines up with the base beneath
        // it rather than sitting half a pixel off.
        const px0 = Math.floor(job.region.x0 * viewport.width)
        const py0 = Math.floor(job.region.y0 * viewport.height)
        const px1 = Math.ceil(job.region.x1 * viewport.width)
        const py1 = Math.ceil(job.region.y1 * viewport.height)
        canvas.width = Math.max(1, px1 - px0)
        canvas.height = Math.max(1, py1 - py0)
        transform = [1, 0, 0, 1, -px0, -py0]
        region = {
          x0: px0 / viewport.width,
          y0: py0 / viewport.height,
          x1: px1 / viewport.width,
          y1: py1 / viewport.height,
        }
      }

      const task = page.render({ canvas, viewport, transform })
      job.task = task
      await task.promise
      if (this.stale(job)) {
        releaseCanvas(canvas)
        return
      }
      this.place(job, canvas, region)
    } catch (error) {
      if (job.canvas) releaseCanvas(job.canvas)
      if (!this.stale(job) && !isRenderCancelled(error)) {
        const state = this.pages.get(job.index)
        if (state && job.kind === 'base') state.failedScale = job.scale
        console.warn(`PDF page ${job.index + 1} failed to draw`, error)
      }
    } finally {
      this.running.delete(job)
      const state = this.pages.get(job.index)
      if (state?.baseJob === job) state.baseJob = null
      if (state?.detailJob === job) state.detailJob = null
      this.pump()
    }
  }

  /**
   * Whether a job's result is no longer wanted. A method rather than an
   * inline check so it is re-read after each `await` — the flags change
   * while the render runs.
   */
  private stale(job: Job): boolean {
    return job.cancelled || this.destroyed
  }

  private place(job: Job, canvas: HTMLCanvasElement, region?: FracRect): void {
    const state = this.pages.get(job.index)
    const layers = this.layers(job.index)
    if (!state || !layers) {
      releaseCanvas(canvas)
      return
    }
    canvas.setAttribute('aria-hidden', 'true')
    if (job.kind === 'base') {
      canvas.style.cssText =
        'position:absolute;left:0;top:0;width:100%;height:100%;display:block'
      layers.base.appendChild(canvas)
      if (state.base) releaseCanvas(state.base.canvas)
      state.base = { canvas, scale: job.scale }
      state.failedScale = null
      // For tests, and for anyone debugging a blank page: this one is drawn.
      layers.base.dataset.rendered = 'true'
    } else if (region) {
      const pct = (n: number) => `${n * 100}%`
      canvas.style.cssText = [
        'position:absolute',
        'display:block',
        `left:${pct(region.x0)}`,
        `top:${pct(region.y0)}`,
        `width:${pct(region.x1 - region.x0)}`,
        `height:${pct(region.y1 - region.y0)}`,
      ].join(';')
      layers.detail.appendChild(canvas)
      if (state.detail) releaseCanvas(state.detail.canvas)
      state.detail = { canvas, scale: job.scale, region }
    } else {
      releaseCanvas(canvas)
    }
  }
}
