import { getStroke } from 'perfect-freehand'

/**
 * The geometry of a signature, apart from any screen.
 *
 * A signature is kept as the strokes the pen made, not as the pixels it left:
 * from those it can be drawn again at any size — sharper for the PDF than it
 * ever was on the phone — refitted when the pad changes shape, and taken back
 * one stroke at a time. Pure, so every rule here is tested without a canvas.
 *
 * Coordinates are the pad's own, as the person signing sees it: CSS pixels
 * from its top-left corner, x to their right, y down. That holds even when
 * the pad is drawn a quarter turn round on a phone held upright (`turned`),
 * so a signature never has to be turned back the right way up afterwards.
 */

/** One sample of the pen: where, and when (ms). */
export type InkPoint = { x: number; y: number; t: number }
export type Stroke = Array<InkPoint>
export type Ink = Array<Stroke>

export type Box = { x: number; y: number; width: number; height: number }
export type Size = { width: number; height: number }

/** --ink, light: a signature is printed on white in both themes. */
export const INK_COLOUR = '#1C1C1E'

/**
 * The pen, in CSS pixels: a line from about 2 to 4 pixels across, the range of
 * a ballpoint or a fine felt-tip. Strokes start blunt, where the pen lands,
 * and taper a little where it lifts.
 */
const PEN = {
  size: 2.6,
  thinning: 0.55,
  smoothing: 0.5,
  streamline: 0.45,
  // Pressure is worked out here from the pen's speed (`pressuresOf`), not
  // by perfect-freehand from the gaps between samples: at a pen this fine
  // nearly every gap reads as fast, and the gaps depend on how often the
  // phone samples the screen — 60 or 120 times a second.
  simulatePressure: false,
  start: { cap: true, taper: 0 },
  end: { cap: true, taper: 6 },
}

/** CSS pixels per millisecond at and past which a line is as thin as it gets. */
const FAST = 1.5
/** The thinnest a quick stroke runs, as a pressure between 0 and 1. */
const LIGHTEST = 0.25
/** How much of the speed so far is kept over each `CARRY_SPAN` ms, so a
 * jittery finger draws an even line. Measured in time, not samples: a phone
 * that samples twice as often smooths over the same span. */
const CARRY = 0.7
const CARRY_SPAN = 16
/** The speed a stroke is taken to start at: an ordinary pace, not a halt. */
const STARTING_SPEED = 0.4

/**
 * How hard the pen pressed at each point, as a pen would show it. A finger on
 * an iPhone reports no pressure at all, so it comes from speed: a quick
 * stroke runs thin, a slow one pools.
 */
export function pressuresOf(stroke: Stroke): Array<number> {
  const pressures: Array<number> = []
  let speed = STARTING_SPEED
  stroke.forEach((point, index) => {
    const previous = index > 0 ? stroke[index - 1] : undefined
    // A sample stamped with the same moment as the last one says nothing
    // about speed, and keeps it as it was.
    const elapsed = previous ? point.t - previous.t : 0
    if (previous && elapsed > 0) {
      const moved = Math.hypot(point.x - previous.x, point.y - previous.y)
      const keep = CARRY ** (elapsed / CARRY_SPAN)
      speed = keep * speed + (1 - keep) * (moved / elapsed)
    }
    pressures.push(Math.max(LIGHTEST, 1 - speed / FAST))
  })
  return pressures
}

/**
 * Closer than this to the last point kept, in CSS pixels, and a point adds
 * nothing anyone could see — a resting finger sends a stream of them.
 */
export const MIN_POINT_GAP = 0.75

/**
 * Adds `point` to the stroke being drawn, in place, unless it is too close to
 * the last one to matter. The pointer handlers call this for every coalesced
 * event, so it allocates nothing.
 */
export function addPoint(stroke: Stroke, point: InkPoint): boolean {
  const last = stroke.at(-1)
  if (last && Math.hypot(point.x - last.x, point.y - last.y) < MIN_POINT_GAP) {
    return false
  }
  stroke.push(point)
  return true
}

