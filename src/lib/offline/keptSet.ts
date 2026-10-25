import { addDaysToKey, startOfWeekKey } from '../../../convex/lib/dates'
import { keptOutOfHtml, rq } from '#/lib/routeQueries'
import { KEPT_FNS, KEPT_SHAPE } from './keptShape'
import type { QueryKey } from '@tanstack/react-query'
import type { Access } from '#/lib/access'
import type { Warmable } from '#/lib/routeQueries'
import type { Id } from '../../../convex/_generated/dataModel'
import type { KeptFn } from './keptShape'
import type { KeptOwner, KeptRow } from './keptStore'

/**
 * What this phone keeps a copy of, for opening the schedule and New Job with
 * no signal, and the rules for when a kept answer may be used: pure, so the
 * keeper (keeper.ts) and its tests make the same decisions.
 *
 * keptStore.ts imports the constants, and through it rootState.ts and the
 * root route, so nothing here may import either of those. Its one value
 * import beyond the date helpers is routeQueries.ts, for the keys, which
 * every loader already depends on and which imports neither.
 *
 * Which functions are kept, and the shape number, live in keptShape.ts, which
 * imports nothing, so the server's test of that shape can read them; they are
 * passed on from here.
 */

export { KEPT_FNS, KEPT_SHAPE } from './keptShape'
export type { KeptFn } from './keptShape'

/**
 * The kill switch. False: nothing is read from the phone, nothing is served
 * from it or written to it, and whatever an earlier build kept is wiped on
 * the next page load (`checkKeptOwner`).
 *
 * `as boolean`: a bare `true` is typed as the literal, and every check on it
 * would then be an unnecessary condition to the linter.
 */
export const KEPT_ENABLED = true as boolean

/**
 * How long the page load's read of the kept copy may take before it is given
 * up on. Off the critical path either way: the read starts at module load.
 */
export const PEEK_TIMEOUT_MS = 3_000

/** A kept answer older than this is never shown: three weeks. */
export const KEPT_MAX_AGE_MS = 21 * 86_400_000

/**
 * How much later than a page's own answer a kept one must have been
 * confirmed to replace it after hydration, where the row doesn't say which
 * page load wrote it (`keptIsNewer`): the phone's clock and the server's can
 * disagree by this much.
 */
export const KEPT_UPGRADE_MARGIN_MS = 2 * 60_000

/**
 * On a line that is working, how long the server is given to answer before
 * the phone's copy is shown instead, so a page with signal rarely swaps what
 * it shows.
 */
export const KEPT_GRACE_MS = 600

/** How long after a change to a kept answer it is written to the phone… */
export const KEPT_WRITE_DELAY_MS = 1_500
/** …and for the client directory, the largest of them. */
export const KEPT_DIRECTORY_DELAY_MS = 5_000
/** An answer that keeps changing is written at most this long after the first. */
export const KEPT_WRITE_MAX_DELAY_MS = 10_000
/** How often the phone notes that every kept answer is still live. */
export const KEPT_STAMP_MS = 30_000
/** How often the keeper asks again for what has gone, and checks the week. */
export const KEPT_TICK_MS = 60_000

/** The days and weeks kept: this week and next, Monday to Sunday. */
export type KeptWindow = {
  weekStarts: readonly [string, string]
  dayKeys: ReadonlyArray<string>
}

/**
 * The fortnight kept for `todayKey` (a day in the business's time zone):
 * the Monday-based week it falls in, and the one after, as the week strip
 * and `listWeek` count them.
 */
export function keptWindow(todayKey: string): KeptWindow {
  const first = startOfWeekKey(todayKey)
  return {
    weekStarts: [first, addDaysToKey(first, 7)],
    dayKeys: Array.from({ length: 14 }, (_, i) => addDaysToKey(first, i)),
  }
}

/**
 * Every query kept for a business over `w`: both weeks, all fourteen days,
 * the directory, the team and the job types. Built from `rq`, so each key is
 * the very one a loader warms and a page reads.
 */
export function keptQueries(
  businessId: Id<'businesses'>,
  w: KeptWindow,
): Array<Warmable> {
  return [
    ...w.weekStarts.map((startKey) => rq.week(businessId, startKey)),
    ...w.dayKeys.map((dayKey) => rq.day(businessId, dayKey)),
    rq.directory(businessId),
    rq.roster(businessId),
    rq.jobTypes(businessId),
  ]
}

const KEPT_NAMES: ReadonlySet<string> = new Set(KEPT_FNS)

/** A Convex query key's arguments, or null for anything else ('skip'). */
export function argsOf(queryKey: QueryKey): Record<string, unknown> | null {
  if (queryKey[0] !== 'convexQuery') return null
  const args = queryKey[2]
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : null
}

/** The business a Convex query key asks about, or null. */
export function businessOf(queryKey: QueryKey): string | null {
  const id = argsOf(queryKey)?.businessId
  return typeof id === 'string' ? id : null
}

/**
 * Which kept function a query key is for, or null: anything else, a skipped
 * key, and anything kept out of the HTML, which is never kept here either.
 */
