import { logConnection } from '#/lib/connectionLog'
import { KEPT_ENABLED, PEEK_TIMEOUT_MS } from './keptSet'
import type { Id } from '../../../convex/_generated/dataModel'
import type { KeptFn } from './keptSet'

/**
 * The copy of the schedule this phone keeps, so it still opens with no
 * signal: its own IndexedDB database, apart from `pestm8` (report drafts), so
 * neither's upgrade waits on the other's.
 *
 * Two stores. `owner` is one row saying whose copy it is — the person, the
 * business, whose view (`lens`) — with an `epoch` that is new whenever any of
 * those changes. `rows` holds one answer per query, by its react-query hash.
 *
 * Whose it is is checked inside the transaction that writes. A write or a
 * stamp names the epoch and the person it was claimed for, and is refused
 * unless the owner row still says so when the transaction reads it. So a
 * sign-out in this tab or another, or a claim for another business, that
 * lands while a write is on its way makes the write fail, rather than put
 * the last person's jobs back after they have gone. A write counts only once
 * its transaction has committed: a full disk is reported at commit.
 *
 * Every call is best-effort, as `draftMirror.ts`'s are: IndexedDB is missing
 * in a private window, can throw on open and can refuse a write on quota, and
 * none of that may cost the page anything. Without it, nothing is kept.
 *
 * Imports only `logConnection` and keptSet.ts's constants, so rootState.ts
 * can wipe from here without bringing anything else into the root route.
 */

export type KeptOwner = {
  key: 'owner'
  userId: string
  businessId: Id<'businesses'>
  slug: string
  timezone: string
  membershipId: Id<'memberships'>
  /** Whose view of the business the rows are (`lensOf`, keptSet.ts). */
  lens: string
  /** New with every claim that changes the person, business or view. */
  epoch: string
  claimedAt: number
  /** The last time the server spoke while every kept answer was live. */
  liveAt: number
}

export type KeptRow = {
  /** The cache's queryHash for `queryKey`. */
  hash: string
  fn: KeptFn
  queryKey: readonly ['convexQuery', string, Record<string, unknown>]
  businessId: string
  lens: string
  data: unknown
  savedAt: number
  shape: number
  build: string
}

/** What a claim says about whose copy this is to be. */
export type KeptClaim = Omit<
  KeptOwner,
  'key' | 'epoch' | 'claimedAt' | 'liveAt'
>

/** What a claim changed, the person first, then the business, then the view. */
export type KeptChange = 'none' | 'lens' | 'business' | 'user'

/** Everything kept, as read in one transaction. */
export type KeptPeek = { owner: KeptOwner | null; rows: Array<KeptRow> }

/** Where the copy lives: IndexedDB here (`keptBackend`), memory in tests. */
export interface KeptBackend {
  /** Null: no IndexedDB, blocked, or slower than PEEK_TIMEOUT_MS. */
  peek: () => Promise<KeptPeek | null>
  /** The owner row alone, none of the rows. Null when it can't be read. */
  whose: () => Promise<{ owner: KeptOwner | null } | null>
  /** Clears the rows unless nothing changed. Null when it failed. */
  claim: (
    next: KeptClaim,
  ) => Promise<{ epoch: string; changed: KeptChange } | null>
  /** False: refused (no longer this epoch and person), or failed. */
  write: (
    epoch: string,
    userId: string,
    put: Array<KeptRow>,
    drop: Array<string>,
  ) => Promise<boolean>
  stamp: (epoch: string, userId: string, liveAt: number) => Promise<boolean>
  /** Both stores, in one transaction. */
  wipe: () => Promise<void>
}

// ── The decisions each transaction makes ──────────────────────────────────
// Pure, so the IndexedDB backend and the tests' memory one make the same.

const OWNER_KEY = 'owner'

/**
 * What a claim for `next` changes. Nothing kept counts as a new person.
 * Membership is part of the view: someone removed and invited back is a new
 * membership, whose rows must not be the old one's.
 */
export function ownerChange(
  current: KeptOwner | null,
  next: KeptClaim,
): KeptChange {
  if (!current || current.userId !== next.userId) return 'user'
  if (current.businessId !== next.businessId) return 'business'
  if (
    current.lens !== next.lens ||
    current.membershipId !== next.membershipId
  ) {
    return 'lens'
  }
  return 'none'
}

