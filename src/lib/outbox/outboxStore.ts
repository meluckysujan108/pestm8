import { logConnection } from '#/lib/connectionLog'
import {
  EDIT_LEASE_MS,
  PEEK_RETRY_MS,
  PEEK_TIMEOUT_MS,
  STORE_OP_MS,
  isReadable,
  isStale,
  sessionEndUnanswered,
} from './outboxSet'
import type {
  BookingArgs,
  OutboxDisplay,
  OutboxItem,
  OutboxState,
} from './outboxItem'
import type { OutboxKind } from './outboxSet'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The bookings kept on this phone and not sent yet (the outbox): their own
 * IndexedDB database, `pestm8-outbox`, apart from the kept copy of the
 * schedule (`pestm8-offline`), which a wipe of that copy never touches.
 *
 * Two stores. `owner` is one row saying whose the bookings are, with their
 * first name for the sign-in screens and an `epoch` that is new whenever the
 * person changes. `items` holds one row per booking, by its `localId`.
 *
 * A booking here is work nobody can type in again, so this store is careful
 * in ways the kept copy needn't be:
 * - The database is opened with no version, and never deleted. A store that
 *   is missing is made by one upgrade to the next version, then. A phone left
 *   at a later version by a later build still opens it (`openDb`).
 * - Every change after an item is first kept reads and writes in one
 *   transaction, with a guard on what it reads (`update`), so two tabs never
 *   both act on one booking, and nothing comes back once it has gone.
 * - A failed or slow operation answers `'error'`, never `'refused'`: storage
 *   not answering is not a guard saying no. Each has STORE_OP_MS.
 * - A sign-out discards the person's bookings the moment it is asked, by a
 *   note in localStorage (`writeSignOutTombstone`) that every reader honours,
 *   whatever the wipe after it does. Two more notes there tell every other
 *   tab when its read or its claim is out of date ("What other tabs did").
 *
 * New Job's Book writes an item (book.ts), in a build with keeping switched
 * on; every other change is a guarded one, below.
 *
 * Imports only `logConnection`, outboxSet.ts and types, so rootState.ts can
 * clear it without bringing anything else into the root route.
 */

/** Whose the bookings are. */
export type OutboxOwner = {
  key: 'owner'
  userId: string
  /** For the sign-in screens: "Kevin has 2 jobs on this phone…". '' when
   * the sign-in didn't say. Never their email. */
  firstName: string
  /** New whenever the person changes, so a write for the last one fails. */
  epoch: string
  /** The last page load signed in as them. */
  lastSeenAt: number
  /** The session they were last signed in with here (Better Auth's, which
   * its Convex plugin puts in every token): '' when no sign-in said. */
  sessionId: string
}

/** Who a claim is for, in which session ('' when the token doesn't say). */
export type OutboxUser = {
  userId: string
  firstName: string
  sessionId: string
}

export type OutboxPeek = { owner: OutboxOwner | null; items: Array<OutboxItem> }

/**
 * A change's answer. `'gone'`: no such item (sent and cleared, discarded,
 * wiped). `'refused'`: a guard said no. `'error'`: storage failed, or didn't
 * answer in time; the change may still land later.
 */
export type StoreResult<T> = T | 'gone' | 'refused' | 'error'

/**
 * What a change does to the item it read. `'abort'`: nothing (refused).
 * `'delete'`: the item alone. `'discard'`: the item and every booking made
 * after it on it, not sent yet.
 */
export type Change = OutboxItem | 'abort' | 'delete' | 'discard'

/** Where the bookings live: IndexedDB here, memory in tests. */
export interface OutboxBackend {
  peek: () => Promise<OutboxPeek | 'error'>
  /**
   * Makes the outbox `user`'s. Nobody's yet: a new epoch, and anyone else's
   * items go. Someone else's: a new epoch, and every item goes. Theirs
   * already: the same epoch, and in a session other than the last one's,
   * their items are marked as having outlived it. Always notes when, their
   * first name and the session.
   */
  claim: (
    user: OutboxUser,
    now: number,
  ) => Promise<
    { owner: OutboxOwner; dropped: number; marked: number } | 'error'
  >
  /** Adds `item`. Only over the same draft's own item while that is still
   * waiting or needing a look, and only for this epoch's person; and only
   * while `wanted` says so, asked in the transaction just before it writes:
   * a keep given up on (`giveUpKeep`) is refused, never written late. */
  keep: (
    epoch: string,
    item: OutboxItem,
    wanted?: () => boolean,
  ) => Promise<'kept' | 'exists' | 'refused' | 'error'>
  /** Reads one item and writes what `change` makes of it, in one
   * transaction. Never brings back an item that has gone. */
  update: (
    epoch: string,
    localId: string,
    change: (item: OutboxItem) => Change,
  ) => Promise<StoreResult<OutboxItem | 'deleted'>>
  /** Every item `change` returns a new one for, in one transaction. */
  updateWhere: (
    change: (item: OutboxItem) => OutboxItem | null,
  ) => Promise<number | 'error'>
  /** Deletes every item `match` says, in one transaction: how many. */
  removeWhere: (
    match: (item: OutboxItem, owner: OutboxOwner | null) => boolean,
  ) => Promise<number | 'error'>
  /** Both stores, in one transaction: how many items it held. */
  wipe: () => Promise<number | 'error'>
}

// ── The decisions each transaction makes ──────────────────────────────────
// Pure, so the IndexedDB backend and the tests' memory one make the same.

const OWNER_KEY = 'owner'

/** An item kept for this epoch's person may still be written. */
export function mayWrite(
  owner: OutboxOwner | null,
  epoch: string,
  userId: string,
): owner is OutboxOwner {
  return owner !== null && owner.epoch === epoch && owner.userId === userId
}

/** The two states a person can still change their mind in. */
function open(state: OutboxState): boolean {
  return state === 'waiting' || state === 'needsLook'
}

/**
 * Marks `item` as having outlived its session at `at`, unless it is sent, a
 * newer build's (never changed) or already waiting on the person for an
 * earlier end: that first one stands. A mark the person has answered with
 * Send since gives way to this one. Null when nothing changes.
 */
function markedSessionEnded(item: OutboxItem, at: number): OutboxItem | null {
  if (!isReadable(item) || item.state === 'sent' || sessionEndUnanswered(item))
    return null
  return { ...item, sessionEndedAt: at, updatedAt: at }
}

/**
 * What a claim leaves: the owner row, the items that go, and the items it
 * marks. The same person in another session than the one last claimed here:
 * that one ended with no sign-out on this phone (which would have discarded
 * them), most often while PestM8 was closed, so SessionWatch never saw it
 * (a password changed on a laptop, an iPhone that had shut the app). Their
 * bookings then wait for their say-so, as SessionWatch's mark would have
 * made them (`markSessionEnded`). A session nobody said ('') proves nothing.
 */
