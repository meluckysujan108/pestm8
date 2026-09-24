/**
 * Where every page sits, and how zoom and scroll move between one layout and
 * the next — the viewer's geometry, kept free of the DOM so it can be tested
 * and so the gesture code has one answer to "what is under this finger".
 *
 * Three coordinate systems, and every function says which it takes:
 *
 * - Unit: the document at zoom 1, pages stacked top to bottom with a gap
 *   between them, each page as wide as the screen allows ("fit width"), plus
 *   side padding. Nothing about zoom or scroll.
 * - Content: unit × zoom, shifted by an origin — pages centred when the
 *   document is narrower than the screen, pushed below the top bar, and
 *   centred vertically when the whole document is shorter than the screen
 *   (a one-page certificate sits in the middle, as Quick Look shows it). This
 *   is what the scroll container scrolls.
 * - Screen: content minus scroll, relative to the scroller's top-left corner.
 *
 * The top and bottom insets are the translucent bars. They are not scaled —
 * a bar is the same height at 5x — which is why the origin, and not a scaled
 * padding, carries them.
 */

/** Space between pages, and above the first and below the last, at zoom 1. */
export const PAGE_GAP = 12
/** Space either side of the pages at zoom 1. */
export const SIDE_PAD = 12
/**
 * The widest a page is drawn at zoom 1. Fit-width on a phone; on a desktop
 * window a page 1,800px wide is a wall of 40px text, so it stops here.
 */
export const MAX_FIT_WIDTH = 880
export const MIN_ZOOM = 1
export const MAX_ZOOM = 5

/** A page's size at scale 1, in PDF points, with its rotation applied. */
export type PageSize = { width: number; height: number }
export type Point = { x: number; y: number }
export type Insets = { top: number; bottom: number }

export type Layout = {
  viewportWidth: number
  viewportHeight: number
  insets: Insets
  /** Width of every page at zoom 1, in CSS pixels. */
  fitWidth: number
  /** Width of the whole document at zoom 1, side padding included. */
  unitWidth: number
  /** Height of the stack of pages at zoom 1, gaps included. */
  unitHeight: number
  /** Top of each page in unit coordinates. */
  tops: number[]
  /** Height of each page in unit coordinates. */
  heights: number[]
}

