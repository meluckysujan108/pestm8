/**
 * Report markup: what one stroke on a report's PDF may be, and how much of it
 * one report may hold, in one place both ends can read.
 *
 * Pure and import-free on purpose, like `lib/products`: the viewer can import
 * these numbers to cut a long scribble short or pull a point back from off
 * the page before it is ever sent, by exactly the rule
 * `reportAnnotations.addStroke` enforces. Nothing here may reach for the
 * database or anything else a browser bundle cannot load.
 *
 * Strokes went unchecked until the new viewer. The old canvas only ever sent
 * real numbers, if sometimes off the page, but the mutation is public, and a
 * stroke is drawn on every teammate's phone that opens the report — a page of
 * `NaN` or a million points is somebody else's broken screen, not just the
 * sender's.
 */

/** Pages are counted from 1, as stored. A report runs to a handful; a
 * building inspection with every photo on its own page to a few dozen. */
export const MAX_MARKUP_PAGE = 500

/**
 * The most points in one stroke. A finger drawing for a full second gives
 * sixty to a hundred and twenty, depending on the phone's screen; this is half
 * a minute of unbroken scribble on the fastest of them. It keeps one stroke at
 * about 100 KB, a tenth of a Convex document, and well inside the 8,192 items
 * an argument array may carry at all.
 */
export const MAX_POINTS_PER_STROKE = 4096

/**
 * The most strokes one report keeps.
 *
 * The marks are read whole — every stroke on every page, in one query — so this
 * is also that query's window: `listForReport` reads at most this many rows,
 * and `addStroke` refuses the one past it rather than save a mark nobody would
 * ever be shown. The same reasoning as `MAX_PRODUCTS`.
 */
export const MAX_STROKES_PER_REPORT = 2000

/**
 * The most points one report keeps, across every stroke.
 *
 * The stroke count alone does not bound what `listForReport` reads: 2,000
 * strokes of 4,096 points is about 200 MB, twelve times what one query may
 * read, and the marks would stop loading for everyone at once. A point costs
 * 24 bytes stored and about 40 on the wire, so this holds a report's marks
 * near 2.5 MB read and 4 MB sent — room for a thousand circled spots — and it
 * is the same refusal as the stroke count, since to the person drawing both
 * mean "this report is full of marks".
 */
export const MAX_POINTS_PER_REPORT = 100_000

/**
 * How far off the page a point is kept.
 *
 * Points are fractions of the page as displayed, 0–1. The old canvas captured
 * the pointer, so a stroke that ran off the edge kept going and stored points
 * outside it; those rows exist and are still drawn (the viewer clamps). A
 * point past this band is pulled in to it rather than refused: the old viewer
 * — live until the new one ships, and on an installed phone for a while after
 * — shows a stroke as drawn and never hears of a refusal, so refusing one run
 * far off the page would lose the whole mark without a word. Pulled in, the
 * part on the page is unchanged and the part off it stays off it, undrawn.
 */
export const MIN_COORDINATE = -0.5
export const MAX_COORDINATE = 1.5

export type StrokePoint = { x: number; y: number }

function clampCoordinate(value: number): number {
  return Math.min(MAX_COORDINATE, Math.max(MIN_COORDINATE, value))
}

/**
 * The stroke as it is kept, or null when it may not be saved at all: a page
 * that is not a whole number in range, no points or more than a stroke may
 * hold, or a coordinate that is not a real number. A single point is a dot,
 * which is a mark someone meant. Coordinates off the page are pulled in to the
 * band around it (above) — a finger that ran off the edge, not a bad stroke.
 */
export function strokeToStore(
  page: number,
  points: ReadonlyArray<StrokePoint>,
): Array<StrokePoint> | null {
  if (!Number.isInteger(page) || page < 1 || page > MAX_MARKUP_PAGE) {
    return null
  }
  if (points.length < 1 || points.length > MAX_POINTS_PER_STROKE) return null
  const finite = points.every(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
  )
  if (!finite) return null
  return points.map((point) => ({
    x: clampCoordinate(point.x),
    y: clampCoordinate(point.y),
  }))
}
