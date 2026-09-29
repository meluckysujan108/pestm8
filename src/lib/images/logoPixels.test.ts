import { describe, expect, test } from 'vitest'
import { analyseLogo, logoEncoding } from './logoPixels'

/**
 * A logo, read off its pixels. Each image here is drawn as RGBA by hand: a
 * background, and a block of "artwork" somewhere in it.
 */

function image(
  width: number,
  height: number,
  background: [number, number, number, number],
  artwork?: {
    x: number
    y: number
    width: number
    height: number
    colour: [number, number, number, number]
  },
) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside =
        artwork &&
        x >= artwork.x &&
        x < artwork.x + artwork.width &&
        y >= artwork.y &&
        y < artwork.y + artwork.height
      data.set(inside ? artwork.colour : background, (y * width + x) * 4)
    }
  }
  return { data, width, height }
}

const BLACK: [number, number, number, number] = [20, 20, 20, 255]
const WHITE: [number, number, number, number] = [255, 255, 255, 255]
const CLEAR: [number, number, number, number] = [0, 0, 0, 0]

describe('reading a logo', () => {
  test('a transparent one is kept transparent and trimmed to its artwork', () => {
    const logo = analyseLogo(
      image(400, 200, CLEAR, {
        x: 100,
        y: 50,
        width: 200,
        height: 60,
        colour: BLACK,
      }),
    )
    expect(logo.transparent).toBe(true)
    expect(logo.background).toBeNull()
    expect(logo.darkBackground).toBe(false)
    // 1% of the longer side, 2px, kept round it.
    expect(logo.box).toEqual({ x: 98, y: 48, width: 204, height: 64 })
  })

  test('one on white is trimmed to its artwork, as Pest M8’s upload of 29 Sept had wide margins', () => {
    const logo = analyseLogo(
      image(800, 360, WHITE, {
        x: 90,
        y: 100,
        width: 620,
        height: 160,
        colour: BLACK,
      }),
    )
    expect(logo.transparent).toBe(false)
    expect(logo.background).toEqual([255, 255, 255])
    expect(logo.darkBackground).toBe(false)
    expect(logo.box).toEqual({ x: 84, y: 94, width: 632, height: 172 })
  })

  test('one on a dark box is trimmed too, and said to print as a box', () => {
    const logo = analyseLogo(
      image(800, 360, BLACK, {
        x: 90,
        y: 100,
        width: 620,
        height: 160,
        colour: WHITE,
      }),
    )
    expect(logo.background).toEqual([20, 20, 20])
    expect(logo.darkBackground).toBe(true)
  })

  test('a photo with no one colour round its edge is kept whole', () => {
    const photo = image(40, 30, WHITE)
    // Paint half of the edge a different colour: no background to trim.
    for (let x = 0; x < 20; x++) photo.data.set(BLACK, x * 4)
    for (let y = 0; y < 30; y++) photo.data.set(BLACK, y * 40 * 4)
    const logo = analyseLogo(photo)
    expect(logo.background).toBeNull()
    expect(logo.box).toEqual({ x: 0, y: 0, width: 40, height: 30 })
  })

  test('nothing but background, or a single pixel, is kept whole rather than trimmed to nothing', () => {
    expect(analyseLogo(image(50, 20, WHITE)).box).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 20,
    })
    // The smallest PNG the e2e suite uploads.
    expect(analyseLogo(image(1, 1, [255, 255, 255, 127])).box).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })
    expect(analyseLogo(image(1, 1, WHITE)).box).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })
  })
})

describe('what a logo is saved as', () => {
  test('anything see-through is a PNG, whatever it came as', () => {
    expect(logoEncoding('image/jpeg', true)).toBe('image/png')
  })

  test('a graphic stays a PNG, so its lettering stays sharp', () => {
    for (const type of [
      'image/png',
      'image/gif',
      'image/webp',
      'image/svg+xml',
    ]) {
      expect(logoEncoding(type, false)).toBe('image/png')
    }
  })

  test('only a photo becomes a JPEG', () => {
    expect(logoEncoding('image/jpeg', false)).toBe('image/jpeg')
    expect(logoEncoding('image/heic', false)).toBe('image/jpeg')
    expect(logoEncoding('', false)).toBe('image/jpeg')
  })
})