export function computeLayout(
  sizes: PageSize[],
  viewport: { width: number; height: number },
  insets: Insets,
): Layout {
  const fitWidth = Math.max(
    1,
    Math.min(viewport.width - 2 * SIDE_PAD, MAX_FIT_WIDTH),
  )
  const tops: number[] = []
  const heights: number[] = []
  let y = 0
  sizes.forEach((size, i) => {
    if (i > 0) y += PAGE_GAP
    tops.push(y)
    // Each page fits the width on its own: a landscape page in a portrait
    // document is as wide as the rest, and shorter.
    const height =
      size.width > 0 && size.height > 0
        ? fitWidth * (size.height / size.width)
        : fitWidth * Math.SQRT2
    heights.push(height)
    y += height
  })
  return {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    insets,
    fitWidth,
    unitWidth: fitWidth + 2 * SIDE_PAD,
    unitHeight: y,
    tops,
    heights,
  }
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** Where unit (0, 0) lands in content coordinates at `zoom`. */
export function contentOrigin(layout: Layout, zoom: number): Point {
  const width = layout.unitWidth * zoom
  const height = layout.unitHeight * zoom
  const room =
    layout.viewportHeight - layout.insets.top - layout.insets.bottom - height
  return {
    x: Math.max(0, (layout.viewportWidth - width) / 2),
    y: layout.insets.top + Math.max(0, room / 2),
  }
}

/** The scrollable size of the content at `zoom`. */
export function contentSize(
  layout: Layout,
  zoom: number,
): { width: number; height: number } {
  const origin = contentOrigin(layout, zoom)
  return {
    width: Math.max(layout.viewportWidth, layout.unitWidth * zoom),
    height: Math.max(
      layout.viewportHeight,
      origin.y + layout.unitHeight * zoom + layout.insets.bottom,
    ),
  }
}

export type Box = { x: number; y: number; width: number; height: number }

/** Page `index` (0-based) in content coordinates at `zoom`. */
export function pageBox(layout: Layout, zoom: number, index: number): Box {
  const origin = contentOrigin(layout, zoom)
  return {
    x: origin.x + SIDE_PAD * zoom,
    y: origin.y + layout.tops[index] * zoom,
    width: layout.fitWidth * zoom,
    height: layout.heights[index] * zoom,
  }
}

/**
 * The page at unit height `y`. The gap below a page belongs to it, so there
 * is always an answer, and above the first page is the first page.
 */
export function pageAtUnitY(layout: Layout, y: number): number {
  const { tops } = layout
  if (tops.length === 0) return 0
  let lo = 0
  let hi = tops.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (tops[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function clampScroll(layout: Layout, zoom: number, p: Point): Point {
  const size = contentSize(layout, zoom)
  return {
    x: Math.min(
      Math.max(0, p.x),
      Math.max(0, size.width - layout.viewportWidth),
    ),
    y: Math.min(
      Math.max(0, p.y),
      Math.max(0, size.height - layout.viewportHeight),
    ),
  }
}

/**
 * The scroll that shows `rect` (fractions of page `index`) between the bars:
 * `scroll` unchanged if it is already there, otherwise the one that centres it
 * in the readable band — clamped, like every scroll, to what the content can
 * reach.
 *
 * Search jumps to its matches with this, which is why the band is the
 * layout's own insets and nothing else: while the search bar is open the
 * viewer counts the software keyboard into the bottom inset. That one number
 * then both narrows the band to what is above the keyboard and — through
 * `contentSize` — lengthens the scroll enough to lift the foot of the last
 * page into it. A band that knew about the keyboard but a scroll range that
 * did not could aim at "Revision date" at the bottom of section 16 and never
 * get there: the clamp would leave it under the keys.
 */
export function revealScroll(
  layout: Layout,
  zoom: number,
  index: number,
  rect: { x: number; y: number; w: number; h: number },
  scroll: Point,
): Point {
  const box = pageBox(layout, zoom, index)
  const r = {
    x: box.x + rect.x * box.width,
    y: box.y + rect.y * box.height,
    w: rect.w * box.width,
    h: rect.h * box.height,
  }
  const top = layout.insets.top
  const bottom = layout.viewportHeight - layout.insets.bottom
  let { x, y } = scroll
  if (r.y < y + top || r.y + r.h > y + bottom) {
    y = r.y + r.h / 2 - (top + (bottom - top) / 2)
  }
  if (r.x < x || r.x + r.w > x + layout.viewportWidth) {
    x = r.x + r.w / 2 - layout.viewportWidth / 2
  }
  return clampScroll(layout, zoom, { x, y })
}

/**
 * The page under the middle of the screen — the one "3 of 12" names, which
 * is the one someone is reading rather than the sliver at the top.
 */
export function currentPageAt(
  layout: Layout,
  zoom: number,
  scroll: Point,
): number {
  const origin = contentOrigin(layout, zoom)
  const y = (scroll.y + layout.viewportHeight / 2 - origin.y) / zoom
  return pageAtUnitY(layout, y)
}

/**
 * What is at the top-left of the readable area (just below the top bar), as a
 * place in a page rather than a pixel: the page, how far down it (a fraction
 * of its height) and how far across (a fraction of its width, below 0 in the
 * left margin).
 *
 * A pixel stops meaning anything the moment the layout changes — a phone
 * turned sideways, the real size of page 7 arriving, a zoom — and a place in
 * a page does not, which is how the viewer keeps someone's place through all
 * three, and remembers it between visits.
 */
export type Anchor = { page: number; fy: number; fx: number }

export function anchorAt(layout: Layout, zoom: number, scroll: Point): Anchor {
  const origin = contentOrigin(layout, zoom)
  const y = (scroll.y + layout.insets.top - origin.y) / zoom
  const x = (scroll.x - origin.x) / zoom
  const page = pageAtUnitY(layout, y)
  const height = layout.heights[page] || 1
  return {
    page,
    fy: (y - (layout.tops[page] ?? 0)) / height,
    fx: (x - SIDE_PAD) / layout.fitWidth,
  }
}

/** The scroll position that puts `anchor` back at the top-left. */
export function scrollForAnchor(
  layout: Layout,
  zoom: number,
  anchor: Anchor,
): Point {
  const page = Math.min(
    Math.max(0, anchor.page),
    Math.max(0, layout.tops.length - 1),
  )
  const origin = contentOrigin(layout, zoom)
  const y = (layout.tops[page] ?? 0) + anchor.fy * (layout.heights[page] ?? 0)
  const x = SIDE_PAD + anchor.fx * layout.fitWidth
  return clampScroll(layout, zoom, {
    x: origin.x + x * zoom,
    y: origin.y + y * zoom - layout.insets.top,
  })
}

/**
 * A visual transform on the page stack, applied while a gesture is under way
 * so a pinch costs the compositor a matrix rather than React a layout per
 * frame: `translate(tx, ty) scale(s)` with the origin at the content's
 * top-left.
 */
export type StageTransform = { s: number; tx: number; ty: number }

export const IDENTITY: StageTransform = { s: 1, tx: 0, ty: 0 }

/**
 * The content point (at the committed zoom) that screen point `q` is showing
 * through `transform`.
 */
export function contentPointUnder(
  transform: StageTransform,
  scroll: Point,
  q: Point,
): Point {
  return {
    x: (q.x + scroll.x - transform.tx) / transform.s,
    y: (q.y + scroll.y - transform.ty) / transform.s,
  }
}

/**
 * Scales `transform` by `factor` around screen point `q`, so whatever is under
 * `q` stays under it: a fingers' midpoint, or the pointer for a trackpad pinch.
 */
export function zoomTransformAround(
  transform: StageTransform,
  scroll: Point,
  q: Point,
  factor: number,
): StageTransform {
  const p = contentPointUnder(transform, scroll, q)
  const s = transform.s * factor
  return { s, tx: q.x + scroll.x - s * p.x, ty: q.y + scroll.y - s * p.y }
}

/**
 * Zooming from `zoom` to `nextZoom` so that content point `p` (at `zoom`)
 * ends up at screen point `q`: the zoom, and the scroll that does it, clamped
 * to what can actually be scrolled to.
 */
export function zoomAbout(
  layout: Layout,
  zoom: number,
  p: Point,
  q: Point,
  nextZoom: number,
): { zoom: number; scroll: Point } {
  const z = clampZoom(nextZoom)
  const from = contentOrigin(layout, zoom)
  const to = contentOrigin(layout, z)
  const ux = (p.x - from.x) / zoom
  const uy = (p.y - from.y) / zoom
  return {
    zoom: z,
    scroll: clampScroll(layout, z, {
      x: to.x + ux * z - q.x,
      y: to.y + uy * z - q.y,
    }),
  }
}

/**
 * Where a gesture that has left the stack at `transform` settles: its zoom
 * clamped to the range, and the scroll that keeps what is under `q` (the last
 * midpoint of the fingers) under it.
 */
export function settleTransform(
  layout: Layout,
  zoom: number,
  transform: StageTransform,
  scroll: Point,
  q: Point,
): { zoom: number; scroll: Point } {
  const p = contentPointUnder(transform, scroll, q)
  return zoomAbout(layout, zoom, p, q, zoom * transform.s)
}

/**
 * The transform, applied at `zoom` and `scroll`, that shows exactly what
 * `nextZoom` at `nextScroll` will — so an animation can run to it and the
 * real re-layout that follows lands on the same pixels, with nothing jumping
 * when the transform is dropped.
 */
export function transformFor(
  layout: Layout,
  zoom: number,
  scroll: Point,
  nextZoom: number,
  nextScroll: Point,
): StageTransform {
  const s = nextZoom / zoom
  const from = contentOrigin(layout, zoom)
  const to = contentOrigin(layout, nextZoom)
  return {
    s,
    tx: to.x - nextScroll.x - s * from.x + scroll.x,
    ty: to.y - nextScroll.y - s * from.y + scroll.y,
  }
}

/**
 * The pages any part of which lies within `margin` pixels of the screen, as
 * an inclusive range.
 */
export function pagesNear(
  layout: Layout,
  zoom: number,
  scroll: Point,
  margin: number,
): [number, number] {
  const origin = contentOrigin(layout, zoom)
  const top = (scroll.y - margin - origin.y) / zoom
  const bottom = (scroll.y + layout.viewportHeight + margin - origin.y) / zoom
  return [pageAtUnitY(layout, top), pageAtUnitY(layout, bottom)]
}

/**
 * How big a canvas may be.
 *
 * iOS Safari caps the memory all canvases on a page may hold between them,
 * and past it a canvas silently draws nothing — a blank white page, no error.
 * A page drawn at 3x on a Pro Max at 5x zoom would want 60 million pixels on
 * its own. So on touch devices a single canvas stays under about 4.2 million
 * pixels (16MB), and 16,777,216 (4096², Safari's per-canvas limit) anywhere.
 * Beyond that a page stays sharp through the detail layer instead, which
 * draws only the part on screen.
 */
export type CanvasLimits = {
  /** Most pixels in one canvas. */
  maxPixels: number
  /** Longest side of one canvas. */
  maxSide: number
  /** Most pixels across all page canvases at once. */
  totalPixels: number
}

export function canvasLimits(touch: boolean): CanvasLimits {
  return touch
    ? { maxPixels: 4_200_000, maxSide: 8192, totalPixels: 24_000_000 }
    : { maxPixels: 16_777_216, maxSide: 16_384, totalPixels: 80_000_000 }
}

/**
 * The scale a page's whole-page canvas is drawn at: the screen's pixel
 * density times how large the page is drawn, unless that would break a limit.
 */
export function baseRenderScale(
  page: PageSize,
  cssWidth: number,
  dpr: number,
  limits: CanvasLimits,
): number {
  const wanted = (cssWidth / page.width) * dpr
  const byArea = Math.sqrt(limits.maxPixels / (page.width * page.height))
  const bySide = limits.maxSide / Math.max(page.width, page.height)
  return Math.max(0.01, Math.min(wanted, byArea, bySide))
}

/** A region of a page as fractions of its width and height. */
export type FracRect = { x0: number; y0: number; x1: number; y1: number }

export type DetailPlan = {
  index: number
  /** The part of the page to draw sharply, margin included. */
  region: FracRect
  /** The part actually on screen: an existing detail canvas that covers
      this is still good enough, and is not redrawn. */
  visible: FracRect
  /** Scale to draw at, as `page.getViewport({ scale })` takes it. */
  scale: number
}

/** The part of `box` inside `rect`, as fractions of `box`, or null. */
function intersect(
  box: Box,
  rect: { x0: number; y0: number; x1: number; y1: number },
): FracRect | null {
  const x0 = Math.max(rect.x0, box.x)
  const y0 = Math.max(rect.y0, box.y)
  const x1 = Math.min(rect.x1, box.x + box.width)
  const y1 = Math.min(rect.y1, box.y + box.height)
  if (x1 <= x0 || y1 <= y0) return null
  return {
    x0: (x0 - box.x) / box.width,
    y0: (y0 - box.y) / box.height,
    x1: (x1 - box.x) / box.width,
    y1: (y1 - box.y) / box.height,
  }
}

/**
 * Which parts of which pages need a sharp detail canvas, and at what scale.
 *
 * Only a page whose whole-page canvas was capped below the screen's density
 * needs one, and only for what is on screen — plus a quarter of a screen
 * around it, so a small pan does not show blurry edges, when the budget
 * allows. If even the bare screen is over budget (a large iPad at 3x),
 * the detail is drawn a little under full density rather than not at all.
 */
export function planDetail(
  layout: Layout,
  zoom: number,
  scroll: Point,
  sizes: PageSize[],
  dpr: number,
  limits: CanvasLimits,
): DetailPlan[] {
  const attempt = (margin: number) => {
    const plans: DetailPlan[] = []
    let pixels = 0
    const view = {
      x0: scroll.x - margin * layout.viewportWidth,
      y0: scroll.y - margin * layout.viewportHeight,
      x1: scroll.x + (1 + margin) * layout.viewportWidth,
      y1: scroll.y + (1 + margin) * layout.viewportHeight,
    }
    const screen = {
      x0: scroll.x,
      y0: scroll.y,
      x1: scroll.x + layout.viewportWidth,
      y1: scroll.y + layout.viewportHeight,
    }
    const [first, last] = pagesNear(layout, zoom, scroll, 0)
    for (let index = first; index <= last; index++) {
      const size = sizes.at(index)
      if (!size) continue
      const box = pageBox(layout, zoom, index)
      const full = (box.width / size.width) * dpr
      if (baseRenderScale(size, box.width, dpr, limits) >= full * 0.9) continue
      const region = intersect(box, view)
      const visible = intersect(box, screen)
      if (!region || !visible) continue
      pixels +=
        (region.x1 - region.x0) *
        size.width *
        full *
        ((region.y1 - region.y0) * size.height * full)
      plans.push({ index, region, visible, scale: full })
    }
    return { plans, pixels }
  }

  let { plans, pixels } = attempt(0.25)
  if (pixels > limits.maxPixels) ({ plans, pixels } = attempt(0))
  if (pixels > limits.maxPixels) {
    const shrink = Math.sqrt(limits.maxPixels / pixels)
    plans = plans.map((plan) => ({ ...plan, scale: plan.scale * shrink }))
  }
  return plans.map((plan) => {
    const size = sizes[plan.index]
    const w = (plan.region.x1 - plan.region.x0) * size.width
    const h = (plan.region.y1 - plan.region.y0) * size.height
    const bySide = limits.maxSide / Math.max(w, h)
    return { ...plan, scale: Math.min(plan.scale, bySide) }
  })
}

/**
 * Which pages keep a canvas: the nearest first, until the total budget runs
 * out. `pixels` is what each would cost, in the order given.
 */
export function withinBudget(
  candidates: Array<{ index: number; pixels: number }>,
  totalPixels: number,
): number[] {
  const kept: number[] = []
  let used = 0
  for (const { index, pixels } of candidates) {
    // The nearest page is always kept, even over budget: a blank screen is
    // the one outcome worse than a slow one.
    if (kept.length > 0 && used + pixels > totalPixels) break
    kept.push(index)
    used += pixels
  }
  return kept
}
