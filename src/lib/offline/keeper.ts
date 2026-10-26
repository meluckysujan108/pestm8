import { hashKey, hydrate, replaceEqualDeep } from '@tanstack/react-query'
import { dayKeyOf } from '../../../convex/lib/dates'
import { APP_VERSION } from '#/lib/appVersion'
import { logConnection } from '#/lib/connectionLog'
import { jwtClaims } from '#/lib/jwt'
import { isOffline } from '#/lib/online'
import { wipeOutboxForBusiness } from '#/lib/outbox/outboxStore'
import { GAP_MS, SOCKET_DOWN_MS } from '#/lib/reach'
import { signedInUserId } from '#/lib/rootState'
import { rq, warm } from '#/lib/routeQueries'
import { QUIET_LINE_MS } from '#/lib/socketWatch'
import {
  keepStartPage,
  keepStartPageIfMissing,
  purgeOtherBusinessPages,
} from './keptPages'
import {
  KEPT_DIRECTORY_DELAY_MS,
  KEPT_ENABLED,
  KEPT_GRACE_MS,
  KEPT_SHAPE,
  KEPT_STAMP_MS,
  KEPT_TICK_MS,
  KEPT_WRITE_DELAY_MS,
  KEPT_WRITE_MAX_DELAY_MS,
  PEEK_TIMEOUT_MS,
  argsOf,
  businessOf,
  confirmsLater,
  inWindow,
  keptIsNewer,
  keptFnOf,
  keptQueries,
  keptWindow,
  lensOf,
  pageRenderedAt,
  rowAsOf,
  shouldUpgrade,
  usableRow,
} from './keptSet'
import {
  currentKeptBackend,
  keptWipeCount,
  onKeptWiped,
  peekKept,
  wipeKept,
} from './keptStore'
import type {
  DehydratedState,
  Query,
  QueryCacheNotifyEvent,
  QueryClient,
  QueryFunction,
  QueryKey,
} from '@tanstack/react-query'
import type { FunctionReturnType } from 'convex/server'
import type { Access } from '#/lib/access'
import type { LineState } from '#/lib/convexClient'
import type { Warmable } from '#/lib/routeQueries'
import type { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import type { KeptFn, KeptWindow } from './keptSet'
import type { KeptOwner, KeptRow } from './keptStore'

/**
 * The copy of the schedule this phone keeps, at run time: what answers from
 * it, what is live, what gets written, and whether the line is down.
 *
 * No React, and part of the root import graph (root-provider.tsx attaches
 * it). The rules it applies are keptSet.ts's, the store keptStore.ts's.
 *
 * - Answering. The cache's query function is wrapped (`wrap`). A kept
 *   function's fetch races the server against the phone's copy: with no
 *   signal the copy answers at once; on a working line the server gets
 *   KEPT_GRACE_MS first. The server's answer then arrives as the adapter's
 *   push, which is what makes the entry live.
 * - Live. An entry is live once the server has pushed it on the connection
 *   the socket has now (`connectionCount`), the socket is connected, and the
 *   line is not quiet. A reconnect re-sends every query, so each comes back
 *   live as its push lands. Pushes are heard through
 *   KeepingConvexQueryClient.
 * - Writing. Only live answers are written, a moment after they change, and
 *   only under a claim: the person's own view of the business they are in,
 *   confirmed live on this connection, over a socket signed in as them.
 *   Never an answer from the phone, the HTML, or anything seen while working
 *   in someone else's account. A change of view or business takes nothing
 *   off live: the server sends every answer such a change alters in the one
 *   transition with access:me, so once that lands, what is in the cache is
 *   all the new view's, and the claim's new epoch refuses a write begun
 *   under the old one.
 * - Pins. What is kept never leaves memory while the app is open
 *   (`gcTime: Infinity` per key), and is asked for again whenever it has
 *   gone: on every new connection, as the page comes back, and every minute,
 *   which is also when a new week moves the pins on.
 */

/** Why the line is down: the phone says so, or PestM8 has not answered. */
export type LineDown = 'no-signal' | 'unreachable'

/** A business as the keeper is told of it, by its layout. */
export type KeptBusiness = {
  _id: Id<'businesses'>
  slug: string
  timezone: string
}

/** A job as a kept day lists it. */
export type DayRow = FunctionReturnType<typeof api.jobs.listDay>[number]

/** A row as a day lists it (`findDayRow`): its day, and how old that is. */
export type FoundDayRow = {
  row: DayRow
  dayKey: string
  /** When the day was last known right; while live, the server's last word. */
  asOf: number
  live: boolean
}

/**
 * What the keeper reads of the Convex client: the browser's
 * HandoverConvexClient, or a test's.
 */
export type KeeperConvex = {
  connectionState: () => {
    isWebSocketConnected: boolean
    connectionCount: number
  }
  subscribeToConnectionState: (
    cb: (state: {
      isWebSocketConnected: boolean
      connectionCount: number
    }) => void,
  ) => () => void
  lineState?: () => LineState
  /** The sign-in token the socket has now (HandoverConvexClient's). */
  currentToken?: () => string | null
}

/**
 * When a socket's spell down began, as far as it counts: null while it is
 * connected or the page is hidden, and otherwise from the first moment it
 * was seen down on screen. Off screen a phone drops its socket as a matter
 * of course.
 */
export function nextDownSince(
  downSince: number | null,
  at: { now: number; visible: boolean; connected: boolean },
): number | null {
  if (at.connected || !at.visible) return null
  return downSince ?? at.now
}

/**
 * The line at `now`: no signal whenever the phone says so; unreachable once
 * the socket has been down SOCKET_DOWN_MS on screen (the wait ConnectionNotice
 * gives it), or QUIET_LINE_MS while it is held for a sign-in token, which a
 * slow line can take a while over without anything being wrong.
 */
export function lineDownAt(
  offline: boolean,
  downSince: number | null,
  now: number,
  pausedForSignIn = false,
): LineDown | null {
  if (offline) return 'no-signal'
  const wait = pausedForSignIn ? QUIET_LINE_MS : SOCKET_DOWN_MS
  return downSince !== null && now - downSince >= wait ? 'unreachable' : null
}

/** Where an entry's data came from, and when it was last known right. */
type Source = {
  from: 'html' | 'kept' | 'live'
  /** html: its dataUpdatedAt; kept: the row's `rowAsOf`; live: the push. */
  asOf: number
  /** Live: the connection it was pushed on, or null once it was refused. */
  epoch: number | null
}

type Claim = {
  epoch: string
  userId: string
  businessId: Id<'businesses'>
  lens: string
}

type Dirty = { first: number; last: number; fn: KeptFn }

/** A key pinned and since left behind is dropped from memory like any other. */
const UNPINNED_GC_MS = 15 * 60_000
/** While the socket is down and not yet counted as down, how often to look. */
const LINE_CHECK_MS = 1_000
/** The longest a claim waits for IndexedDB before it counts as failed. */
const CLAIM_WAIT_MS = 10_000

const ACCESS_FN = 'access:me'

function isAccessKey(queryKey: QueryKey): boolean {
  return queryKey[0] === 'convexQuery' && queryKey[1] === ACCESS_FN
}

/** A ConvexError's code (`ConvexError('NO_ACCESS')` arrives as its data). */
function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const data = (error as { data?: unknown }).data
  return typeof data === 'string' ? data : null
}

