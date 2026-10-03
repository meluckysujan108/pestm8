import { signedInUserId } from '#/lib/rootState'
import type { StrokesFile } from './ink'

/**
 * A signature drawn on this phone that the server has not yet confirmed.
 *
 * Done used to upload the drawing and attach it, and a failure on the way —
 * one bar of signal under a house, the app closed before it landed — lost
 * it: the client had gone by the time anyone noticed, and a report that needs
 * their signature cannot be finished without them. So the drawing is kept
 * here first, and forgotten once `attachSignature` has it. What is left is
 * exactly "signatures this phone has that the server never confirmed", which
 * the report offers to save when it is opened again.
 *
 * It is not a queue (ARCHITECTURE §5.5): nothing is sent from here on its
 * own. The person who drew it decides, on the report, to save it or not.
 *
 * Each drawing is the signed-in person's (`signedInUserId`), kept under their
 * id and shown to nobody else: on a phone that changes hands, someone else's
 * unsaved drawing must not become theirs to save — least of all as their own
 * saved signature. Not dropped when the person signs out, as kept licences
 * are: a session lapses after a week unused, and a client's signature cannot
 * be asked for again.
 *
 * Every call is best-effort, as `draftMirror.ts`'s are: IndexedDB is missing
 * in a private window, can throw on open and can refuse a write, and none of
 * that may stand in the way of the network path that works. A write counts
 * only once its transaction has committed. Its own database, so neither's
 * upgrade waits on the other's.
 */

const DB_NAME = 'pestm8-signatures'
const DB_VERSION = 1
const STORE = 'kept'

export type KeptSignature = {
  reportId: string
  slot: string
  /** The image, as bytes: what IndexedDB stores the same everywhere. */
  png: ArrayBuffer
  strokes: StrokesFile
  /** When Done was tapped: the time it was signed, however late it saves. */
  drawnAt: number
  /** The form's version it was signed against: a report switched to a new
   * one since has had its signatures withdrawn, and this goes with them. */
  templateVersion?: number
  /** The name typed above the pad, where the form asks for one. */
  signedBy?: string
  /** The words agreed to, as they read when it was drawn. */
  statement?: string
  /** Also keep it as the signer's own saved signature. */
  keepAsMine: boolean
}

type Row = KeptSignature & { key: string; userId: string }

function keyOf(userId: string, reportId: string, slot: string): string {
  return `${userId}:${reportId}:${slot}`
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/**
 * Runs `work` in one transaction and answers once it has committed: what
 * `work` handed back to `done`, or null if anything failed. A write whose
 * request succeeded can still be lost when its transaction aborts (a full
 * disk is reported at commit), so nothing here trusts a request alone.
 */
async function transact<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise<T | null>((resolve) => {
    let value: T | null = null
    try {
      const tx = db.transaction(STORE, mode)
      tx.oncomplete = () => resolve(value)
      tx.onerror = () => resolve(null)
      tx.onabort = () => resolve(null)
      work(tx.objectStore(STORE), (result) => {
        value = result
      })
    } catch {
      resolve(null)
    } finally {
      // Closing waits for the transaction; leaving connections open blocks
      // a later version upgrade.
      setTimeout(() => db.close(), 0)
    }
  })
}

/** Keeps a drawing until the server has it, as the signed-in person's.
 * Replaces any they kept for its slot: the newest drawing is the one meant.
 * Whether it was kept. */
export async function keepSignature(kept: KeptSignature): Promise<boolean> {
  const userId = signedInUserId()
  if (!userId) return false
  const row: Row = {
    ...kept,
    userId,
    key: keyOf(userId, kept.reportId, kept.slot),
  }
  const done = await transact<true>('readwrite', (store, ok) => {
    store.put(row).onsuccess = () => ok(true)
  })
  return done === true
}

/** The drawing the signed-in person kept for a report's slot, if any. */
export async function keptSignature(
  reportId: string,
  slot: string,
): Promise<KeptSignature | null> {
  const userId = signedInUserId()
  if (!userId) return null
  const row = await transact<Row | undefined>('readonly', (store, ok) => {
    const request = store.get(keyOf(userId, reportId, slot))
    request.onsuccess = () => ok(request.result as Row | undefined)
  })
  if (!row) return null
  const { key: _key, userId: _user, ...kept } = row
  return kept
}

/**
 * Forgets a slot's drawing: the server has it, or it was discarded. With
 * `drawnAt`, only that drawing — one kept since, by a Done made while this
 * one was still on its way, is the newer signature and stays.
 */
export async function forgetSignature(
  reportId: string,
  slot: string,
  drawnAt?: number,
): Promise<void> {
  const userId = signedInUserId()
  if (!userId) return
  const key = keyOf(userId, reportId, slot)
  await transact<true>('readwrite', (store, ok) => {
    const request = store.get(key)
    request.onsuccess = () => {
      const row = request.result as Row | undefined
      if (row && (drawnAt === undefined || row.drawnAt === drawnAt)) {
        store.delete(key)
      }
      ok(true)
    }
  })
}

/**
 * Forgets every drawing the signed-in person kept for a report: it is
 * finalised, and nothing can be signed on it any more.
 */
export async function forgetReportSignatures(reportId: string): Promise<void> {
  const userId = signedInUserId()
  if (!userId) return
  const prefix = `${userId}:${reportId}:`
  await transact<true>('readwrite', (store, ok) => {
    store.delete(IDBKeyRange.bound(prefix, `${prefix}￿`))
    ok(true)
  })
}
