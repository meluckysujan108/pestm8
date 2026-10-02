import { describe, expect, test } from 'vitest'
import {
  addPoint,
  exportPlan,
  fitInk,
  hasInk,
  inkBounds,
  inkToSave,
  outlineOf,
  pathOf,
  pressuresOf,
  toInkPoint,
  turnsForSigning,
} from './ink'
import type { Ink, Stroke } from './ink'

/** A stroke along a line, one point every `step` pixels, 8 ms apart. */
function line(from: [number, number], to: [number, number], step = 4): Stroke {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1])
  const count = Math.max(1, Math.round(length / step))
  return Array.from({ length: count + 1 }, (_, i) => ({
    x: from[0] + ((to[0] - from[0]) * i) / count,
    y: from[1] + ((to[1] - from[1]) * i) / count,
    t: i * 8,
  }))
}

/** Points along x at `pace` px/ms, one every `every` ms, for `ms`. */
function paced(every: number, pace: number, ms: number): Stroke {
  return Array.from({ length: ms / every + 1 }, (_, i) => ({
    x: i * every * pace,
    y: 0,
    t: i * every,
  }))
}

describe('a stroke being drawn', () => {
  test('keeps a point that moved, and drops one that did not', () => {
    const stroke: Stroke = [{ x: 10, y: 10, t: 0 }]
    expect(addPoint(stroke, { x: 10.3, y: 10.2, t: 8 })).toBe(false)
    expect(addPoint(stroke, { x: 12, y: 10, t: 16 })).toBe(true)
    expect(stroke).toHaveLength(2)
  })

  test('a tap is not a signature; a stroke that moved is', () => {
    expect(hasInk([])).toBe(false)
    expect(hasInk([[{ x: 5, y: 5, t: 0 }]])).toBe(false)
    expect(hasInk([[{ x: 5, y: 5, t: 0 }], line([0, 0], [40, 0])])).toBe(true)
  })
})

describe('the pen', () => {
  const thickness = (stroke: Stroke) => {
    const ys = outlineOf(stroke).map(([, y]) => y)
    return Math.max(...ys) - Math.min(...ys)
  }

  test('draws a line a pen would, not a marker', () => {
    const outline = outlineOf(line([20, 50], [220, 50]))
    expect(outline.length).toBeGreaterThan(4)
    expect(thickness(line([20, 50], [220, 50]))).toBeGreaterThan(0.5)
    expect(thickness(line([20, 50], [220, 50]))).toBeLessThan(6)
  })

  test('runs thinner on a quick stroke than a slow one', () => {
    // 12px every 8ms is a flick; 1.5px every 8ms a careful line.
    expect(thickness(line([0, 0], [300, 0], 12))).toBeLessThan(
      thickness(line([0, 0], [300, 0], 1.5)),
    )
  })

  test('takes its pressure from speed, whatever the phone samples at', () => {
    // An ordinary pace, at 60 and 120 samples a second.
    const at60 = pressuresOf(paced(16, 0.3, 960)).at(-1)!
    const at120 = pressuresOf(paced(8, 0.3, 960)).at(-1)!
    expect(at60).toBeCloseTo(at120, 2)
    expect(at60).toBeGreaterThan(0.7)
    // And while the speed is still changing, 48 ms into a quick stroke.
    expect(pressuresOf(paced(16, 1.2, 48)).at(-1)!).toBeCloseTo(
      pressuresOf(paced(8, 1.2, 48)).at(-1)!,
      2,
    )
  })

  test('reads two samples stamped with one moment as no change, not a flick', () => {
    const steady = paced(16, 0.3, 320)
    const last = steady.at(-1)!
    const doubled = [...steady, { x: last.x + 4.8, y: 0, t: last.t }]
    expect(pressuresOf(doubled).at(-1)).toBe(pressuresOf(steady).at(-1))
  })

  test('is as light as it gets on a flick, and heavy at a crawl', () => {
    expect(pressuresOf(paced(8, 5, 240)).at(-1)).toBe(0.25)
    expect(pressuresOf(paced(16, 0.0125, 480)).at(-1)).toBeGreaterThan(0.95)
  })

  test('closes its path, and draws nothing for an outline too short to be a shape', () => {
    const d = pathOf(outlineOf(line([0, 0], [80, 30])))
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    expect(pathOf([[0, 0]])).toBe('')
  })

  test('covers the ink and nothing more', () => {
    const ink: Ink = [line([40, 60], [240, 60]), line([100, 20], [100, 100])]
    const box = inkBounds(ink)!
    // Strokes start blunt, so the cap reaches back past where the pen
    // landed; they taper where it lifts, so they end where they ended.
    expect(box.x).toBeGreaterThan(36)
    expect(box.x).toBeLessThan(40)
    expect(box.y).toBeGreaterThan(16)
    expect(box.y).toBeLessThan(20)
    expect(box.x + box.width).toBeGreaterThanOrEqual(239)
    expect(box.x + box.width).toBeLessThan(244)
    expect(box.y + box.height).toBeGreaterThanOrEqual(99)
    expect(box.y + box.height).toBeLessThan(104)
    expect(inkBounds([])).toBeNull()
  })
})