/** Whether anything here is a signature: a stroke that moved, not a tap. */
export function hasInk(ink: Ink): boolean {
  return ink.some((stroke) => stroke.length > 1)
}

/**
 * How near a signature a lone tap has to be to count as part of it — the dot
 * on an i — rather than a tap that missed, or one to put a keyboard away.
 */
const NEAR = 40

/**
 * What of the pad is saved: every stroke that moved, and a tap only where it
 * sits by them. A stray dot in a corner would otherwise stretch the cut, and
 * the signature print half the size.
 */
export function inkToSave(ink: Ink): Ink {
  const box = pointBounds(ink.filter((stroke) => stroke.length > 1))
  if (!box) return []
  return ink.filter((stroke) => {
    if (stroke.length > 1) return true
    if (stroke.length === 0) return false
    const [point] = stroke
    return (
      point.x >= box.x - NEAR &&
      point.x <= box.x + box.width + NEAR &&
      point.y >= box.y - NEAR &&
      point.y <= box.y + box.height + NEAR
    )
  })
}

/** The box the pen's points cover, before the line's own width. */
function pointBounds(ink: Ink): Box | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const stroke of ink) {
    for (const { x, y } of stroke) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * The outline of one stroke, as a polygon to fill. `done` is false for the
 * stroke still being drawn, whose end is not tapered yet.
 */
export function outlineOf(
  stroke: Stroke,
  { done = true }: { done?: boolean } = {},
): Array<[number, number]> {
  const pressures = pressuresOf(stroke)
  return getStroke(
    stroke.map((point, index) => [point.x, point.y, pressures[index]]),
    { ...PEN, last: done },
  )
}

/**
 * An SVG path through an outline, smoothed into quadratic curves between the
 * midpoints of its sides (perfect-freehand's own recipe). Empty for an
 * outline too short to be a shape.
 */
export function pathOf(outline: ReadonlyArray<[number, number]>): string {
  if (outline.length < 4) return ''
  const mid = (a: number, b: number) => round((a + b) / 2)
  const [a, b, c] = outline
  let d = `M${round(a[0])},${round(a[1])} Q${round(b[0])},${round(b[1])} ${mid(b[0], c[0])},${mid(b[1], c[1])} T`
  for (let i = 2; i < outline.length - 1; i++) {
    const p = outline[i]
    const q = outline[i + 1]
    d += `${mid(p[0], q[0])},${mid(p[1], q[1])} `
  }
  return `${d}Z`
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * The box the ink covers, outlines and all — what is kept when the empty pad
 * around a signature is cut away. Null when nothing has been drawn.
 */
export function inkBounds(ink: Ink): Box | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const stroke of ink) {
    if (stroke.length === 0) continue
    for (const [x, y] of outlineOf(stroke)) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * The smallest piece of pad a signature is cut from, in CSS pixels: about the
 * shape of the PDF's box. Initials, or a short stroke, keep space round them,
 * so they print at the size they were drawn rather than blown up to fill the
 * box, line and all, as a smudge.
 */
const MIN_CUT: Size = { width: 240, height: 80 }

/**
 * The saved image: the ink and a margin round it, drawn large.
 *
 * The PDF prints a signature into a 150 x 52 pt box. The whole pad, empty
 * space and all, used to go into it, so a signature written small printed as
 * a smudge. Cut to the ink (never smaller than `MIN_CUT`), and drawn at least
 * `minLongSide` pixels across from the strokes rather than enlarged from the
 * screen's pixels, it fills the box and stays sharp; `maxLongSide` keeps the
 * file small.
 *
 * `scale` maps the pad's CSS pixels to the image's, and (`dx`, `dy`) is where
 * the pad's origin lands in it.
 */
export function exportPlan(
  bounds: Box,
  {
    margin = 10,
    minLongSide = 1200,
    maxLongSide = 2000,
  }: { margin?: number; minLongSide?: number; maxLongSide?: number } = {},
): { width: number; height: number; scale: number; dx: number; dy: number } {
  const inkWidth = bounds.width + margin * 2
  const inkHeight = bounds.height + margin * 2
  const boxWidth = Math.max(inkWidth, MIN_CUT.width)
  const boxHeight = Math.max(inkHeight, MIN_CUT.height)
  // The ink centred in a cut bigger than itself.
  const left = bounds.x - margin - (boxWidth - inkWidth) / 2
  const top = bounds.y - margin - (boxHeight - inkHeight) / 2
  const long = Math.max(boxWidth, boxHeight)
  const scale = Math.min(Math.max(minLongSide / long, 1), maxLongSide / long)
  return {
    width: Math.max(1, Math.round(boxWidth * scale)),
    height: Math.max(1, Math.round(boxHeight * scale)),
    scale,
    dx: -left * scale,
    dy: -top * scale,
  }
}

/** Where a pad is on screen: a `DOMRect`, or anything shaped like one. */
export type ScreenBox = { left: number; top: number; right: number }

/**
 * A pointer on screen, as a point on the pad.
 *
 * A `turned` pad is drawn a quarter turn clockwise, so it reads the right way
 * up on a phone held upright and turned anticlockwise onto its side: the
 * pad's x runs down the screen, and its y runs in from the screen's right
 * edge. Its on-screen box is still upright — a quarter turn of a rectangle is
 * a rectangle — which is all this needs.
 */
export function toInkPoint(
  clientX: number,
  clientY: number,
  box: ScreenBox,
  turned: boolean,
  t: number,
): InkPoint {
  return turned
    ? { x: clientY - box.top, y: box.right - clientX, t }
    : { x: clientX - box.left, y: clientY - box.top, t }
}

/**
 * The ink, kept on a pad that has changed size — the phone turned, the
 * browser's bars shown or hidden, a line of text above it. What was drawn
 * stays the size it was drawn and where it was, moved in only as far as it
 * must to stay on the pad; only ink bigger than the pad now is shrunk, evenly,
 * and centred. The same array when nothing has to move.
 */
export function fitInk(ink: Ink, to: Size): Ink {
  const box = pointBounds(ink)
  if (!box || to.width <= 0 || to.height <= 0) return ink
  // The line's own width stays on the pad too.
  const edge = PEN.size * 2
  const width = box.width + edge * 2
  const height = box.height + edge * 2
  const scale = Math.min(1, to.width / width, to.height / height)
  const left =
    scale < 1
      ? (to.width - width * scale) / 2
      : clamp(box.x - edge, 0, to.width - width)
  const top =
    scale < 1
      ? (to.height - height * scale) / 2
      : clamp(box.y - edge, 0, to.height - height)
  if (scale === 1 && left === box.x - edge && top === box.y - edge) return ink
  return ink.map((stroke) =>
    stroke.map((point) => ({
      x: (point.x - (box.x - edge)) * scale + left,
      y: (point.y - (box.y - edge)) * scale + top,
      t: point.t,
    })),
  )
}

function clamp(n: number, low: number, high: number): number {
  return Math.min(Math.max(n, low), high)
}

/**
 * Whether a signing screen is laid out a quarter turn round: on a phone held
 * upright, where a signature, which is wide, would otherwise have the narrow
 * side of the screen to go across. Turned onto its side, the phone gives it
 * the long side.
 *
 * A phone, by its screen: a tablet's narrow window (an iPad's Slide Over) is
 * upright whichever way the tablet is held, so turning it would never read
 * the right way up, and a computer is not turned on its side. `window` is
 * the layout's size, not what a pinch has zoomed into.
 */
export function turnsForSigning(window: Size, screen: Size): boolean {
  return (
    window.height > window.width &&
    window.width < 600 &&
    Math.min(screen.width, screen.height) < 600
  )
}
