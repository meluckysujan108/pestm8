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
 * the marks on screen are seen to hold it — by the id the save hands back —
 * or when a newer set of marks than the one on screen at the save arrives
 * (which also covers an Undo that removed it), or, failing both, after
 * `PENDING_FALLBACK_MS`. Until then it is drawn exactly on top of its saved
 * twin, in the same colour, which cannot be seen.
 *
 * A stroke can also be taken back before its save comes back — by an Undo
 * aimed at it, or a Clear of its page (`localMarks.ts`). It stays in this
 * list, undrawn, until the save says how it went: that is when the Undo
 * learns which stored mark to remove.
 *
 * ── Knowing the twin before the save names it ─────────────────────────────
 *
 * The marks can hold the stroke a moment before its save comes back, and an
 * Undo aimed at it then must hide that stored twin too — shown, it would be
 * back on screen after its Undo, and the next Undo's choice. Before the save
 * there is no id, only the points: one of your strokes on the page with
 * exactly these points.
 *
 * Points alone are not enough. A tap that does not move is a one-point
 * stroke, and two taps on one spot give the same point exactly — nothing
 * between the finger and the record rounds or moves it. Taking your older
 * dot there for the new one's twin hid it along with the new one, and the
 * next Undo passed it over and deleted a mark older still. So each stroke
 * carries `others`: the ids of your strokes it is known not to be — those on
 * its page as it was drawn, and those that another stroke's save named
 * since. A twin by points is only ever a stroke that arrived after it and
 * that nothing else has claimed. Once the save names the stroke, the id is
 * all that counts.
 */

export const PENDING_FALLBACK_MS = 2000

export type Strokes = ReadonlyMap<number, ReadonlyArray<MarkupStroke>>

export type PendingMark = {
  /** Local, for React: `pending-3`. */
  key: string
  /** 0-based. */
  page: number
  points: ReadonlyArray<MarkupPoint>
  /**
   * Ids of your strokes on this page that are not this one, whatever their
   * points: those on screen when it was drawn, and those other saves have
   * named since (see the file comment).
   */
  others: ReadonlySet<string>
  /** Null while the save is out. */
  saved: {
    /** The marks on screen when the save came back. */
    strokes: Strokes | undefined
    at: number
    /** The new stroke's id, as the caller's save resolved with it. */
    id: string
  } | null
  /**
   * Taken back while its save was out, and not drawn: by an Undo, or by the
   * Clear with this number. Only ever set while `saved` is null — a stroke
   * that has saved is taken back by its id instead.
   */
  taken: null | 'undo' | { clear: number }
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

/**
 * Whether `stroke`, on the same page, is this mark as the caller holds it:
 * its id, once the save has named one, or — for a save the marks got ahead
 * of — one of your own strokes with exactly its points that is not known to
 * be another mark (`others`).
 */
export function isTwin(stroke: MarkupStroke, mark: PendingMark): boolean {
  if (mark.saved !== null) return stroke.id === mark.saved.id
  return (
    stroke.mine &&
    !mark.others.has(stroke.id) &&
    samePoints(stroke.points, mark.points)
  )
}

/**
 * The ids of your strokes a stroke drawn now on `page` cannot be: those
 * `strokes` holds there, and those saves have named already that the marks
 * may not hold yet.
 */
export function othersOnPage(
  list: ReadonlyArray<PendingMark>,
  strokes: Strokes | undefined,
  page: number,
): ReadonlySet<string> {
  const others = new Set<string>()
  for (const stroke of strokes?.get(page) ?? []) {
    if (stroke.mine) others.add(stroke.id)
  }
  for (const mark of list) {
    if (mark.page === page && mark.saved) others.add(mark.saved.id)
  }
  return others
}

/**
 * The save of `key` named its stroke `id`: that stroke is no other mark's
 * twin, so every other stroke on its page still waiting for a name of its
 * own learns so. The same list if none is.
 */
export function claimId(
  list: ReadonlyArray<PendingMark>,
  key: string,
  id: string,
): ReadonlyArray<PendingMark> {
  const named = list.find((mark) => mark.key === key)
  if (!named) return list
  const waiting = (mark: PendingMark) =>
    mark !== named && mark.page === named.page && mark.saved === null
  if (!list.some(waiting)) return list
  return list.map((mark) =>
    waiting(mark) ? { ...mark, others: new Set(mark.others).add(id) } : mark,
  )
}

/** Whether `strokes` visibly holds this mark already. */
function holds(strokes: Strokes | undefined, mark: PendingMark): boolean {
  const onPage = strokes?.get(mark.page)
  if (!onPage) return false
  return onPage.some((stroke) => isTwin(stroke, mark))
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
 * The save of `key` came back with the stroke's `id`. `strokes` is what is on
 * screen at that moment: a newer set of marks than this is taken to include
 * the stroke.
 */
export function markSaved(
  list: ReadonlyArray<PendingMark>,
  key: string,
  strokes: Strokes | undefined,
  now: number,
  id: string,
): ReadonlyArray<PendingMark> {
  const next = list.map((mark) =>
    mark.key === key ? { ...mark, saved: { strokes, at: now, id } } : mark,
  )
  return reconcile(next, strokes, now)
}

/** Drops the mark `key`: its save failed, or it has been taken back. */
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

/** The marks still drawn — none that has been taken back — by page, for the
 * page slots. */
export function byPage(
  list: ReadonlyArray<PendingMark>,
): ReadonlyMap<number, ReadonlyArray<PendingMark>> {
  const pages = new Map<number, Array<PendingMark>>()
  for (const mark of list) {
    if (mark.taken !== null) continue
    const onPage = pages.get(mark.page)
    if (onPage) onPage.push(mark)
    else pages.set(mark.page, [mark])
  }
  return pages
}