function visible(): boolean {
  return (
    typeof document === 'undefined' || document.visibilityState === 'visible'
  )
}

export class Keeper {
  private qc: QueryClient | null = null
  private convex: KeeperConvex | null = null
  private detachNow: (() => void) | null = null

  // What the phone keeps, as this page load read it and has written since.
  private rows = new Map<string, KeptRow>()
  private owner: KeptOwner | null = null
  private peekDone = false
  private peeked: Promise<void> = Promise.resolve()

  private readonly sources = new Map<string, Source>()
  // The connection each query was last pushed on, whether or not the push
  // set anything, kept past the entry itself (`answered`).
  private readonly pushedOn = new Map<string, number>()
  // A new connection that hasn't pushed anything yet (`onConnection`).
  private rewarmOn: number | null = null
  // Each entry's dataUpdatedAt as the HTML brought it, which no push
  // changes: what the server drew the note's time from (`htmlAsOf`).
  private readonly htmlAt = new Map<string, number>()
  // When the server drew this page load's HTML (`pageRenderedAt`): what each
  // row written here is marked with, and what a row is judged newer against.
  private pageRenderedAt: number | null = null
  private readonly pinned = new Map<string, Warmable>()
  // This business's keys from a week gone by, dropped once nothing shows them.
  private readonly leaving = new Map<string, QueryKey>()
  private entered: KeptBusiness | null = null
  private window: KeptWindow | null = null
  private ticks: Array<ReturnType<typeof setInterval>> = []

  private claim: Claim | null = null
  private claimedOn: {
    connection: number
    userId: string
    businessId: string
    lens: string | null
  } | null = null
  private claiming: Promise<void> = Promise.resolve()
  private claimQueued = false
  private wipeQueued = false
  // The business whose pages the worker was last told to keep, this page load.
  private pagesFor: string | null = null

  private readonly dirty = new Map<string, Dirty>()
  // The data last written for each key this page load.
  private readonly written = new Map<string, unknown>()
  private writeTimer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> | null = null
  private writeAllNext = false
  private writesStopped = false
  private persistAsked = false

  // The line.
  private connected = false
  private connectionSeen = 0
  // When the server last spoke on each connection that has ended.
  private readonly heardUntil = new Map<number, number>()
  private downSince: number | null = null
  private lineTimer: ReturnType<typeof setTimeout> | undefined
  // When the line timer is due, while it is pending.
  private lineDue: number | null = null
  private lastDown: LineDown | null = null

  private readonly listeners = new Set<() => void>()
  private notifyQueued = false

  // ── Set-up ───────────────────────────────────────────────────────────────

  /**
   * Starts keeping for this page load: after `connect()` (root-provider.tsx),
   * in the browser only, and before the router hydrates, so every entry the
   * HTML brings is seen arrive. Writes nothing into the cache itself. A
   * second attach replaces the first. Returns the way to stop, for tests.
   */
  attach(qc: QueryClient, convex: KeeperConvex): () => void {
    this.detachNow?.()
    this.qc = qc
    this.convex = convex
    this.pageRenderedAt = pageRenderedAt()
    const cache = qc.getQueryCache()
    for (const query of cache.getAll()) this.noteAdded(query)
    const stopCache = cache.subscribe((event) => this.onCacheEvent(event))

    const state = convex.connectionState()
    this.connected = state.isWebSocketConnected
    this.connectionSeen = state.connectionCount
    const stopConnection = convex.subscribeToConnectionState((next) =>
      this.onConnection(next.isWebSocketConnected, next.connectionCount),
    )
    const stopWiped = onKeptWiped(() => this.onWiped())

    const wipesBefore = keptWipeCount()
    this.peekDone = false
    this.peeked = peekKept().then(
      (kept) => {
        if (kept && keptWipeCount() === wipesBefore) {
          this.owner = kept.owner
          this.rows = new Map(kept.rows.map((row) => [row.hash, row]))
        }
        this.peekDone = true
        this.notify()
      },
      () => {
        this.peekDone = true
        this.notify()
      },
    )

    const onVisibility = () => {
      this.updateLine(false)
      if (visible()) this.tick()
      else this.flush(true)
    }
    const onPageHide = () => this.flush(true)
    const onNetwork = () => {
      this.updateLine(false)
      this.notify()
    }
    const doc = typeof document === 'undefined' ? null : document
    const page =
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
        ? window
        : null
    doc?.addEventListener('visibilitychange', onVisibility)
    page?.addEventListener('pagehide', onPageHide)
    page?.addEventListener('online', onNetwork)
    page?.addEventListener('offline', onNetwork)
    this.updateLine(false)

    const detach = () => {
      stopCache()
      stopConnection()
      stopWiped()
      doc?.removeEventListener('visibilitychange', onVisibility)
      page?.removeEventListener('pagehide', onPageHide)
      page?.removeEventListener('online', onNetwork)
      page?.removeEventListener('offline', onNetwork)
      this.stopTicks()
      clearTimeout(this.writeTimer)
      clearTimeout(this.lineTimer)
      this.lineDue = null
      if (this.detachNow === detach) {
        this.detachNow = null
        this.qc = null
        this.convex = null
      }
    }
    this.detachNow = detach
    return detach
  }

  /**
   * The business whose pages are on screen ($businessSlug's layout, on
   * every page load and every switch): pins what is kept for it, asks for
   * whatever of that is missing, and claims the copy for it once its access
   * is live. With the kill switch off, only what New Job is made of is
   * pinned and asked for, as it was before anything was kept. Returns the
   * effect's clean-up.
   */
  enter(b: KeptBusiness): () => void {
    if (!this.qc) return () => {}
    this.entered = b
    this.pinWindow(b)
    this.startTicks()
    this.queueClaim()
    return () => {
      if (this.entered !== b) return
      this.entered = null
      this.stopTicks()
    }
  }

  /**
   * The business whose pages are on screen, as its layout last said
   * (`enter`): null outside one, and on the server. The bookings kept on
   * the phone go only for this one (lib/outbox/sender.ts).
   */
  enteredBusiness(): KeptBusiness | null {
    return this.entered
  }

  /**
   * Which connection the socket is on: one more for each new one. A call's
   * answer heard on the connection it went on is that call's own; one heard
   * on a later one may follow a commit nobody heard (lib/outbox/sender.ts).
   */
  connection(): number {
    return this.connectionCount()
  }

