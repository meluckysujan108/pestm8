import {
  claimId,
  dropMark,
  isTwin,
  markSaved,
  othersOnPage,
  reconcile,
} from './pendingMarks'
import type { PendingMark, Strokes } from './pendingMarks'
import type { MarkupPoint, MarkupStroke } from './types'

/**
 * What this viewer knows about the marks before the caller's `strokes` do:
 * the strokes still saving (`pendingMarks.ts`), and the marks Undo and Clear
 * are taking away.
 *
 * ── Undo is aimed when the thumb lands ────────────────────────────────────
 *
 * It used to be aimed later. Undo waited for the strokes still saving, then
 * asked the server for "my newest mark" — and a stroke drawn during that
 * wait reached the server first and was the one taken: the mark just drawn,
 * still on screen, gone from the record, and the one the Undo was meant for
 * left behind. Waiting cannot fix that; only choosing at the tap can.
 *
 * So the tap chooses (`undo`): the newest stroke of this session still drawn
 * — by the order it was drawn in, saved or not — and failing that the newest
 * of your stored marks still showing, by `order`. The mark goes from the
 * screen at once, and the tap is spent on it whatever happens next:
 *
 * - A stored mark is named to the caller's `removeStroke` straight away, and
 *   stays hidden until `strokes` no longer holds it; if the removal fails it
 *   comes back (`removeFailed`) and the viewer says so.
 * - A stroke still saving waits, undrawn, for its save to name it
 *   (`saveLanded` hands back the id to remove). If the save fails instead,
 *   the stroke is already gone and its failure has said so; the Undo does
 *   nothing more. It must not go on to an older mark — at a report's mark
 *   limit that would turn "take back the stroke that was refused" into
 *   "delete a real one", which nothing can bring back.
 *
 * A mark being taken away is no longer "yours to undo", so two quick taps
 * take two marks, never the same one twice; and a stroke drawn after the tap
 * was not there to be chosen by it.
 *
 * ── Clear is handed over when it is tapped ────────────────────────────────
 *
 * The caller keeps the order (`ViewerMarkup.clearPage`): strokes drawn
 * before the tap are saved and then cleared, strokes drawn after it wait and
 * survive. So the viewer need not wait for anything. It hides your marks on
 * the page for as long as the clear is out — stored ones, and strokes still
 * saving there, which the clear will sweep up once they land — and brings
 * them all back if it fails (`clearFailed`). A viewer opened while a Clear
 * asked for in an earlier one is still out does the same for it
 * (`clearTakenOver`), so closing and reopening the document does not bring
 * back, for a while, marks already cleared.
 *
 * No React and no DOM, so every ordering can be tested with plain calls.
 */

export type LocalMarks = {
  /** Strokes drawn here that `strokes` may not hold yet, in drawing order. */
  pending: ReadonlyArray<PendingMark>
  /**
   * Stored marks of yours hidden while they are taken away, by id: true once
   * the removal has come back, and then forgotten as soon as `strokes` stops
   * holding the mark (it cannot come back after that).
   */
  hidden: ReadonlyMap<string, boolean>
  /** Clears still out, by the number `clear` was given: the page of each. */
  clearing: ReadonlyMap<number, number>
}

export const NO_LOCAL_MARKS: LocalMarks = {
  pending: [],
  hidden: new Map(),
  clearing: new Map(),
}

// ---- Strokes ---------------------------------------------------------------

/**
 * A finished stroke, as its save starts. `strokes` is what is on screen as
 * it is drawn: none of your marks there is this one, however alike their
 * points (`pendingMarks.ts`, "Knowing the twin").
 */
export function drawn(
  state: LocalMarks,
  key: string,
  page: number,
  points: ReadonlyArray<MarkupPoint>,
  strokes: Strokes | undefined,
): LocalMarks {
  const others = othersOnPage(state.pending, strokes, page)
  return {
    ...state,
    pending: [
      ...state.pending,
      { key, page, points, others, saved: null, taken: null },
    ],
  }
}

/**
 * The save of `key` came back with the stroke's `id`; `strokes` is what is on
 * screen. `remove` is the id an Undo aimed at the stroke while it saved now
 * has to remove — the stroke stays hidden meanwhile.
 */
export function saveLanded(
  state: LocalMarks,
  key: string,
  id: string,
  strokes: Strokes | undefined,
  now: number,
): { state: LocalMarks; remove: string | null } {
  const mark = state.pending.find((m) => m.key === key)
  if (!mark) return { state, remove: null }
  // Whatever becomes of this stroke, the stored one with this id is it, and
  // never the twin of another stroke still saving with the same points.
  const claimed = claimId(state.pending, key, id)
  if (mark.taken === null) {
    const pending = markSaved(claimed, key, strokes, now, id)
    return { state: { ...state, pending }, remove: null }
  }
  const pending = dropMark(claimed, key)
  if (mark.taken === 'undo') {
    const hidden = new Map(state.hidden).set(id, false)
    return { state: { ...state, pending, hidden }, remove: id }
  }
  // A Clear's. Its page stays hidden while the clear is out, and the clear
  // lands after this save did, so the stored stroke is never seen.
  return { state: { ...state, pending }, remove: null }
}