export function claimDecision(
  current: OutboxOwner | null,
  items: ReadonlyArray<OutboxItem>,
  user: OutboxUser,
  now: number,
  makeEpoch: () => string,
): { owner: OutboxOwner; drop: Array<string>; mark: Array<OutboxItem> } {
  const same = current?.userId === user.userId
  const newSession =
    same &&
    current.sessionId !== '' &&
    user.sessionId !== '' &&
    current.sessionId !== user.sessionId
  return {
    owner: {
      key: OWNER_KEY,
      userId: user.userId,
      // A sign-in that didn't say keeps the name the last one did, and the
      // session.
      firstName: user.firstName || (same ? current.firstName : ''),
      epoch: same ? current.epoch : makeEpoch(),
      lastSeenAt: now,
      sessionId: user.sessionId || (same ? current.sessionId : ''),
    },
    // Nobody's yet: anyone else's go. Someone else's: all of them go, as
    // everything kept was kept under their epoch.
    drop: same
      ? []
      : items
          .filter((item) => current !== null || item.userId !== user.userId)
          .map((item) => item.localId),
    mark: newSession
      ? items.flatMap((item) => {
          const marked =
            item.userId === user.userId ? markedSessionEnded(item, now) : null
          return marked ? [marked] : []
        })
      : [],
  }
}

/** Whether `item` may be kept, over `existing` if there is one. */
export function keepDecision(
  owner: OutboxOwner | null,
  epoch: string,
  item: OutboxItem,
  existing: OutboxItem | undefined,
): 'kept' | 'exists' | 'refused' {
  if (!mayWrite(owner, epoch, item.userId)) return 'refused'
  // The same draft kept again after a refusal it can retry: the rollback
  // made nothing. Never over one that went, or may have.
  if (existing && !(open(existing.state) && existing.userId === item.userId)) {
    return 'exists'
  }
  return 'kept'
}

/**
 * Every booking that waits on `localId` for its site, and on those, not
 * sent yet: what goes with it when it is discarded.
 */
export function dependantsOf(
  items: ReadonlyArray<OutboxItem>,
  localId: string,
): Array<string> {
  const found: Array<string> = []
  const queue = [localId]
  for (
    let parent = queue.shift();
    parent !== undefined;
    parent = queue.shift()
  ) {
    for (const item of items) {
      if (
        item.dependsOn === parent &&
        open(item.state) &&
        !found.includes(item.localId)
      ) {
        found.push(item.localId)
        queue.push(item.localId)
      }
    }
  }
  return found
}

/** What `update` does: its answer, and what it writes. */
export function updateDecision(
  owner: OutboxOwner | null,
  epoch: string,
  items: ReadonlyArray<OutboxItem>,
  localId: string,
  change: (item: OutboxItem) => Change,
): {
  result: Exclude<StoreResult<OutboxItem | 'deleted'>, 'error'>
  put: OutboxItem | null
  drop: Array<string>
} {
  const nothing = { put: null, drop: [] }
  const item = items.find((row) => row.localId === localId)
  if (!item || owner?.userId !== item.userId) {
    return { result: 'gone', ...nothing }
  }
  if (owner.epoch !== epoch) return { result: 'refused', ...nothing }
  const next = change(item)
  if (next === 'abort') return { result: 'refused', ...nothing }
  if (next === 'delete')
    return { result: 'deleted', put: null, drop: [localId] }
  if (next === 'discard') {
    return {
      result: 'deleted',
      put: null,
      drop: [localId, ...dependantsOf(items, localId)],
    }
  }
  // Its key and whose it is never change.
  const written = { ...next, localId, userId: item.userId }
  return { result: written, put: written, drop: [] }
}

// ── The changes ────────────────────────────────────────────────────────────
// What each move does to the item it reads, and when it refuses. The caller
// of the ones marked "holds the lock" holds the item's Web Lock
// (`pestm8-outbox:item:{localId}`), so no other tab is sending or settling
// it meanwhile; the guard here is what holds across tabs without it.

/** An Edit open in another tab, its lease not yet run out. */
function editedElsewhere(item: OutboxItem, now: number, tab?: string): boolean {
  return (
    item.editing !== null &&
    item.editing.until > now &&
    item.editing.tab !== tab
  )
}

function future(at: number | null, now: number): boolean {
  return at !== null && at > now
}

/**
 * Holds the lock. A waiting item goes: from here it is locked. Never one
 * that has waited too long or outlived its session (`isStale`), as this
 * transaction reads it: a claim marking it as having outlived its session
 * can land between the sender's look and this, in this tab (the mark is
 * what that claim writes, and this write waits on it) or another.
 */
export function beginSendChange(now: number): (item: OutboxItem) => Change {
  return (item) => {
    if (
      !isReadable(item) ||
      tombstoned(item) ||
      item.state !== 'waiting' ||
      isStale(item, now) ||
      editedElsewhere(item, now) ||
      future(item.retryAt, now) ||
      future(item.holdUntil, now)
    ) {
      return 'abort'
    }
    const kind = item.kind as OutboxKind
    return {
      ...item,
      state: 'sending',
      attempts: item.attempts + 1,
      lastAttemptAt: now,
      sentKinds: item.sentKinds.includes(kind)
        ? item.sentKinds
        : [...item.sentKinds, kind],
      updatedAt: now,
    }
  }
}

/** The server answered an attempt: as `apply` says, while it is locked. */
export function answeredChange(
  apply: (item: OutboxItem) => OutboxItem | 'delete',
): (item: OutboxItem) => Change {
  return (item) =>
    isReadable(item) && item.state === 'sending' ? apply(item) : 'abort'
}

/** Holds the lock. Nothing was made by any attempt: it can go again. */
export function unlockChange(now: number): (item: OutboxItem) => Change {
  return (item) =>
    isReadable(item) && item.state === 'sending'
      ? { ...item, state: 'waiting', updatedAt: now }
      : 'abort'
}

/**
 * Holds the lock. The server refused the request id itself, on the
 * connection the call went on, so nothing was made under it: a new one, in
 * place, under the same `localId`.
 */
export function newRequestIdChange(
  requestId: string,
  now: number,
): (item: OutboxItem) => Change {
  return (item) =>
    isReadable(item) && item.state === 'sending'
      ? { ...item, requestId, state: 'waiting', updatedAt: now }
      : 'abort'
}

/** An Edit opens: only while nothing can have been made of it. */
export function beginEditChange(
  tab: string,
  now: number,
): (item: OutboxItem) => Change {
  return (item) =>
    isReadable(item) && open(item.state) && !editedElsewhere(item, now, tab)
      ? {
          ...item,
          editing: { tab, until: now + EDIT_LEASE_MS },
          updatedAt: now,
        }
      : 'abort'
}

