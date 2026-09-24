import { describe, expect, it } from 'vitest'
import {
  IDENTITY,
  MAX_FIT_WIDTH,
  PAGE_GAP,
  PAN_ONLY_STRETCH,
  SIDE_PAD,
  anchorAt,
  baseRenderScale,
  canvasLimits,
  clampScroll,
  computeLayout,
  contentOrigin,
  contentPointUnder,
  contentSize,
  currentPageAt,
  pageAtUnitY,
  pageBox,
  pagesNear,
  pinchTransform,
  planDetail,
  revealScroll,
  scrollForAnchor,
  settleTransform,
  transformFor,
  withinBudget,
  zoomAbout,
  zoomTransformAround,
} from './layout'
import type { Layout, Point, StageTransform } from './layout'

/**
 * The viewer's geometry. The gestures are only as good as this: a pinch that
 * lets go must leave the words under the fingers where they were, and a
 * phone turned sideways must still be on the same paragraph.
 */

const A4 = { width: 595, height: 842 }
const LANDSCAPE = { width: 842, height: 595 }
// An iPhone 15: 393 wide, a 44+59 top bar and a 49+34 bottom bar.
const PHONE = { width: 393, height: 852 }
const INSETS = { top: 103 + PAGE_GAP, bottom: 83 + PAGE_GAP }

function phoneLayout(pages = 12): Layout {
  return computeLayout(Array(pages).fill(A4), PHONE, INSETS)
}

/** Where content point `p` (at `zoom`) is in unit coordinates. */
function toUnit(layout: Layout, zoom: number, p: Point): Point {
  const o = contentOrigin(layout, zoom)
  return { x: (p.x - o.x) / zoom, y: (p.y - o.y) / zoom }
}

function screenOf(
  layout: Layout,
  zoom: number,
  unit: Point,
  scroll: Point,
  t: StageTransform = IDENTITY,
): Point {
  const o = contentOrigin(layout, zoom)
  const content = { x: o.x + unit.x * zoom, y: o.y + unit.y * zoom }
  return {
    x: t.s * content.x + t.tx - scroll.x,
    y: t.s * content.y + t.ty - scroll.y,
  }
}

describe('computeLayout', () => {
  it('fits each page to the width, with a gap between pages', () => {
    const layout = computeLayout([A4, LANDSCAPE, A4], PHONE, INSETS)
    expect(layout.fitWidth).toBe(PHONE.width - 2 * SIDE_PAD)
    expect(layout.heights[0]).toBeCloseTo(layout.fitWidth * (842 / 595))
    expect(layout.heights[1]).toBeCloseTo(layout.fitWidth * (595 / 842))
    expect(layout.tops[1]).toBeCloseTo(layout.heights[0] + PAGE_GAP)
    expect(layout.unitHeight).toBeCloseTo(layout.tops[2] + layout.heights[2])
  })

  it('stops growing pages on a wide window', () => {
    const layout = computeLayout([A4], { width: 1600, height: 900 }, INSETS)
    expect(layout.fitWidth).toBe(MAX_FIT_WIDTH)
    // Centred, not left-aligned.
    expect(contentOrigin(layout, 1).x).toBeCloseTo(
      (1600 - MAX_FIT_WIDTH - 2 * SIDE_PAD) / 2,
    )
  })

  it('centres a short document between the bars', () => {
    const layout = computeLayout([LANDSCAPE], PHONE, INSETS)
    const box = pageBox(layout, 1, 0)
    const above = box.y - INSETS.top
    const below = PHONE.height - INSETS.bottom - (box.y + box.height)
    expect(above).toBeCloseTo(below)
    expect(contentSize(layout, 1).height).toBe(PHONE.height)
  })

  it('starts a long document just below the top bar', () => {
    const layout = phoneLayout()
    expect(pageBox(layout, 1, 0).y).toBe(INSETS.top)
    expect(contentSize(layout, 1).width).toBe(PHONE.width)
  })
})

describe('pageAtUnitY', () => {
  it('gives the gap below a page to that page', () => {
    const layout = phoneLayout(3)
    expect(pageAtUnitY(layout, -50)).toBe(0)
    expect(pageAtUnitY(layout, layout.tops[1] - 1)).toBe(0)
    expect(pageAtUnitY(layout, layout.tops[1])).toBe(1)
    expect(pageAtUnitY(layout, layout.unitHeight + 500)).toBe(2)
  })
})

