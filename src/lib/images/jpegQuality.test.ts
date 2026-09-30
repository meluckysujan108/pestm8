import { describe, expect, test } from 'vitest'
import {
  FALLBACK_CANVAS_QUALITY,
  UPLOAD_QUALITY,
  calibrateQuality,
  estimateJpegQuality,
} from './jpegQuality'

/**
 * Reading a JPEG's quality back, and finding the canvas setting that saves
 * a photo at libjpeg's 85 whatever the encoder.
 *
 * The files here are the few bytes the reading looks at: the start-of-image
 * marker and a quantisation table, made the way libjpeg makes one.
 */

const STANDARD = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16,
  24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
]

/** The luminance table libjpeg writes at `quality`, in stored order. */
function libjpegTable(quality: number): Array<number> {
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2
  return ZIGZAG.map((position) =>
    Math.min(
      255,
      Math.max(1, Math.floor((STANDARD[position] * scale + 50) / 100)),
    ),
  )
}

/** A JPEG's first bytes: SOI, a JFIF header, then the table. */
function jpegWith(table: Array<number>, precision: 0 | 1 = 0): Uint8Array {
  const entries = precision
    ? table.flatMap((value) => [value >> 8, value & 255])
    : table
  const length = 2 + 1 + entries.length
  return Uint8Array.from([
    0xff,
    0xd8,
    // APP0 JFIF, which comes before the tables in a real file.
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xdb,
    length >> 8,
    length & 255,
    (precision << 4) | 0,
    ...entries,
    0xff,
    0xda,
  ])
}

describe('the quality a JPEG was saved at', () => {
  test.each([50, 75, 82, 85, 90, 94])('libjpeg’s %i reads as itself', (q) => {
    expect(estimateJpegQuality(jpegWith(libjpegTable(q)))).toBe(q)
  })

  test('a table written with 16-bit entries reads the same', () => {
    expect(estimateJpegQuality(jpegWith(libjpegTable(85), 1))).toBe(85)
  })

  test('what is not a JPEG, or has no table, has no quality', () => {
    expect(
      estimateJpegQuality(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    ).toBeNull()
    expect(estimateJpegQuality(new Uint8Array(0))).toBeNull()
    expect(
      estimateJpegQuality(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2])),
    ).toBeNull()
  })
})

/** An encoder that saves at libjpeg quality `mapping(setting)`. */
function encoder(mapping: (setting: number) => number) {
  const asked: Array<number> = []
  return {
    asked,
    encode: async (setting: number) => {
      asked.push(setting)
      return jpegWith(libjpegTable(mapping(setting)))
    },
  }
}

/**
 * Apple's encoder, as measured through macOS's own (the same ImageIO an
 * iPhone's canvas uses): 0.5 → 80, 0.6 → 87, 0.65 → 89, 0.7 → 91,
 * 0.75 → 93, 0.8 → 94. Between the points it is taken as a straight line.
 */
function apple(setting: number): number {
  const points: Array<[number, number]> = [
    [0.3, 66],
    [0.5, 80],
    [0.6, 87],
    [0.65, 89],
    [0.7, 91],
    [0.75, 93],
    [0.8, 94],
    [1, 96],
  ]
  for (let i = 1; i < points.length; i++) {
    const [s1, q1] = points[i]
    const [s0, q0] = points[i - 1]
    if (setting <= s1) {
      return Math.round(q0 + ((setting - s0) / (s1 - s0)) * (q1 - q0))
    }
  }
  return 96
}

describe('the canvas setting a photo is saved at', () => {
  test('libjpeg (Chrome, Firefox): the target itself, asked once', async () => {
    const libjpeg = encoder((setting) => Math.round(setting * 100))
    expect(await calibrateQuality(libjpeg.encode)).toBe(UPLOAD_QUALITY / 100)
    expect(libjpeg.asked).toHaveLength(1)
  })

  test('an iPhone: found well below 0.82, landing on 85', async () => {
    const iphone = encoder(apple)
    const setting = await calibrateQuality(iphone.encode)
    expect(setting).toBeLessThan(0.7)
    expect(Math.abs(apple(setting) - UPLOAD_QUALITY)).toBeLessThanOrEqual(1)
    // Asked a handful of times, once a session: a few milliseconds.
    expect(iphone.asked.length).toBeLessThanOrEqual(11)
  })

  test('an encoder that ignores the setting keeps the old one', async () => {
    const stuck = encoder(() => 94)
    expect(await calibrateQuality(stuck.encode)).toBe(FALLBACK_CANVAS_QUALITY)
  })

  test('an encoder that cannot be read keeps the old one', async () => {
    expect(await calibrateQuality(async () => null)).toBe(
      FALLBACK_CANVAS_QUALITY,
    )
    expect(
      await calibrateQuality(async () => {
        throw new Error('no canvas')
      }),
    ).toBe(FALLBACK_CANVAS_QUALITY)
  })
})
