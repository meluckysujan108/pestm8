import type { MarkupPoint } from './types'

/**
 * One stroke of the markup pen, from pointer positions to the points that are
 * saved and the path that is drawn — kept apart from the DOM so the rules can
 * be tested.
 *
 * A point is a fraction of the page as displayed (0–1 from its top-left), the
 * shape every stored stroke already has. It is worked out against the page
 * slot's `getBoundingClientRect`, which includes the stage's gesture
 * transform, so a point taken mid-pinch or mid-settle still lands on the words
 * under the finger.
 */

/**
 * Closer than this to the last point kept, in CSS pixels on screen, and a
 * point adds nothing anyone could see: a finger resting still sends a stream
 * of them, and every one is a row's worth of bytes on every teammate's phone.
 */
export const MIN_POINT_GAP = 1.5

/**
 * The most points in one stroke. The stroke simply ends there — the finger
 * has to lift and land again to go on — rather than being split into two
 * saves behind the person's back: half a minute of unbroken scribble on the
 * fastest screen, and well inside what the server takes for one stroke.
 */
export const MAX_STROKE_POINTS = 2000

/** Where the page is on screen: a `DOMRect`, or anything shaped like one. */
export type PageBox = {
  left: number
  top: number
  width: number
  height: number
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/**
 * The page point under a pointer, clamped to the page: a stroke that runs off
 * the edge runs along it, and never stores a point the page cannot show. Null
 * for a page with no size yet (nothing to be a fraction of).
 */
export function pagePoint(
  clientX: number,
  clientY: number,
  box: PageBox,
): MarkupPoint | null {
  if (!(box.width > 0) || !(box.height > 0)) return null
  const x = (clientX - box.left) / box.width
  const y = (clientY - box.top) / box.height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: clamp01(x), y: clamp01(y) }
}

/**
 * Adds `point` to a stroke being drawn, in place — the pointer handlers call
 * this for every coalesced event, so it allocates nothing.
 *
 * `'skipped'` when it is within `MIN_POINT_GAP` of the last point kept (the
 * gap measured on screen, so a stroke drawn at 5x keeps its fine detail), and
 * `'full'` once the stroke holds `MAX_STROKE_POINTS`: the caller ends it
 * there.
 */
export function addPoint(
  points: Array<MarkupPoint>,
  point: MarkupPoint,
  box: Pick<PageBox, 'width' | 'height'>,
): 'added' | 'skipped' | 'full' {
  if (points.length >= MAX_STROKE_POINTS) return 'full'
  const last = points.at(-1)
  if (
    last &&
    Math.hypot(
      (point.x - last.x) * box.width,
      (point.y - last.y) * box.height,
    ) < MIN_POINT_GAP
  ) {
    return 'skipped'
  }
  points.push(point)
  return points.length >= MAX_STROKE_POINTS ? 'full' : 'added'
}

/**
 * Stored strokes are drawn as they were saved, off-page points included —
 * the old canvas captured the pointer, so some rows run a little past the
 * edge, and the overlay's `overflow: hidden` clips them exactly as that
 * canvas did. This bound only keeps an absurd number (an old row saved
 * before points were checked) from reaching the path parser.
 */
const DRAW_BOUND = 10

/** Five places: under a twentieth of a pixel on a page drawn 4,400px wide. */
function coordinate(n: number): string {
  const bounded = Math.min(DRAW_BOUND, Math.max(-DRAW_BOUND, n))
  return String(Math.round(bounded * 1e5) / 1e5)
}

/**
 * An SVG path through `points`, in the overlay's 0–1 viewBox. A single point
 * is a dot — a zero-length line, which the round cap draws as one — because
 * a tap with the pen is a mark someone meant. Points that are not numbers
 * are left out rather than breaking the whole path.
 */
export function pathData(points: ReadonlyArray<MarkupPoint>): string {
  let d = ''
  let count = 0
  let lastX = ''
  let lastY = ''
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    lastX = coordinate(point.x)
    lastY = coordinate(point.y)
    d += `${count === 0 ? 'M' : 'L'}${lastX} ${lastY}`
    count++
  }
  if (count === 1) d += `L${lastX} ${lastY}`
  return d
}

const paths = new WeakMap<ReadonlyArray<MarkupPoint>, string>()

/**
 * `pathData`, remembered per points array: a page's marks are drawn again
 * each time the page comes back near the screen, and the arrays themselves
 * only change when the marks do.
 */
export function cachedPathData(points: ReadonlyArray<MarkupPoint>): string {
  let d = paths.get(points)
  if (d === undefined) {
    d = pathData(points)
    paths.set(points, d)
  }
  return d
}