/**
 * The owner row a claim leaves. Nothing changed: the same epoch, with the
 * slug and time zone as they are now (a business can be renamed or move).
 * Anything changed: a new epoch, never live yet, and the rows go with it.
 */
export function claimOwner(
  current: KeptOwner | null,
  next: KeptClaim,
  now: number,
  makeEpoch: () => string,
): { owner: KeptOwner; changed: KeptChange } {
  const changed = ownerChange(current, next)
  if (current && changed === 'none') {
    return {
      changed,
      owner: { ...current, slug: next.slug, timezone: next.timezone },
    }
  }
  return {
    changed,
    // Field by field, so nothing else the caller's object carries is kept.
    owner: {
      key: OWNER_KEY,
      userId: next.userId,
      businessId: next.businessId,
      slug: next.slug,
      timezone: next.timezone,
      membershipId: next.membershipId,
      lens: next.lens,
      epoch: makeEpoch(),
      claimedAt: now,
      liveAt: 0,
    },
  }
}

/** Whether a write or stamp made for `epoch` and `userId` may still land. */
export function mayWrite(
  owner: KeptOwner | null,
  epoch: string,
  userId: string,
): owner is KeptOwner {
  return owner !== null && owner.epoch === epoch && owner.userId === userId
}

/** The owner row after a stamp. Never earlier: two tabs may stamp. */
export function stampOwner(owner: KeptOwner, liveAt: number): KeptOwner {
  return { ...owner, liveAt: Math.max(owner.liveAt, liveAt) }
}

/**
 * Whether what is kept is not `userId`'s to keep, so goes. Rows with no
 * owner row are nobody's. Unreadable (no IndexedDB, or too slow): nothing can
 * be served from it either, so it goes only when nobody is signed in; for
 * someone, the next claim clears what is not theirs.
 */
export function keptForSomeoneElse(
  kept: KeptPeek | null,
  userId: string | null,
): boolean {
  if (kept === null) return userId === null
  if (kept.owner) return kept.owner.userId !== userId
  return kept.rows.length > 0
}

// ── IndexedDB ──────────────────────────────────────────────────────────────

const DB_NAME = 'pestm8-offline'
const DB_VERSION = 1
const OWNER_STORE = 'owner'
const ROWS_STORE = 'rows'

function openOnce(): Promise<IDBDatabase | null> {
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
      if (typeof indexedDB === 'undefined') return settle(null)
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(OWNER_STORE)) {
          db.createObjectStore(OWNER_STORE, { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains(ROWS_STORE)) {
          db.createObjectStore(ROWS_STORE, { keyPath: 'hash' })
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
      // A blocked upgrade fires neither handler until the other connection
      // closes, and nothing here is worth waiting on that.
      request.onblocked = () => settle(null)
    } catch {
      settle(null)
    }
  })
}

function deleteDb(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB_NAME)
      request.onsuccess = () => resolve(true)
      request.onerror = () => resolve(false)
      request.onblocked = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

function hasStores(db: IDBDatabase): boolean {
  return (
    db.objectStoreNames.contains(OWNER_STORE) &&
    db.objectStoreNames.contains(ROWS_STORE)
  )
}

/**
 * A connection for one operation. A database already at version 1 with no
 * stores (opened by something that gave no version, which makes an empty
 * version 1) never runs the upgrade that makes them, so it is deleted and
 * opened again, once.
 */
async function openDb(): Promise<IDBDatabase | null> {
  const db = await openOnce()
  if (!db || hasStores(db)) return db
  db.close()
  if (!(await deleteDb())) return null
  const again = await openOnce()
  if (!again || hasStores(again)) return again
  again.close()
  return null
}

type Stores = { owner: IDBObjectStore; rows: IDBObjectStore }

/**
 * Runs `work` in one transaction over both stores, and answers once it has
 * committed: what `work` handed to `done`, or null if anything failed.
 */
async function transact<T>(
  mode: IDBTransactionMode,
  work: (stores: Stores, done: (value: T) => void) => void,
): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise<T | null>((resolve) => {
    let value: T | null = null
    try {
      const tx = db.transaction([OWNER_STORE, ROWS_STORE], mode)
      tx.oncomplete = () => resolve(value)
      tx.onerror = () => resolve(null)
      tx.onabort = () => resolve(null)
      work(
        {
          owner: tx.objectStore(OWNER_STORE),
          rows: tx.objectStore(ROWS_STORE),
        },
        (result) => {
          value = result
        },
      )
    } catch {
      resolve(null)
    } finally {
      // Closing waits for the transaction; a connection left open blocks a
      // later version upgrade.
      setTimeout(() => db.close(), 0)
    }
  })
}

