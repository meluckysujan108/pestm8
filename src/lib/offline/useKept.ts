import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useState,
  useSyncExternalStore,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { dayKeyOf } from '../../../convex/lib/dates'
import { isOffline } from '#/lib/online'
import { keeper } from './keeper'
import { RENDERED_AT_KEY } from './keptSet'
import type { CSSProperties } from 'react'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { LineDown } from './keeper'

/**
 * The keeper (keeper.ts) for React: whether a page can show an answer,
 * whether the line is down, and what the "Updated" note says.
 *
 * Each reads the same on the server and in the hydration render as the
 * server rendered it, and moves to what the phone knows after: nothing
 * renders as kept, down or missing before the browser has said so.
 */

const subscribe = (listener: () => void) => keeper.subscribe(listener)
const subscribeNothing = () => () => {}

/**
 * Whether `queryKey` can be shown now (`keeper.readable`): true on the
 * server and while hydrating.
 */
export function useReadable(queryKey: QueryKey): boolean {
  return useSyncExternalStore(
    subscribe,
    () => keeper.readable(queryKey),
    () => true,
  )
}

/** Whether every one of `queryKeys` can be shown now (`useReadable`). */
export function useReadableAll(queryKeys: ReadonlyArray<QueryKey>): boolean {
  return useSyncExternalStore(
    subscribe,
    () => queryKeys.every((key) => keeper.readable(key)),
    () => true,
  )
}

/**
 * Whether `queryKey` has an answer in memory, kept current as the cache
 * changes, without asking for it: for a page whose choice of what to read
 * waits on an answer it doesn't read itself (`useKeptMode`). As the server
 * had it while hydrating, since the HTML brought what the server held.
 */
export function useInMemory(queryKey: QueryKey): boolean {
  const queryClient = useQueryClient()
  const subscribeCache = useCallback(
    (listener: () => void) => queryClient.getQueryCache().subscribe(listener),
    [queryClient],
  )
  const inMemory = () => queryClient.getQueryData(queryKey) !== undefined
  return useSyncExternalStore(subscribeCache, inMemory, inMemory)
}

/**
 * A page's choice to draw from the phone's copy alone, made once and kept
 * for as long as the page is open, so what it shows never changes source
 * under a thumb (`nextKeptMode`). False on the server and while hydrating,
 * so the page hydrates as the server drew it; and what the hydration render
 * drew from the page's usual source (`drawn`) stays. (The Clients page reads
 * every client from the phone's copy with the line down: `keptClientsMode`.)
 */
export function useKeptMode(decide: () => boolean, drawn: boolean): boolean {
  const hydrating = useSyncExternalStore(
    subscribeNothing,
    () => false,
    () => true,
  )
  const [mode, setMode] = useState(() =>
    firstKeptMode({ hydrating, drawn, decide }),
  )
  const next = nextKeptMode(mode, { hydrating, drawn, decide })
  if (next !== mode) setMode(next)
  return next ?? false
}

/** Kept (true), the page's usual source (false), or not decided yet. */
export type KeptMode = boolean | null

type KeptModeAt = {
  hydrating: boolean
  /** The page has drawn from its usual source, or does on this render. */
  drawn: boolean
  /** Whether to draw from the phone's copy, asked now. */
  decide: () => boolean
}

/**
 * The choice as a page first renders: in the hydration render, the usual
 * source if that is what the server drew, else not yet decided; otherwise
 * as on any render (`nextKeptMode`).
 */
export function firstKeptMode(at: KeptModeAt): KeptMode {
  if (at.hydrating) return at.drawn ? false : null
  return nextKeptMode(null, at)
}

/**
 * The choice after a render: asked (`decide`) on each render that isn't
 * hydrating, until it says yes or the page has drawn from its usual source,
 * and never again once made. A page still on its placeholder can take the
 * phone's copy later (the line going down, an answer that never comes), as
 * nothing under a thumb moves for that.
 */
export function nextKeptMode(mode: KeptMode, at: KeptModeAt): KeptMode {
  if (mode !== null || at.hydrating) return mode
  if (at.decide()) return true
  return at.drawn ? false : null
}

/**
 * Whether the day `dayKey` is shown from a copy the phone kept before that
 * day had arrived (`keeper.keptSavedAt`), in the business's time zone: such
 * a copy has none of the day's recurring visits on it. False on the server
 * and while hydrating.
 */
