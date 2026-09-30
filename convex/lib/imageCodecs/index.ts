'use node'

import decodeWithMozjpeg, {
  init as initDecoderGlue,
} from '@jsquash/jpeg/decode.js'
import encodeWithMozjpeg, {
  init as initEncoderGlue,
} from '@jsquash/jpeg/encode.js'
import {
  initSync as initResizerGlue,
  resize as resizeWithLanczos,
} from '@jsquash/resize/lib/resize/pkg/squoosh_resize.js'
import { LANCZOS_RESIZER, MOZJPEG_DECODER, MOZJPEG_ENCODER } from './wasm'
import type { EmbeddedWasm } from './wasm'

/**
 * JPEG in, pixels, JPEG out — in WebAssembly, so it runs the same in a
 * Convex Node action, a test and a laptop.
 *
 * mozjpeg (decoder and encoder) and a Lanczos resampler, from Squoosh by way
 * of jSquash. Chosen over sharp, the usual Node answer, because sharp is a
 * native binary: it has to match the machine it lands on, and on Convex's
 * runtime it has been reported to fail on a missing GLIBCXX. This makes the
 * same bytes sharp's mozjpeg does — checked tier by tier on the 30 Sept
 * report's photos — at about half the speed, about 150 ms a photo.
 *
 * The modules come from `./wasm`, embedded, and are compiled once per
 * process. The packages' own loaders would fetch each `.wasm` from beside
 * their JavaScript, which in a bundle is not there.
 */

/** Pixels, four bytes each (RGBA), row by row. */
export type Rgba = { data: Uint8ClampedArray; width: number; height: number }

/**
 * Each glue's typings admit only options, but its JavaScript takes the
 * compiled module first (`@jsquash/jpeg/utils.js`, `initEmscriptenModule`).
 */
type GlueInit = (
  module: WebAssembly.Module,
  overrides: Record<string, unknown>,
) => Promise<void>

/**
 * libjpeg says why it gave up on stderr, then throws. The throw is what the
 * caller acts on — the photo goes as it came — so the chatter is dropped.
 */
const QUIET = { print: () => undefined, printErr: () => undefined }

let ready: Promise<void> | undefined

function compile(file: EmbeddedWasm): Promise<WebAssembly.Module> {
  return WebAssembly.compile(Buffer.from(file.base64, 'base64'))
}

/** Compiles and starts the three modules, once. */
export function loadCodecs(): Promise<void> {
  ready ??= (async () => {
    const [decoder, encoder, resizer] = await Promise.all([
      compile(MOZJPEG_DECODER),
      compile(MOZJPEG_ENCODER),
      compile(LANCZOS_RESIZER),
    ])
    await (initDecoderGlue as unknown as GlueInit)(decoder, QUIET)
    await (initEncoderGlue as unknown as GlueInit)(encoder, QUIET)
    initResizerGlue(resizer)
  })().catch((error: unknown) => {
    // Nothing here is expected to fail, but a failure must not be cached:
    // the next caller tries again rather than inheriting this one's error.
    ready = undefined
    throw error
  })
  return ready
}

/**
 * A JPEG's pixels, turned upright first when its EXIF says the camera was
 * held sideways — react-pdf honours that flag when it draws the original, so
 * a copy made without it would print the photo on its side.
 *
 * Throws on a file mozjpeg cannot read (empty, not a JPEG, no image in it);
 * the module is still usable afterwards.
 */
export async function decodeJpeg(bytes: Uint8Array): Promise<Rgba> {
  await loadCodecs()
  // Its own ArrayBuffer: mozjpeg reads the whole buffer it is handed, and a
  // view onto a larger one would hand it someone else's bytes too.
  const image = await decodeWithMozjpeg(bytes.slice().buffer, {
    preserveOrientation: true,
  })
  return { data: image.data, width: image.width, height: image.height }
}

/** Lanczos3 in sRGB with no premultiply — what sharp does by default. */
const LANCZOS3 = 3

export async function resizeRgba(
  image: Rgba,
  width: number,
  height: number,
): Promise<Rgba> {
  await loadCodecs()
  if (width === image.width && height === image.height) return image
  const data = resizeWithLanczos(
    new Uint8Array(
      image.data.buffer,
      image.data.byteOffset,
      image.data.byteLength,
    ),
    image.width,
    image.height,
    width,
    height,
    LANCZOS3,
    false,
    false,
  )
  return { data, width, height }
}

/**
 * A baseline JPEG, 4:2:0, with optimised Huffman tables and mozjpeg's
 * default quantisation (table 3) — the settings the tiers were measured at.
 * No metadata is written, so nothing the original carried (a location, the
 * phone's model) travels in the copy.
 */
export async function encodeJpeg(
  image: Rgba,
  quality: number,
): Promise<Uint8Array> {
  await loadCodecs()
  const encoded = await encodeWithMozjpeg(
    // What the encoder reads of an ImageData; Node has no ImageData.
    {
      data: image.data,
      width: image.width,
      height: image.height,
    } as ImageData,
    {
      quality,
      baseline: true,
      arithmetic: false,
      progressive: false,
      optimize_coding: true,
      smoothing: 0,
      color_space: 3,
      quant_table: 3,
      trellis_multipass: false,
      trellis_opt_zero: false,
      trellis_opt_table: false,
      trellis_loops: 1,
      auto_subsample: false,
      chroma_subsample: 2,
      separate_chroma_quality: false,
      chroma_quality: quality,
    },
  )
  return new Uint8Array(encoded)
}
