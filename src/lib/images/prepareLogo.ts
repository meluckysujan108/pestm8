import {
  EMAIL_LOGO,
  LOGO_MAX_EDGE,
  emailCardSize,
  fitEmailLogo,
} from '../../../convex/lib/businessLogo'
import { analyseLogo, logoEncoding } from './logoPixels'
import type { Box, LogoAnalysis } from './logoPixels'

/**
 * A picked logo, made into the files the letterhead and its emails use
 * (convex/lib/businessLogo.ts).
 *
 * Not `prepareUpload`, which is for photos: that saves everything as a JPEG,
 * and a JPEG has no transparency — a browser saving one paints every clear
 * pixel black, which turned a transparent logo into a black box on every
 * report until Sept 2026. And a photo is kept as it was taken, where a logo is
 * trimmed to its artwork, so it fills the box it is printed in rather than a
 * corner of it.
 */

export type PreparedLogo = {
  /** The logo, trimmed: what the PDF prints and Settings shows. */
  logo: PreparedFile
  /** Its copy for email, drawn at `EMAIL_LOGO.scale`: on a white card for
   * the letterhead's logo, on the same geometry but clear for the one with
   * light lettering. `width` and `height` are the email's, in CSS pixels. */
  email: PreparedFile
  /** What the owner should hear about the picture, once it is up. */
  warning: LogoWarning | null
}

/**
 * - `darkBackground`: it sits on a dark box, which prints as one on paper.
 * - `lightLettering`: mostly white, so it vanishes on paper — it is the
 *   version for dark backgrounds, picked for the wrong row.
 * - `darkLettering`: mostly black, so it vanishes in a dark email — the
 *   other way round.
 */
export type LogoWarning = 'darkBackground' | 'lightLettering' | 'darkLettering'

type PreparedFile = { blob: Blob; width: number; height: number }

/** A file this browser could not draw: not a picture, or not one it knows. */
export class UnreadableImageError extends Error {
  constructor() {
    super('unreadable image')
  }
}

/**
 * Pixels read at most this big to find the artwork. What is kept is cut
 * from the picture itself, so reading it smaller loses nothing.
 */
const READ_EDGE = 2400

/**
 * What a logo may weigh. Every report's PDF embeds it and every report email
 * attaches that PDF: a logo is a few hundred kilobytes, where a photograph
 * saved as a PNG runs to several megabytes.
 */
const LOGO_BUDGET = 1024 * 1024

/** The long edges tried, in turn, for a logo still over budget. */
const SMALLER = [1200, 900, 700]

/** `--paper`, which the card is and a JPEG is flattened onto: white in both
 * themes. */
const PAPER = '#ffffff'

export async function prepareLogo(
  file: Blob,
  as: 'logo' | 'logoOnDark',
): Promise<PreparedLogo> {
  const canvases = new Canvases()
  try {
    const drawn =
      (file.type === 'image/svg+xml'
        ? await drawVector(file, canvases)
        : null) ?? (await drawPicture(file, canvases))
    const { analysis, kept } = drawn
    return {
      logo: await withinBudget(
        kept,
        logoEncoding(file.type, analysis.transparent),
        analysis.transparent,
        canvases,
      ),
      email: await emailCopy(kept, as, canvases),
      warning: warningFor(analysis, as),
    }
  } finally {
    canvases.release()
  }
}

type Drawn = { analysis: LogoAnalysis; kept: HTMLCanvasElement }

/** A photo or a graphic: read small to find the artwork, then cut from the
 * picture itself at up to `LOGO_MAX_EDGE`. */
async function drawPicture(file: Blob, canvases: Canvases): Promise<Drawn> {
  const picture = await decode(file)
  try {
    const scale = Math.min(
      1,
      READ_EDGE / Math.max(picture.width, picture.height),
    )
    const read = canvases.make(
      Math.max(1, Math.round(picture.width * scale)),
      Math.max(1, Math.round(picture.height * scale)),
    )
    read.context.drawImage(picture.source, 0, 0, read.el.width, read.el.height)
    const analysis = analyseLogo(
      read.context.getImageData(0, 0, read.el.width, read.el.height),
    )
    canvases.free(read.el)
    const box = analysis.box
    const cut = {
      x: box.x / scale,
      y: box.y / scale,
      width: box.width / scale,
      height: box.height / scale,
    }
    const keep = Math.min(1, LOGO_MAX_EDGE / Math.max(cut.width, cut.height))
    const kept = resample(
      picture.source,
      cut,
      {
        width: Math.max(1, Math.round(cut.width * keep)),
        height: Math.max(1, Math.round(cut.height * keep)),
      },
      canvases,
    )
    return { analysis, kept }
  } finally {
    picture.close()
  }
}