  /** Called whenever anything here may read differently. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ── Answering ────────────────────────────────────────────────────────────

  /**
   * The cache's query function, answering a kept function from the phone
   * when the server is slower: at once with no signal, after KEPT_GRACE_MS
   * on a working line, and never while signing out, while working in
   * someone else's account, or with the kill switch off. An answer from the
   * server that lost the race is dropped, never taken as live: the adapter's
   * push brings the same answer, and that is what makes the entry live.
   * Anything not kept is asked for as it always was.
   */
  wrap(live: QueryFunction): QueryFunction {
    return (context) => {
      const qc = this.qc
      const key = context.queryKey
      if (typeof window === 'undefined' || !qc || key[0] !== 'convexQuery') {
        return live(context)
      }
      const hash = this.hashOf(key)
      let asked: Promise<unknown>
      try {
        asked = Promise.resolve(live(context))
      } catch (error) {
        asked = Promise.reject(error)
      }
      if (!KEPT_ENABLED || keptFnOf(key) === null) {
        return asked.then((value) => {
          this.answered(hash, key)
          return value
        })
      }
      return new Promise((resolve, reject) => {
        let done = false
        asked.then(
          (value) => {
            if (done) return
            done = true
            this.answered(hash, key)
            resolve(value)
          },
          (error: unknown) => {
            if (done) return
            done = true
            // As the server refused it: the page's own read reports it.
            reject(error)
          },
        )
        void this.keptAnswer(key, () => done).then((kept) => {
          if (done || kept === null) return
          done = true
          this.sources.set(hash, { from: 'kept', asOf: kept.asOf, epoch: null })
          this.notify()
          resolve(kept.data)
        })
      })
    }
  }

  private async keptAnswer(
    key: QueryKey,
    settled: () => boolean,
  ): Promise<{ data: unknown; asOf: number } | null> {
    await this.peeked
    if (settled() || !this.usableFor(key)) return null
    if (this.lineLive()) {
      await new Promise((resolve) => setTimeout(resolve, KEPT_GRACE_MS))
      if (settled()) return null
    }
    // Asked again: a wipe, a sign-out or a switch may have come meanwhile.
    const found = this.usableFor(key)
    return found
      ? { data: found.row.data, asOf: rowAsOf(found.row, found.owner) }
      : null
  }

  /**
   * The kept row that may answer for `key` now, with the owner row it was
   * judged by: this person's (anyone else's is wiped), this business's, the
   * view on screen's, in this fortnight.
   */
  private usableFor(key: QueryKey): { row: KeptRow; owner: KeptOwner } | null {
    const qc = this.qc
    const owner = this.owner
    if (!qc || !owner || !KEPT_ENABLED) return null
    const row = this.rows.get(this.hashOf(key))
    if (!row) return null
    const userId = signedInUserId()
    if (userId === null) return null
    if (owner.userId !== userId) {
      this.wipeLater('other-person')
      return null
    }
    const businessId = businessOf(key)
    if (businessId === null) return null
    const lens = lensOf(
      qc.getQueryData<Access>(
        rq.access(businessId as Id<'businesses'>).queryKey,
      ),
    )
    if (lens === null) return null
    const now = Date.now()
    const timezone =
      this.entered?._id === owner.businessId
        ? this.entered.timezone
        : owner.timezone
    const ok = usableRow(row, {
      owner,
      userId,
      businessId,
      lens,
      window: keptWindow(dayKeyOf(now, timezone)),
      now,
    })
    return ok ? { row, owner } : null
  }

  /** A wipe, out of whatever render or read noticed it was needed. */
  private wipeLater(why: string): void {
    if (this.wipeQueued) return
    this.wipeQueued = true
    queueMicrotask(() => {
      this.wipeQueued = false
      void wipeKept(why)
    })
  }

  // ── Live ─────────────────────────────────────────────────────────────────

  /**
   * The adapter has just pushed onto `hash` (KeepingConvexQueryClient).
   * `pushed`: whether that set its data. A push that found no entry with
   * data sets nothing, and says nothing about what is there, but it does
   * say the server has sent this query on this connection (`answered`).
   */
  heard(hash: string, pushed = true): void {
    const connection = this.connectionCount()
    this.pushedOn.set(hash, connection)
    if (this.rewarmOn === connection) {
      this.rewarmOn = null
      // After the whole transition has landed.
      queueMicrotask(() => this.rewarm())
    }
    const query = this.qc?.getQueryCache().get(hash)
    if (!query) return
    if (query.state.status === 'error') {
      this.refused(query)
      return
    }
    if (
      !pushed ||
      query.state.status !== 'success' ||
      query.state.data === undefined
    ) {
      return
    }
    this.markLive(hash, query.queryKey)
  }

  /**
   * The query function's own answer from the server. The Convex client
   * answers a fetch from what it already holds, when it holds anything, and
   * after a reconnect that is still the last connection's until the new
   * one's first transition. So the answer counts as live only if the server
   * has pushed this query on the connection open now: a fetch it answers
   * fresh is always pushed to the adapter's watch a moment before. Otherwise
   * the first transition's push, which goes to every query watched, makes it
   * live.
   */
  private answered(hash: string, key: QueryKey): void {
    if (this.pushedOn.get(hash) === this.connectionCount()) {
      this.markLive(hash, key)
    }
  }

  private markLive(hash: string, key: QueryKey): void {
    this.sources.set(hash, {
      from: 'live',
      asOf: Date.now(),
      epoch: this.connectionCount(),
    })
    const fn = keptFnOf(key)
    if (fn !== null) this.markDirty(hash, fn)
    if (isAccessKey(key)) this.queueClaim()
    this.notify()
  }

  /**
   * A refusal pushed or fetched onto an entry: it is not live, whatever it
   * still shows. NO_ACCESS on access:me is the server saying this person is
   * no longer in the business, and what the phone kept of it goes: the copy,
   * and their bookings for it not sent yet, which can never be sent now.
   * Someone signed out gets `Unauthenticated`, never that, so a sign-in
   * between two tokens never wipes anything.
   */
  private refused(query: Query): void {
    const hash = query.queryHash
    const src = this.sources.get(hash)
    if (src?.from === 'live' && src.epoch !== null) {
      this.sources.set(hash, {
        ...src,
        asOf: this.confirmedUntil(src),
        epoch: null,
      })
    }
    this.dirty.delete(hash)
    const businessId = businessOf(query.queryKey)
    if (
      isAccessKey(query.queryKey) &&
      businessId !== null &&
      codeOf(query.state.error) === 'NO_ACCESS'
    ) {
      void this.forgetBusiness({ businessId }, 'no-access')
      this.forgetBookings({ businessId }, 'no-access', 'socket')
    }
    this.notify()
  }

  private onCacheEvent(event: QueryCacheNotifyEvent): void {
    const { query } = event
    if (query.queryKey[0] !== 'convexQuery') return
    switch (event.type) {
      case 'added':
        this.noteAdded(query)
        break
      case 'removed':
        this.sources.delete(query.queryHash)
        this.htmlAt.delete(query.queryHash)
        this.dirty.delete(query.queryHash)
        this.written.delete(query.queryHash)
        break
      case 'updated':
        if (event.action.type === 'error') this.refused(query)
        else if (
          event.action.type === 'success' &&
          isAccessKey(query.queryKey)
        ) {
          this.queueClaim()
        }
        break
      default:
        break
    }
  }

