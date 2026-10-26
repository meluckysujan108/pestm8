import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react'
import { QUERY_WAIT_MS } from '#/lib/reach'
import type { KeptNote } from './useKept'

/**
 * Where a line saying the screen is the copy kept on the phone, and why, is
 * showing now: "No signal — showing the copy kept on this phone." on a page
 * (KeptCopyNote), or "Could not reach PestM8 — showing the kept copy,
 * updated 9:42am. Editing needs signal." in a sheet (KeptJobView,
 * KeptClientView). The can't-reach notice reads it where it would show, on
 * the page (ConnectionNotice) or at the top of a sheet (primitives/
 * Sheet.tsx), and gives way to such a line, which says the same thing just
 * under it (`noticeOverKept`, lib/reach.ts, has when it doesn't).
 *
 * A place is the page or one open sheet: SheetShell gives each sheet a
 * place of its own (`KeptPlace`), so a note on the page behind a sheet says
 * nothing about the sheet, and a sheet opened over a kept job's has its own
 * notice.
 *
 * The page's note counts only while it is on screen (`useOnScreen`): it
 * scrolls away with the page, and the band it stands in for is fixed under
 * the header, so with the note gone up out of sight the band is back to say
 * the line is down. And it goes on counting for a while once the line is
 * back, until PestM8 has answered on it (`nextNoteHold`). A sheet's kept
 * view counts wherever it is in the sheet: the sheet's notice is in the
 * sheet's flow, so one that came and went with its scroll would move what
 * is under a thumb.
 *
 * Said in a layout effect and read in one, so a notice drawn in the same
 * commit as the line that holds it back never paints: React renders again
 * for an update made there before the browser paints. Nothing shows on the
 * server or in the hydration render, so the two draw the notice alike.
 */

/** The page, outside any sheet. */
export const ON_PAGE = 'page'

/** The place what is drawn here is in: the page, or the sheet round it. */
export const KeptPlace = createContext<string>(ON_PAGE)

/**
 * How long a place still counts once its last line has gone: longer than
 * ConnectionNotice takes between looks (a second), so a notice the line
 * coming back has just made stale goes before it can show, rather than
 * standing for a moment over "Up to date." or a live sheet that has just
 * taken a kept view's place.
 */
export const KEPT_GONE_MS = 1_500

const showing = new Map<string, number>()
const going = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Whether a line about the kept copy shows at `place`, or went less than
 * KEPT_GONE_MS ago. */
export function keptShowing(place: string): boolean {
  return showing.has(place) || going.has(place)
}