/**
 * The save of `key` failed: the stroke goes, and the viewer says so. An Undo
 * aimed at it is spent — there is nothing left to take back.
 */
export function saveFailed(state: LocalMarks, key: string): LocalMarks {
  const pending = dropMark(state.pending, key)
  return pending === state.pending ? state : { ...state, pending }
}

/**
 * The marks on screen changed, or time passed: lets go of saved strokes the
 * marks now hold, and forgets removed marks the marks no longer hold.
 */
export function sync(
  state: LocalMarks,
  strokes: Strokes | undefined,
  now: number,
): LocalMarks {
  const pending = reconcile(state.pending, strokes, now)
  const hidden = forgetGone(state.hidden, strokes)
  if (pending === state.pending && hidden === state.hidden) return state
  return { ...state, pending, hidden }
}

// ---- Undo ------------------------------------------------------------------

export type UndoTap = {
  state: LocalMarks
  /**
   * The stored mark to remove now; null when the Undo is waiting for the
   * stroke it chose to finish saving (`saveLanded` names it then).
   */
  remove: string | null
}

/**
 * An Undo tap: takes your newest mark from the screen and says what to
 * remove (see the file comment). Null when you have no mark left to take.
 */
export function undo(
  state: LocalMarks,
  strokes: Strokes | undefined,
): UndoTap | null {
  for (let i = state.pending.length - 1; i >= 0; i--) {
    const mark = state.pending[i]
    if (mark.taken !== null) continue
    if (mark.saved === null) {
      const pending = state.pending.map((m) =>
        m === mark ? { ...m, taken: 'undo' as const } : m,
      )
      return { state: { ...state, pending }, remove: null }
    }
    // Saved, and its twin in the marks or on its way: that twin is the mark.
    const { id } = mark.saved
    const pending = dropMark(state.pending, mark.key)
    const hidden = new Map(state.hidden).set(id, false)
    return { state: { ...state, pending, hidden }, remove: id }
  }

  const newest = newestOwn(state, strokes)
  if (!newest) return null
  const hidden = new Map(state.hidden).set(newest.id, false)
  return { state: { ...state, hidden }, remove: newest.id }
}

/** The removal of `id` came back: it goes once `strokes` no longer holds it. */
export function removeLanded(
  state: LocalMarks,
  id: string,
  strokes: Strokes | undefined,
): LocalMarks {
  if (!state.hidden.has(id)) return state
  const hidden = forgetGone(new Map(state.hidden).set(id, true), strokes)
  return { ...state, hidden }
}

/**
 * The removal of `id` failed: the mark shows again — unless a Clear has
 * taken it meanwhile, which a failed Undo does not undo. The same state when
 * nothing comes back, so the viewer need not apologise for it.
 */
export function removeFailed(state: LocalMarks, id: string): LocalMarks {
  if (state.hidden.get(id) !== false) return state
  const hidden = new Map(state.hidden)
  hidden.delete(id)
  return { ...state, hidden }
}

// ---- Clear -----------------------------------------------------------------

/**
 * A Clear of `page`, numbered `clearId`, as it is handed over: your marks on
 * the page are hidden until it comes back.
 */
export function clear(
  state: LocalMarks,
  clearId: number,
  page: number,
): LocalMarks {
  const pending: Array<PendingMark> = []
  for (const mark of state.pending) {
    if (mark.taken !== null || mark.page !== page) {
      pending.push(mark)
    } else if (mark.saved === null) {
      // Still saving: undrawn until its save lands, then swept up.
      pending.push({ ...mark, taken: { clear: clearId } })
    }
    // Saved already: let go of — its stored twin is one of the page's
    // marks, hidden with them.
  }
  const clearing = new Map(state.clearing).set(clearId, page)
  return { ...state, pending, clearing }
}

/**
 * A Clear of `page` that was already on its way when this viewer opened —
 * asked for by one closed since — taken over as `clearId`: your marks on the
 * page are hidden until it comes back, as they were in the viewer that asked
 * for it, and `clearLanded` / `clearFailed` follow it as for any other.
 *
 * Unlike `clear`, nothing drawn here is swept up with it. All of that was
 * drawn after the Clear was tapped, and the caller holds each save back until
 * the clear has landed (`ViewerMarkup.clearPage`), so every stroke survives
 * it and must stay on screen.
 */
export function clearTakenOver(
  state: LocalMarks,
  clearId: number,
  page: number,
): LocalMarks {
  const clearing = new Map(state.clearing).set(clearId, page)
  return { ...state, clearing }
}

/**
 * Clear `clearId` came back. The marks on screen may not have caught up with
 * it yet, so each of yours still on its page stays hidden until they have.
 */