  /** An entry that arrives with data came in the HTML (hydration). */
  private noteAdded(query: Query): void {
    if (query.state.data === undefined || this.sources.has(query.queryHash)) {
      return
    }
    this.sources.set(query.queryHash, {
      from: 'html',
      asOf: query.state.dataUpdatedAt,
      epoch: null,
    })
    this.htmlAt.set(query.queryHash, query.state.dataUpdatedAt)
  }

  private onConnection(connected: boolean, count: number): void {
    // The last word of a connection that has ended, for how fresh what it
    // pushed is (`confirmedUntil`).
    const last = this.lastServerMessageAt()
    const newConnection = count !== this.connectionSeen
    const ended = newConnection || (this.connected && !connected)
    if (ended && last !== null && !this.heardUntil.has(this.connectionSeen)) {
      this.heardUntil.set(this.connectionSeen, last)
    }
    this.connected = connected
    this.connectionSeen = count
    this.updateLine(false)
    // Whatever went while the line was down, asked for on the new one once
    // it has pushed something (`heard`): until then the Convex client still
    // answers a fetch from the last connection's results, a refusal that had
    // the entry dropped included, which would only drop it again.
    if (newConnection) this.rewarmOn = count
    this.notify()
  }

  private connectionCount(): number {
    return this.convex?.connectionState().connectionCount ?? 0
  }

  private lastServerMessageAt(): number | null {
    return this.convex?.lineState?.().lastServerMessageAt ?? null
  }

  private pausedForSignIn(): boolean {
    return this.convex?.lineState?.().pausedForSignIn ?? false
  }

  /** Whether the server has said nothing for longer than a live line does. */
  private lineQuiet(now: number): boolean {
    const last = this.lastServerMessageAt()
    return last !== null && now - last >= QUIET_LINE_MS
  }

  private isLiveHash(hash: string): boolean {
    const src = this.sources.get(hash)
    if (src?.from !== 'live' || src.epoch === null || !this.convex) return false
    const state = this.convex.connectionState()
    if (!state.isWebSocketConnected || src.epoch !== state.connectionCount) {
      return false
    }
    if (this.qc?.getQueryCache().get(hash)?.state.status !== 'success') {
      return false
    }
    return !this.lineQuiet(Date.now())
  }