/** Calls `listener` whenever `keptShowing` may say otherwise somewhere. */
export function subscribeKept(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Says a line about the kept copy shows at `place`, until the function it
 * returns is called. A place can hold several at once, and counts until the
 * last has gone, and KEPT_GONE_MS after.
 */
export function showKept(place: string): () => void {
  const was = keptShowing(place)
  const timer = going.get(place)
  if (timer !== undefined) {
    clearTimeout(timer)
    going.delete(place)
  }
  showing.set(place, (showing.get(place) ?? 0) + 1)
  if (!was) notify()
  let shown = true
  return () => {
    if (!shown) return
    shown = false
    const left = (showing.get(place) ?? 1) - 1
    if (left > 0) {
      showing.set(place, left)
      return
    }
    showing.delete(place)
    going.set(
      place,
      setTimeout(() => {
        going.delete(place)
        notify()
      }, KEPT_GONE_MS),
    )
  }
}

/**
 * Whether KeptCopyNote says the screen is the kept copy because the line is
 * down: "No signal — …" or "Could not reach PestM8 — …". Not while
 * hydrating (the page's CSS shows it then, and no notice is up so soon),
 * nor "Showing the copy kept on this phone.", which doesn't say PestM8
 * can't be reached (a socket that looks open and never answers), nor
 * "Up to date.".
 */
export function noteSaysKept(note: Pick<KeptNote, 'phase' | 'tone'>): boolean {
  return (
    note.phase === 'shown' &&
    (note.tone === 'no-signal' || note.tone === 'unreachable')
  )
}

/**
 * How long the note still holds the notice back once it has gone from
 * saying the line is down to "Showing the copy kept on this phone.": the
 * socket open again, and nothing confirmed on it yet (`toneOf`,
 * lib/offline/useKept.ts). The first answer on a new line carries every
 * query on screen, which on one bar can take a while; the notice, which has
 * counted the kept answers as waiting since the page drew, would otherwise
 * show for the first time just as the signal comes back, and stand until
 * that answer lands. As long as a fresh page's answers are given
 * (QUERY_WAIT_MS), so a line that opens and never answers still gets its
 * notice, and Try again.
 */
export const KEPT_AFTER_DOWN_MS = QUERY_WAIT_MS

/**
 * What KeptCopyNote holds the notice back for (`nextNoteHold`): its saying
 * the line is down (`'down'`), "Showing the copy kept on this phone." said
 * straight after that, since `keptFrom`, or nothing.
 */
export type NoteHold = 'down' | { keptFrom: number } | null

/**
 * The hold after a render: down while the note says so (`noteSaysKept`);
 * straight from there, "Showing the copy kept on this phone." holds from
 * when it began saying it, for as long as it does (KEPT_AFTER_DOWN_MS of it
 * at most, `useNoteHolds`); anything else ("Up to date.", hidden, gone,
 * hydrating) holds nothing. A note that has only ever said "Showing the
 * copy kept on this phone." holds nothing either: an open socket that has
 * never answered gets its notice, and Try again. The same hold back when
 * nothing changed, so a render can set it unconditionally.
 */
export function nextNoteHold(
  hold: NoteHold,
  note: Pick<KeptNote, 'phase' | 'tone'>,
  now: number,
): NoteHold {
  if (noteSaysKept(note)) return 'down'
  if (note.phase !== 'shown' || note.tone !== 'kept' || hold === null) {
    return null
  }
  return hold === 'down' ? { keptFrom: now } : hold
}

/**
 * Whether KeptCopyNote holds the notice back now (`nextNoteHold`): while it
 * says the line is down, and KEPT_AFTER_DOWN_MS into the "Showing the copy
 * kept on this phone." that follows. False on the server and while
 * hydrating.
 */
export function useNoteHolds(note: Pick<KeptNote, 'phase' | 'tone'>): boolean {
  const [hold, setHold] = useState<NoteHold>(null)
  const next = nextNoteHold(hold, note, Date.now())
  if (next !== hold) setHold(next)
  const keptFrom = next !== null && next !== 'down' ? next.keptFrom : null
  // The spell after the line came back whose time is up, by when it began:
  // one begun since isn't.
  const [overFor, setOverFor] = useState<number | null>(null)
  useEffect(() => {
    if (keptFrom === null) return
    const timer = setTimeout(
      () => setOverFor(keptFrom),
      Math.max(0, keptFrom + KEPT_AFTER_DOWN_MS - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [keptFrom])
  return next === 'down' || (keptFrom !== null && overFor !== keptFrom)
}

/**
 * Where the page's note counts as on screen: below where the band shows
 * under the header (84px, ConnectionNotice), so a note scrolled up under
 * the header's glass doesn't. A margin can't name a notched phone's inset,
 * so there a little of the header's foot still counts.
 */
export const ON_SCREEN_MARGIN = '-84px 0px 0px 0px'

/** How much of the note must be in that part of the screen: half. */
export const ON_SCREEN_SHARE = 0.5

/**
 * Calls `onChange` with whether `el` is on screen (ON_SCREEN_MARGIN,
 * ON_SCREEN_SHARE): once as it starts watching, and whenever that changes.
 * Measured against the screen, which also clips it to any column it
 * scrolls in. Says nothing where there is no IntersectionObserver, so what
 * the caller took it as stands. Returns the way to stop.
 */
export function observeOnScreen(
  el: Element,
  onChange: (onScreen: boolean) => void,
): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {}
  const observer = new IntersectionObserver(
    (entries) => {
      // The last of a batch is the element's state now.
      const latest = entries.at(-1)
      if (latest) {
        onChange(
          latest.isIntersecting && latest.intersectionRatio >= ON_SCREEN_SHARE,
        )
      }
    },
    { rootMargin: ON_SCREEN_MARGIN, threshold: ON_SCREEN_SHARE },
  )
  observer.observe(el)
  return () => observer.disconnect()
}

/**
 * Whether `node` is on screen (`observeOnScreen`): taken as yes until the
 * browser has said, since the note is drawn near the top of its page, and
 * wherever the browser can't say.
 */
export function useOnScreen(node: Element | null): boolean {
  const [onScreen, setOnScreen] = useState(true)
  useLayoutEffect(
    () => (node ? observeOnScreen(node, setOnScreen) : undefined),
    [node],
  )
  return onScreen
}

/** `useShowsKept` at a given place. */
export function useShowKeptAt(place: string, on: boolean): void {
  useLayoutEffect(() => (on ? showKept(place) : undefined), [place, on])
}

/**
 * Says a line about the kept copy shows where this is drawn (the page, or
 * the sheet round it), while `on`.
 */
export function useShowsKept(on: boolean): void {
  useShowKeptAt(useContext(KeptPlace), on)
}

/** `useKeptHere` at a given place. */
export function useKeptAt(place: string): boolean {
  const [kept, setKept] = useState(false)
  useLayoutEffect(() => {
    const look = () => setKept(keptShowing(place))
    look()
    return subscribeKept(look)
  }, [place])
  return kept
}

/**
 * Whether a line about the kept copy shows where this is drawn (the page,
 * or the sheet round it): false on the server and in the hydration render.
 */
export function useKeptHere(): boolean {
  return useKeptAt(useContext(KeptPlace))
}
