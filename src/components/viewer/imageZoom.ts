import {
  IDENTITY,
  MAX_ZOOM,
  MIN_ZOOM,
  zoomTransformAround,
} from '#/components/pdf/layout'
import type { Point, StageTransform } from '#/components/pdf/layout'

/**
 * The image viewer's zoom and pan, as pure functions of sizes and points.
 *
 * The same model as the PDF viewer's pinch (`layout.ts`): the picture sits
 * fitted inside a stage the size of the screen, and the stage is moved with
 * `translate(tx, ty) scale(s)` from its top-left corner, so a gesture costs
 * the compositor a matrix and never React a layout. `zoomTransformAround` is
 * that file's, used here with no scroll, since nothing here scrolls.
 *
 * Kept apart from the component so the part that decides where a picture
 * ends up — the part that gets a licence number stuck off the edge of the
 * screen when it is wrong — can be tested without a browser.
 */

export type Size = { width: number; height: number }
export type Box = { x: number; y: number; width: number; height: number }

export { IDENTITY }
export type { Point, StageTransform }

/** How far a double tap zooms in: enough to read a licence number on a card
 * photographed at arm's length. */
export const DOUBLE_TAP_ZOOM = 2.5

/**
 * Where the picture sits in the stage before any zoom: as large as fits,
 * centred — what `object-fit: contain` draws. Empty until both sizes are known.
 */
export function fittedBox(stage: Size, image: Size): Box {
  if (
    stage.width <= 0 ||
    stage.height <= 0 ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scale = Math.min(stage.width / image.width, stage.height / image.height)
  const width = image.width * scale
  const height = image.height * scale
  return {
    x: (stage.width - width) / 2,
    y: (stage.height - height) / 2,
    width,
    height,
  }
}

/**
 * A transform the picture can actually be left at: zoom within the range,
 * and moved no further than keeps it on screen — centred on an axis where it
 * is smaller than the stage, edge to edge where it is larger, so a pan never
 * leaves blank space beside a picture that could fill it.
 */
export function clampTransform(
  transform: StageTransform,
  stage: Size,
  fitted: Box,
): StageTransform {
  const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, transform.s))
  return {
    s,
    tx: clampAxis(transform.tx, s, fitted.x, fitted.width, stage.width),
    ty: clampAxis(transform.ty, s, fitted.y, fitted.height, stage.height),
  }
}

function clampAxis(
  t: number,
  s: number,
  start: number,
  length: number,
  room: number,
): number {
  const shown = length * s
  // Smaller than the stage: centred.
  if (shown <= room) return (room - shown) / 2 - start * s
  // Larger: its edges no further in than the stage's.
  const least = room - (start + length) * s
  const most = 0 - start * s
  return Math.min(most, Math.max(least, t))
}

/**
 * A pinch or a trackpad zoom by `factor` about screen point `q`, kept to what
 * can be shown.
 */
export function zoomBy(
  transform: StageTransform,
  q: Point,
  factor: number,
  stage: Size,
  fitted: Box,
): StageTransform {
  const next = zoomTransformAround(transform, { x: 0, y: 0 }, q, factor)
  // Held at the ends of the range about the same point, rather than letting
  // the clamp below slide the picture sideways as the zoom stops.
  const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next.s))
  const held =
    s === next.s
      ? next
      : zoomTransformAround(transform, { x: 0, y: 0 }, q, s / transform.s)
  return clampTransform(held, stage, fitted)
}

/** A one-finger drag, or a two-finger scroll, by `delta`. */
export function panBy(
  transform: StageTransform,
  delta: Point,
  stage: Size,
  fitted: Box,
): StageTransform {
  return clampTransform(
    { s: transform.s, tx: transform.tx + delta.x, ty: transform.ty + delta.y },
    stage,
    fitted,
  )
}

/**
 * A double tap: in to `DOUBLE_TAP_ZOOM` on the point tapped, or back out to
 * the whole picture when already zoomed.
 */
export function doubleTap(
  transform: StageTransform,
  q: Point,
  stage: Size,
  fitted: Box,
): StageTransform {
  if (transform.s > MIN_ZOOM + 0.05) {
    return clampTransform(IDENTITY, stage, fitted)
  }
  return zoomBy(transform, q, DOUBLE_TAP_ZOOM / transform.s, stage, fitted)
}
