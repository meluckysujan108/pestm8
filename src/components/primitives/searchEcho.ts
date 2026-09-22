/**
 * SearchBox's bookkeeping for terms it has sent and not yet seen come back
 * through `value`. Pure, so the cases that need a slow navigation to happen in
 * a browser can be pinned without one.
 *
 * Two facts about the router make this sound: only the newest navigation ever
 * commits (an older one still in flight is superseded, not queued), and a
 * term round-trips through the URL unchanged — so an echo equals what was
 * sent, and an echo of one term settles every term sent before it.
 *
 * One case is beyond it, and was before: a term still in flight, superseded by
 * a navigation from elsewhere that lands on the value already committed. Then
 * `value` never changes, so nothing tells the box its term was dropped, and it
 * waits for an echo that cannot come. Seeing it needs a navigation slower than
 * the debounce and a keystroke inside that window; settling it would mean
 * following each `navigate()` promise rather than watching `value`.
 */

/** A term handed to `onChange`. */
export function recordSend(
  unechoed: ReadonlyArray<string>,
  term: string,
  value: string,
): Array<string> {
  // Sending what is already committed changes nothing in the URL, so it will
  // never echo; and it supersedes whatever was still out, which never will
  // either. Queueing it would leave both waiting forever, and a later outside
  // change that happened to match one would be taken for an echo.
  if (term === value) return []
  return [...unechoed, term]
}

/** `value` arrived: an echo of something sent, or a change from outside. */
export function settleEcho(
  unechoed: ReadonlyArray<string>,
  value: string,
): { unechoed: Array<string>; adopt: boolean } {
  const echoed = unechoed.lastIndexOf(value)
  if (echoed !== -1) {
    return { unechoed: unechoed.slice(echoed + 1), adopt: false }
  }
  // Not ours — a filter cleared elsewhere, the back button — so the box
  // takes it, and nothing sent before it can still land.
  return { unechoed: [], adopt: true }
}

/** What `value` will be once everything sent has landed. */
export function settlesAt(
  unechoed: ReadonlyArray<string>,
  value: string,
): string {
  return unechoed.at(-1) ?? value
}
