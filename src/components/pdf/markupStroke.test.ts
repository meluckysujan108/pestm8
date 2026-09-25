import { describe, expect, it } from 'vitest'
import {
  MAX_STROKE_POINTS,
  MIN_POINT_GAP,
  addPoint,
  cachedPathData,
  pagePoint,
  pathData,
} from './markupStroke'
import type { MarkupPoint } from './types'

/**
 * From a finger on the glass to a saved stroke. The fractions matter most:
 * every stored stroke is a fraction of the page as displayed, and a point
 * worked out against the wrong box lands the mark somewhere other than where
 * it was drawn, on every teammate's phone.
 */

// A page slot 393 CSS px wide at fit width, 100px down the screen.
const PAGE = { left: 12, top: 100, width: 369, height: 522 }

describe('pagePoint', () => {
  it('is the pointer as fractions of the page', () => {
    expect(pagePoint(12, 100, PAGE)).toEqual({ x: 0, y: 0 })
    expect(pagePoint(12 + 369 / 2, 100 + 522 / 4, PAGE)).toEqual({
      x: 0.5,
      y: 0.25,
    })
  })

  it('reads the box as it is on screen, so a point mid-pinch is still the same word', () => {
    // The stage scaled 2x around the page's top-left: the rectangle the
    // browser reports is twice the size, and the word a quarter of the way
    // across is twice as far from the edge.
    const pinched = { ...PAGE, width: PAGE.width * 2, height: PAGE.height * 2 }
    const x = PAGE.left + pinched.width * 0.25
    const y = PAGE.top + pinched.height * 0.6
    const point = pagePoint(x, y, pinched)
    expect(point?.x).toBeCloseTo(0.25)
    expect(point?.y).toBeCloseTo(0.6)
  })

  it('clamps to the page, so a stroke run off the edge runs along it', () => {
    expect(pagePoint(0, 50, PAGE)).toEqual({ x: 0, y: 0 })
    expect(pagePoint(1000, 2000, PAGE)).toEqual({ x: 1, y: 1 })
    expect(pagePoint(200, 2000, PAGE)?.y).toBe(1)
  })

  it('has no answer for a page with no size yet', () => {
    expect(pagePoint(50, 50, { ...PAGE, width: 0 })).toBeNull()
    expect(pagePoint(50, 50, { ...PAGE, height: Number.NaN })).toBeNull()
    expect(pagePoint(Number.NaN, 50, PAGE)).toBeNull()
  })
})

describe('addPoint', () => {
  it('keeps a point only once it is far enough from the last one kept', () => {
    const box = { width: 400, height: 600 }
    const points: Array<MarkupPoint> = []
    expect(addPoint(points, { x: 0.5, y: 0.5 }, box)).toBe('added')
    // One pixel across: nothing anyone could see.
    expect(addPoint(points, { x: 0.5 + 1 / 400, y: 0.5 }, box)).toBe('skipped')
    // Measured from the last point *kept*, so a slow drag still adds up.
    expect(addPoint(points, { x: 0.5 + 2 / 400, y: 0.5 }, box)).toBe('added')
    expect(points).toHaveLength(2)
  })

  it('measures the gap on screen, so a stroke drawn zoomed in keeps its detail', () => {
    // The same fractional step: under the gap at 1x, well over it at 5x.
    const step = { x: 0.5 + 1 / 400, y: 0.5 }
    const atFit: Array<MarkupPoint> = [{ x: 0.5, y: 0.5 }]
    const zoomed: Array<MarkupPoint> = [{ x: 0.5, y: 0.5 }]
    expect(addPoint(atFit, step, { width: 400, height: 600 })).toBe('skipped')
    expect(addPoint(zoomed, step, { width: 2000, height: 3000 })).toBe('added')
    expect(MIN_POINT_GAP).toBeGreaterThan(1)
  })

  it('ends the stroke at the cap rather than growing past it', () => {
    const box = { width: 10_000, height: 10_000 }
    const points: Array<MarkupPoint> = []
    let result: ReturnType<typeof addPoint> = 'added'
    for (let i = 0; result !== 'full'; i++) {
      result = addPoint(points, { x: (i % 100) / 100, y: i / 5000 }, box)
    }
    expect(points).toHaveLength(MAX_STROKE_POINTS)
    // Anything more is refused, and the stroke is not touched.
    expect(addPoint(points, { x: 0.9, y: 0.9 }, box)).toBe('full')
    expect(points).toHaveLength(MAX_STROKE_POINTS)
  })
})

describe('pathData', () => {
  it('draws a line through the points in the 0–1 box', () => {
    expect(
      pathData([
        { x: 0, y: 0 },
        { x: 0.25, y: 0.5 },
        { x: 1, y: 1 },
      ]),
    ).toBe('M0 0L0.25 0.5L1 1')
  })

  it('draws a single point as a dot', () => {
    // A zero-length line, which the round cap draws as a dot.
    expect(pathData([{ x: 0.3, y: 0.4 }])).toBe('M0.3 0.4L0.3 0.4')
    expect(pathData([])).toBe('')
  })

  it('keeps five places, and leaves out points that are not numbers', () => {
    expect(
      pathData([
        { x: 0.123456789, y: 0.5 },
        { x: Number.NaN, y: 0.5 },
        { x: 0.2, y: Number.POSITIVE_INFINITY },
        { x: 0.6, y: 0.7 },
      ]),
    ).toBe('M0.12346 0.5L0.6 0.7')
  })

  it('draws an old stroke that ran off the page as it was saved, for the page to clip', () => {
    expect(
      pathData([
        { x: 0.9, y: 0.95 },
        { x: 1.2, y: 1.3 },
        { x: 1e300, y: -1e300 },
      ]),
    ).toBe('M0.9 0.95L1.2 1.3L10 -10')
  })

  it('remembers a path per points array', () => {
    const points = [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.2 },
    ]
    const first = cachedPathData(points)
    expect(cachedPathData(points)).toBe(first)
    expect(cachedPathData([...points, { x: 0.3, y: 0.3 }])).not.toBe(first)
  })
})
