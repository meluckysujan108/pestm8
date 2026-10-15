import { useCallback, useMemo, useState } from 'react'

/**
 * A list that is already here in full, drawn a step at a time.
 *
 * For the lists that are not paged on the server but are still too long to
 * draw at once on a phone: one person's newest 200 jobs, or the Clients
 * page's search over its whole directory. Every card drawn is a card the
 * phone lays out and hydrates, so they are revealed the way a paged list
 * loads — `step` at first, `step` more each time `LoadMore` asks.
 *
 * `resetKey` says when it is a different list — a new search, another
 * filter — and the reveal starts again from `step`. The rows changing under
 * the same key (a job booked, a client renamed) keeps what was revealed, or
 * every live update would scroll the list back to its first page.
 */

export type Reveal = { key: string; count: number }

/**
 * The reveal to draw with: the one held, or a fresh one when the key has
 * changed. Decided while rendering rather than in an effect, so the first
 * frame of a new search already draws `step` rows — an effect would draw one
 * frame of the old count against the new rows (up to 240 cards a keystroke
 * on the Clients page) before putting it right.
 */
export function currentReveal(
  held: Reveal,
  resetKey: string,
  step: number,
): Reveal {
  return held.key === resetKey ? held : { key: resetKey, count: step }
}

/** What a reveal shows of `rows`, and whether there is more to show. */
export function revealView<T>(
  rows: ReadonlyArray<T>,
  count: number,
): { visible: Array<T>; canLoadMore: boolean } {
  return { visible: rows.slice(0, count), canLoadMore: rows.length > count }
}

export function useRevealMore<T>(
  rows: ReadonlyArray<T>,
  step: number,
  resetKey: string,
): { visible: Array<T>; canLoadMore: boolean; loadMore: () => void } {
  const [held, setHeld] = useState<Reveal>(() => ({
    key: resetKey,
    count: step,
  }))
  const reveal = currentReveal(held, resetKey, step)
  // React's own pattern for state that follows a prop: set during render,
  // and it renders again at once with the new value, before anything is
  // committed or painted.
  if (reveal !== held) setHeld(reveal)

  const { count } = reveal
  const view = useMemo(() => revealView(rows, count), [rows, count])

  // Stable, for LoadMore's effects. It grows whichever reveal is current
  // when the update runs, so a tap that lands on the frame a search changed
  // grows the new list rather than restoring the old one's count.
  const loadMore = useCallback(() => {
    setHeld((prev) => ({ key: prev.key, count: prev.count + step }))
  }, [step])

  return { visible: view.visible, canLoadMore: view.canLoadMore, loadMore }
}
