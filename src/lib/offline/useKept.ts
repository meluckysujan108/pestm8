import { useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { dayKeyOf } from '../../../convex/lib/dates'
import { isOffline } from '#/lib/online'
import { keeper } from './keeper'
import { RENDERED_AT_KEY } from './keptSet'
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
 * (`about`: the day, the view, today) then hides it, and the line going
 * down again before that keeps it. The same object back when nothing
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
  },
): NoteLatch {
  const shown =
    latch.shown === null && !at.hydrating ? at.htmlKept : latch.shown
  let { liveFor, gone } = latch
  if (shown === true && !gone) {
    if (liveFor !== null && liveFor.about !== at.about) gone = true
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

/** What the latch makes of the note now. */
export function notePhase(
  latch: NoteLatch,
  hydrating: boolean,
): KeptNote['phase'] {
  if (hydrating) return 'hydrating'
  return latch.shown === true && !latch.gone ? 'shown' : 'hidden'
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
 * goes at the next change of what it is about (`queryKeys`, or `todayKey`
 * moving on), which redraws the list under it anyway (`nextNoteLatch`).
 *
 * `tz` and `todayKey` say which day is today for `asOfToday`: the loader's
 * today, so the server and the hydration render agree.
 */
export function useKeptNote(
  queryKeys: ReadonlyArray<QueryKey>,
  tz: string,
  todayKey: string,
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
  const about = `${todayKey}\n${queryKeys.map((key) => JSON.stringify(key)).join('\n')}`
  const [latch, setLatch] = useState(() =>
    firstNoteLatch(hydrating, keeper.lineDown()),
  )
  const next = nextNoteLatch(latch, {
    hydrating,
    htmlKept: !hydrating && latch.shown === null && htmlSaysKept(),
    tone,
    about,
    now: Date.now(),
  })
  if (next !== latch) setLatch(next)

  const asOf = tone === 'live' ? (next.liveFor?.at ?? oldest) : oldest
  return {
    phase: notePhase(next, hydrating),
    tone,
    asOf,
    asOfToday: asOf !== null && dayKeyOf(asOf, tz) === todayKey,
  }
}