/** The Edit still open in `tab`: held a while longer. */
export function renewEditChange(
  tab: string,
  now: number,
): (item: OutboxItem) => Change {
  return (item) =>
    isReadable(item) && item.editing?.tab === tab
      ? { ...item, editing: { tab, until: now + EDIT_LEASE_MS } }
      : 'abort'
}

/** The Edit in `tab` closed without booking. */
export function endEditChange(
  tab: string,
  now: number,
): (item: OutboxItem) => Change {
  return (item) =>
    isReadable(item) && item.editing?.tab === tab
      ? { ...item, editing: null, updatedAt: now }
      : 'abort'
}

/**
 * Book, from an Edit in `tab`: the booking as it now is, to go again. It
 * keeps its request id: nothing was made under it, or the Edit couldn't have
 * opened. On one that had waited too long (or outlived its session), booking
 * it again is the person's own say-so, so it counts as their Send, for that
 * as it stands now (`isStale`). On any other it is not: an edit doesn't put
 * back the clock its three days run on, nor answer a session that ends later.
 */
export function replaceChange(
  tab: string,
  next: { booking: BookingArgs; display: OutboxDisplay },
  now: number,
): (item: OutboxItem) => Change {
  return (item) => {
    if (!isReadable(item) || !open(item.state) || item.editing?.tab !== tab) {
      return 'abort'
    }
    const { dependsOn: _was, ...rest } = item
    const parent =
      'local' in next.booking.property ? next.booking.property.local : undefined
    const confirms = item.problem?.code === 'STALE' || isStale(item, now)
    return {
      ...rest,
      ...(parent !== undefined && { dependsOn: parent }),
      booking: next.booking,
      kind: next.booking.repeat === null ? 'job' : 'series',
      display: next.display,
      state: 'waiting',
      problem: null,
      serverFailures: 0,
      retryAt: null,
      holdUntil: null,
      editing: null,
      confirmedAt: confirms ? now : item.confirmedAt,
      updatedAt: now,
    }
  }
}

/**
 * Holds the lock. Before a send, the phone's own word that the booking
 * needs a look: waited too long, or a Recurring Job whose first visit has
 * gone by (outboxRules.ts `preSendProblem`), or the site the booking it was
 * made on made can't be had (`NOT_FOUND`). Only on one still waiting, with
 * no problem already said.
 */
export function preSendChange(
  code: 'STALE' | 'FIRST_VISIT_PAST' | 'NOT_FOUND',
  now: number,
): (item: OutboxItem) => Change {
  return (item) =>
    isReadable(item) && item.state === 'waiting' && item.problem === null
      ? { ...item, state: 'needsLook', problem: { code }, updatedAt: now }
      : 'abort'
}

/**
 * Holds the lock. What the server says of a booking already sent, asked once
 * after it went (`clientRequests.find`): the site it is at, and a Recurring
 * Job's first visit. Only adds to what is known: an id it went as stays.
 */
export function resultChange(
  found: { propertyId?: Id<'properties'>; firstJobId?: Id<'jobs'> },
  now: number,
): (item: OutboxItem) => Change {
  return (item) =>
    isReadable(item) && item.state === 'sent' && item.result !== null
      ? {
          ...item,
          result: {
            ...item.result,
            ...(found.propertyId !== undefined && {
              propertyId: found.propertyId,
            }),
            ...(found.firstJobId !== undefined && {
              firstJobId: found.firstJobId,
            }),
          },
          updatedAt: now,
        }
      : 'abort'
}

/** A booking sent a while ago, whose card has had time to land: it goes
 * from the phone. Only one that was sent. */
export function forgetSentChange(): (item: OutboxItem) => Change {
  return (item) =>
    isReadable(item) && item.state === 'sent' ? 'delete' : 'abort'
}

/** Send, on one that waited too long: it goes. */
export function confirmStaleChange(now: number): (item: OutboxItem) => Change {
  return (item) =>
    isReadable(item) &&
    item.state === 'needsLook' &&
    item.problem?.code === 'STALE'
      ? {
          ...item,
          state: 'waiting',
          problem: null,
          confirmedAt: now,
          updatedAt: now,
        }
      : 'abort'
}

/**
 * Discard: with the bookings made after it on it. Only while nothing can
 * have been made of it, a newer build's included, since what its state means
 * is the same in every build. `mayHaveGone`: one sent with no answer that
 * can't be settled, which the person discards knowing it may be booked
 * (holds the lock).
 */
export function discardChange(
  opts: { mayHaveGone?: boolean } = {},
): (item: OutboxItem) => Change {
  return (item) =>
    open(item.state) || (opts.mayHaveGone === true && item.state === 'sending')
      ? 'discard'
      : 'abort'
}

// ── The sign-out tombstone ─────────────────────────────────────────────────

/**
 * What a sign-out discarded, kept in localStorage: `{ userId, at }`, for every
 * item of theirs made by then. Written synchronously, before anything else
 * the sign-out does, so a wipe that never lands (WebKit's IndexedDB, or a
 * reload in the 2 s it is given) still counts: every reader treats those
 * items as gone, nothing sends them, and the next page load deletes them.
 * An entry goes once a wipe or delete that covers it has committed. Without
 * localStorage (it can throw in a private window) the wipe is all there is.
 *
 * One entry per person, the latest: it covers everything an earlier one of
 * theirs did. So a phone signed in and out over and over while its IndexedDB
 * won't answer keeps the last few people's, not one person's few.
 */
const TOMBSTONE_KEY = 'pestm8-outbox-discarded'
const TOMBSTONES_KEPT = 4

type Tombstone = { userId: string; at: number }

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isTombstone(value: unknown): value is Tombstone {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Tombstone).userId === 'string' &&
    typeof (value as Tombstone).at === 'number'
  )
}

function readTombstones(): Array<Tombstone> {
  try {
    const raw = storage()?.getItem(TOMBSTONE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isTombstone) : []
  } catch {
    return []
  }
}

function writeTombstones(list: Array<Tombstone>): void {
  try {
    if (list.length === 0) storage()?.removeItem(TOMBSTONE_KEY)
    else storage()?.setItem(TOMBSTONE_KEY, JSON.stringify(list))
  } catch {
    // See above.
  }
}

/** Synchronously: everything of `userId`'s kept until now is discarded. */
export function writeSignOutTombstone(userId: string, at = Date.now()): void {
  writeTombstones(
    [
      ...readTombstones().filter((entry) => entry.userId !== userId),
      { userId, at },
    ].slice(-TOMBSTONES_KEPT),
  )
}

function coveredBy(
  list: ReadonlyArray<Tombstone>,
  item: { userId: string; createdAt: number },
): boolean {
  return list.some(
    (entry) => entry.userId === item.userId && item.createdAt <= entry.at,
  )
}

/** Whether a sign-out discarded `item`. Read afresh: another tab's counts. */
export function tombstoned(item: {
  userId: string
  createdAt: number
}): boolean {
  return coveredBy(readTombstones(), item)
}

