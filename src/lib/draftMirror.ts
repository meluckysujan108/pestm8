/**
 * A copy of the answers on the device that holds them.
 *
 * There is no offline mutation queue in this app (ARCHITECTURE §5.5), and
 * there is a good reason not to build one for reports: two devices editing the
 * same draft would need conflict resolution nobody has asked for. But the
 * failure the absence causes is real — a technician under a house with one bar
 * fills in a section, the tab is killed by iOS before the save lands, and the
 * work is gone with nothing to recover it from.
 *
 * So the answers are mirrored here as they are typed and cleared the moment the
 * server acknowledges them. What is left behind is exactly "answers this phone
 * has that the server never confirmed", which is the only thing worth offering
 * to restore. No photo queue, no mutation log, no sync: one record per report,
 * replaced on every keystroke-debounce and deleted on every save.
 *
 * Every call is best-effort. IndexedDB is unavailable in a private window, can
 * throw on open, and can refuse a write on quota — none of which should cost a
 * technician the network path that works.
 */

const DB_NAME = 'pestm8'
const DB_VERSION = 1
const STORE = 'reportDrafts'

export type MirroredDraft = {
  reportId: string
  data: Record<string, unknown>
  /** When this device last held answers the server had not acknowledged. */
  savedAt: number
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'reportId' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      // A blocked upgrade never fires either handler. Nothing here is worth
      // hanging a save path on.
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
      // Closing is safe here: the transaction keeps its own handle until it
      // settles, and leaving connections open blocks a later version upgrade.
      setTimeout(() => db.close(), 0)
    }
  })
}

/** Records what this device holds and the server has not acknowledged. */
export async function rememberDraft(
  reportId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await withStore('readwrite', (store) =>
    store.put({ reportId, data, savedAt: Date.now() } satisfies MirroredDraft),
  )
}

/** Called the moment the server confirms: there is nothing left to recover. */
export async function forgetDraft(reportId: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(reportId))
}

/** Answers this device kept that never reached the server, if any. */
export async function recallDraft(
  reportId: string,
): Promise<MirroredDraft | null> {
  const found = await withStore<MirroredDraft | undefined>(
    'readonly',
    (store) => store.get(reportId),
  )
  return found ?? null
}