export function keptFnOf(queryKey: QueryKey): KeptFn | null {
  if (argsOf(queryKey) === null || keptOutOfHtml(queryKey)) return null
  const name = queryKey[1]
  return typeof name === 'string' && KEPT_NAMES.has(name)
    ? (name as KeptFn)
    : null
}

/** Whether a key's day or week is in `w`. True for anything not by date. */
export function inWindow(queryKey: QueryKey, w: KeptWindow): boolean {
  const args = argsOf(queryKey)
  switch (keptFnOf(queryKey)) {
    case 'jobs:listDay':
      return typeof args?.dayKey === 'string' && w.dayKeys.includes(args.dayKey)
    case 'jobs:listWeek':
      return (
        typeof args?.startKey === 'string' &&
        w.weekStarts.includes(args.startKey)
      )
    default:
      return true
  }
}

/**
 * Whose view of the business a kept answer is: the person's own membership
 * and, for an owner, which of his views. Null while they work in someone
 * else's account or look at it as them, when nothing is written and nothing
 * is served: a phone never holds another member's clients.
 */
export function lensOf(a: Access | undefined): string | null {
  if (!a) return null
  if (a.actingAs !== null || a.viewingAs !== null) return null
  if (a.view?.mode === 'account') return null
  return `${a.membershipId}|${a.view?.mode ?? '-'}`
}

/** Whether `data` has the shape `fn` answers with: a list, or the directory. */
export function shapeOk(fn: KeptFn, data: unknown): boolean {
  if (fn !== 'clients:directory') return Array.isArray(data)
  if (typeof data !== 'object' || data === null) return false
  const { clients, sites } = data as { clients?: unknown; sites?: unknown }
  return Array.isArray(clients) && Array.isArray(sites)
}

/** Where and when a kept row is being considered for use. */
export type KeptUse = {
  owner: KeptOwner
  userId: string
  businessId: string
  lens: string
  window: KeptWindow
  now: number
}

/**
 * Whether a kept row may answer for its key now: this build's shape, kept
 * for this person, this business and this view, in the window, under three
 * weeks old, and shaped as its function answers. Anything else is skipped,
 * and dropped at the next write.
 */
export function usableRow(row: KeptRow, at: KeptUse): boolean {
  const { owner } = at
  return (
    row.shape === KEPT_SHAPE &&
    owner.userId === at.userId &&
    owner.businessId === at.businessId &&
    owner.lens === at.lens &&
    row.businessId === at.businessId &&
    row.lens === at.lens &&
    businessOf(row.queryKey) === at.businessId &&
    keptFnOf(row.queryKey) === row.fn &&
    inWindow(row.queryKey, at.window) &&
    at.now - row.savedAt < KEPT_MAX_AGE_MS &&
    shapeOk(row.fn, row.data)
  )
}

/**
 * When a kept row was last known to be right: when it was written, or the
 * last time the server spoke while every kept answer was live, if later.
 */
export function rowAsOf(row: KeptRow, owner: KeptOwner): number {
  return Math.max(row.savedAt, owner.liveAt)
}

/**
 * The name the head script (`keptInitScript`, useKept.ts) gives, on
 * `window`, the time the server drew the page: what each row this page load
 * writes is marked with (`KeptRow.renderedAt`).
 */
export const RENDERED_AT_KEY = '__pestm8RenderedAt'

/** When the server drew the page on screen, by its clock, if the head script said. */
export function pageRenderedAt(): number | null {
  if (typeof window === 'undefined') return null
  const at: unknown = Reflect.get(window, RENDERED_AT_KEY)
  return typeof at === 'number' && Number.isFinite(at) ? at : null
}

/**
 * Whether a kept row is newer than the answer a page's HTML brought.
 *
 * By the server's clock alone where the row says which page load wrote it.
 * Every row is written from answers the server pushed after that page was
 * drawn, so a row written under this page, or under one drawn since, is at
 * least as new as this page's HTML. However soon after: a caller booked a
 * minute after the app opened, the phone locked, the app reopened with no
 * signal on the page the service worker kept from that opening.
 *
 * Otherwise (a row that doesn't say, or a page whose head script didn't
 * run) by the phone's time for the row against the server's for the page,
 * which can disagree, so only when clearly later (KEPT_UPGRADE_MARGIN_MS).
 */
export function keptIsNewer(
  row: { renderedAt?: number; asOf: number },
  page: { renderedAt: number | null; dataUpdatedAt: number },
): boolean {
  if (row.renderedAt !== undefined && page.renderedAt !== null) {
    return row.renderedAt >= page.renderedAt
  }
  return row.asOf > page.dataUpdatedAt + KEPT_UPGRADE_MARGIN_MS
}

/**
 * Whether a page's answer should give way to the kept one after hydration:
 * never a live answer, never for the same data, and only for a newer copy
 * (`keptIsNewer`).
 */
export function shouldUpgrade(
  entry: { live: boolean },
  newer: boolean,
  differs: boolean,
): boolean {
  return !entry.live && differs && newer
}

/**
 * Whether the kept copy confirms a page's answer as it stands, and is newer:
 * the answer stays on screen, and its time becomes the copy's. The other
 * half of `shouldUpgrade`.
 */
export function confirmsLater(
  entry: { live: boolean },
  newer: boolean,
  differs: boolean,
): boolean {
  return !entry.live && !differs && newer
}