/** The entries `covered` once what they cover has gone for good. */
function dropTombstones(covered: ReadonlyArray<Tombstone>): void {
  if (covered.length === 0) return
  writeTombstones(
    readTombstones().filter(
      (entry) =>
        !covered.some((c) => c.userId === entry.userId && c.at === entry.at),
    ),
  )
}

// ── The bookings New Job gave up keeping ───────────────────────────────────

/**
 * The bookings New Job gave up keeping (`giveUpKeep`), by key, kept in
 * localStorage as well as in memory. A keep whose transaction had passed its
 * check before New Job gave it up still lands, and the sheet takes it off
 * the phone again (book.ts); until it has, every reader treats it as gone
 * (`stillKept`), so nothing shows or sends it, and the next page load
 * deletes it (`sweep`). So a page closed while the phone's storage was still
 * writing never leaves a booking the person was told was not kept to go
 * later. An entry goes once the sheet has taken the booking off, or left it
 * needing a look (`forgetGivenUp`), or once a page load has deleted it.
 * Without localStorage nothing is kept at all (`localNotesWork`): New Job
 * sends straight, as it always did.
 */
const GIVEN_UP_KEY = 'pestm8-outbox-given-up'
const GIVEN_UP_KEPT = 50
const PROBE_KEY = 'pestm8-outbox-probe'

/**
 * Whether localStorage takes this page's notes now, tried with one of its
 * own, written and taken away again. Keeping a booking relies on them (a
 * keep given up on, `giveUpKeep`, and a sign-out's tombstone), so without
 * them New Job keeps nothing and sends straight (book.ts `canKeepNow`).
 */
export function localNotesWork(): boolean {
  try {
    const notes = storage()
    if (!notes) return false
    notes.setItem(PROBE_KEY, newEpoch())
    notes.removeItem(PROBE_KEY)
    return true
  } catch {
    return false
  }
}

function readGivenUp(): Array<string> {
  try {
    const raw = storage()?.getItem(GIVEN_UP_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((each): each is string => typeof each === 'string')
      : []
  } catch {
    return []
  }
}

function writeGivenUp(list: ReadonlyArray<string>): void {
  try {
    if (list.length === 0) storage()?.removeItem(GIVEN_UP_KEY)
    else storage()?.setItem(GIVEN_UP_KEY, JSON.stringify(list))
  } catch {
    // See the tombstone's.
  }
}

/** Whether New Job gave `localId` up, in this tab or another, and nothing
 * has taken it off the phone since. Read afresh. */
export function givenUpNoted(localId: string): boolean {
  return readGivenUp().includes(localId)
}

// ── What other tabs did ────────────────────────────────────────────────────

/**
 * Every tab of PestM8 open on the phone shares the outbox, and each holds its
 * own read of it and its own claim. Two notes in localStorage, each a fresh
 * random value whenever it is written, tell a tab when another has made
 * those out of date:
 * - `cleared`, whenever bookings are removed in bulk (a wipe as it starts and
 *   as it lands, a page load's sweep, a business someone was removed from, a
 *   claim that dropped the last person's): a read made before it may hold
 *   bookings now gone, and is read again. Written before a tombstone goes,
 *   so a read the tombstone stopped covering is always one known stale.
 * - `wiped`, whenever a tab wipes the outbox (a sign-out): the person a
 *   claim made before it was for may have signed out, so it no longer
 *   holds, and only the next sign-in check claims again.
 * Without localStorage there are none, and a tab learns of another's
 * clearing only from the guards inside each transaction.
 */
const CLEARED_KEY = 'pestm8-outbox-cleared'
const WIPED_KEY = 'pestm8-outbox-wiped'

function noteOf(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** A fresh note under `key`: what is there now (null without storage). */
function renewNote(key: string): string | null {
  try {
    storage()?.setItem(key, newEpoch())
  } catch {
    // See above.
  }
  return noteOf(key)
}

// ── IndexedDB ──────────────────────────────────────────────────────────────

const DB_NAME = 'pestm8-outbox'
const OWNER_STORE = 'owner'
const ITEMS_STORE = 'items'
const STORES = [OWNER_STORE, ITEMS_STORE]

/**
 * One open, at `version`, or at whatever version the database is at when
 * none is given (a database that doesn't exist yet is made at 1). The
 * upgrade makes whichever store is missing, and only that.
 */
function openAt(version: number | undefined): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false
    // A blocked open can still succeed later, once the connection in the
    // way closes; by then it was answered null, and is closed at once.
    const settle = (db: IDBDatabase | null) => {
      if (settled) {
        db?.close()
        return
      }
      settled = true
      resolve(db)
    }
    try {
      const request =
        version === undefined
          ? indexedDB.open(DB_NAME)
          : indexedDB.open(DB_NAME, version)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(OWNER_STORE)) {
          db.createObjectStore(OWNER_STORE, { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains(ITEMS_STORE)) {
          db.createObjectStore(ITEMS_STORE, {
            keyPath: 'localId',
          }).createIndex('byBusiness', ['businessId', 'createdAt'])
        }
      }
      request.onsuccess = () => {
        const db = request.result
        // A later build's upgrade, in this tab or another, waits on every
        // connection left open.
        db.onversionchange = () => db.close()
        settle(db)
      }
      request.onerror = () => settle(null)
      request.onblocked = () => settle(null)
    } catch {
      settle(null)
    }
  })
}

function hasStores(db: IDBDatabase): boolean {
  return STORES.every((name) => db.objectStoreNames.contains(name))
}

/**
 * A connection for one operation. Never at a fixed version: a phone a later
 * build left at version 3 would refuse every open at 1 or 2 (VersionError),
 * and every booking on it would be out of reach. And never deleted: that
 * would lose them. A store missing (an empty database something opened
 * without a version, or a later build's layout) is made by opening once at
 * the next version up.
 */
async function openDb(): Promise<IDBDatabase | null> {
  const db = await openAt(undefined)
  if (!db || hasStores(db)) return db
  const next = db.version + 1
  db.close()
  const again = await openAt(next)
  if (!again || hasStores(again)) return again
  again.close()
  return null
}

type Stores = { owner: IDBObjectStore; items: IDBObjectStore }

/**
 * Runs `work` in one transaction over both stores, and answers once it has
 * committed: what `work` handed to `done`, or `'error'` if anything failed.
 * A write is durable before it counts (`strict`, which Safari ignores).
 */