/**
 * An SVG: read to find the artwork, then drawn again from the vector with its
 * view box cut to that artwork, at `LOGO_MAX_EDGE`. A logo on a big artboard
 * — a designer's A4 page — would otherwise be kept a few hundred pixels wide.
 * Null for an SVG this cannot take apart; it is then drawn as a picture.
 */
async function drawVector(
  file: Blob,
  canvases: Canvases,
): Promise<Drawn | null> {
  const svg = parseSvg(await file.text())
  if (!svg) return null
  const whole = svg.viewBox
  const scale = LOGO_MAX_EDGE / Math.max(whole.width, whole.height)
  const read = await renderSvg(
    svg.root,
    whole,
    Math.max(1, Math.round(whole.width * scale)),
    Math.max(1, Math.round(whole.height * scale)),
    canvases,
  )
  const analysis = analyseLogo(
    read.context.getImageData(0, 0, read.el.width, read.el.height),
  )
  canvases.free(read.el)
  const box = analysis.box
  const keep = LOGO_MAX_EDGE / Math.max(box.width, box.height)
  const kept = await renderSvg(
    svg.root,
    {
      x: whole.x + box.x / scale,
      y: whole.y + box.y / scale,
      width: box.width / scale,
      height: box.height / scale,
    },
    Math.max(1, Math.round(box.width * keep)),
    Math.max(1, Math.round(box.height * keep)),
    canvases,
  )
  return { analysis, kept: kept.el }
}

/** The SVG's root and the box its drawing is in, or null if it has none
 * this can use: a percentage size, or units other than pixels. */
function parseSvg(text: string): { root: Element; viewBox: Box } | null {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = doc.documentElement
  if (
    root.nodeName.toLowerCase() !== 'svg' ||
    doc.getElementsByTagName('parsererror').length > 0
  ) {
    return null
  }
  const box = (root.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (
    box.length === 4 &&
    box.every(Number.isFinite) &&
    box[2] > 0 &&
    box[3] > 0
  ) {
    return {
      root,
      viewBox: { x: box[0], y: box[1], width: box[2], height: box[3] },
    }
  }
  const px = (value: string | null) =>
    value && /^\s*[\d.]+\s*(px)?\s*$/.test(value) ? parseFloat(value) : NaN
  const width = px(root.getAttribute('width'))
  const height = px(root.getAttribute('height'))
  return width > 0 && height > 0
    ? { root, viewBox: { x: 0, y: 0, width, height } }
    : null
}

/** Part of an SVG's drawing, rendered at a size. The browser draws it from
 * the vector, so it is sharp at any size; as an image, it runs no script. */
async function renderSvg(
  root: Element,
  viewBox: Box,
  width: number,
  height: number,
  canvases: Canvases,
) {
  const clone = root.cloneNode(true) as Element
  clone.setAttribute(
    'viewBox',
    `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`,
  )
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  // The size was worked out from the box's own shape; only rounding differs.
  clone.setAttribute('preserveAspectRatio', 'none')
  const picture = await loadImage(
    new Blob([new XMLSerializer().serializeToString(clone)], {
      type: 'image/svg+xml',
    }),
  )
  try {
    const out = canvases.make(width, height)
    out.context.drawImage(picture.source, 0, 0, width, height)
    return out
  } finally {
    picture.close()
  }
}

type Decoded = {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

/** The picture as something a canvas draws, orientation baked in. */
async function decode(file: Blob): Promise<Decoded> {
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
    })
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    }
  } catch {
    // What a bitmap cannot be made of, an <img> sometimes can: an SVG this
    // could not take apart, in some browsers a HEIC.
    return loadImage(file)
  }
}

async function loadImage(file: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('no size')
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    }
  } catch {
    URL.revokeObjectURL(url)
    throw new UnreadableImageError()
  }
}

/**
 * Part of a picture, scaled to a size. Halved a step at a time first: one
 * big jump down skips pixels and leaves lettering ragged, where halving
 * averages every one of them. Drawn straight across when no halving is due.
 */
function resample(
  source: CanvasImageSource,
  rect: Box,
  size: { width: number; height: number },
  canvases: Canvases,
): HTMLCanvasElement {
  let from = source
  let area = rect
  let step: HTMLCanvasElement | null = null
  while (area.width / 2 >= size.width && area.height / 2 >= size.height) {
    const half = canvases.make(
      Math.max(1, Math.round(area.width / 2)),
      Math.max(1, Math.round(area.height / 2)),
    )
    half.context.drawImage(
      from,
      area.x,
      area.y,
      area.width,
      area.height,
      0,
      0,
      half.el.width,
      half.el.height,
    )
    // The step before is done with: give its memory back now.
    if (step) canvases.free(step)
    step = half.el
    from = half.el
    area = { x: 0, y: 0, width: half.el.width, height: half.el.height }
  }
  const done = canvases.make(size.width, size.height)
  done.context.drawImage(
    from,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    size.width,
    size.height,
  )
  if (step) canvases.free(step)
  return done.el
}