/** The owner row as read, or null when there is none it can trust. */
function asOwner(value: unknown): KeptOwner | null {
  if (typeof value !== 'object' || value === null) return null
  const owner = value as Partial<KeptOwner>
  return owner.key === OWNER_KEY &&
    typeof owner.userId === 'string' &&
    typeof owner.businessId === 'string' &&
    typeof owner.epoch === 'string'
    ? (owner as KeptOwner)
    : null
}

function isRow(value: unknown): value is KeptRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { hash?: unknown }).hash === 'string'
  )
}

function readOwner(
  store: IDBObjectStore,
  then: (owner: KeptOwner | null) => void,
): void {
  const request = store.get(OWNER_KEY)
  request.onsuccess = () => then(asOwner(request.result))
}

/** A new epoch: random, so two tabs claiming at once never share one. */
function newEpoch(): string {
  try {
    return crypto.randomUUID()
  } catch {
    // No randomUUID before Safari 15.4.
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
}

export const keptBackend: KeptBackend = {
  async peek() {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PEEK_TIMEOUT_MS)
    })
    const read = transact<KeptPeek>('readonly', (stores, done) => {
      let owner: KeptOwner | null = null
      // Requests in a transaction answer in the order they were made.
      readOwner(stores.owner, (found) => {
        owner = found
      })
      const rows = stores.rows.getAll()
      rows.onsuccess = () =>
        done({ owner, rows: (rows.result as Array<unknown>).filter(isRow) })
    })
    try {
      return await Promise.race([read, late])
    } finally {
      clearTimeout(timer)
    }
  },

  whose() {
    return transact<{ owner: KeptOwner | null }>('readonly', (stores, done) => {
      readOwner(stores.owner, (owner) => done({ owner }))
    })
  },

  claim(next) {
    return transact<{ epoch: string; changed: KeptChange }>(
      'readwrite',
      (stores, done) => {
        readOwner(stores.owner, (current) => {
          const claimed = claimOwner(current, next, Date.now(), newEpoch)
          if (claimed.changed !== 'none') stores.rows.clear()
          stores.owner.put(claimed.owner)
          done({ epoch: claimed.owner.epoch, changed: claimed.changed })
        })
      },
    )
  },

  async write(epoch, userId, put, drop) {
    const done = await transact<boolean>('readwrite', (stores, ok) => {
      readOwner(stores.owner, (current) => {
        if (!mayWrite(current, epoch, userId)) return ok(false)
        // Dropped first, so a row both dropped and put is the new one.
        for (const hash of drop) stores.rows.delete(hash)
        for (const row of put) stores.rows.put(row)
        ok(true)
      })
    })
    return done === true
  },

  async stamp(epoch, userId, liveAt) {
    const done = await transact<boolean>('readwrite', (stores, ok) => {
      readOwner(stores.owner, (current) => {
        if (!mayWrite(current, epoch, userId)) return ok(false)
        stores.owner.put(stampOwner(current, liveAt))
        ok(true)
      })
    })
    return done === true
  },

  async wipe() {
    // Cleared, not deleted: `deleteDatabase` waits on every open connection,
    // another tab's included.
    await transact<true>('readwrite', (stores, ok) => {
      stores.owner.clear()
      stores.rows.clear()
      ok(true)
    })
  },
}

// ── This page load ─────────────────────────────────────────────────────────

let backend: KeptBackend = keptBackend
let peeked: Promise<KeptPeek | null> | null = null
// Bumped by every wipe, so a read under way when it came hands out nothing.
let wipes = 0
const listeners = new Set<() => void>()
// Who `checkKeptOwner` last checked for, this page load.
let checked: { userId: string | null } | null = null
let disabledWiped = false

const NOTHING_KEPT: KeptPeek = { owner: null, rows: [] }

/**
 * Everything kept, as this page load first read it: one read, started at
 * module load in the browser, so it is done or nearly by the time anything
 * asks. Null when it could not be read, and always with the kill switch
 * off. Nothing kept once anything has wiped it.
 */