async function transact<T>(
  mode: IDBTransactionMode,
  work: (stores: Stores, done: (value: T) => void) => void,
): Promise<T | 'error'> {
  const db = await openDb()
  if (!db) return 'error'
  return new Promise<T | 'error'>((resolve) => {
    let value: T | 'error' = 'error'
    try {
      const tx = db.transaction(STORES, mode, { durability: 'strict' })
      tx.oncomplete = () => resolve(value)
      tx.onerror = () => resolve('error')
      tx.onabort = () => resolve('error')
      work(
        {
          owner: tx.objectStore(OWNER_STORE),
          items: tx.objectStore(ITEMS_STORE),
        },
        (result) => {
          value = result
        },
      )
    } catch {
      resolve('error')
    } finally {
      // Closing waits for the transaction; a connection left open blocks a
      // later version upgrade.
      setTimeout(() => db.close(), 0)
    }
  })
}

/** The owner row as read, or null when there is none it can trust. */
function asOwner(value: unknown): OutboxOwner | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Partial<OutboxOwner>
  if (
    row.key !== OWNER_KEY ||
    typeof row.userId !== 'string' ||
    typeof row.epoch !== 'string'
  ) {
    return null
  }
  return {
    key: OWNER_KEY,
    userId: row.userId,
    firstName: typeof row.firstName === 'string' ? row.firstName : '',
    epoch: row.epoch,
    lastSeenAt: typeof row.lastSeenAt === 'number' ? row.lastSeenAt : 0,
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : '',
  }
}

/** A row whose envelope can be read, whichever build wrote it. */
function isItem(value: unknown): value is OutboxItem {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<OutboxItem>
  return (
    typeof row.localId === 'string' &&
    typeof row.v === 'number' &&
    typeof row.kind === 'string' &&
    typeof row.userId === 'string' &&
    typeof row.businessId === 'string' &&
    typeof row.state === 'string' &&
    typeof row.createdAt === 'number'
  )
}

/** Both stores read, in order: requests in a transaction answer in turn. */
function readAll(
  stores: Stores,
  then: (owner: OutboxOwner | null, items: Array<OutboxItem>) => void,
): void {
  let owner: OutboxOwner | null = null
  const ownerRequest = stores.owner.get(OWNER_KEY)
  ownerRequest.onsuccess = () => {
    owner = asOwner(ownerRequest.result)
  }
  const itemsRequest = stores.items.getAll()
  itemsRequest.onsuccess = () => {
    then(owner, (itemsRequest.result as Array<unknown>).filter(isItem))
  }
}