/**
 * The logo saved, and within `LOGO_BUDGET`: a photograph that came as a PNG
 * is saved as a JPEG instead, and anything still too heavy is made smaller.
 */
async function withinBudget(
  kept: HTMLCanvasElement,
  type: 'image/png' | 'image/jpeg',
  transparent: boolean,
  canvases: Canvases,
): Promise<PreparedFile> {
  let current = kept
  let format = type
  let blob = await encode(current, format, canvases)
  if (blob.size > LOGO_BUDGET && format === 'image/png' && !transparent) {
    format = 'image/jpeg'
    blob = await encode(current, format, canvases)
  }
  for (const edge of SMALLER) {
    if (blob.size <= LOGO_BUDGET) break
    const longest = Math.max(current.width, current.height)
    if (longest <= edge) continue
    current = resample(
      current,
      { x: 0, y: 0, width: current.width, height: current.height },
      {
        width: Math.max(1, Math.round((current.width * edge) / longest)),
        height: Math.max(1, Math.round((current.height * edge) / longest)),
      },
      canvases,
    )
    blob = await encode(current, format, canvases)
  }
  return { blob, width: current.width, height: current.height }
}

/** The logo's copy for email: fitted to the email's box, with the card's
 * margin round it, white for the letterhead's logo and clear for the other. */
async function emailCopy(
  kept: HTMLCanvasElement,
  as: 'logo' | 'logoOnDark',
  canvases: Canvases,
): Promise<PreparedFile> {
  const fitted = fitEmailLogo(kept.width, kept.height)
  const card = emailCardSize(fitted)
  const S = EMAIL_LOGO.scale
  const copy = canvases.make(card.width * S, card.height * S)
  if (as === 'logo') {
    copy.context.fillStyle = PAPER
    roundedRect(
      copy.context,
      copy.el.width,
      copy.el.height,
      EMAIL_LOGO.radius * S,
    )
    copy.context.fill()
  }
  const inner = resample(
    kept,
    { x: 0, y: 0, width: kept.width, height: kept.height },
    { width: fitted.width * S, height: fitted.height * S },
    canvases,
  )
  copy.context.drawImage(inner, EMAIL_LOGO.padding * S, EMAIL_LOGO.padding * S)
  return {
    blob: await encode(copy.el, 'image/png', canvases),
    width: card.width,
    height: card.height,
  }
}

function warningFor(
  analysis: LogoAnalysis,
  as: 'logo' | 'logoOnDark',
): LogoWarning | null {
  if (as === 'logoOnDark') {
    return analysis.tone === 'dark' ? 'darkLettering' : null
  }
  if (analysis.darkBackground) return 'darkBackground'
  return analysis.tone === 'light' ? 'lightLettering' : null
}

/** A rounded rectangle filling the canvas, drawn by hand: `roundRect` is
 * missing from the iPhones still on iOS 15. */
function roundedRect(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(r, 0)
  context.arcTo(width, 0, width, height, r)
  context.arcTo(width, height, 0, height, r)
  context.arcTo(0, height, 0, 0, r)
  context.arcTo(0, 0, width, 0, r)
  context.closePath()
}

/** A canvas saved as a file. A JPEG is flattened onto white first: any edge
 * pixel less than opaque would otherwise be saved onto black. */
async function encode(
  el: HTMLCanvasElement,
  type: 'image/png' | 'image/jpeg',
  canvases: Canvases,
): Promise<Blob> {
  let target = el
  if (type === 'image/jpeg') {
    const flat = canvases.make(el.width, el.height)
    flat.context.fillStyle = PAPER
    flat.context.fillRect(0, 0, el.width, el.height)
    flat.context.drawImage(el, 0, 0)
    target = flat.el
  }
  const blob = await new Promise<Blob | null>((resolve) =>
    target.toBlob(resolve, type, type === 'image/jpeg' ? 0.92 : undefined),
  )
  if (target !== el) canvases.free(target)
  if (!blob) throw new UnreadableImageError()
  return blob
}

/**
 * The canvases one logo is drawn with, freed as soon as each is done with.
 * Safari caps the memory all of a page's canvases may hold together and only
 * gives it back when it collects garbage, so a few picks in a row could
 * otherwise leave nothing to draw the next one with.
 */
class Canvases {
  private held = new Set<HTMLCanvasElement>()

  make(width: number, height: number) {
    const el = document.createElement('canvas')
    el.width = width
    el.height = height
    const context = el.getContext('2d')
    if (!context) throw new UnreadableImageError()
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    this.held.add(el)
    return { el, context }
  }

  free(el: HTMLCanvasElement) {
    el.width = 0
    el.height = 0
    this.held.delete(el)
  }

  release() {
    for (const el of this.held) {
      el.width = 0
      el.height = 0
    }
    this.held.clear()
  }
}
