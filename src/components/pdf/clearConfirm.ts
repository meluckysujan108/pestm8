/**
 * "Clear my marks on page 3" asks twice, in place: the first tap turns the
 * button into "Tap again to clear page 3", and only a second tap on the same
 * page, at least `CLEAR_ARM_MS` and less than `CLEAR_CONFIRM_MS` later,
 * clears it.
 *
 * In place because the app's confirm dialogs cannot be used here: they are
 * layered at z-60/70, under the viewer at z-80, so one would open behind the
 * page it is asking about. And for a single page of someone's own marks a
 * second tap is enough of a pause — Undo is right beside it, one mark at a
 * time, for anything less.
 */

export const CLEAR_CONFIRM_MS = 3000

/**
 * How long the question has to have been on screen before a tap answers it.
 *
 * Without it a double-tap — a gloved thumb, a bounce on a bumpy ute seat —
 * is both taps, 100–200 ms apart: each is its own click (the viewer turns off
 * double-tap zoom), so the second arrives already armed and clears the page
 * before "Tap again" has been seen, let alone read. Reading those four words
 * takes longer than this anyway, so nobody who meant it waits for it.
 */
export const CLEAR_ARM_MS = 400

/** The page the button is waiting on a second tap for, and since when. */
export type ClearConfirm = { page: number; at: number } | null

/** Whether the button for `page` should read "Tap again…" at `now`. */
export function armedFor(
  confirm: ClearConfirm,
  page: number,
  now: number,
): boolean {
  return (
    confirm !== null &&
    confirm.page === page &&
    now - confirm.at < CLEAR_CONFIRM_MS
  )
}

/**
 * A tap on the button for `page`: clears when it is waiting on that page,
 * and otherwise starts waiting. Scrolling to another page in between makes
 * it a first tap again, so the second tap never clears a page that is not
 * the one on screen.
 *
 * A tap sooner than `CLEAR_ARM_MS` after the first is the same tap again and
 * changes nothing: the button goes on asking, from when it first asked, so a
 * bouncing thumb neither clears the page nor keeps the question up for good.
 */
export function tapClear(
  confirm: ClearConfirm,
  page: number,
  now: number,
): { confirm: ClearConfirm; clear: boolean } {
  if (armedFor(confirm, page, now)) {
    if (confirm && now - confirm.at < CLEAR_ARM_MS) {
      return { confirm, clear: false }
    }
    return { confirm: null, clear: true }
  }
  return { confirm: { page, at: now }, clear: false }
}