export function useKeptBeforeDay(
  queryKey: QueryKey,
  timezone: string,
  dayKey: string,
): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      const savedAt = keeper.keptSavedAt(queryKey)
      return savedAt !== null && dayKeyOf(savedAt, timezone) < dayKey
    },
    () => false,
  )
}

/**
 * Calls `onChange` whenever the line may have changed: the keeper's word,
 * and the phone's own, which reaches a page the keeper isn't watching from
 * (the UI harness) too.
 */
export function subscribeLineDown(onChange: () => void): () => void {
  const stop = keeper.subscribe(onChange)
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    stop()
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/**
 * Why the line is down (`keeper.downReason`), kept current: for the caption
 * above a save that waits for signal, and the business switcher. Null on
 * the server and while hydrating.
 */
export function useLineDown(): LineDown | null {
  return useSyncExternalStore(subscribeLineDown, keeper.downReason, () => null)
}

/**
 * Whether a sheet with no answer has waited `ms` for it on a line that looks
 * up, or the line has been down while it waited. Latched once over, so a
 * line that comes back before the answer does changes nothing here.
 */
export function useWaitedOut(
  waiting: boolean,
  down: LineDown | null,
  ms: number,
): boolean {
  const [waitedOut, setWaitedOut] = useState(false)
  useEffect(() => {
    if (!waiting || waitedOut) return
    if (down !== null) {
      setWaitedOut(true)
      return
    }
    const timer = setTimeout(() => setWaitedOut(true), ms)
    return () => clearTimeout(timer)
  }, [waiting, waitedOut, down, ms])
  return waitedOut
}

/**
 * When the wait under way began (`useLateSince`): kept while it lasts, now
 * for one just begun, null while nothing is waited for.
 */
export function waitSince(
  since: number | null,
  pending: boolean,
  now: number,
): number | null {
  if (!pending) return null
  return since ?? now
}

/** How long until a wait that began `since` has lasted `ms`: 0 once it has. */
export function msUntilLate(since: number, ms: number, now: number): number {
  return Math.max(0, since + ms - now)
}

/**
 * Whether `pending` has held for `ms`. The wait a page opens with counts
 * from `openedAt`, the tap that asked for it, so time its loader held the
 * tap counts towards it; a later one counts from when it began. False again
 * once it stops.
 */
export function useLateSince(
  pending: boolean,
  ms: number,
  openedAt: number,
): boolean {
  const [since, setSince] = useState<number | null>(() =>
    pending ? openedAt : null,
  )
  const current = waitSince(since, pending, Date.now())
  if (current !== since) setSince(current)
  // The wait that has gone on `ms`, by when it began: one begun since isn't.
  const [lateFor, setLateFor] = useState<number | null>(null)
  useEffect(() => {
    if (current === null) return
    const timer = setTimeout(
      () => setLateFor(current),
      msUntilLate(current, ms, Date.now()),
    )
    return () => clearTimeout(timer)
  }, [current, ms])
  return current !== null && lateFor === current
}

/** How often a sheet held for a live answer looks again (`useKeeperReads`). */
const LIVE_RECHECK_MS = 1_000

/**
 * Renders again whenever the keeper may read differently, while `active`;
 * and each second too while `ticking`, for what changes with time alone: an
 * answer stops counting as live once the server has gone quiet, which
 * nothing announces.
 */
export function useKeeperReads(active: boolean, ticking: boolean): void {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => (active ? keeper.subscribe(bump) : undefined), [active])
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(bump, LIVE_RECHECK_MS)
    return () => clearInterval(timer)
  }, [ticking])
}

/**
 * Whether an answer on screen may be missing something newer
 * (`useBehindOnce`), counting only what can't be brought up to date now:
 * - not while it is live;
 * - with the line down, yes;
 * - the phone's copy, yes;
 * - the answer a page's HTML brought: if the page is a copy the service
 *   worker kept, yes; if the server has just drawn it, it is as new as
 *   PestM8 had it a moment ago;
 * - anything else (an answer that was live on an earlier connection, or one
 *   fetched and not pushed yet) is being asked for again, and comes up to
 *   date on a line PestM8 is speaking on (`lineLive`): only on one gone
 *   quiet, yes.
 */