describe('currentPageAt', () => {
  it('names the page under the middle of the screen', () => {
    const layout = phoneLayout()
    const box = pageBox(layout, 1, 4)
    const scroll = { x: 0, y: box.y + 10 - PHONE.height / 2 }
    expect(currentPageAt(layout, 1, scroll)).toBe(4)
  })
})

describe('anchors', () => {
  it('round-trip through the same layout', () => {
    const layout = phoneLayout()
    for (const zoom of [1, 2.5, 5]) {
      const scroll = clampScroll(layout, zoom, {
        x: 180 * zoom,
        y: 2345 * zoom,
      })
      const back = scrollForAnchor(layout, zoom, anchorAt(layout, zoom, scroll))
      expect(back.x).toBeCloseTo(scroll.x)
      expect(back.y).toBeCloseTo(scroll.y)
    }
  })

  it('keep the same paragraph at the top when the phone turns sideways', () => {
    const portrait = phoneLayout()
    const landscape = computeLayout(
      Array(12).fill(A4),
      { width: 852, height: 393 },
      { top: 44 + PAGE_GAP, bottom: 49 + PAGE_GAP },
    )
    const anchor = { page: 6, fy: 0.4, fx: 0 }
    const a = scrollForAnchor(portrait, 1, anchor)
    const b = scrollForAnchor(landscape, 1, anchor)
    expect(anchorAt(portrait, 1, a).page).toBe(6)
    const after = anchorAt(landscape, 1, b)
    expect(after.page).toBe(6)
    expect(after.fy).toBeCloseTo(0.4)
  })

  it('clamp rather than scroll past either end', () => {
    const layout = phoneLayout(2)
    const end = scrollForAnchor(layout, 1, { page: 1, fy: 1, fx: 0 })
    const size = contentSize(layout, 1)
    expect(end.y).toBeCloseTo(size.height - PHONE.height)
    expect(scrollForAnchor(layout, 1, { page: 0, fy: -3, fx: -2 })).toEqual({
      x: 0,
      y: 0,
    })
  })
})

describe('revealScroll', () => {
  // The keyboard above the home-indicator strip the bottom bar already
  // reserves: an iPhone 15's 336pt keyboard, less its 34pt safe area.
  const LIFT = 302
  const TYPING = { top: INSETS.top, bottom: INSETS.bottom + LIFT }
  const hit = (y: number, x = 0.1) => ({ x, y, w: 0.3, h: 0.015 })

  /** Where the rect lands on screen, top and bottom edges. */
  function landed(
    layout: Layout,
    zoom: number,
    index: number,
    rect: ReturnType<typeof hit>,
    scroll: Point,
  ) {
    const box = pageBox(layout, zoom, index)
    const top = box.y + rect.y * box.height - scroll.y
    const left = box.x + rect.x * box.width - scroll.x
    return {
      top,
      bottom: top + rect.h * box.height,
      left,
      right: left + rect.w * box.width,
    }
  }

  it('leaves the scroll alone when the match is already between the bars', () => {
    const layout = phoneLayout(3)
    const scroll = { x: 0, y: 0 }
    expect(revealScroll(layout, 1, 0, hit(0.2), scroll)).toEqual(scroll)
  })

  it('centres an off-screen match between the bars', () => {
    const layout = phoneLayout(12)
    const scroll = revealScroll(layout, 1, 7, hit(0.5), { x: 0, y: 0 })
    const at = landed(layout, 1, 7, hit(0.5), scroll)
    const middle = (INSETS.top + PHONE.height - INSETS.bottom) / 2
    expect((at.top + at.bottom) / 2).toBeCloseTo(middle)
  })

  it('brings the foot of the last page up above the keyboard', () => {
    // "Revision date" at the bottom of section 16, typed for with the
    // keyboard up: the scroll range has to grow by the keyboard for the
    // match to clear it, or the clamp leaves it under the keys.
    const layout = computeLayout(Array(3).fill(A4), PHONE, TYPING)
    for (const y of [0.5, 0.7, 0.9, 0.98]) {
      const scroll = revealScroll(layout, 1, 2, hit(y), { x: 0, y: 0 })
      const at = landed(layout, 1, 2, hit(y), scroll)
      expect(at.top).toBeGreaterThanOrEqual(TYPING.top)
      expect(at.bottom).toBeLessThanOrEqual(PHONE.height - TYPING.bottom)
    }
  })

  it('could not, with a scroll range that ignored the keyboard', () => {
    // Why the keyboard goes into the layout's inset rather than only into
    // the band aimed at: at the furthest the bars-only layout scrolls, the
    // same match is still under the keys.
    const layout = computeLayout(Array(3).fill(A4), PHONE, INSETS)
    const furthest = clampScroll(layout, 1, { x: 0, y: 1e6 })
    const at = landed(layout, 1, 2, hit(0.9), furthest)
    expect(at.bottom).toBeGreaterThan(PHONE.height - TYPING.bottom)
  })

  it('pans sideways to a match off the edge when zoomed', () => {
    const layout = phoneLayout(3)
    const zoom = 3
    const rect = { ...hit(0.3, 0.8), w: 0.15 }
    const scroll = revealScroll(layout, zoom, 1, rect, { x: 0, y: 0 })
    const at = landed(layout, zoom, 1, rect, scroll)
    expect(at.left).toBeGreaterThanOrEqual(0)
    expect(at.right).toBeLessThanOrEqual(PHONE.width)
    expect(at.top).toBeGreaterThanOrEqual(INSETS.top)
    expect(at.bottom).toBeLessThanOrEqual(PHONE.height - INSETS.bottom)
  })
})

