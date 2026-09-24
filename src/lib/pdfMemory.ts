/**
 * The last few PDFs this page has had in its hands, in memory, keyed by the
 * URL they came from.
 *
 * This is what makes Share work on an iPhone. Safari opens the share sheet
 * only inside the tap that asked for it (see the top of `pdfFiles.ts`), so a
 * tap on Share that first has to download the file has already lost the
 * sheet by the time the bytes arrive. With the bytes here — because the
 * viewer just showed them, the kept copy was read when the sheet opened, or an
 * earlier tap fetched them — the tap shares at once.
 *
 * Keyed by the file's URL because that is the identity of the bytes (Convex
 * hands out one URL per stored file; `DocumentSource.key` relies on the same
 * thing), so a PDF replaced since is simply a different entry and a stale copy
 * is never handed out under the new URL.
 *
 * Capped by count and by bytes, oldest out first: a product PDF can be 20 MB,
 * and an installed web app on an older iPhone is killed well before a desktop
 * tab would be. The newest file always stays, whatever its size — it is the
 * one someone is about to share.
 */

export type PdfMemory = {
  /** The bytes, or null. A hit counts as a use, for what is dropped next. */
  get: (key: string) => Blob | null
  set: (key: string, blob: Blob) => void
  delete: (key: string) => void
  clear: () => void
  /** Keys, oldest first. For tests. */
  keys: () => Array<string>
}

export function createPdfMemory({
  maxFiles = 3,
  maxBytes = 48_000_000,
}: { maxFiles?: number; maxBytes?: number } = {}): PdfMemory {
  // A Map iterates in insertion order, so re-inserting on use keeps it in
  // least-recently-used order.
  const entries = new Map<string, Blob>()

  const total = () => {
    let bytes = 0
    for (const blob of entries.values()) bytes += blob.size
    return bytes
  }

  const trim = () => {
    while (
      entries.size > 1 &&
      (entries.size > maxFiles || total() > maxBytes)
    ) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  return {
    get(key) {
      const blob = entries.get(key)
      if (!blob) return null
      entries.delete(key)
      entries.set(key, blob)
      return blob
    },
    set(key, blob) {
      entries.delete(key)
      entries.set(key, blob)
      trim()
    },
    delete(key) {
      entries.delete(key)
    },
    clear() {
      entries.clear()
    },
    keys() {
      return [...entries.keys()]
    },
  }
}

/**
 * Bytes this phone has just uploaded as a product's PDF, waiting for the URL
 * they will be served from.
 *
 * A Save or a Replace knows the bytes long before it knows their URL: the
 * mutation answers with nothing, and the new URL arrives later, with the
 * products list. Without this, the viewer that reloads on that new URL — and
 * a Share tapped straight after — would download from the server the very
 * file this phone has just sent it, on the same weak signal the upload
 * crawled over.
 *
 * So the bytes wait here under the product, with the key its PDF had BEFORE
 * the save (null when it had none). The first time the product is asked for
 * under any other key, that key is the new file's URL, and the bytes are
 * taken into the memory under it. Asked for under the old key — the list has
 * not caught up yet — they keep waiting.
 */
export type UploadedPdfs = {
  expect: (productId: string, previousKey: string | null, blob: Blob) => void
  /** The bytes for `key`, if they are the ones waiting for this product. */
  claim: (productId: string, key: string) => Blob | null
  /** A save that failed: nothing new is coming, so nothing may be claimed. */
  drop: (productId: string) => void
  clear: () => void
}

export function createUploadedPdfs(): UploadedPdfs {
  const waiting = new Map<string, { previousKey: string | null; blob: Blob }>()
  return {
    expect(productId, previousKey, blob) {
      waiting.set(productId, { previousKey, blob })
    },
    claim(productId, key) {
      const entry = waiting.get(productId)
      if (!entry || entry.previousKey === key) return null
      waiting.delete(productId)
      return entry.blob
    },
    drop(productId) {
      waiting.delete(productId)
    },
    clear() {
      waiting.clear()
    },
  }
}

const shared = createPdfMemory()
const uploaded = createUploadedPdfs()

/** Holds a PDF's bytes for the rest of the visit, under the URL they came from. */
export function rememberPdf(key: string, blob: Blob): void {
  shared.set(key, blob)
}

/**
 * Holds the bytes of a PDF this phone just saved onto a product until the
 * product's new URL is known (see `createUploadedPdfs`). `previousKey` is the
 * product's PDF URL before the save, or null.
 */
export function rememberUpload(
  productId: string,
  previousKey: string | null,
  blob: Blob,
): void {
  uploaded.expect(productId, previousKey, blob)
}

/**
 * Takes back `rememberUpload` for a save that did not go through. Must be
 * called on failure: the bytes would otherwise be claimed by the next file
 * that product gets, from whoever saves it.
 */
export function forgetUpload(productId: string): void {
  uploaded.drop(productId)
}

/**
 * A PDF this page already holds, or null. Given the product it belongs to,
 * this also finds bytes that product's last Save uploaded from this phone.
 */
export function recallPdf(
  key: string | null | undefined,
  productId?: string,
): Blob | null {
  if (!key) return null
  const held = shared.get(key)
  if (held || productId === undefined) return held
  const fresh = uploaded.claim(productId, key)
  if (fresh) shared.set(key, fresh)
  return fresh
}
