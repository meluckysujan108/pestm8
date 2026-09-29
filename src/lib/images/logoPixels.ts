/**
 * What a logo's pixels say about it: whether any of it is see-through, what
 * colour it sits on if it sits on one, and where its artwork ends. Plain
 * arithmetic over RGBA, so it is tested without a canvas; `prepareLogo.ts`
 * does the drawing.
 */

export type Rgba = {
  /** Four bytes a pixel, row by row, as `getImageData` gives them. */
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

export type Box = { x: number; y: number; width: number; height: number }

export type LogoAnalysis = {
  /**
   * Some of it is see-through. Kept as a PNG then, always: a JPEG has no
   * transparency, and a browser saving one paints every clear pixel black.
   */
  transparent: boolean
  /** The colour all round its edge, when the edge is one colour. */
  background: readonly [number, number, number] | null
  /** That colour is dark: on white paper the logo prints as a dark box. */
  darkBackground: boolean
  /**
   * For a see-through logo, what most of its artwork is: 'light' (white
   * lettering, lost on white paper) or 'dark' (dark lettering, lost in a dark
   * email). Null when it is neither, or when the logo carries its own
   * background and so shows either way.
   */
  tone: 'light' | 'dark' | null
  /** Its artwork and a hairline round it: what is kept. The whole image
   * when nothing tells artwork from background. */
  box: Box
}

/** Alpha below this is see-through. */
const SEE_THROUGH = 250
/** Alpha above this is artwork (anti-aliased edges fade to nothing). */
const INK_ALPHA = 8
/** Channels within this of the background are background (JPEG noise). */
const SAME_COLOUR = 24
/** How much of the edge must agree before it counts as a background. */
const EDGE_AGREEMENT = 0.96
/** Luminance under this, from 0 to 1, is a dark background: darker than a
 * mid grey, which on white paper reads as a box rather than as paper. */
const DARK = 0.18

export function analyseLogo(image: Rgba): LogoAnalysis {
  const { data, width, height } = image
  let transparent = false
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < SEE_THROUGH) {
      transparent = true
      break
    }
  }

  const background = transparent ? null : edgeColour(image)
  const isArtwork = transparent
    ? (i: number) => data[i + 3] > INK_ALPHA
    : background
      ? (i: number) =>
          Math.abs(data[i] - background[0]) > SAME_COLOUR ||
          Math.abs(data[i + 1] - background[1]) > SAME_COLOUR ||
          Math.abs(data[i + 2] - background[2]) > SAME_COLOUR
      : null

  return {
    transparent,
    background,
    darkBackground: background !== null && luminance(background) < DARK,
    tone: transparent ? artworkTone(image) : null,
    box: isArtwork
      ? artworkBox(image, isArtwork)
      : { x: 0, y: 0, width, height },
  }
}

/** Half or more of it, by area, for a logo to count as that tone. */
const MOSTLY = 0.5

/**
 * What most of a see-through logo's solid artwork is. White lettering reads
 * over 0.8 luminance and black under 0.05; red, blue or mid grey is neither,
 * so a logo of mostly brand colour is left alone.
 */
function artworkTone({ data }: Rgba): 'light' | 'dark' | null {
  let solid = 0
  let light = 0
  let dark = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= 128) continue
    solid++
    const l = luminance([data[i], data[i + 1], data[i + 2]])
    if (l > 0.8) light++
    else if (l < 0.05) dark++
  }
  if (solid === 0) return null
  if (light / solid >= MOSTLY) return 'light'
  if (dark / solid >= MOSTLY) return 'dark'
  return null
}

/**
 * The artwork's extent, with a margin of 1% of its longer side (at least two
 * pixels) so an anti-aliased edge is never shaved. The whole image when there
 * is no artwork at all.
 */
function artworkBox(
  { width, height }: Rgba,
  isArtwork: (i: number) => boolean,
): Box {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isArtwork((y * width + x) * 4)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width, height }
  const margin = Math.max(
    2,
    Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * 0.01),
  )
  const x = Math.max(0, minX - margin)
  const y = Math.max(0, minY - margin)
  return {
    x,
    y,
    width: Math.min(width, maxX + 1 + margin) - x,
    height: Math.min(height, maxY + 1 + margin) - y,
  }
}

/** The colour round the edge, if nearly all of the edge is that colour. */
function edgeColour({
  data,
  width,
  height,
}: Rgba): readonly [number, number, number] | null {
  const edge: Array<number> = []
  const add = (x: number, y: number) => edge.push((y * width + x) * 4)
  for (let x = 0; x < width; x++) {
    add(x, 0)
    if (height > 1) add(x, height - 1)
  }
  for (let y = 1; y < height - 1; y++) {
    add(0, y)
    if (width > 1) add(width - 1, y)
  }
  const median = (channel: number) => {
    const values = edge.map((i) => data[i + channel]).sort((a, b) => a - b)
    return values[values.length >> 1]
  }
  const colour = [median(0), median(1), median(2)] as const
  const agreeing = edge.filter(
    (i) =>
      Math.abs(data[i] - colour[0]) <= SAME_COLOUR &&
      Math.abs(data[i + 1] - colour[1]) <= SAME_COLOUR &&
      Math.abs(data[i + 2] - colour[2]) <= SAME_COLOUR,
  ).length
  return agreeing >= edge.length * EDGE_AGREEMENT ? colour : null
}

/** Each 0–255 channel value, linearised by the sRGB curve, worked out once. */
const LINEAR = Array.from({ length: 256 }, (_, c) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
})

/** Relative luminance, 0 (black) to 1 (white). */
function luminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b]
}

/**
 * What to save a logo as. PNG for anything see-through, and for anything that
 * came as a graphic (a PNG, GIF, WebP or SVG): lettering stays crisp, where a
 * JPEG blurs every edge. JPEG only for a photo — of a van, a sign, a card —
 * which is what it is for.
 */
export function logoEncoding(
  sourceType: string,
  transparent: boolean,
): 'image/png' | 'image/jpeg' {
  if (transparent) return 'image/png'
  const type = sourceType.split(';')[0].trim().toLowerCase()
  return ['image/png', 'image/gif', 'image/webp', 'image/svg+xml'].includes(
    type,
  )
    ? 'image/png'
    : 'image/jpeg'
}