export function peekKept(): Promise<KeptPeek | null> {
  if (!KEPT_ENABLED) return Promise.resolve(null)
  peeked ??= readKept()
  return peeked
}

async function readKept(): Promise<KeptPeek | null> {
  const started = Date.now()
  const wipesBefore = wipes
  const found = await backend.peek().catch(() => null)
  logConnection('kept-peek', {
    ms: Date.now() - started,
    rows: found?.rows.length ?? 0,
    ok: found !== null,
  })
  if (found === null) return null
  return wipes === wipesBefore ? found : NOTHING_KEPT
}

/**
 * Forgets everything kept: the rows and whose they were. Whoever holds a
 * copy in memory is told first, before this returns, so nothing is served
 * from it from this moment; the stores are cleared after. Never rejects.
 */
export function wipeKept(why: string): Promise<void> {
  wipes++
  peeked = Promise.resolve(NOTHING_KEPT)
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // One listener's trouble is not another's.
    }
  }
  logConnection('kept-wipe', { why })
  return backend.wipe().catch(() => undefined)
}

/**
 * Where the copy lives this page load (IndexedDB, or a test's), for the
 * keeper's claims, writes and stamps (keeper.ts). Every one of those names
 * its epoch and person, so a wipe still wins against any in flight.
 */
export function currentKeptBackend(): KeptBackend {
  return backend
}

/**
 * How many times the copy has been wiped this page load, so the keeper can
 * tell a write or claim that a wipe overtook from one that landed.
 */
export function keptWipeCount(): number {
  return wipes
}

/** Called the moment anything wipes the copy. Returns the way to stop. */
export function onKeptWiped(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Wipes the copy if it is not `userId`'s — someone else's, or anyone's when
 * nobody is signed in — once per person per page load, as soon as the page
 * knows who is signed in (rootState.ts). Answered from the page load's read,
 * so it costs nothing more. With the kill switch off it wipes whatever an
 * earlier build kept.
 */
export function checkKeptOwner(userId: string | null): void {
  if (typeof window === 'undefined') return
  if (!KEPT_ENABLED) {
    if (!disabledWiped) {
      disabledWiped = true
      void wipeKept('disabled')
    }
    return
  }
  if (checked?.userId === userId) return
  checked = { userId }
  void peekKept().then((kept) => {
    if (keptForSomeoneElse(kept, userId)) {
      void wipeKept(userId === null ? 'signed-out' : 'other-person')
    }
  })
}

/**
 * Wipes the copy if it is the business `slug`'s, once the server has said
 * this person is not a member of it (`$businessSlug`'s guard, through the
 * root's "Not found"). Reads the owner row alone, not every row, and read
 * now rather than at page load, which the copy may have moved on from. If
 * that can't be read, or not within PEEK_TIMEOUT_MS, the copy goes anyway:
 * an answer like this is rare, and a copy wiped that needn't have been only
 * fills again.
 */
export async function wipeKeptForBusiness(
  slug: string,
  why: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = await Promise.race([
    backend.whose().catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PEEK_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
  if (read !== null && read.owner?.slug !== slug) return
  await wipeKept(why)
}

/**
 * What a business's not-found carries when the server said this person is
 * not a member of it, for the page to wipe the copy (`wipeKeptForBusiness`):
 * the server can't reach the phone, and the browser doesn't run the guard
 * again for a page the server rendered. The same for a business that doesn't
 * exist, so it says nothing about which.
 */
export function notAMemberOf(slug: string): { notAMemberOf: string } {
  return { notAMemberOf: slug }
}

/** The slug `notAMemberOf` put in a not-found's data, or null. */
export function notAMemberSlug(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const slug = (data as { notAMemberOf?: unknown }).notAMemberOf
  return typeof slug === 'string' && slug !== '' ? slug : null
}

/**
 * For tests: `next` in IndexedDB's place, and this page load's read, checks
 * and listeners forgotten, as a new page load would have them.
 */
export function setKeptBackendForTests(next: KeptBackend): void {
  backend = next
  peeked = null
  checked = null
  disabledWiped = false
  listeners.clear()
}

// Started now, in the browser: the read is off every critical path, and a
// cold open with no signal wants its answer as soon as it can have it.
if (
  KEPT_ENABLED &&
  typeof window !== 'undefined' &&
  typeof document !== 'undefined'
) {
  void peekKept()
}