export function mayBeBehind(at: {
  live: boolean
  lineDown: boolean
  /** PestM8 has spoken on the line lately (`keeper.lineLive`). */
  lineLive: boolean
  /** It is the phone's copy (`keeper.keptSavedAt`). */
  fromCopy: boolean
  /** It is still the answer the page's HTML brought. */
  fromHtml: boolean
  /** That HTML is a copy the service worker kept (`data-kept`). */
  htmlKept: boolean
}): boolean {
  if (at.live) return false
  if (at.lineDown || at.fromCopy) return true
  if (at.fromHtml) return at.htmlKept
  return !at.lineLive
}

/** `mayBeBehind` for `queryKey`'s answer, as the keeper has it now. */
function behindNow(queryKey: QueryKey): boolean {
  const html = keeper.htmlAsOf([queryKey])
  return mayBeBehind({
    live: keeper.isLive(queryKey),
    lineDown: keeper.lineDown(),
    lineLive: keeper.lineLive(),
    fromCopy: keeper.keptSavedAt(queryKey) !== null,
    fromHtml: html !== null && keeper.asOf([queryKey]) === html,
    htmlKept: htmlSaysKept(),
  })
}

/** What `useBehindOnce` decided, and what was on screen then. */
export type BehindLatch = { about: string; behind: boolean } | null

/**
 * The latch after a render: decided (`behind`, asked only then) as what it
 * is about first shows, kept while it shows, and decided again only for
 * something else (`about`), or once it has gone and shows again. While
 * hydrating, never behind: the server drew what it had. The same latch
 * back when nothing changed, so a render can set it unconditionally.
 */
export function nextBehindLatch(
  latch: BehindLatch,
  at: {
    showing: boolean
    hydrating: boolean
    about: string
    behind: () => boolean
  },
): BehindLatch {
  if (!at.showing) return null
  if (latch !== null && latch.about === at.about) return latch
  return { about: at.about, behind: !at.hydrating && at.behind() }
}

/**
 * Whether `queryKey`'s answer may be missing something newer
 * (`mayBeBehind`), for words said about it while `showing` (NoMatches'
 * hint, that newer clients show with signal): decided as they first show,
 * and kept until what they are about changes (`about`: a search, an order,
 * a filter) or they go, so they never change length on the screen they're
 * on, moving the button under them, or are announced again. False on the
 * server and while hydrating, and kept so after, as the server drew it.
 */
export function useBehindOnce(
  queryKey: QueryKey,
  showing: boolean,
  about: string,
): boolean {
  const hydrating = useSyncExternalStore(
    subscribeNothing,
    () => false,
    () => true,
  )
  const [latch, setLatch] = useState<BehindLatch>(null)
  const next = nextBehindLatch(latch, {
    showing,
    hydrating,
    about,
    behind: () => behindNow(queryKey),
  })
  if (next !== latch) setLatch(next)
  return next?.behind ?? false
}

/**
 * How a sheet's scrolling body is held once the live sheet has taken the
 * place of a kept view drawn in it (`useHandOverBody`): at the kept view's
 * own height, as a size the body may still give up when the sheet has less
 * room (a notice above it), but never grow past. Nothing while the kept
 * view shows, or where none has been measured.
 */
export function handOverStyle(
  kept: boolean,
  keptHeight: number | null,
): CSSProperties | undefined {
  if (kept || keptHeight === null) return undefined
  return { flex: '0 1 auto', height: keptHeight }
}

/**
 * For a sheet that shows a job or client from the phone's copy until PestM8
 * answers (KeptJobView, KeptClientView): its one scrolling body, drawn for
 * both, so the live sheet lands in the same element, scrolled where the
 * kept view was; and held at the kept view's height from then on, for as
 * long as the sheet is open. A bottom sheet is as tall as what is in it, up
 * to its cap, so a live sheet taller or shorter than the kept view would
 * move its top edge, and every Call with it. `kept`: the kept view is what
 * the body shows now. Its height is measured as it draws and whenever it
 * changes.
 */
export function useHandOverBody(kept: boolean): {
  ref: (node: HTMLElement | null) => void
  style: CSSProperties | undefined
} {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [keptHeight, setKeptHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!kept || !node) return
    const measure = () => setKeptHeight(node.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [kept, node])
  return { ref: setNode, style: handOverStyle(kept, keptHeight) }
}

/** What the "Updated" note says first: no signal, unreachable, kept, live. */
export type KeptNoteTone = 'no-signal' | 'unreachable' | 'kept' | 'live'

