import { describe, expect, test } from 'vitest'
import { imageSize } from './imageSize'

/**
 * A logo's size, from the few bytes at the front of its file. Each header here
 * is built the way its format lays it out, with the rest of the file left as
 * padding: nothing past the header is read.
 */

function bytes(...parts: Array<string | Array<number>>): Uint8Array {
  const out: Array<number> = []
  for (const part of parts) {
    if (typeof part === 'string') {
      for (const char of part) out.push(char.charCodeAt(0))
    } else out.push(...part)
  }
  while (out.length < 64) out.push(0)
  return Uint8Array.from(out)
}

const be32 = (n: number) => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
]
const be16 = (n: number) => [(n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >>> 8) & 255]
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]

describe('what size a logo is', () => {
  test('a PNG, from its IHDR', () => {
    const png = bytes(
      [0x89],
      'PNG',
      [0x0d, 0x0a, 0x1a, 0x0a],
      be32(13),
      'IHDR',
      be32(1246),
      be32(326),
    )
    expect(imageSize(png)).toEqual({ width: 1246, height: 326, format: 'png' })
  })

  test('a GIF, from its logical screen (the old Pest M8 logo was one)', () => {
    expect(imageSize(bytes('GIF87a', le16(800), le16(200)))).toEqual({
      width: 800,
      height: 200,
      format: 'gif',
    })
  })

  test('a JPEG, from its start of frame, past the segments before it', () => {
    const jpeg = bytes(
      [0xff, 0xd8],
      // APP0 (JFIF), 16 bytes long including its own length.
      [0xff, 0xe0],
      be16(16),
      'JFIF',
      [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
      // A fill byte before the next marker is allowed.
      [0xff],
      // SOF2 (progressive): precision, then height, then width.
      [0xff, 0xc2],
      be16(17),
      [8],
      be16(360),
      be16(800),
    )
    expect(imageSize(jpeg)).toEqual({ width: 800, height: 360, format: 'jpeg' })
  })

  test('a WebP, lossless or extended', () => {
    // 1246 × 326, packed as width-1 and height-1 in fourteen bits each.
    const w = 1245
    const h = 325
    const lossless = bytes('RIFF', be32(0), 'WEBP', 'VP8L', be32(0), [
      0x2f,
      w & 0xff,
      ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
      (h >> 2) & 0xff,
      (h >> 10) & 0x0f,
    ])
    expect(imageSize(lossless)).toEqual({
      width: 1246,
      height: 326,
      format: 'webp',
    })

    const extended = bytes(
      'RIFF',
      be32(0),
      'WEBP',
      'VP8X',
      be32(10),
      [0, 0, 0, 0],
      le24(1245),
      le24(325),
    )
    expect(imageSize(extended)).toEqual({
      width: 1246,
      height: 326,
      format: 'webp',
    })
  })

  test('anything else, or too little of it, is null rather than a guess', () => {
    expect(imageSize(bytes('not an image at all'))).toBeNull()
    expect(imageSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    // A JPEG whose markers stop making sense before any frame.
    expect(imageSize(bytes([0xff, 0xd8, 0x00, 0x00]))).toBeNull()
    // A PNG that says it is empty.
    expect(
      imageSize(
        bytes(
          [0x89],
          'PNG',
          [0x0d, 0x0a, 0x1a, 0x0a],
          be32(13),
          'IHDR',
          be32(0),
          be32(0),
        ),
      ),
    ).toBeNull()
  })
})
