// @vitest-environment node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'
import { photoLike } from '../../../test/photos'
import { decodeJpeg, encodeJpeg, loadCodecs, resizeRgba } from './index'
import { LANCZOS_RESIZER, MOZJPEG_DECODER, MOZJPEG_ENCODER } from './wasm'

/**
 * The WebAssembly a big report's email copy is made with.
 *
 * In Node rather than the edge runtime the rest of convex/ is tested in: the
 * embedded files are checked against the installed packages on disk, which
 * the edge runtime cannot read.
 */

const require = createRequire(import.meta.url)

describe('the embedded codecs', () => {
  test.each([
    ['decoder', MOZJPEG_DECODER, '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'],
    ['encoder', MOZJPEG_ENCODER, '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'],
    [
      'resizer',
      LANCZOS_RESIZER,
      '@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm',
    ],
  ])(
    'the %s is the installed package’s — run scripts/embed-image-codecs.mjs after an upgrade',
    (_name, embedded, specifier) => {
      // The glue that drives each module comes from the package; a module
      // from another version would be driven with the wrong calls.
      const installed = readFileSync(require.resolve(specifier))
      expect(embedded.sha256).toBe(
        createHash('sha256').update(installed).digest('hex'),
      )
      expect(Buffer.from(embedded.base64, 'base64').equals(installed)).toBe(
        true,
      )
    },
  )

  test('start from the bundle alone', async () => {
    await expect(loadCodecs()).resolves.toBeUndefined()
  })
})

describe('a photo, made lighter', () => {
  test('keeps its shape and loses most of its weight', async () => {
    const phone = await encodeJpeg(photoLike(1200, 1600), 94)
    const pixels = await decodeJpeg(phone)
    expect([pixels.width, pixels.height]).toEqual([1200, 1600])

    const smaller = await resizeRgba(pixels, 750, 1000)
    expect([smaller.width, smaller.height]).toEqual([750, 1000])
    expect(smaller.data).toHaveLength(750 * 1000 * 4)

    const copy = await encodeJpeg(smaller, 75)
    const back = await decodeJpeg(copy)
    expect([back.width, back.height]).toEqual([750, 1000])
    expect(copy.length).toBeLessThan(phone.length / 3)
    // Under a second on its own; a busy machine running the whole suite
    // beside it can take several times that.
  }, 60_000)

  test('a resize to the same size hands the pixels back untouched', async () => {
    const pixels = photoLike(40, 30)
    expect(await resizeRgba(pixels, 40, 30)).toBe(pixels)
  })

  test('carries nothing but the picture: no EXIF, so no location', async () => {
    const jpeg = await encodeJpeg(photoLike(64, 48), 80)
    expect(Buffer.from(jpeg).includes(Buffer.from('Exif\0\0'))).toBe(false)
  })

  test('each decode is its own copy of the pixels', async () => {
    const a = await decodeJpeg(await encodeJpeg(photoLike(64, 48, 1), 90))
    const before = a.data.slice()
    await decodeJpeg(await encodeJpeg(photoLike(64, 48, 7), 90))
    expect(a.data).toEqual(before)
  })
})

describe('a file that is not a readable JPEG', () => {
  test('is refused, and the decoder still works afterwards', async () => {
    const good = await encodeJpeg(photoLike(64, 48), 80)
    for (const bad of [
      new Uint8Array(0),
      Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 255),
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3, 4]),
    ]) {
      await expect(decodeJpeg(bad)).rejects.toThrow()
      const after = await decodeJpeg(good)
      expect([after.width, after.height]).toEqual([64, 48])
    }
  })
})

/**
 * A JPEG with an EXIF Orientation tag, the way a phone camera writes one when
 * it was held sideways: an APP1 segment after the start-of-image marker.
 */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08, // big-endian, IFD at 8
    0x00,
    0x01, // one entry
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01, // Orientation, SHORT, 1
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00, // no next IFD
  ]
  const body = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff]
  const length = body.length + 2
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe1,
    length >> 8,
    length & 255,
    ...body,
    ...jpeg.slice(2),
  ])
}

describe('a photo taken with the phone on its side', () => {
  test('comes out upright, as react-pdf would have drawn it', async () => {
    const landscape = await encodeJpeg(photoLike(64, 32), 85)
    const sideways = withOrientation(landscape, 6)
    const pixels = await decodeJpeg(sideways)
    expect([pixels.width, pixels.height]).toEqual([32, 64])
  })
})
