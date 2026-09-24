import type { MarkupPoint, MarkupStroke } from './types'

/**
 * Strokes that have been drawn but are not yet in the caller's marks.
 *
 * A finished stroke has to stay on the page while it saves and until the
 * marks that include it arrive, or it vanishes when the finger lifts and
 * reappears a moment later. The old canvas only looked optimistic by accident
 * (it never cleared what the finger drew); a layer drawn from data needs to
 * hold the stroke on purpose.
 *
 * The hard part is letting go of it without a blink. The save coming back is
 * not enough on its own: the marks that include the stroke can reach the
 * screen a render later than the promise settles. So a saved stroke goes when
 * the marks on screen are seen to hold it — its id, when the caller hands one
 * back, or the same points — or when a newer set of marks than the one on
 * screen at the save arrives (which also covers an Undo that removed it), or,
 * failing both, after `PENDING_FALLBACK_MS`. Until then it is drawn exactly
 * on top of its saved twin, in the same colour, which cannot be seen.
 */

export const PENDING_FALLBACK_MS = 2000

export type Strokes = ReadonlyMap<number, ReadonlyArray<MarkupStroke>>

export type PendingMark = {
  /** Local, for React: `pending-3`. */
  key: string
  /** 0-based. */
  page: number
  points: ReadonlyArray<MarkupPoint>
  /** Null while the save is out. */
  saved: {
    /** The marks on screen when the save came back. */
    strokes: Strokes | undefined
    at: number
    /** The new stroke's id, if the caller's save resolved with one. */
    id: string | null
  } | null
}

function samePoints(
  a: ReadonlyArray<MarkupPoint>,
  b: ReadonlyArray<MarkupPoint>,
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return false
  }
  return true
}

/** Whether `strokes` visibly holds this mark already. */
function holds(strokes: Strokes | undefined, mark: PendingMark): boolean {
  const onPage = strokes?.get(mark.page)
  if (!onPage) return false
  const id = mark.saved?.id
  return onPage.some(
    (stroke) =>
      (id != null && stroke.id === id) ||
      (stroke.mine && samePoints(stroke.points, mark.points)),
  )
}

/** Whether a saved mark can stop being drawn: see the file comment. */
export function settled(
  mark: PendingMark,
  strokes: Strokes | undefined,
  now: number,
): boolean {
  const { saved } = mark
  if (!saved) return false
  return (
    strokes !== saved.strokes ||
    holds(strokes, mark) ||
    now - saved.at >= PENDING_FALLBACK_MS
  )
}

/** Drops every mark that has settled; the same list if none has. */
export function reconcile(
  list: ReadonlyArray<PendingMark>,
  strokes: Strokes | undefined,
  now: number,
): ReadonlyArray<PendingMark> {
  const next = list.filter((mark) => !settled(mark, strokes, now))
  return next.length === list.length ? list : next
}

/**
 * The save of `key` came back. `strokes` is what is on screen at that moment:
 * a newer set of marks than this is taken to include the stroke.
 */
export function markSaved(
  list: ReadonlyArray<PendingMark>,
  key: string,
  strokes: Strokes | undefined,
  now: number,
  id: string | null,
): ReadonlyArray<PendingMark> {
  const next = list.map((mark) =>
    mark.key === key ? { ...mark, saved: { strokes, at: now, id } } : mark,
  )
  return reconcile(next, strokes, now)
}

/** The save of `key` failed: the stroke goes, and the viewer says so. */
export function dropMark(
  list: ReadonlyArray<PendingMark>,
  key: string,
): ReadonlyArray<PendingMark> {
  const next = list.filter((mark) => mark.key !== key)
  return next.length === list.length ? list : next
}

/**
 * When the next saved mark runs out of `PENDING_FALLBACK_MS`, or null if none
 * is waiting on it.
 */
export function nextFallback(list: ReadonlyArray<PendingMark>): number | null {
  let soonest: number | null = null
  for (const mark of list) {
    if (!mark.saved) continue
    const due = mark.saved.at + PENDING_FALLBACK_MS
    if (soonest === null || due < soonest) soonest = due
  }
  return soonest
}

/** The pending marks by page, for the page slots. */
export function byPage(
  list: ReadonlyArray<PendingMark>,
): ReadonlyMap<number, ReadonlyArray<PendingMark>> {
  const pages = new Map<number, Array<PendingMark>>()
  for (const mark of list) {
    const onPage = pages.get(mark.page)
    if (onPage) onPage.push(mark)
    else pages.set(mark.page, [mark])
  }
  return pages
}
