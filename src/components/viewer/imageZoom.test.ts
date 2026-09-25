import { describe, expect, test } from 'vitest'
import { MAX_ZOOM } from '#/components/pdf/layout'
import {
  DOUBLE_TAP_ZOOM,
  IDENTITY,
  clampTransform,
  doubleTap,
  fittedBox,
  panBy,
  zoomBy,
} from './imageZoom'

// A phone screen, and a landscape photo of a licence card on it.
const stage = { width: 400, height: 800 }
const card = { width: 2000, height: 1250 }
const fitted = fittedBox(stage, card)

describe('fittedBox', () => {
  test('as large as fits, centred', () => {
    expect(fitted).toEqual({ x: 0, y: 275, width: 400, height: 250 })
  })

  test('empty until both sizes are known', () => {
    expect(fittedBox(stage, { width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })
  })
})

describe('clampTransform', () => {
  test('at 1x the picture cannot be dragged anywhere', () => {
    expect(clampTransform({ s: 1, tx: 90, ty: -40 }, stage, fitted)).toEqual(
      IDENTITY,
    )
  })

  test('zoom stays within the viewer’s range', () => {
    expect(clampTransform({ s: 0.2, tx: 0, ty: 0 }, stage, fitted).s).toBe(1)
    expect(clampTransform({ s: 50, tx: 0, ty: 0 }, stage, fitted).s).toBe(
      MAX_ZOOM,
    )
  })

  test('zoomed, an edge never comes further in than the screen’s', () => {
    // At 2x the card is 800 wide: tx runs from -400 (right edge at the
    // screen's) to 0 (left edge at the screen's). 500 tall, still centred.
    const far = clampTransform({ s: 2, tx: 300, ty: 0 }, stage, fitted)
    expect(far.tx).toBe(0)
    expect(far.ty).toBeCloseTo((800 - 500) / 2 - 275 * 2)
    expect(clampTransform({ s: 2, tx: -900, ty: 0 }, stage, fitted).tx).toBe(
      -400,
    )
  })
})

describe('gestures', () => {
  test('a pinch keeps what is under the fingers under them', () => {
    const q = { x: 100, y: 400 }
    const next = zoomBy(IDENTITY, q, 2, stage, fitted)
    expect(next.s).toBe(2)
    // The content point under q at 1x was (100, 400); at 2x it must map back.
    expect(next.tx + next.s * 100).toBeCloseTo(q.x)
  })

  test('a pinch past the range stops at its end', () => {
    const next = zoomBy(IDENTITY, { x: 200, y: 400 }, 40, stage, fitted)
    expect(next.s).toBe(MAX_ZOOM)
  })

  test('panning moves a zoomed picture, and stops at its edge', () => {
    const zoomed = zoomBy(IDENTITY, { x: 200, y: 400 }, 2, stage, fitted)
    const moved = panBy(zoomed, { x: 50, y: 0 }, stage, fitted)
    expect(moved.tx).toBe(zoomed.tx + 50)
    expect(panBy(zoomed, { x: 5000, y: 0 }, stage, fitted).tx).toBe(0)
  })

  test('a double tap zooms in on the point, and a second one back out', () => {
    const q = { x: 300, y: 400 }
    const inward = doubleTap(IDENTITY, q, stage, fitted)
    expect(inward.s).toBe(DOUBLE_TAP_ZOOM)
    expect(doubleTap(inward, q, stage, fitted)).toEqual(IDENTITY)
  })
})