export type KeptNote = {
  /** Hydrating: as the server drew it, which the page's CSS shows or hides
   * (the HTML's `data-kept`). Then shown, or not, for good. */
  phase: 'hydrating' | 'shown' | 'hidden'
  tone: KeptNoteTone
  /** How old the oldest answer on screen is; once all of it is live, when
   * it came live. Null only when nothing on screen has an answer. */
  asOf: number | null
  /** Whether `asOf` is today, in the business's time zone. */
  asOfToday: boolean
}

function toneOf(queryKeys: ReadonlyArray<QueryKey>): KeptNoteTone {
  if (isOffline()) return 'no-signal'
  const down = keeper.downReason()
  if (down !== null) return down
  return queryKeys.length > 0 && queryKeys.every((key) => keeper.isLive(key))
    ? 'live'
    : 'kept'
}

/**
 * The oldest answer among `queryKeys` as the HTML has it, for the server
 * and the hydration render: the keeper's record of what the HTML brought,
 * which a push landing before the note hydrates can't change, or on the
 * server (and wherever nothing is watched) the cache, which there is the
 * HTML's.
 */
function htmlAsOf(
  queryClient: QueryClient,
  queryKeys: ReadonlyArray<QueryKey>,
): number | null {
  const recorded = keeper.htmlAsOf(queryKeys)
  if (recorded !== null) return recorded
  let oldest: number | null = null
  for (const queryKey of queryKeys) {
    const state = queryClient.getQueryState(queryKey)
    if (state?.data === undefined) continue
    if (oldest === null || state.dataUpdatedAt < oldest) {
      oldest = state.dataUpdatedAt
    }
  }
  return oldest
}

/**
 * How long after the server drew a page it counts as a copy the service
 * worker kept, rather than one fresh off the network: more than a slow line
 * takes, and more than a phone's clock is usually out by.
 */
export const KEPT_PAGE_AGE_MS = 120_000

/**
 * Runs in <head> (__root.tsx, after the theme's), before <body> is parsed:
 * marks <html> with `data-kept` when the page was drawn by the server more
 * than KEPT_PAGE_AGE_MS ago, which is a copy the service worker served, and
 * says `no-signal` in it when the phone has no network. The "Updated" note
 * the server drew hidden then shows from the first paint (`kept:` in
 * styles.css), already in the words for no signal (`kept-offline:`), and
 * `useKeptNote` keeps it once hydrated.
 *
 * It also leaves the time on `window` (RENDERED_AT_KEY), for the keeper to
 * mark what this page load writes with, and to compare what was written
 * with this page's own answers (`keptIsNewer`).
 *
 * A string that closes over nothing, as the theme's is, and the attribute's
 * name lives beside `htmlSaysKept`, which reads it, so the two can't drift.
 */
export function keptInitScript(renderedAt: number): string {
  const at = Math.round(renderedAt)
  return `(function(){try{window.${RENDERED_AT_KEY}=${at};if(Date.now()-${at}>${KEPT_PAGE_AGE_MS})document.documentElement.setAttribute('data-kept',navigator.onLine===false?'no-signal':'')}catch(e){}})()`
}

/** Whether the page on screen is a copy the service worker kept a while. */
function htmlSaysKept(): boolean {
  return document.documentElement.hasAttribute('data-kept')
}

/**
 * Whether the note shows, decided once (`shown`, null until it can be), and
 * once everything under it is live, what it was about then and when
 * (`liveFor`), until the next change of that hides it for good (`gone`).
 */
export type NoteLatch = {
  shown: boolean | null
  liveFor: { about: string; at: number } | null
  gone: boolean
}

/**
 * The latch as a page first renders: undecided while hydrating, since the
 * server can't know; otherwise shown only if the line is down right then.
 */
export function firstNoteLatch(
  hydrating: boolean,
  lineDown: boolean,
): NoteLatch {
  return { shown: hydrating ? null : lineDown, liveFor: null, gone: false }
}

/**
 * The latch after a render (`useKeptNote`). The first render that isn't
 * hydrating decides it from the HTML's `data-kept`. Shown, it notes when
 * everything under it came live and what it was about; a change of that
 * (`about`: the day, the view, today, a search) then hides it, and the line
 * going down again before that keeps it. It is hidden for good, too, once
 * nothing under it can be drawn (`empty`): it would say a copy is on screen
 * over a page saying there is none. The same object back when nothing
 * changed, so a render can set it unconditionally.
 */