export function clearLanded(
  state: LocalMarks,
  clearId: number,
  strokes: Strokes | undefined,
): LocalMarks {
  const page = state.clearing.get(clearId)
  if (page === undefined) return state
  const clearing = new Map(state.clearing)
  clearing.delete(clearId)
  const hidden = new Map(state.hidden)
  for (const stroke of strokes?.get(page) ?? []) {
    if (stroke.mine) hidden.set(stroke.id, true)
  }
  return { ...state, clearing, hidden }
}

/** Clear `clearId` failed: the page's marks show again. */
export function clearFailed(state: LocalMarks, clearId: number): LocalMarks {
  if (!state.clearing.has(clearId)) return state
  const clearing = new Map(state.clearing)
  clearing.delete(clearId)
  const pending = state.pending.map((mark) =>
    mark.taken !== null && mark.taken !== 'undo' && mark.taken.clear === clearId
      ? { ...mark, taken: null }
      : mark,
  )
  return { ...state, pending, clearing }
}

// ---- What to draw ----------------------------------------------------------

/**
 * The caller's marks without those being taken away. The same Map when none
 * on it is, and each page's own array where nothing on that page is: the page
 * slots are memoised on both.
 */
export function visibleStrokes(strokes: Strokes, state: LocalMarks): Strokes {
  const away = takenAway(state)
  if (!away) return strokes
  let changed = false
  const next = new Map<number, ReadonlyArray<MarkupStroke>>()
  for (const [page, onPage] of strokes) {
    const kept = onPage.filter((stroke) => !away(page, stroke))
    if (kept.length === onPage.length) {
      next.set(page, onPage)
    } else {
      changed = true
      next.set(page, kept)
    }
  }
  return changed ? next : strokes
}

/**
 * Whether you have a mark still showing — anywhere, or on `page` — for
 * Undo, or Clear, to take.
 */
export function hasOwnMarks(
  state: LocalMarks,
  strokes: Strokes | undefined,
  page?: number,
): boolean {
  const onPage = (p: number) => page === undefined || p === page
  if (state.pending.some((mark) => mark.taken === null && onPage(mark.page))) {
    return true
  }
  if (!strokes) return false
  const away = takenAway(state)
  for (const [p, list] of strokes) {
    if (!onPage(p)) continue
    if (list.some((stroke) => stroke.mine && !away?.(p, stroke))) return true
  }
  return false
}

// ---- Inside ----------------------------------------------------------------

/**
 * Which of the caller's marks are being taken away: yours, and hidden by an
 * Undo or a Clear that has come back, or on a page a Clear is still out for,
 * or the twin of a stroke an Undo took while it saved — the marks can hold a
 * stroke a moment before its save names it, and a mark shown there would be
 * both on screen and the next Undo's choice. That twin is only ever a stroke
 * that arrived after it was drawn (`isTwin`): an older dot of yours on the
 * same spot has the same points, and hiding it would make the next Undo pass
 * it over for a mark older still. Null when nothing is.
 */
function takenAway(
  state: LocalMarks,
): ((page: number, stroke: MarkupStroke) => boolean) | null {
  const clearingPages = new Set(state.clearing.values())
  const undone = state.pending.filter((mark) => mark.taken === 'undo')
  if (state.hidden.size === 0 && clearingPages.size === 0 && !undone.length) {
    return null
  }
  return (page, stroke) =>
    stroke.mine &&
    (state.hidden.has(stroke.id) ||
      clearingPages.has(page) ||
      undone.some((mark) => mark.page === page && isTwin(stroke, mark)))
}

/**
 * Your newest stored mark still showing: the largest `order`, and of two
 * alike the later in the marks — on one page, the later written, as the
 * caller lists them in the order they were drawn.
 */
function newestOwn(
  state: LocalMarks,
  strokes: Strokes | undefined,
): MarkupStroke | null {
  if (!strokes) return null
  const away = takenAway(state)
  let newest: MarkupStroke | null = null
  for (const [page, onPage] of strokes) {
    for (const stroke of onPage) {
      if (!stroke.mine || away?.(page, stroke)) continue
      if (!newest || stroke.order >= newest.order) newest = stroke
    }
  }
  return newest
}

/** Drops removed marks `strokes` no longer holds; the same Map if none. */
function forgetGone(
  hidden: ReadonlyMap<string, boolean>,
  strokes: Strokes | undefined,
): ReadonlyMap<string, boolean> {
  if (![...hidden.values()].some(Boolean)) return hidden
  const held = new Set<string>()
  for (const onPage of strokes?.values() ?? []) {
    for (const stroke of onPage) held.add(stroke.id)
  }
  const next = new Map<string, boolean>()
  for (const [id, removed] of hidden) {
    if (!removed || held.has(id)) next.set(id, removed)
  }
  return next.size === hidden.size ? hidden : next
}