describe('what is saved', () => {
  const signature = line([100, 100], [300, 120])

  test('is every stroke, and a tap only where it sits by them', () => {
    const dot: Stroke = [{ x: 180, y: 85, t: 0 }]
    const stray: Stroke = [{ x: 20, y: 300, t: 0 }]
    expect(inkToSave([stray, signature, dot])).toEqual([signature, dot])
    // Nothing but taps is nothing to save.
    expect(inkToSave([stray, dot])).toEqual([])
  })

  test('is cut to the ink and drawn at least 1,200 pixels across', () => {
    const plan = exportPlan({ x: 150, y: 120, width: 380, height: 110 })
    // Its own shape, margin and all, not the pad's.
    expect(plan.width).toBe(1200)
    expect(plan.height).toBe(Math.round((130 * 1200) / 400))
    // The ink's top-left lands one margin in from the image's.
    expect(150 * plan.scale + plan.dx).toBeCloseTo(10 * plan.scale)
    expect(120 * plan.scale + plan.dy).toBeCloseTo(10 * plan.scale)
  })

  test('keeps room round initials, so they print the size they were drawn', () => {
    // 30 x 15, cut from a 240 x 80 piece of the pad, not blown up to fill it.
    const plan = exportPlan({ x: 100, y: 50, width: 30, height: 15 })
    expect(plan.width).toBe(1200)
    expect(plan.height).toBe(400)
    expect(plan.scale).toBe(5)
    // Centred in it.
    expect(100 * plan.scale + plan.dx).toBeCloseTo(((240 - 50) / 2 + 10) * 5)
    expect(50 * plan.scale + plan.dy).toBeCloseTo(((80 - 35) / 2 + 10) * 5)
  })

  test('is never shrunk below the size it was drawn', () => {
    const plan = exportPlan({ x: 0, y: 0, width: 1380, height: 300 })
    expect(plan.scale).toBe(1)
    expect(plan.width).toBe(1400)
  })

  test('is never more than 2,000 pixels across', () => {
    expect(exportPlan({ x: 0, y: 0, width: 2980, height: 400 }).width).toBe(
      2000,
    )
  })

  test('is measured along its long side when that is its height', () => {
    const plan = exportPlan({ x: 0, y: 0, width: 20, height: 300 })
    expect(plan.height).toBe(1200)
    expect(plan.width).toBeLessThan(plan.height)
  })
})

describe('a pointer on the pad', () => {
  const box = { left: 16, top: 40, right: 377 }

  test('upright, is measured from the top-left corner', () => {
    expect(toInkPoint(116, 140, box, false, 5)).toEqual({
      x: 100,
      y: 100,
      t: 5,
    })
  })

  test('turned, reads as the person signing sees it', () => {
    // The pad is a quarter turn clockwise: its top-left corner is the screen
    // box's top-right, its x runs down the screen, its y leftwards.
    expect(toInkPoint(377, 40, box, true, 0)).toEqual({ x: 0, y: 0, t: 0 })
    expect(toInkPoint(377, 240, box, true, 0)).toEqual({ x: 200, y: 0, t: 0 })
    expect(toInkPoint(277, 40, box, true, 0)).toEqual({ x: 0, y: 100, t: 0 })
  })

  test('a line drawn down a phone held upright is level on the turned pad', () => {
    const start = toInkPoint(300, 100, box, true, 0)
    const end = toInkPoint(300, 500, box, true, 16)
    expect(start.y).toBe(end.y)
    expect(end.x - start.x).toBe(400)
  })
})

describe('ink on a pad that changed size', () => {
  const ink: Ink = [line([40, 30], [240, 90])]

  test('stays as it was drawn while it still fits', () => {
    expect(fitInk(ink, { width: 400, height: 200 })).toBe(ink)
    expect(fitInk(ink, { width: 260, height: 110 })).toBe(ink)
    expect(fitInk([], { width: 10, height: 10 })).toEqual([])
  })

  test('is moved in, not shrunk, when the pad narrows past it', () => {
    const fitted = fitInk(ink, { width: 230, height: 110 })
    const xs = fitted[0].map((point) => point.x)
    // The same length of line, slid left onto the pad.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(200)
    expect(Math.max(...xs)).toBeLessThanOrEqual(230)
    expect(fitted[0][0].y).toBe(30)
  })

  test('is shrunk evenly, and centred, only when it is bigger than the pad', () => {
    const fitted = fitInk(ink, { width: 120, height: 200 })
    const xs = fitted[0].map((point) => point.x)
    const ys = fitted[0].map((point) => point.y)
    const width = Math.max(...xs) - Math.min(...xs)
    const height = Math.max(...ys) - Math.min(...ys)
    expect(width).toBeLessThan(120)
    // The same shape: 200 across for every 60 down.
    expect(width / height).toBeCloseTo(200 / 60)
    expect(Math.min(...xs)).toBeCloseTo(120 - Math.max(...xs))
  })

  test('keeps when each point was drawn', () => {
    const fitted = fitInk(ink, { width: 120, height: 200 })
    expect(fitted[0].map((point) => point.t)).toEqual(
      ink[0].map((point) => point.t),
    )
  })
})

describe('turning for signing', () => {
  const phone = { width: 393, height: 852 }
  const ipad = { width: 820, height: 1180 }
  const monitor = { width: 1440, height: 900 }

  test('a phone held upright turns', () => {
    expect(turnsForSigning(phone, phone)).toBe(true)
  })

  test('a phone on its side, a tablet and a computer do not', () => {
    expect(turnsForSigning({ width: 852, height: 393 }, phone)).toBe(false)
    expect(turnsForSigning(ipad, ipad)).toBe(false)
    expect(turnsForSigning(monitor, monitor)).toBe(false)
  })

  test('nor a narrow window on a tablet or a computer', () => {
    // An iPad's Slide Over is upright whichever way the iPad is held.
    expect(turnsForSigning({ width: 375, height: 1100 }, ipad)).toBe(false)
    expect(turnsForSigning({ width: 400, height: 800 }, monitor)).toBe(false)
  })
})