  /**
   * Until when a live answer is known right: the server's last word on the
   * connection that pushed it.
   */
  private confirmedUntil(src: Source): number {
    if (src.epoch === null) return src.asOf
    const until =
      src.epoch === this.connectionCount()
        ? this.lastServerMessageAt()
        : this.heardUntil.get(src.epoch)
    return Math.max(src.asOf, until ?? src.asOf)
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /**
   * Whether the phone's copy has been read this page load, or given up on:
   * until then, a page can't yet say something is not on this phone.
   * Always where nothing is kept (the server, the UI harness).
   */
  copyRead(): boolean {
    return this.qc === null || this.peekDone
  }

  /**
   * When the server last said anything on this connection: how recently an
   * answer that is still live was known right. Null before it has spoken.
   */
  heardAt(): number | null {
    return this.lastServerMessageAt()
  }

  /** Whether `queryKey`'s answer is live, pushed on this connection. */
  isLive(queryKey: QueryKey): boolean {
    return this.qc !== null && this.isLiveHash(this.hashOf(queryKey))
  }

  /**
   * Whether a page can show `queryKey` now: there is an answer in memory, or
   * the phone's copy has one, or the line is up and one will come. Also
   * while the phone's copy is still being read, so nothing says "not on
   * this phone" before it knows. Always on the server.
   */
  readable(queryKey: QueryKey): boolean {
    const qc = this.qc
    if (!qc) return true
    const query = qc.getQueryCache().get(this.hashOf(queryKey))
    if (query?.state.data !== undefined) return true
    if (!this.peekDone) return true
    if (this.usableFor(queryKey)) return true
    return !this.lineDown()
  }

  /**
   * Whether `queryKey` can be shown with nothing from PestM8: there is an
   * answer in memory, or the phone's copy has one that would answer for it
   * now. Unlike `readable`, never on the line's word alone, and not while
   * the copy is still being read. Never on the server.
   */
  onPhone(queryKey: QueryKey): boolean {
    return this.answerOnPhone(queryKey) !== undefined
  }

  /**
   * `queryKey`'s answer with nothing from PestM8 (`onPhone`), without asking
   * for it: the one in memory, else the phone's copy as it would answer for
   * it now. Undefined where there is neither, or nothing is kept here (the
   * server).
   */
  answerOnPhone(queryKey: QueryKey): unknown {
    const qc = this.qc
    if (!qc) return undefined
    const query = qc.getQueryCache().get(this.hashOf(queryKey))
    if (query?.state.data !== undefined) return query.state.data
    if (!this.peekDone) return undefined
    return this.usableFor(queryKey)?.row.data
  }

  /**
   * How old the oldest answer among `queryKeys` is, or null when every one
   * with an answer is live: a kept row's confirmed time, the HTML's own
   * time, or for an answer that was live and is no longer, the server's
   * last word on its connection. Never the end of a wait for a token.
   */
  asOf(queryKeys: ReadonlyArray<QueryKey>): number | null {
    if (!this.qc) return null
    let oldest: number | null = null
    for (const key of queryKeys) {
      const at = this.asOfHash(this.hashOf(key))
      if (at !== null && (oldest === null || at < oldest)) oldest = at
    }
    return oldest
  }

  private asOfHash(hash: string): number | null {
    const query = this.qc?.getQueryCache().get(hash)
    if (!query || query.state.data === undefined) return null
    if (this.isLiveHash(hash)) return null
    const src: Source = this.sources.get(hash) ?? {
      from: 'html',
      asOf: query.state.dataUpdatedAt,
      epoch: null,
    }
    return src.from === 'live' ? this.confirmedUntil(src) : src.asOf
  }

  /**
   * How old the oldest of `queryKeys` was as the page's HTML brought it, or
   * null when none came in it, or nothing is watched here (the server):
   * what the server drew the "Updated" note's time from, and so what the
   * hydration render must say too. Recorded as each entry arrived, so a push
   * landing before the note hydrates changes nothing here.
   */
  htmlAsOf(queryKeys: ReadonlyArray<QueryKey>): number | null {
    if (!this.qc) return null
    let oldest: number | null = null
    for (const key of queryKeys) {
      const at = this.htmlAt.get(this.hashOf(key))
      if (at !== undefined && (oldest === null || at < oldest)) oldest = at
    }
    return oldest
  }

  /**
   * When the phone's copy now answering for `queryKey` was written: null
   * while the answer is the server's or the HTML's. A day kept before it
   * arrived has none of its recurring visits on it (`listDay` shows them
   * only from their own day), and the schedule says so.
   */
  keptSavedAt(queryKey: QueryKey): number | null {
    if (!this.qc) return null
    const hash = this.hashOf(queryKey)
    if (this.sources.get(hash)?.from !== 'kept') return null
    return this.rows.get(hash)?.savedAt ?? null
  }

  /** `asOf` over every kept answer something is showing. */
  screenAsOf(): number | null {
    let oldest: number | null = null
    for (const query of this.shownKept()) {
      const at = this.asOfHash(query.queryHash)
      if (at !== null && (oldest === null || at < oldest)) oldest = at
    }
    return oldest
  }

  /**
   * The kept answers something is showing that are not live, by hash, for
   * ConnectionNotice to time as it times queries with no answer: a socket
   * that looks open but never answers is then noticed too. Not one the
   * server refused: that is an answer, and no sign it can't be reached.
   */
  keptWaiting(): Array<string> {
    return this.shownKept()
      .filter(
        (query) =>
          query.state.status !== 'error' && !this.isLiveHash(query.queryHash),
      )
      .map((query) => query.queryHash)
  }

  private shownKept(): Array<Query> {
    if (!this.qc) return []
    return this.qc
      .getQueryCache()
      .getAll()
      .filter(
        (query) =>
          query.state.data !== undefined &&
          query.getObserversCount() > 0 &&
          keptFnOf(query.queryKey) !== null,
      )
  }

  /** The business's time zone, as the keeper last heard it. */
  timezone(): string | null {
    return this.entered?.timezone ?? this.owner?.timezone ?? null
  }

  /**
   * A job as its day lists it, for the job sheet with no answer: from a day
   * in memory first, then from the phone's copy as it would answer, but
   * never a kept day memory has an answer for. That answer is the newer, and
   * one that no longer lists the job (cancelled, moved, given to someone
   * else) is right not to.
   */
  findDayRow(jobId: Id<'jobs'>): FoundDayRow | null {
    return this.findDayRowWhere((row) => row._id === jobId)
  }

  /**
   * The first row `match` takes, as `findDayRow` looks for a job: a day in
   * memory first, then the phone's copy as it would answer, never a kept day
   * memory has an answer for. For what a row says of its client (their
   * email, on the client sheet with no answer).
   */
  findDayRowWhere(match: (row: DayRow) => boolean): FoundDayRow | null {
    const qc = this.qc
    if (!qc) return null
    const days = qc
      .getQueryCache()
      .findAll({ queryKey: ['convexQuery', 'jobs:listDay'] })
    for (const query of days) {
      const row = findRow(query.state.data, match)
      const dayKey = argsOf(query.queryKey)?.dayKey
      if (!row || typeof dayKey !== 'string') continue
      const asOf = this.asOfHash(query.queryHash)
      return {
        row,
        dayKey,
        asOf: asOf ?? this.lastServerMessageAt() ?? Date.now(),
        live: asOf === null,
      }
    }
    for (const [hash, kept] of this.rows) {
      if (kept.fn !== 'jobs:listDay') continue
      if (qc.getQueryCache().get(hash)?.state.data !== undefined) continue
      const found = this.usableFor(kept.queryKey)
      const row = found && findRow(found.row.data, match)
      const dayKey = argsOf(kept.queryKey)?.dayKey
      if (!found || !row || typeof dayKey !== 'string') continue
      return {
        row,
        dayKey,
        asOf: rowAsOf(found.row, found.owner),
        live: false,
      }
    }
    return null
  }

  /**
   * Replaces what the page's HTML drew with the phone's copy, where that is
   * newer (`keptIsNewer`) and differs (`shouldUpgrade`) — but only if the
   * copy can be read within `withinMs` of the page's hydration effect, so
   * cards never move under a thumb a moment later. Through `hydrate`, which
   * keeps the copy's own time rather than stamping now.
   */
  async upgradeFromKept(
    queryKeys: ReadonlyArray<QueryKey>,
    withinMs: number,
  ): Promise<void> {
    const qc = this.qc
    if (!qc || !KEPT_ENABLED) return
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = await Promise.race([
      this.peeked.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), withinMs)
      }),
    ]).finally(() => clearTimeout(timer))
    if (late) {
      logConnection('kept-upgrade', { n: 0, late: true })
      return
    }
    const queries: DehydratedState['queries'] = []
    let confirmed = 0
    for (const key of queryKeys) {
      const hash = this.hashOf(key)
      const query = qc.getQueryCache().get(hash)
      if (query?.state.status !== 'success') continue
      const found = this.usableFor(key)
      if (!found) continue
      const asOf = rowAsOf(found.row, found.owner)
      const differs =
        replaceEqualDeep(query.state.data, found.row.data) !== query.state.data
      const entry = { live: this.isLiveHash(hash) }
      const newer = keptIsNewer(
        { renderedAt: found.row.renderedAt, asOf },
        {
          renderedAt: this.pageRenderedAt,
          dataUpdatedAt: query.state.dataUpdatedAt,
        },
      )
      if (confirmsLater(entry, newer, differs)) {
        // The HTML's answer, which the phone has since confirmed as it
        // stands: nothing on screen changes, but its time is the copy's.
        // Otherwise the "Updated" note, which goes by the oldest answer on
        // screen, kept the HTML's time beside a day the copy had replaced,
        // as if the booking now on it had not been made yet.
        this.sources.set(hash, { from: 'html', asOf, epoch: null })
        confirmed++
        continue
      }
      if (!shouldUpgrade(entry, newer, differs)) continue
      this.sources.set(hash, { from: 'kept', asOf, epoch: null })
      queries.push({
        queryHash: hash,
        queryKey: query.queryKey,
        state: { ...query.state, data: found.row.data, dataUpdatedAt: asOf },
      })
    }
    if (queries.length === 0 && confirmed === 0) return
    if (queries.length > 0) hydrate(qc, { queries, mutations: [] })
    logConnection('kept-upgrade', {
      n: queries.length,
      confirmed,
      late: false,
      ms: Date.now() - started,
    })
    this.notify()
  }

  /**
   * Forgets what the phone kept of a business the server says this person
   * is no longer in. Only if the copy is that business's: one kept for
   * another stays. What this page load holds in memory can be behind the
   * phone, as another tab may have claimed the copy since for the business
   * refused, so unless memory already says it is that one's, the phone's own
   * owner row decides, read now. If that can't be read within
   * PEEK_TIMEOUT_MS the copy goes anyway, as `wipeKeptForBusiness` has it:
   * an answer like this is rare, and a copy wiped that needn't have been
   * only fills again.
   */
  async forgetBusiness(
    by: { slug?: string; businessId?: string },
    why: string,
  ): Promise<void> {
    await this.peeked
    const theirs = (owner: KeptOwner | null) =>
      owner !== null &&
      (owner.businessId === by.businessId || owner.slug === by.slug)
    if (theirs(this.owner)) {
      await wipeKept(why)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = await Promise.race([
      currentKeptBackend()
        .whose()
        .catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PEEK_TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(timer))
    if (read === null || theirs(read.owner)) await wipeKept(why)
  }

  /**
   * Forgets this person's bookings kept on the phone, not sent yet, for a
   * business the server says they are no longer in (lib/outbox/): only when
   * the answer was about them, which depends on whose token it went out
   * with (`answered`).
   * - `'socket'`: an answer pushed on the socket (NO_ACCESS on access:me)
   *   counts only while the socket is signed in as them. A token another
   *   tab's sign-in handed it answers for someone else, and says nothing
   *   about this person's place in the business.
   * - `'page'`: the root's "Not found" (`notAMemberOf`) was answered with
   *   the page's own sign-in, whose person `signedInUserId` is: by the
   *   business guard's lookup over HTTP (`signedInToken`), or by the server
   *   render's with the request's own session, which seeded this page. So
   *   it is theirs whatever the socket holds, which on a page the server
   *   rendered is nothing yet when "Not found" first shows.
   */
  forgetBookings(
    by: { slug?: string; businessId?: string },
    why: string,
    answered: 'socket' | 'page',
  ): void {
    const userId = signedInUserId()
    if (userId === null) return
    if (answered === 'socket' && this.socketUserId() !== userId) return
    void wipeOutboxForBusiness(by, userId, why)
  }

  // ── The line ─────────────────────────────────────────────────────────────

  /**
   * Whether the line is working: connected, the phone not saying it has no
   * signal, and the server heard from in the last QUIET_LINE_MS.
   */
  lineLive(): boolean {
    const now = Date.now()
    const last = this.lastServerMessageAt()
    return (
      this.convex?.connectionState().isWebSocketConnected === true &&
      !isOffline() &&
      last !== null &&
      now - last < QUIET_LINE_MS
    )
  }

  /** Whether the line is down (`downReason`). */
  lineDown(): boolean {
    return this.downReason() !== null
  }

  /**
   * Why the line is down, or null while it is up: the phone has no signal,
   * or the socket has been down SOCKET_DOWN_MS on screen (QUIET_LINE_MS
   * while held for a sign-in token).
   */
  downReason = (): LineDown | null => {
    const now = Date.now()
    // The look due each second is overdue by more than GAP_MS: the page was
    // frozen, and has thawed before the timer could say so. Its spell down
    // starts again then, so it is not counted as down meanwhile either.
    const frozen = this.lineDue !== null && now - this.lineDue > GAP_MS
    const downSince = frozen ? null : this.downSince
    return lineDownAt(
      isOffline(),
      downSince,
      now,
      downSince !== null && this.pausedForSignIn(),
    )
  }

  /**
   * Follows the socket, counting only time on screen, and looks again each
   * second while it is down but not yet counted so: the wait depends on
   * whether it is held for a token, which says nothing when it changes. A
   * look more than GAP_MS late means the page was frozen, and the count
   * starts again.
   */
  private updateLine(frozen: boolean): void {
    clearTimeout(this.lineTimer)
    this.lineTimer = undefined
    this.lineDue = null
    const now = Date.now()
    this.downSince = nextDownSince(frozen ? null : this.downSince, {
      now,
      visible: visible(),
      connected: this.connected,
    })
    if (this.downSince !== null && this.downReason() !== 'unreachable') {
      const due = now + LINE_CHECK_MS
      this.lineDue = due
      this.lineTimer = setTimeout(
        () => this.updateLine(Date.now() - due > GAP_MS),
        LINE_CHECK_MS,
      )
    }
    const down = this.downReason()
    if (down !== this.lastDown) {
      this.lastDown = down
      this.notify()
    }
  }

  // ── Claiming ─────────────────────────────────────────────────────────────

  private queueClaim(): void {
    if (this.claimQueued) return
    this.claimQueued = true
    // After the push or fetch that asked has landed in the cache.
    queueMicrotask(() => {
      this.claimQueued = false
      this.claiming = this.claiming
        .then(() => this.claimNow())
        .catch(() => undefined)
    })
  }

  /**
   * Claims the copy for the business on screen, under the view access:me
   * now says is live: once per connection and on every change of view.
   * Working in someone else's account claims nothing, and nothing is written
   * meanwhile; what is kept stays. Nor while the socket is signed in as
   * someone other than this page load's person. Nothing is taken off live
   * by a change of view or business (the top of this file says why), and
   * every answer live then is written under the new claim.
   */
  private async claimNow(): Promise<void> {
    const qc = this.qc
    const b = this.entered
    if (!qc || !b || !KEPT_ENABLED) return
    // Never before the page load's read: it would put back what this clears.
    await this.peeked
    if (this.entered !== b) return
    const accessKey = rq.access(b._id).queryKey
    if (!this.isLiveHash(this.hashOf(accessKey))) return
    const userId = signedInUserId()
    if (userId === null) return
    if (this.socketIsSomeoneElse(userId)) {
      // Asked again with the next push: nothing is noted as claimed.
      this.claim = null
      return
    }
    const access = qc.getQueryData<Access>(accessKey)
    const lens = lensOf(access)
    const connection = this.connectionCount()
    const before = this.claimedOn
    if (
      before?.connection === connection &&
      before.userId === userId &&
      before.businessId === b._id &&
      before.lens === lens
    ) {
      return
    }
    this.claimedOn = { connection, userId, businessId: b._id, lens }
    if (lens === null || !access) {
      this.claim = null
      return
    }
    // The view changed on screen since this page load last claimed, or it
    // is back from someone else's account: the start page the worker keeps
    // may have been drawn under the other, and a cold open with no signal
    // takes whose view it is from that page's HTML.
    const viewChanged =
      before !== null && before.businessId === b._id && before.lens !== lens
    const pages = this.tidyPages(b.slug)

    const wipesBefore = keptWipeCount()
    let timer: ReturnType<typeof setTimeout> | undefined
    const claimed = await Promise.race([
      currentKeptBackend()
        .claim({
          userId,
          businessId: b._id,
          slug: b.slug,
          timezone: b.timezone,
          membershipId: access.membershipId,
          lens,
        })
        .catch(() => null),
      // An IndexedDB that never answers, as WebKit's sometimes doesn't, must
      // not hold every claim after this one too.
      new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), CLAIM_WAIT_MS)
      }),
    ]).finally(() => clearTimeout(timer))
    if (keptWipeCount() !== wipesBefore || signedInUserId() !== userId) {
      this.claim = null
      return
    }
    if (claimed === null || claimed === 'late') {
      logConnection('kept-write-failed', {
        why: claimed === null ? 'claim' : 'claim-late',
      })
      this.claim = null
      return
    }

    const { epoch, changed } = claimed
    const kept = this.owner
    if (changed !== 'none') {
      this.rows.clear()
      this.written.clear()
      logConnection('kept-claim', { changed })
    }
    const same = changed === 'none' && kept?.epoch === epoch
    this.owner = {
      key: 'owner',
      userId,
      businessId: b._id,
      slug: b.slug,
      timezone: b.timezone,
      membershipId: access.membershipId,
      lens,
      epoch,
      claimedAt: same ? kept.claimedAt : Date.now(),
      liveAt: same ? kept.liveAt : 0,
    }
    this.claim = { epoch, userId, businessId: b._id, lens }

    if (changed === 'business' || changed === 'user') {
      // Another business's kept answers no longer belong in memory.
      qc.removeQueries({
        predicate: (query) =>
          keptFnOf(query.queryKey) !== null &&
          businessOf(query.queryKey) !== b._id &&
          query.getObserversCount() === 0,
      })
    }
    if (changed !== 'none' || viewChanged) {
      // The start page drawn again, under the view the copy is kept for
      // now, unless `tidyPages` has only just kept it.
      void pages.then((justKept) =>
        justKept ? undefined : keepStartPage(b.slug),
      )
    }

    for (const query of qc.getQueryCache().getAll()) {
      const fn = keptFnOf(query.queryKey)
      if (fn !== null && this.isLiveHash(query.queryHash)) {
        this.markDirty(query.queryHash, fn)
      }
    }
    this.notify()
  }

  /**
   * The worker's pages, the first time this page load claims for a
   * business (plan §3.5): another business's go, and this one's start page
   * is kept if it isn't, with the home marker naming it. Done as the claim
   * is asked, not when IndexedDB answers it, since that may fail or never
   * come; purging needs only the cache. Resolves true when the start page
   * was kept just now.
   */
  private tidyPages(slug: string): Promise<boolean> {
    if (this.pagesFor === slug) return Promise.resolve(false)
    this.pagesFor = slug
    return purgeOtherBusinessPages(slug)
      .then(() => keepStartPageIfMissing(slug))
      .catch(() => false)
  }

  /**
   * Whether the socket is signed in as someone other than `userId`, this
   * page load's person: someone else signed in in another tab (a shared
   * tablet's), and this tab's last token came through their cookie. What
   * the socket brings is then theirs, and is never kept under this person.
   * A token that can't be read says nothing either way.
   */
  private socketIsSomeoneElse(userId: string): boolean {
    const sub = this.socketUserId()
    return sub !== null && sub !== userId
  }

  /**
   * Whose sign-in token the socket has: its `sub`, the user's id. Null when
   * it has none, or one that can't be read.
   */
  socketUserId(): string | null {
    const sub = jwtClaims(this.convex?.currentToken?.())?.sub
    return typeof sub === 'string' && sub !== '' ? sub : null
  }

  // ── Writing ──────────────────────────────────────────────────────────────

  private markDirty(hash: string, fn: KeptFn): void {
    if (!KEPT_ENABLED || this.writesStopped) return
    const now = Date.now()
    const was = this.dirty.get(hash)
    this.dirty.set(hash, { first: was?.first ?? now, last: now, fn })
    this.scheduleWrite()
  }

  private dueOf(d: Dirty): number {
    const wait =
      d.fn === 'clients:directory'
        ? KEPT_DIRECTORY_DELAY_MS
        : KEPT_WRITE_DELAY_MS
    return Math.min(d.last + wait, d.first + KEPT_WRITE_MAX_DELAY_MS)
  }

  private scheduleWrite(): void {
    clearTimeout(this.writeTimer)
    this.writeTimer = undefined
    if (this.writing) return
    let due = Infinity
    for (const d of this.dirty.values()) due = Math.min(due, this.dueOf(d))
    if (due === Infinity) return
    this.writeTimer = setTimeout(
      () => this.flush(false),
      Math.max(0, due - Date.now()),
    )
  }

  /**
   * Writes what is due (everything, as the page is hidden or left), one
   * write at a time. Resolves once that write has landed or been refused.
   */
  flush(all: boolean): Promise<void> {
    if (this.writing) {
      this.writeAllNext ||= all
      return this.writing
    }
    clearTimeout(this.writeTimer)
    this.writeTimer = undefined
    const writing = this.writeDue(all).finally(() => {
      this.writing = null
      const again = this.writeAllNext
      this.writeAllNext = false
      if (again) void this.flush(true)
      else this.scheduleWrite()
    })
    this.writing = writing
    return writing
  }

  /** Whether the claim still holds: the same person, the same view, live. */
  private claimHolds(claim: Claim): string | null {
    const qc = this.qc
    const userId = signedInUserId()
    if (!qc || userId !== claim.userId || this.socketIsSomeoneElse(userId)) {
      return null
    }
    const accessKey = rq.access(claim.businessId).queryKey
    if (!this.isLiveHash(this.hashOf(accessKey))) return null
    return lensOf(qc.getQueryData<Access>(accessKey)) === claim.lens
      ? userId
      : null
  }

  private windowOf(businessId: string): KeptWindow | null {
    const timezone =
      this.entered?._id === businessId
        ? this.entered.timezone
        : this.owner?.businessId === businessId
          ? this.owner.timezone
          : null
    return timezone === null ? null : keptWindow(dayKeyOf(Date.now(), timezone))
  }

  private async writeDue(all: boolean): Promise<void> {
    const qc = this.qc
    const claim = this.claim
    const userId = claim && this.claimHolds(claim)
    const window = claim && this.windowOf(claim.businessId)
    if (
      !qc ||
      !KEPT_ENABLED ||
      this.writesStopped ||
      !claim ||
      !userId ||
      !window
    ) {
      // Nothing to write under: a claim marks everything live again.
      this.dirty.clear()
      return
    }
    const now = Date.now()
    const put: Array<KeptRow> = []
    for (const [hash, d] of this.dirty) {
      if (!all && this.dueOf(d) > now) continue
      this.dirty.delete(hash)
      const query = qc.getQueryCache().get(hash)
      const src = this.sources.get(hash)
      if (!query || !src || !this.isLiveHash(hash)) continue
      const { data } = query.state
      if (
        data === undefined ||
        businessOf(query.queryKey) !== claim.businessId ||
        !inWindow(query.queryKey, window) ||
        this.written.get(hash) === data
      ) {
        continue
      }
      put.push({
        hash,
        fn: d.fn,
        queryKey: query.queryKey as KeptRow['queryKey'],
        businessId: claim.businessId,
        lens: claim.lens,
        data,
        savedAt: src.asOf,
        ...(this.pageRenderedAt === null
          ? {}
          : { renderedAt: this.pageRenderedAt }),
        shape: KEPT_SHAPE,
        build: APP_VERSION,
      })
    }
    const owner = this.owner
    const putting = new Set(put.map((row) => row.hash))
    const drop = owner
      ? [...this.rows.values()]
          .filter(
            (row) =>
              !putting.has(row.hash) &&
              !usableRow(row, {
                owner,
                userId,
                businessId: claim.businessId,
                lens: claim.lens,
                window,
                now,
              }),
          )
          .map((row) => row.hash)
      : []
    if (put.length === 0 && drop.length === 0) return

    const wipesBefore = keptWipeCount()
    const ok = await currentKeptBackend()
      .write(claim.epoch, userId, put, drop)
      .catch(() => false)
    // Overtaken by a wipe or a new claim: what is in memory is theirs now.
    if (keptWipeCount() !== wipesBefore || this.claim?.epoch !== claim.epoch) {
      return
    }
    if (!ok) {
      logConnection('kept-write-failed', { why: 'write', n: put.length })
      this.stopWriting()
      return
    }
    for (const hash of drop) this.rows.delete(hash)
    for (const row of put) {
      this.rows.set(row.hash, row)
      this.written.set(row.hash, row.data)
    }
    if (!this.persistAsked) {
      this.persistAsked = true
      // Safari drops a site's storage after seven days unused otherwise;
      // a Home Screen app is spared either way.
      try {
        void navigator.storage.persist().catch(() => false)
      } catch {
        // No storage manager: nothing to ask.
      }
    }
    this.notify()
  }

  private stopWriting(): void {
    this.writesStopped = true
    this.dirty.clear()
    clearTimeout(this.writeTimer)
    this.writeTimer = undefined
  }

  /**
   * Notes on the phone that every kept answer is live, now that the server
   * has spoken: `owner.liveAt`, which counts as confirming every row
   * (`rowAsOf`). Only with nothing waiting to be written, so a row is never
   * confirmed past a change it hasn't taken in.
   */
  private async stamp(): Promise<void> {
    const claim = this.claim
    const owner = this.owner
    if (!KEPT_ENABLED || this.writesStopped || !claim || !owner) return
    if (!visible() || this.dirty.size > 0 || this.writing) return
    if (this.entered?._id !== claim.businessId || this.pinned.size === 0) {
      return
    }
    const userId = this.claimHolds(claim)
    if (!userId) return
    for (const hash of this.pinned.keys()) if (!this.isLiveHash(hash)) return
    const at = this.lastServerMessageAt()
    if (at === null || at <= owner.liveAt) return
    const wipesBefore = keptWipeCount()
    const ok = await currentKeptBackend()
      .stamp(claim.epoch, userId, at)
      .catch(() => false)
    if (keptWipeCount() !== wipesBefore || this.claim?.epoch !== claim.epoch) {
      return
    }
    if (!ok) {
      logConnection('kept-write-failed', { why: 'stamp' })
      this.stopWriting()
      return
    }
    if (this.owner) {
      this.owner = { ...this.owner, liveAt: Math.max(this.owner.liveAt, at) }
    }
  }

  private onWiped(): void {
    this.rows.clear()
    this.owner = null
    this.claim = null
    this.claimedOn = null
    this.pagesFor = null
    this.dirty.clear()
    this.written.clear()
    clearTimeout(this.writeTimer)
    this.writeTimer = undefined
    this.notify()
  }

  // ── Pins ─────────────────────────────────────────────────────────────────

  /**
   * Pins what is kept for `b` this fortnight, and lets go of what was kept
   * before that no longer is. A day or week of this business's gone by is
   * dropped once nothing shows it (`pruneLeaving`); another business's is
   * only unpinned, never dropped, until a claim with signal says it isn't
   * this person's business any more (R13 in the plan).
   */
  private pinWindow(b: KeptBusiness): void {
    const qc = this.qc
    if (!qc) return
    const window = keptWindow(dayKeyOf(Date.now(), b.timezone))
    const wanted = KEPT_ENABLED
      ? keptQueries(b._id, window)
      : [rq.directory(b._id), rq.roster(b._id), rq.jobTypes(b._id)]
    const keep = new Map(
      wanted.map((query) => [this.hashOf(query.queryKey), query]),
    )
    const weekChanged =
      this.window !== null && this.window.dayKeys[0] !== window.dayKeys[0]
    for (const [hash, query] of this.pinned) {
      if (keep.has(hash)) continue
      this.pinned.delete(hash)
      const fn = keptFnOf(query.queryKey)
      // The directory, team and job types stay pinned for good, as they
      // were before anything was kept (root-provider.tsx).
      if (fn !== 'jobs:listDay' && fn !== 'jobs:listWeek') continue
      qc.setQueryDefaults(query.queryKey, { gcTime: UNPINNED_GC_MS })
      if (businessOf(query.queryKey) === b._id) {
        this.leaving.set(hash, query.queryKey)
      }
    }
    for (const [hash, query] of keep) {
      this.leaving.delete(hash)
      if (!this.pinned.has(hash)) {
        qc.setQueryDefaults(query.queryKey, { gcTime: Infinity })
        this.pinned.set(hash, query)
      }
      // An entry already here (the HTML's) keeps the time it was made with
      // unless told; it can only ever be lengthened.
      const existing = qc.getQueryCache().get(hash)
      if (existing && existing.options.gcTime !== Infinity) {
        existing.setOptions({ ...existing.options, gcTime: Infinity })
      }
    }
    this.window = window
    this.pruneLeaving()
    this.rewarm()
    // Rows outside the new fortnight go at the next write; this is one.
    if (weekChanged) void this.flush(true)
  }

  private pruneLeaving(): void {
    const qc = this.qc
    if (!qc) return
    for (const [hash, key] of this.leaving) {
      const query = qc.getQueryCache().get(hash)
      if (query && query.getObserversCount() > 0) continue
      if (query) qc.removeQueries({ queryKey: key, exact: true })
      this.leaving.delete(hash)
    }
  }

  /**
   * Asks again for every pinned answer that has gone: one `warm` or
   * `forgetRefusedQueries` dropped after a refusal before it had data, say.
   * Offline, the phone's copy answers; otherwise the server.
   */
  private rewarm(): void {
    const qc = this.qc
    if (!qc || !this.entered) return
    const missing = [...this.pinned.entries()]
      .filter(([hash]) => qc.getQueryCache().get(hash) === undefined)
      .map(([, query]) => query)
    if (missing.length > 0) void warm(qc, ...missing)
  }

  /** Each minute, and as the page comes back: the week, and what has gone. */
  private tick(): void {
    const b = this.entered
    if (!b) return
    const today = keptWindow(dayKeyOf(Date.now(), b.timezone))
    if (this.window?.dayKeys[0] !== today.dayKeys[0]) this.pinWindow(b)
    else {
      this.pruneLeaving()
      this.rewarm()
    }
  }

  private startTicks(): void {
    if (this.ticks.length > 0) return
    this.ticks = [
      setInterval(() => this.tick(), KEPT_TICK_MS),
      setInterval(() => void this.stamp(), KEPT_STAMP_MS),
    ]
  }

  private stopTicks(): void {
    for (const tick of this.ticks) clearInterval(tick)
    this.ticks = []
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** The cache's own hash for a key: convexQueryClient.hashFn() here. */
  private hashOf(queryKey: QueryKey): string {
    const hashFn = this.qc?.getDefaultOptions().queries?.queryKeyHashFn
    return (hashFn ?? hashKey)(queryKey)
  }

  private notify(): void {
    if (this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      for (const listener of [...this.listeners]) listener()
    })
  }
}

function findRow(
  data: unknown,
  match: (row: DayRow) => boolean,
): DayRow | undefined {
  return Array.isArray(data) ? (data as Array<DayRow>).find(match) : undefined
}

/** The page load's keeper (root-provider.tsx attaches it). */
export const keeper = new Keeper()
