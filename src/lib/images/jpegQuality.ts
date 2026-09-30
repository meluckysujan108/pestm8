/**
 * The JPEG quality a photo is saved at, the same on every phone.
 *
 * `canvas.toBlob(…, 'image/jpeg', 0.82)` means different things in different
 * browsers. Chrome and Firefox hand the number to libjpeg, where 0.82 is
 * quality 82. An iPhone hands it to Apple's own encoder, where 0.82 comes out
 * at about libjpeg's 94 — measured on the 30 Sept 2026 report, whose 53
 * photos were saved at 94 and averaged 647 KB at 1200×1600: twice the bytes
 * of quality 85 for nothing a printed page, or a phone screen, can show.
 *
 * So the number handed to the canvas is found, not assumed. A tiny picture is
 * encoded at a few settings, the quality each came out at is read back from
 * the file's own quantisation table, and the setting that lands on libjpeg's
 * 85 is kept for the rest of the session — or 0.82, where that is already
 * lighter (`uploadCanvasQuality`). No browser is named: whatever encoder this
 * is, it is asked.
 */

/** The quality a photo is saved at, in libjpeg's terms. */
export const UPLOAD_QUALITY = 85

/**
 * What is used when the encoder cannot be asked: the setting photos were
 * saved at until Sept 2026. Too heavy on an iPhone, but never worse than
 * before, and never a reason for a photo not to be saved.
 */
export const FALLBACK_CANVAS_QUALITY = 0.82

/** libjpeg's luminance table at quality 50 (JPEG Annex K), row by row. */
const STANDARD_LUMINANCE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16,
  24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]

/** The order a table's 64 entries are stored in (zig-zag), as row-by-row
 * positions. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
]

/**
 * The quality a JPEG was saved at, as libjpeg would number it, read from its
 * luminance quantisation table; null for a file that is not a JPEG or has no
 * table.
 *
 * libjpeg makes its table by scaling the standard one; an encoder that does
 * not (Apple's) is read as the libjpeg quality whose table is nearest, by
 * least squares. That is a comparison of how coarsely each encoder throws
 * detail away, which is what quality means to anyone looking at the photo.
 */
export function estimateJpegQuality(bytes: Uint8Array): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let at = 2
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]
    const length = (bytes[at + 2] << 8) | bytes[at + 3]
    // Start of scan, or end of image: the tables come before either.
    if (marker === 0xda || marker === 0xd9) return null
    if (marker === 0xdb) {
      const end = at + 2 + length
      let p = at + 4
      while (p < end) {
        const precision = bytes[p] >> 4
        const id = bytes[p] & 0x0f
        p++
        const table: Array<number> = []
        for (let i = 0; i < 64; i++) {
          table.push(
            precision
              ? (bytes[p + 2 * i] << 8) | bytes[p + 2 * i + 1]
              : bytes[p + i],
          )
        }
        p += precision ? 128 : 64
        if (id === 0) return qualityOf(table)
      }
    }
    at += 2 + length
  }
  return null
}

/** A table in stored (zig-zag) order, as a libjpeg quality. */
function qualityOf(zigzagged: ReadonlyArray<number>): number {
  const natural = new Array<number>(64)
  zigzagged.forEach((value, i) => {
    natural[ZIGZAG[i]] = value
  })
  // The scale that best maps the standard table onto this one.
  let across = 0
  let standard = 0
  for (let i = 0; i < 64; i++) {
    across += natural[i] * STANDARD_LUMINANCE[i]
    standard += STANDARD_LUMINANCE[i] * STANDARD_LUMINANCE[i]
  }
  const scale = (across / standard) * 100
  // libjpeg: scale = 5000 / quality below 50, 200 − 2 × quality above.
  const quality = scale <= 100 ? (200 - scale) / 2 : 5000 / scale
  return Math.max(1, Math.min(100, Math.round(quality)))
}

/**
 * The canvas setting that makes this encoder write about `target`.
 *
 * `encode` saves a small picture at a setting and hands back the file. The
 * setting libjpeg would use is tried first, and on Chrome or Firefox that is
 * the answer; otherwise the settings between are halved down until one lands
 * within a point or two. An encoder that cannot be read, or does not change
 * with the setting, gets `FALLBACK_CANVAS_QUALITY`.
 */
export async function calibrateQuality(
  encode: (setting: number) => Promise<Uint8Array | null>,
  target = UPLOAD_QUALITY,
): Promise<number> {
  const qualityAt = async (setting: number) => {
    const bytes = await encode(setting)
    return bytes ? estimateJpegQuality(bytes) : null
  }
  try {
    const direct = await qualityAt(target / 100)
    if (direct === null) return FALLBACK_CANVAS_QUALITY
    if (Math.abs(direct - target) <= 1) return target / 100

    let low = 0.3
    let high = 0.95
    const [atLow, atHigh] = [await qualityAt(low), await qualityAt(high)]
    if (
      atLow === null ||
      atHigh === null ||
      atHigh <= atLow ||
      target < atLow ||
      target > atHigh
    ) {
      return FALLBACK_CANVAS_QUALITY
    }

    let best = { setting: FALLBACK_CANVAS_QUALITY, off: Infinity }
    for (let step = 0; step < 8; step++) {
      const setting = (low + high) / 2
      const quality = await qualityAt(setting)
      if (quality === null) return FALLBACK_CANVAS_QUALITY
      const off = Math.abs(quality - target)
      if (off < best.off) best = { setting, off }
      if (quality === target) break
      if (quality < target) low = setting
      else high = setting
    }
    return best.off <= 2
      ? Math.round(best.setting * 1000) / 1000
      : FALLBACK_CANVAS_QUALITY
  } catch {
    return FALLBACK_CANVAS_QUALITY
  }
}

/** A 64 × 64 picture with some detail in it, saved at `setting`. */
async function encodeProbe(setting: number): Promise<Uint8Array | null> {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const gradient = ctx.createLinearGradient(0, 0, 64, 64)
  gradient.addColorStop(0, 'rgb(120, 92, 60)')
  gradient.addColorStop(1, 'rgb(40, 60, 90)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  ctx.fillStyle = 'rgb(230, 225, 210)'
  for (let i = 0; i < 64; i += 8) ctx.fillRect(i, (i * 5) % 64, 3, 20)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', setting),
  )
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

let calibrated: Promise<number> | undefined

/**
 * The canvas setting a photo is saved at on this device, worked out once per
 * session. Never rejects: a device that cannot be asked saves at
 * `FALLBACK_CANVAS_QUALITY`, as every device did before.
 *
 * Never heavier than before, either. Where 0.82 already meant 82 — Chrome,
 * Firefox, an Android phone — reaching for 85 would make every photo about a
 * fifth bigger for a difference nobody could see, so those keep 0.82. The
 * saving is on the phones that were saving at 94: iPhones, where the jobs'
 * photos come from.
 */
export function uploadCanvasQuality(): Promise<number> {
  calibrated ??= calibrateQuality(encodeProbe)
    .then((setting) => Math.min(setting, FALLBACK_CANVAS_QUALITY))
    .catch(() => FALLBACK_CANVAS_QUALITY)
  return calibrated
}
