import type { StrokesFile } from './ink'

/**
 * A signature drawn on this phone that the server has not yet confirmed.
 *
 * Done used to upload the drawing and attach it, and a failure on the way —
 * one bar of signal under a house, the app closed before it landed — lost
 * it: the client had gone by the time anyone noticed, and a report that needs
 * their signature cannot be finished without them. So the drawing is kept
 * here first, and forgotten only once `attachSignature` has it. What is left
 * is exactly "signatures this phone has that the server never confirmed",
 * which the report offers to save when it is opened again.
 *
 * It is not a queue (ARCHITECTURE §5.5): nothing is sent from here on its
 * own. The person who drew it decides, on the report, to save it or not.
 *
 * Every call is best-effort, as `draftMirror.ts`'s are: IndexedDB is missing
 * in a private window, can throw on open and can refuse a write, and none of
 * that may stand in the way of the network path that works. Its own database,
 * so neither's upgrade waits on the other's.
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
  /** The name typed above the pad, where the form asks for one. */
  signedBy?: string
  /** The words agreed to, as they read when it was drawn. */
  statement?: string
  /** Also keep it as the signer's own saved signature. */
  keepAsMine: boolean
}

type Row = KeptSignature & { key: string }

function keyOf(reportId: string, slot: string): string {
  return `${reportId}:${slot}`
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

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(STORE, mode)
      const request = run(tx.objectStore(STORE))
      request.onsuccess = () => resolve(request.result as T)
      request.onerror = () => resolve(null)
      tx.onabort = () => resolve(null)
    } catch {
      resolve(null)
    } finally {
      setTimeout(() => db.close(), 0)
    }
  })
}

/** Keeps a drawing until the server has it. Replaces any kept for its slot:
 * the newest drawing is the one meant. Whether it was kept. */
export async function keepSignature(kept: KeptSignature): Promise<boolean> {
  const row: Row = { ...kept, key: keyOf(kept.reportId, kept.slot) }
  const done = await withStore<IDBValidKey>('readwrite', (store) =>
    store.put(row),
  )
  return done !== null
}

/** The drawing kept for a report's slot, if this phone holds one. */
export async function keptSignature(
  reportId: string,
  slot: string,
): Promise<KeptSignature | null> {
  const row = await withStore<Row | undefined>('readonly', (store) =>
    store.get(keyOf(reportId, slot)),
  )
  if (!row) return null
  const { key: _key, ...kept } = row
  return kept
}

/** Forgets a slot's drawing: the server has it, or it was discarded. */
export async function forgetSignature(
  reportId: string,
  slot: string,
): Promise<void> {
  await withStore('readwrite', (store) => store.delete(keyOf(reportId, slot)))
}
