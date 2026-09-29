import {
  EMAIL_LOGO,
  LOGO_MAX_EDGE,
  emailCardSize,
  fitEmailLogo,
} from '../../../convex/lib/businessLogo'
import { analyseLogo, logoEncoding } from './logoPixels'
import type { Box } from './logoPixels'

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
  /** It sits on a dark box, which prints as one on white paper. */
  darkBackground: boolean
}

type PreparedFile = { blob: Blob; width: number; height: number }

/** A file this browser could not draw: not a picture, or not one it knows. */
export class UnreadableImageError extends Error {
  constructor() {
    super('unreadable image')
  }
}

/**
 * Pixels read at most this big. More is only slower: what is kept is
 * `LOGO_MAX_EDGE`, and the trim is found as well on this.
 */
const READ_EDGE = 2400

/** `--paper`, which is what the card is: white in both themes. */
const PAPER = '#ffffff'

export async function prepareLogo(
  file: Blob,
  as: 'logo' | 'logoOnDark',
): Promise<PreparedLogo> {
  const picture = await decode(file)
  try {
    // An SVG has no pixels of its own: draw it at the size it is kept at.
    const vector = file.type === 'image/svg+xml'
    const longest = Math.max(picture.width, picture.height)
    const scale = vector
      ? LOGO_MAX_EDGE / longest
      : Math.min(1, READ_EDGE / longest)
    const read = canvas(
      Math.max(1, Math.round(picture.width * scale)),
      Math.max(1, Math.round(picture.height * scale)),
    )
    read.context.drawImage(picture.source, 0, 0, read.el.width, read.el.height)

    const analysis = analyseLogo(
      read.context.getImageData(0, 0, read.el.width, read.el.height),
    )
    const { box } = analysis

    // The logo, trimmed, no longer than LOGO_MAX_EDGE.
    const keep = Math.min(1, LOGO_MAX_EDGE / Math.max(box.width, box.height))
    const kept = shrink(read.el, box, {
      width: Math.max(1, Math.round(box.width * keep)),
      height: Math.max(1, Math.round(box.height * keep)),
    })
    const type = logoEncoding(file.type, analysis.transparent)
    const logo = {
      blob: await encode(kept, type),
      width: kept.width,
      height: kept.height,
    }

    // Its email copy: fitted to the email's box, with the card's margin.
    const fitted = fitEmailLogo(box.width, box.height)
    const card = emailCardSize(fitted)
    const S = EMAIL_LOGO.scale
    const copy = canvas(card.width * S, card.height * S)
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
    const inner = shrink(read.el, box, {
      width: fitted.width * S,
      height: fitted.height * S,
    })
    copy.context.drawImage(
      inner,
      EMAIL_LOGO.padding * S,
      EMAIL_LOGO.padding * S,
    )
    const email = {
      blob: await encode(copy.el, 'image/png'),
      width: card.width,
      height: card.height,
    }

    return {
      logo,
      email,
      darkBackground: as === 'logo' && analysis.darkBackground,
    }
  } finally {
    picture.close()
  }
}

/** The picture as something a canvas draws, orientation baked in. */
async function decode(file: Blob): Promise<{
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}> {
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
    // Some browsers will not make a bitmap of an SVG; an <img> draws one.
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
}

function canvas(width: number, height: number) {
  const el = document.createElement('canvas')
  el.width = width
  el.height = height
  const context = el.getContext('2d')
  if (!context) throw new UnreadableImageError()
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  return { el, context }
}

/**
 * Part of a canvas, scaled to a size. Halved a step at a time first: one
 * big jump down skips pixels and leaves lettering ragged, where halving
 * averages every one of them.
 */
function shrink(
  source: HTMLCanvasElement,
  box: Box,
  size: { width: number; height: number },
): HTMLCanvasElement {
  let current = canvas(box.width, box.height)
  current.context.drawImage(
    source,
    box.x,
    box.y,
    box.width,
    box.height,
    0,
    0,
    box.width,
    box.height,
  )
  while (
    current.el.width / 2 >= size.width &&
    current.el.height / 2 >= size.height
  ) {
    const half = canvas(
      Math.round(current.el.width / 2),
      Math.round(current.el.height / 2),
    )
    half.context.drawImage(current.el, 0, 0, half.el.width, half.el.height)
    current = half
  }
  const done = canvas(size.width, size.height)
  done.context.drawImage(current.el, 0, 0, size.width, size.height)
  return done.el
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

async function encode(
  el: HTMLCanvasElement,
  type: 'image/png' | 'image/jpeg',
): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) =>
    el.toBlob(resolve, type, type === 'image/jpeg' ? 0.92 : undefined),
  )
  if (!blob) throw new UnreadableImageError()
  return blob
}
