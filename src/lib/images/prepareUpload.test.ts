import { describe, expect, test } from 'vitest'
import { targetSize } from './prepareUpload'

/**
 * The scaling rule, which decides what a report's photos actually are.
 *
 * Only the arithmetic is tested here: the encode itself needs a canvas, and
 * this repo has no DOM test layer — that path is covered end to end by the
 * photo specs instead.
 */

describe('what a photo is scaled to', () => {
  test('a phone photo comes down to the long edge, keeping its shape', () => {
    // 4:3 landscape, the usual shape out of a phone camera.
    expect(targetSize(4032, 3024)).toEqual({ width: 1600, height: 1200 })
    // The same camera turned sideways.
    expect(targetSize(3024, 4032)).toEqual({ width: 1200, height: 1600 })
  })

  test('a small photo is left alone rather than enlarged', () => {
    // Scaling up adds bytes and no detail — a 640px photo of a bait station
    // is exactly as informative at 640px.
    expect(targetSize(640, 480)).toEqual({ width: 640, height: 480 })
    expect(targetSize(1600, 900)).toEqual({ width: 1600, height: 900 })
  })

  test('an extreme shape keeps at least one pixel', () => {
    // A panorama's short edge must not round to zero, which would encode
    // nothing at all.
    expect(targetSize(8000, 3)).toEqual({ width: 1600, height: 1 })
  })

  test('honours a caller that wants something smaller', () => {
    // The business logo, which is printed a few centimetres wide.
    expect(targetSize(2400, 1200, 800)).toEqual({ width: 800, height: 400 })
  })

  test('survives an image with no dimensions rather than dividing by zero', () => {
    expect(targetSize(0, 0)).toEqual({ width: 0, height: 0 })
  })
})