describe('pinch', () => {
  it('keeps the point under the fingers where it was when it settles', () => {
    const layout = phoneLayout()
    const zoom = 1
    const scroll = { x: 0, y: 3000 }
    const start = { x: 120, y: 400 }
    const under = toUnit(
      layout,
      zoom,
      contentPointUnder(IDENTITY, scroll, start),
    )

    // Fingers spread to 2.2x while drifting 30px right and 50px down.
    const q = { x: 150, y: 450 }
    let t = zoomTransformAround(IDENTITY, scroll, start, 2.2)
    t = { ...t, tx: t.tx + 30, ty: t.ty + 50 }
    // Mid-gesture, the point is under the new midpoint.
    const mid = screenOf(layout, zoom, under, scroll, t)
    expect(mid.x).toBeCloseTo(q.x)
    expect(mid.y).toBeCloseTo(q.y)

    const settled = settleTransform(layout, zoom, t, scroll, q)
    expect(settled.zoom).toBeCloseTo(2.2)
    const after = screenOf(layout, settled.zoom, under, settled.scroll)
    expect(after.x).toBeCloseTo(q.x)
    expect(after.y).toBeCloseTo(q.y)
  })

  it('clamps to 1x–5x, and the transform for the clamped result matches it', () => {
    const layout = phoneLayout()
    const scroll = { x: 400, y: 5000 }
    const zoom = 3
    const q = { x: 200, y: 300 }
    const over = zoomTransformAround(IDENTITY, scroll, q, 4)
    const settled = settleTransform(layout, zoom, over, scroll, q)
    expect(settled.zoom).toBe(5)

    const t = transformFor(layout, zoom, scroll, settled.zoom, settled.scroll)
    // Any unit point shows in the same place through the transform as it
    // does after the real re-layout.
    for (const unit of [
      { x: 30, y: 2100 },
      { x: 300, y: 2200 },
    ]) {
      const through = screenOf(layout, zoom, unit, scroll, t)
      const real = screenOf(layout, settled.zoom, unit, settled.scroll)
      expect(through.x).toBeCloseTo(real.x)
      expect(through.y).toBeCloseTo(real.y)
    }
  })

  it('pinching out below 1x comes back to fit width with nothing to pan', () => {
    const layout = phoneLayout()
    const scroll = { x: 250, y: 4000 }
    const t = zoomTransformAround(IDENTITY, scroll, { x: 100, y: 100 }, 0.3)
    const settled = settleTransform(layout, 2, t, scroll, { x: 100, y: 100 })
    expect(settled.zoom).toBe(1)
    expect(settled.scroll.x).toBe(0)
  })

  it('shows the fingers’ first point under their midpoint, at any scale', () => {
    const scroll = { x: 300, y: 2000 }
    const start = { x: 150, y: 400 }
    const p0 = contentPointUnder(IDENTITY, scroll, start)
    // Spread in place: the same as zooming around the midpoint.
    const spread = pinchTransform(p0, start, scroll, 1.8)
    const around = zoomTransformAround(IDENTITY, scroll, start, 1.8)
    expect(spread.tx).toBeCloseTo(around.tx)
    expect(spread.ty).toBeCloseTo(around.ty)
    // Anywhere, at any scale: p0 is under the midpoint.
    const mid = { x: 90, y: 310 }
    const t = pinchTransform(p0, mid, scroll, 2.4)
    const under = contentPointUnder(t, scroll, mid)
    expect(under.x).toBeCloseTo(p0.x)
    expect(under.y).toBeCloseTo(p0.y)
  })

  it('a two-finger pan in markup mode keeps its zoom and moves by the fingers’ travel', () => {
    // At 2x, both fingers drag up and left while their spread wobbles 3%.
    const layout = phoneLayout()
    const zoom = 2
    const scroll = { x: 200, y: 6000 }
    const start = { x: 200, y: 420 }
    const end = { x: 160, y: 300 }
    const p0 = contentPointUnder(IDENTITY, scroll, start)
    expect(0.03).toBeLessThan(PAN_ONLY_STRETCH)

    const wobbled = pinchTransform(p0, end, scroll, 1.03)
    // Taken at its word, the wobble is a zoom…
    expect(
      settleTransform(layout, zoom, wobbled, scroll, end).zoom,
    ).toBeCloseTo(2.06)
    // …and snapped to a pan, it is not: the page moved with the fingers.
    const panned = pinchTransform(p0, end, scroll, 1)
    const settled = settleTransform(layout, zoom, panned, scroll, end)
    expect(settled.zoom).toBe(zoom)
    expect(settled.scroll.x).toBeCloseTo(scroll.x + 40)
    expect(settled.scroll.y).toBeCloseTo(scroll.y + 120)
  })
})