export function nextNoteLatch(
  latch: NoteLatch,
  at: {
    hydrating: boolean
    htmlKept: boolean
    tone: KeptNoteTone
    about: string
    now: number
    empty?: boolean
  },
): NoteLatch {
  const shown =
    latch.shown === null && !at.hydrating ? at.htmlKept : latch.shown
  let { liveFor, gone } = latch
  if (shown === true && !gone) {
    if (at.empty === true && !at.hydrating) gone = true
    else if (liveFor !== null && liveFor.about !== at.about) gone = true
    else if (at.tone === 'live' && liveFor === null) {
      liveFor = { about: at.about, at: at.now }
    } else if (at.tone !== 'live' && liveFor !== null) liveFor = null
  }
  return shown === latch.shown &&
    liveFor === latch.liveFor &&
    gone === latch.gone
    ? latch
    : { shown, liveFor, gone }
}

/**
 * What a note is about (`nextNoteLatch`): today, the answers under it, and
 * whatever else the page says redraws them.
 */
export function noteAbout(
  todayKey: string,
  queryKeys: ReadonlyArray<QueryKey>,
  about = '',
): string {
  return [todayKey, about, ...queryKeys.map((key) => JSON.stringify(key))].join(
    '\n',
  )
}

/** What the latch makes of the note now, left out while `hidden`. */
export function notePhase(
  latch: NoteLatch,
  hydrating: boolean,
  hidden = false,
): KeptNote['phase'] {
  if (hydrating) return 'hydrating'
  return latch.shown === true && !latch.gone && !hidden ? 'shown' : 'hidden'
}

/**
 * The "Updated" note above what `queryKeys` draw (KeptCopyNote), decided
 * once and then never put in later, so nothing on screen moves for it:
 * - drawn by the server, it shows if the page is a copy the service worker
 *   kept (the head script's `data-kept`, which the CSS already showed it
 *   for at first paint);
 * - drawn in the browser (a tap within the app), it shows if the line is
 *   down as it first renders.
 * A line that drops later is ConnectionNotice's to say. Once shown, its words
 * follow the line; once everything on it is live it says so, with when, and
 * goes at the next change of what it is about (`queryKeys`, `todayKey`
 * moving on, or the page's own `about`: a search, an order, a filter),
 * which redraws the list under it anyway (`nextNoteLatch`). It goes for good
 * once the page has nothing under it to draw (`empty`), and is left out
 * while what is under it could not load for now (`hidden`).
 *
 * `tz` and `todayKey` say which day is today for `asOfToday`: the loader's
 * today, so the server and the hydration render agree.
 */
export function useKeptNote(
  queryKeys: ReadonlyArray<QueryKey>,
  tz: string,
  todayKey: string,
  page: {
    /** What else redraws what is under it, beside its answers and today. */
    about?: string
    /** Nothing under it can be drawn, now or once it is redrawn: the page
     * says it could not load, and the note goes for good. */
    empty?: boolean
    /** Left out for now, decided as before once this is over: what is under
     * it could not load, but what it is redrawn as next can be (a search
     * over the newest clients, which come back as it is cleared). */
    hidden?: boolean
  } = {},
): KeptNote {
  const queryClient = useQueryClient()
  const hydrating = useSyncExternalStore(
    subscribeNothing,
    () => false,
    () => true,
  )
  const tone = useSyncExternalStore(
    subscribe,
    () => toneOf(queryKeys),
    (): KeptNoteTone => 'kept',
  )
  const oldest = useSyncExternalStore(
    subscribe,
    () => keeper.asOf(queryKeys),
    () => htmlAsOf(queryClient, queryKeys),
  )

  // What it is about, for "goes at the next change once live".
  const about = noteAbout(todayKey, queryKeys, page.about)
  const [latch, setLatch] = useState(() =>
    firstNoteLatch(hydrating, keeper.lineDown()),
  )
  const next = nextNoteLatch(latch, {
    hydrating,
    htmlKept: !hydrating && latch.shown === null && htmlSaysKept(),
    tone,
    about,
    now: Date.now(),
    empty: page.empty,
  })
  if (next !== latch) setLatch(next)

  const asOf = tone === 'live' ? (next.liveFor?.at ?? oldest) : oldest
  return {
    phase: notePhase(next, hydrating, page.hidden),
    tone,
    asOf,
    asOfToday: asOf !== null && dayKeyOf(asOf, tz) === todayKey,
  }
}