/** A new epoch: random, so two tabs claiming at once never share one. */
function newEpoch(): string {
  try {
    return crypto.randomUUID()
  } catch {
    // No randomUUID before Safari 15.4, nor outside a secure context.
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
}

export const idbOutboxBackend: OutboxBackend = {
  async peek() {
    // No IndexedDB here at all: nothing can have been kept in it.
    if (typeof indexedDB === 'undefined') return { owner: null, items: [] }
    return transact<OutboxPeek>('readonly', (stores, done) => {
      readAll(stores, (owner, items) => done({ owner, items }))
    })
  },

  claim(user, now) {
    return transact<{ owner: OutboxOwner; dropped: number; marked: number }>(
      'readwrite',
      (stores, done) => {
        readAll(stores, (current, items) => {
          const { owner, drop, mark } = claimDecision(
            current,
            items,
            user,
            now,
            newEpoch,
          )
          // Someone else's: rows no build can read go too.
          if (current !== null && current.userId !== user.userId) {
            stores.items.clear()
          } else {
            for (const localId of drop) stores.items.delete(localId)
          }
          for (const item of mark) stores.items.put(item)
          stores.owner.put(owner)
          done({ owner, dropped: drop.length, marked: mark.length })
        })
      },
    )
  },

  keep(epoch, item, wanted = () => true) {
    return transact<'kept' | 'exists' | 'refused'>(
      'readwrite',
      (stores, done) => {
        const ownerRequest = stores.owner.get(OWNER_KEY)
        ownerRequest.onsuccess = () => {
          const owner = asOwner(ownerRequest.result)
          const existingRequest = stores.items.get(item.localId)
          existingRequest.onsuccess = () => {
            const found: unknown = existingRequest.result
            const decided = !wanted()
              ? 'refused'
              : keepDecision(
                  owner,
                  epoch,
                  item,
                  isItem(found) ? found : undefined,
                )
            if (decided === 'kept') stores.items.put(item)
            done(decided)
          }
        }
      },
    )
  },

  update(epoch, localId, change) {
    return transact<Exclude<StoreResult<OutboxItem | 'deleted'>, 'error'>>(
      'readwrite',
      (stores, done) => {
        readAll(stores, (owner, items) => {
          const decided = updateDecision(owner, epoch, items, localId, change)
          for (const gone of decided.drop) stores.items.delete(gone)
          if (decided.put) stores.items.put(decided.put)
          done(decided.result)
        })
      },
    )
  },

  updateWhere(change) {
    return transact<number>('readwrite', (stores, done) => {
      readAll(stores, (_owner, items) => {
        let changed = 0
        for (const item of items) {
          const next = change(item)
          if (next === null) continue
          stores.items.put({ ...next, localId: item.localId })
          changed++
        }
        done(changed)
      })
    })
  },

  removeWhere(match) {
    return transact<number>('readwrite', (stores, done) => {
      readAll(stores, (owner, items) => {
        let removed = 0
        for (const item of items) {
          if (!match(item, owner)) continue
          stores.items.delete(item.localId)
          removed++
        }
        done(removed)
      })
    })
  },

  wipe() {
    // Cleared, not deleted: `deleteDatabase` waits on every open connection,
    // another tab's included, and would lose the bookings if it went wrong.
    return transact<number>('readwrite', (stores, done) => {
      const count = stores.items.count()
      count.onsuccess = () => {
        stores.owner.clear()
        stores.items.clear()
        done(count.result)
      }
    })
  },
}

// ── This page load ─────────────────────────────────────────────────────────

/** `work`, or `'error'` once `ms` has passed or it failed. */
function withinMs<T>(ms: number, work: Promise<T>): Promise<T | 'error'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.catch(() => 'error' as const),
    new Promise<'error'>((resolve) => {
      timer = setTimeout(() => resolve('error'), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Tries `attempt` again after each of PEEK_RETRY_MS while it keeps failing,
 * then only when the page wakes (`retryOutbox`). The steps are its own: a
 * try something else asked for in between, failing too, takes none of them.
 */
function retrier(attempt: () => void): {
  failed: () => void
  stop: () => void
} {
  let step = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    failed() {
      const wait = PEEK_RETRY_MS[step] as number | undefined
      if (timer !== null || wait === undefined) return
      timer = setTimeout(() => {
        timer = null
        step++
        attempt()
      }, wait)
    },
    stop() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      step = 0
    },
  }
}

const NOTHING: OutboxPeek = { owner: null, items: [] }

let backend: OutboxBackend = idbOutboxBackend
// The page load's read, once one has succeeded, and the `cleared` note as it
// was when that read began. A failure is never kept.
let peeked: OutboxPeek | null = null
let peekedNote: string | null = null
let reading: Promise<OutboxPeek | 'error'> | null = null
// The last read failed, so whoever asked was left with nothing.
let readFailed = false
const readAgain = retrier(() => retryRead())
// Whose the outbox is to be, as the last sign-in check said, and the `wiped`
// note then: null when nobody is, or since a wipe…
let wanted: OutboxUser | null = null
let wantedNote: string | null = null
// …the claim for them on its way…
let claiming: Promise<void> | null = null
const claimAgain = retrier(() => retryClaim())
// …and what it made the outbox, once it landed.
let epoch: string | null = null
let ownerNow: OutboxOwner | null | undefined
// What has been cleared since the read, so none of it is handed out from
// the read: a business someone was removed from, as kept until then…
const cleared: Array<(item: OutboxItem) => boolean> = []
// …and anyone's but the person signed in, once someone is.
let onlyFor: string | null = null
// The keeps this page load has given up on (`giveUpKeep`).
const givenUp = new Set<string>()
let swept: Promise<void> | null = null
const wipeListeners = new Set<() => void>()
// Whoever holds the bookings in memory (outbox.ts), told when this tab has
// changed them in bulk (`onOutboxChanged`), and how many wipes this tab has
// begun, so a fresh read a wipe overtook is never taken.
const changeListeners = new Set<() => void>()
let wipesHere = 0

function notifyChanged(): void {
  for (const listener of [...changeListeners]) {
    try {
      listener()
    } catch {
      // One listener's trouble is not another's.
    }
  }
}

/**
 * What other tabs have done since this one read and claimed (the notes
 * above): a read made before bookings went in bulk is read again, and a
 * claim made before a wipe no longer holds.
 */
function noteOtherTabs(): void {
  if (peeked !== null && noteOf(CLEARED_KEY) !== peekedNote) peeked = null
  if (wanted !== null && noteOf(WIPED_KEY) !== wantedNote) forgetClaim()
}

/** This page load's claim, and whom it was for, forgotten. */
function forgetClaim(): void {
  wanted = null
  epoch = null
  ownerNow = undefined
  claimAgain.stop()
}

/**
 * Whether `item`, as read, is still on the phone: not discarded by a
 * sign-out (here or in another tab), nor given up by New Job (`giveUpKeep`),
 * nor cleared since (a business the person was removed from, anyone's but
 * the person signed in). Whoever holds items in memory asks it again before
 * using one.
 */
export function stillKept(item: OutboxItem): boolean {
  return (
    !tombstoned(item) &&
    !givenUpNoted(item.localId) &&
    (onlyFor === null || item.userId === onlyFor) &&
    !cleared.some((gone) => gone(item))
  )
}

/**
 * What the read holds, less what is gone since (`stillKept`), and less what
 * was sent before this page load, which its sweep deletes.
 */
function shown(read: OutboxPeek): OutboxPeek {
  return {
    owner: ownerNow === undefined ? read.owner : ownerNow,
    items: read.items.filter(
      (item) => stillKept(item) && !(item.state === 'sent' && isReadable(item)),
    ),
  }
}

/**
 * Everything kept, as this page load read it: one read, started at module
 * load in the browser, within PEEK_TIMEOUT_MS. A success is kept for the
 * page load, less whatever has been cleared since, until another tab clears
 * bookings in bulk, when it is read again; changes made since are not in it.
 * A failure is not kept: it is tried again after 1, 5 and 15 s, and whenever
 * the page wakes (`retryOutbox`).
 */
export function peekOutbox(): Promise<OutboxPeek | 'error'> {
  noteOtherTabs()
  if (peeked) return Promise.resolve(shown(peeked))
  reading ??= readOutbox()
  return reading.then((read) => (read === 'error' ? read : shown(read)))
}

async function readOutbox(): Promise<OutboxPeek | 'error'> {
  const started = Date.now()
  let note = noteOf(CLEARED_KEY)
  let found = await withinMs(PEEK_TIMEOUT_MS, backend.peek())
  // Bookings went in bulk in another tab while this read was out, and it may
  // have read them before they went: once more, after.
  if (found !== 'error' && noteOf(CLEARED_KEY) !== note) {
    note = noteOf(CLEARED_KEY)
    found = await withinMs(PEEK_TIMEOUT_MS, backend.peek())
  }
  reading = null
  logConnection('outbox-peek', {
    ms: Date.now() - started,
    n: found === 'error' ? 0 : found.items.length,
    ok: found !== 'error',
  })
  if (found === 'error') {
    readFailed = true
    readAgain.failed()
    return 'error'
  }
  readAgain.stop()
  // A wipe since the read began has the last word: it read as nothing.
  if (peeked === null) {
    peeked = found
    peekedNote = note
  }
  // Storage answering again: a claim that failed is tried again too, and
  // whoever found nothing to show learns there is now.
  retryClaim()
  if (readFailed) {
    readFailed = false
    notifyChanged()
  }
  return peeked
}

/**
 * The outbox read afresh, for whoever holds it in memory (outbox.ts) once
 * another tab has changed it, or this one changed it in bulk: what
 * `peekOutbox` hands out, with every change since in it, and with what is
 * sent, which is in memory until the sender deletes it. It becomes the page
 * load's read too. A wipe in this tab while it reads has the last word, as
 * at `peekOutbox`.
 */
export async function readOutboxNow(): Promise<OutboxPeek | 'error'> {
  noteOtherTabs()
  const wipes = wipesHere
  let note = noteOf(CLEARED_KEY)
  let found = await withinMs(PEEK_TIMEOUT_MS, backend.peek())
  if (found !== 'error' && noteOf(CLEARED_KEY) !== note) {
    note = noteOf(CLEARED_KEY)
    found = await withinMs(PEEK_TIMEOUT_MS, backend.peek())
  }
  if (found === 'error') {
    logConnection('outbox-store-failed', { op: 'read' })
    return 'error'
  }
  if (wipesHere !== wipes) found = peeked ?? NOTHING
  else {
    peeked = found
    peekedNote = note
    readFailed = false
    readAgain.stop()
  }
  return {
    owner: ownerNow === undefined ? found.owner : ownerNow,
    items: found.items.filter(stillKept),
  }
}

/**
 * Called whenever this tab has changed the bookings in bulk, or found them
 * readable after all: a business someone was removed from, a page load's
 * sweep, a claim that dropped or marked any, a session that ended. Not a
 * wipe: `onOutboxWiped` says that, sooner. Whose they are once someone signs
 * in needs no read: `stillKept` holds to it from then. Returns the way to
 * stop.
 */
export function onOutboxChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

function retryRead(): void {
  noteOtherTabs()
  if (peeked === null && reading === null) void peekOutbox()
}

/**
 * When the page wakes (it comes back on screen, or the line comes up): a
 * read or a claim that failed is tried again.
 */
export function retryOutbox(): void {
  retryRead()
  retryClaim()
}

/** Whether a read has succeeded this page load, and is not out of date. */
export function outboxReadable(): boolean {
  return peeked !== null
}

/** This page load's claim on the outbox, for keeping a booking in it. */
export function outboxEpoch(): string | null {
  noteOtherTabs()
  return epoch
}

/**
 * Forgets every booking kept on this phone, and whose they were, at a
 * sign-out. Whoever holds them in memory is told first, before this returns,
 * and so is every other tab, by the notes: the stores are cleared after.
 * Never rejects.
 */
export function wipeOutbox(why: string): Promise<void> {
  const covered = readTombstones()
  // As read, tombstoned or not: a sign-out writes its tombstone first.
  const known = peeked === null ? null : peeked.items.length
  renewNote(WIPED_KEY)
  const asked = renewNote(CLEARED_KEY)
  forgetClaim()
  wipesHere++
  peeked = NOTHING
  peekedNote = asked
  ownerNow = null
  onlyFor = null
  cleared.length = 0
  for (const listener of [...wipeListeners]) {
    try {
      listener()
    } catch {
      // One listener's trouble is not another's.
    }
  }
  logConnection('outbox-wipe', { why, n: known ?? 0, read: known !== null })
  return withinMs(STORE_OP_MS, backend.wipe()).then((done) => {
    if (done === 'error') {
      logConnection('outbox-store-failed', { op: 'wipe' })
      return
    }
    // Landed. Any other tab's read from before now is out of date, which it
    // must be able to tell before the tombstone stops covering it. This
    // tab's own is nothing already.
    const landed = renewNote(CLEARED_KEY)
    if (peekedNote === asked) peekedNote = landed
    dropTombstones(covered)
  })
}

/** Called the moment anything wipes the outbox. Returns the way to stop. */
export function onOutboxWiped(listener: () => void): () => void {
  wipeListeners.add(listener)
  return () => {
    wipeListeners.delete(listener)
  }
}

/**
 * As soon as a page load knows who is signed in (rootState.ts), and again
 * whenever the server says so afresh. Every page load, once: bookings a
 * sign-out discarded go, and so do ones New Job gave up keeping
 * (`giveUpKeep`) and ones sent before it. Then the outbox is
 * made the person's, and anyone else's bookings go (the sign-in screens say
 * so first); the same person in a new session has theirs marked
 * (`claimDecision`). A claim that fails is tried again, on its own and
 * whenever anything needs it. Nobody signed in changes nothing on the phone:
 * that is also what an offline open onto a saved sign-in page looks like,
 * and the person's bookings must still be there when they are back. Nothing
 * of a person's own goes by itself, however long it waits.
 */
export function checkOutboxOwner(user: OutboxUser | null): void {
  if (typeof window === 'undefined') return
  noteOtherTabs()
  swept ??= sweep()
  if (user === null) {
    // Nothing is kept here for nobody.
    forgetClaim()
    return
  }
  if (wanted?.userId === user.userId && wanted.sessionId === user.sessionId) {
    retryClaim()
    return
  }
  wanted = user
  wantedNote = noteOf(WIPED_KEY)
  epoch = null
  // Nothing of anyone else's is handed out from here, claimed or not.
  onlyFor = user.userId
  claimAgain.stop()
  void startClaim(user)
}

async function sweep(): Promise<void> {
  const covered = readTombstones()
  const givenUpThen = readGivenUp()
  const removed = await withinMs(
    STORE_OP_MS,
    backend.removeWhere(
      (item) =>
        coveredBy(covered, item) ||
        givenUpThen.includes(item.localId) ||
        (item.state === 'sent' && isReadable(item)),
    ),
  )
  if (removed === 'error') {
    logConnection('outbox-store-failed', { op: 'sweep' })
    return
  }
  // Before the tombstone goes: other tabs' reads from before now may hold
  // what it covered.
  if (removed > 0 || covered.length > 0 || givenUpThen.length > 0) {
    renewNote(CLEARED_KEY)
  }
  dropTombstones(covered)
  forgetGivenUpAll(givenUpThen)
  if (removed > 0) {
    logConnection('outbox-purge', { why: 'page-load', n: removed })
    notifyChanged()
  }
}

/** A claim for `user`, after the sweep: what writes wait on meanwhile. */
function startClaim(user: OutboxUser): Promise<void> {
  const run = (swept ?? Promise.resolve()).then(() => claimFor(user))
  claiming = run
  const settled = () => {
    if (claiming === run) claiming = null
  }
  void run.then(settled, settled)
  return run
}

/** A claim that failed, tried again: while someone is to have it. */
function retryClaim(): void {
  noteOtherTabs()
  if (wanted !== null && epoch === null && claiming === null) {
    void startClaim(wanted)
  }
}

async function claimFor(user: OutboxUser): Promise<void> {
  const claimed = await withinMs(STORE_OP_MS, backend.claim(user, Date.now()))
  // A wipe, here or in another tab, or another sign-in check since: this
  // claim is not the last word.
  noteOtherTabs()
  if (wanted !== user) return
  if (claimed === 'error') {
    logConnection('outbox-store-failed', { op: 'claim' })
    claimAgain.failed()
    return
  }
  epoch = claimed.owner.epoch
  ownerNow = claimed.owner
  if (claimed.dropped > 0) {
    // Other tabs' reads of the last person's are out of date.
    renewNote(CLEARED_KEY)
    logConnection('outbox-purge', { why: 'other-person', n: claimed.dropped })
  }
  if (claimed.marked > 0) {
    logConnection('outbox-session-ended', {
      why: 'new-session',
      n: claimed.marked,
    })
  }
  if (claimed.dropped > 0 || claimed.marked > 0) notifyChanged()
}

/**
 * Forgets `userId`'s bookings for a business the server says they are no
 * longer in, by its id or its slug, whatever tab kept them, as kept until
 * now (`wipeOutboxWhere`). The caller has
 * checked the answer was about them: one given to someone else's token says
 * nothing about this person.
 */
export function wipeOutboxForBusiness(
  by: { businessId?: string; slug?: string },
  userId: string,
  why: string,
): Promise<void> {
  return wipeOutboxWhere(
    userId,
    (item) =>
      (by.businessId !== undefined && item.businessId === by.businessId) ||
      (by.slug !== undefined && item.slug === by.slug),
    why,
  )
}

/**
 * Forgets those of `userId`'s bookings that `match` takes, whatever tab
 * kept them: handed out by nothing from the moment it is asked, then
 * deleted. For a business they are no longer in (`wipeOutboxForBusiness`),
 * and for the bookings of an earlier stint in one they have since been
 * invited back to (sender.ts). As there, the caller has checked the answer
 * was about them. `match` reads only what every build's items name the same
 * (the envelope) unless it checks `isReadable` first.
 *
 * Only what was kept by the moment it is asked, as a sign-out's tombstone
 * covers: someone removed, invited back and booking again in the same page
 * load keeps what they book then, shown and sent.
 */
export async function wipeOutboxWhere(
  userId: string,
  match: (item: OutboxItem) => boolean,
  why: string,
): Promise<void> {
  const asked = Date.now()
  const theirs = (item: OutboxItem) =>
    item.userId === userId && item.createdAt <= asked && match(item)
  cleared.push(theirs)
  notifyChanged()
  const removed = await withinMs(
    STORE_OP_MS,
    backend.removeWhere((item) => theirs(item)),
  )
  if (removed !== 'error' && removed > 0) {
    renewNote(CLEARED_KEY)
    notifyChanged()
  }
  logConnection('outbox-wipe', {
    why,
    n: removed === 'error' ? 0 : removed,
    ok: removed !== 'error',
  })
}

/**
 * When the session ended with no sign-out of this page's own (revoked,
 * expired, offboarded): `userId`'s bookings are kept, and marked, so the
 * same person signing in again is asked before any of them goes. Someone
 * else signing in drops them (`checkOutboxOwner`). One the person had sent
 * on after an earlier end is marked again: their say-so was for that one.
 * A mark lost here (storage not answering) is made at their next sign-in,
 * which comes in another session (`claimDecision`).
 */
export async function markSessionEnded(
  userId: string,
  at = Date.now(),
): Promise<void> {
  const marked = await withinMs(
    STORE_OP_MS,
    backend.updateWhere((item) =>
      item.userId === userId ? markedSessionEnded(item, at) : null,
    ),
  )
  if (marked === 'error') {
    logConnection('outbox-store-failed', { op: 'session-ended' })
  } else if (marked > 0) {
    logConnection('outbox-session-ended', { why: 'session-watch', n: marked })
    notifyChanged()
  }
}

/**
 * The claim a write goes under: this page load's, or, while the person is
 * known and their claim failed or is still on its way, the one that makes.
 * `'refused'` with nobody to write for: nobody signed in, or a sign-out
 * since, in this tab or another. `'error'` when the claim can't be made,
 * which a storage that isn't answering is: never a refusal.
 */
async function claimToWrite(): Promise<
  { epoch: string } | 'refused' | 'error'
> {
  const before = claimNow()
  if (before !== 'waiting') return before
  const run = claiming ?? (wanted === null ? null : startClaim(wanted))
  if (run) await run
  const after = claimNow()
  return after === 'waiting' ? 'error' : after
}

/** The claim as it stands: held, nobody's to hold, or still to be made. */
function claimNow(): { epoch: string } | 'refused' | 'waiting' {
  noteOtherTabs()
  if (epoch !== null) return { epoch }
  return wanted === null ? 'refused' : 'waiting'
}

/**
 * Adds a booking for this page load's person, within STORE_OP_MS, its claim
 * included: New Job's Book, through `OutboxModel.keep` (outbox.ts).
 *
 * `'error'` once STORE_OP_MS is up says only that it hadn't answered: its
 * transaction may still commit after that. So `landed` is told what it came
 * to whenever that is, and a keep this page load has given up on
 * (`giveUpKeep`) is refused in its own transaction, never written late.
 */
export function keepOutboxItem(
  item: OutboxItem,
  landed?: (result: 'kept' | 'exists' | 'refused' | 'error') => void,
): Promise<'kept' | 'exists' | 'refused' | 'error'> {
  const localId = item.localId
  const done = claimToWrite()
    .then((claim) =>
      typeof claim === 'string'
        ? claim
        : backend.keep(claim.epoch, item, () => !givenUp.has(localId)),
    )
    .catch(() => 'error' as const)
  if (landed) void done.then(landed)
  return withinMs(STORE_OP_MS, done).then((kept) => {
    if (kept === 'error') logConnection('outbox-store-failed', { op: 'keep' })
    return kept
  })
}

/**
 * Gives up on keeping `localId` this page load: New Job sends it straight,
 * its keep not in time, or its sheet was discarded before it said the
 * booking was kept (book.ts). A keep of it still on its way is refused in
 * its own transaction, so it can never land as a booking nobody is waiting
 * on, to be sent later. One whose transaction had passed that check lands
 * all the same, and the sheet takes it off again: until it has, it is noted
 * as given up in localStorage too, so no tab shows or sends it, and the next
 * page load deletes it if this one never got to (`stillKept`, `sweep`).
 * Synchronous, so it holds from the moment it is asked.
 */
export function giveUpKeep(localId: string): void {
  givenUp.add(localId)
  writeGivenUp(
    [...readGivenUp().filter((each) => each !== localId), localId].slice(
      -GIVEN_UP_KEPT,
    ),
  )
}

/**
 * The booking New Job gave up is off the phone, or left on it needing a
 * look, where it shows and never goes by itself (book.ts): no longer
 * treated as gone. A keep of it on its way is still refused.
 */
export function forgetGivenUp(localId: string): void {
  forgetGivenUpAll([localId])
}

function forgetGivenUpAll(gone: ReadonlyArray<string>): void {
  if (gone.length === 0) return
  writeGivenUp(readGivenUp().filter((each) => !gone.includes(each)))
}

/**
 * One guarded change to one item (the changes above), within STORE_OP_MS,
 * its claim included. `op` names it in the note a failure leaves.
 *
 * As with a keep, `'error'` once STORE_OP_MS is up says only that it hadn't
 * answered: its transaction may still commit. `landed` is told what it came
 * to whenever that is.
 */
export function changeOutboxItem(
  op: string,
  localId: string,
  change: (item: OutboxItem) => Change,
  landed?: (result: StoreResult<OutboxItem | 'deleted'>) => void,
): Promise<StoreResult<OutboxItem | 'deleted'>> {
  const done = claimToWrite()
    .then((claim) =>
      typeof claim === 'string'
        ? claim
        : backend.update(claim.epoch, localId, change),
    )
    .catch(() => 'error' as const)
  if (landed) void done.then(landed)
  return withinMs(STORE_OP_MS, done).then((result) => {
    if (result === 'error') logConnection('outbox-store-failed', { op })
    return result
  })
}

/**
 * For tests: `next` in IndexedDB's place, and this page load's read, claim,
 * checks, retries and listeners forgotten, as a new page load would have
 * them.
 */
export function setOutboxBackendForTests(next: OutboxBackend): void {
  backend = next
  peeked = null
  peekedNote = null
  reading = null
  readFailed = false
  readAgain.stop()
  forgetClaim()
  wantedNote = null
  claiming = null
  onlyFor = null
  givenUp.clear()
  cleared.length = 0
  swept = null
  wipeListeners.clear()
  changeListeners.clear()
}

// Started now, in the browser: the read is off every critical path, and a
// cold open with no signal wants its answer as soon as it can have it.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void peekOutbox()
}