describe('zoomAbout', () => {
  it('double-tapping to 2.5x keeps the tapped word under the finger', () => {
    const layout = phoneLayout()
    const scroll = { x: 0, y: 1500 }
    const tap = { x: 250, y: 500 }
    const p = contentPointUnder(IDENTITY, scroll, tap)
    const next = zoomAbout(layout, 1, p, tap, 2.5)
    const unit = toUnit(layout, 1, p)
    const after = screenOf(layout, 2.5, unit, next.scroll)
    expect(after.x).toBeCloseTo(tap.x)
    expect(after.y).toBeCloseTo(tap.y)
  })
})

describe('pagesNear', () => {
  it('reaches a screen above and below', () => {
    const layout = phoneLayout(30)
    const scroll = { x: 0, y: pageBox(layout, 1, 10).y }
    const [first, last] = pagesNear(layout, 1, scroll, PHONE.height)
    expect(first).toBeLessThan(10)
    expect(last).toBeGreaterThan(10)
    expect(last - first).toBeLessThan(8)
  })
})

describe('canvas budget', () => {
  const touch = canvasLimits(true)

  it('draws at full density when it fits', () => {
    // 369 CSS px wide at 3x: about 1.7 million pixels.
    expect(baseRenderScale(A4, 369, 3, touch)).toBeCloseTo((369 / 595) * 3)
  })

  it('caps a zoomed page to the per-canvas limit on a phone', () => {
    const scale = baseRenderScale(A4, 369 * 5, 3, touch)
    const pixels = A4.width * scale * (A4.height * scale)
    expect(pixels).toBeLessThanOrEqual(touch.maxPixels + 1)
    expect(scale).toBeLessThan((369 * 5 * 3) / 595)
  })

  it('asks for no detail canvas at 1x', () => {
    const layout = phoneLayout()
    expect(
      planDetail(layout, 1, { x: 0, y: 0 }, Array(12).fill(A4), 3, touch),
    ).toEqual([])
  })

  it('draws the visible part sharply when zoomed past the cap, within budget', () => {
    const layout = phoneLayout()
    const zoom = 4
    const scroll = clampScroll(layout, zoom, { x: 500, y: 9000 })
    const plans = planDetail(layout, zoom, scroll, Array(12).fill(A4), 3, touch)
    expect(plans.length).toBeGreaterThan(0)
    let pixels = 0
    for (const { index, region, scale } of plans) {
      expect(region.x0).toBeGreaterThanOrEqual(0)
      expect(region.x1).toBeLessThanOrEqual(1)
      expect(region.x1).toBeGreaterThan(region.x0)
      const box = pageBox(layout, zoom, index)
      expect(scale).toBeLessThanOrEqual((box.width / A4.width) * 3 + 1e-9)
      pixels +=
        (region.x1 - region.x0) *
        A4.width *
        scale *
        ((region.y1 - region.y0) * A4.height * scale)
    }
    expect(pixels).toBeLessThanOrEqual(touch.maxPixels * 1.001)
  })

  it('keeps the nearest pages until the total runs out, but always one', () => {
    const pages = [0, 1, 2, 3].map((index) => ({ index, pixels: 10 }))
    expect(withinBudget(pages, 25)).toEqual([0, 1])
    expect(withinBudget([{ index: 7, pixels: 99 }], 25)).toEqual([7])
  })
})
