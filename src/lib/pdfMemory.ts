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
 * So the bytes wait here under the product, with the keys that are known NOT
 * to be theirs: the key its PDF had on the row the person acted on (null when
 * it had none), and the key the list shows for it as the write goes out. The
 * first other key the product is seen under — asked for, or shown by the list
 * (`listed`) — is the new file's URL, and the bytes are handed over under it.
 * Either way that ends the wait: the list moves on to the new file first, so
 * a key seen after that one is someone else's later file, never these bytes.
 * A new product's bytes (`expectNew`) have no key that is not theirs: it was
 * written with them, so the first key the list shows for it is theirs.
 *
 * "The first other key" is only the new file's while something was watching
 * when it landed. A page that unmounted mid-upload, or a retried Save whose
 * first write had in fact landed (the server takes a re-sent id as no change,
 * so the bytes wait under the key that already is theirs), can next see a
 * LATER file from someone else. So the size the server reports for the file
 * at that key must also be the size of these bytes: a different size is a
 * different file, and the wait ends with nothing handed over — the viewer
 * downloads, which is slower, never wrong. Handing an old safety data sheet
 * out as the new one would be wrong. An unknown size compares as a match.
 */
export type UploadedPdfs = {
  /** Before the write of an edit or a Replace. */
  expect: (productId: string, previousKey: string | null, blob: Blob) => void
  /**
   * After a new product was written with these bytes. The bytes and their
   * key when the list already shows it, for the caller to remember.
   */
  expectNew: (productId: string, blob: Blob) => HandedOver | null
  /**
   * The bytes for `key`, if they are the ones waiting for this product.
   * `size` is the file's size as the server reports it, when known.
   */
  claim: (productId: string, key: string, size?: number | null) => Blob | null
  /**
   * The product's PDF key as the products list shows it now (null for no
   * PDF, or one gone from storage), with the size the list reports for it.
   * The bytes and their key when that is the new file, for the caller to
   * remember.
   */
  listed: (
    productId: string,
    key: string | null,
    size?: number | null,
  ) => HandedOver | null
  /** A save that failed: nothing new is coming, so nothing may be claimed. */
  drop: (productId: string) => void
  clear: () => void
}

export type HandedOver = { key: string; blob: Blob }

export function createUploadedPdfs(): UploadedPdfs {
  const waiting = new Map<
    string,
    { notYet: ReadonlyArray<string | null>; blob: Blob }
  >()
  /** The products list's key and size for each product, as last shown. */
  const shown = new Map<
    string,
    { key: string | null; size: number | null | undefined }
  >()

  const sameSize = (blob: Blob, size: number | null | undefined) =>
    typeof size !== 'number' || size === blob.size

  const settle = (productId: string): HandedOver | null => {
    const entry = waiting.get(productId)
    const now = shown.get(productId)
    if (!entry || !now) return null
    if (entry.notYet.includes(now.key)) return null
    waiting.delete(productId)
    // The list moved on to no file at all (removed by someone else), or to
    // a file that is not these bytes: they are nobody's now.
    if (now.key === null || !sameSize(entry.blob, now.size)) return null
    return { key: now.key, blob: entry.blob }
  }

  return {
    expect(productId, previousKey, blob) {
      const notYet = [previousKey]
      // The row the person acted on can be older than the list: someone
      // else's file that arrived while this one uploaded is not this one.
      const now = shown.get(productId)
      if (now) notYet.push(now.key)
      waiting.set(productId, { notYet, blob })
    },
    expectNew(productId, blob) {
      waiting.set(productId, { notYet: [], blob })
      return settle(productId)
    },
    claim(productId, key, size) {
      const entry = waiting.get(productId)
      if (!entry || entry.notYet.includes(key)) return null
      waiting.delete(productId)
      return sameSize(entry.blob, size) ? entry.blob : null
    },
    listed(productId, key, size) {
      shown.set(productId, { key, size })
      return settle(productId)
    },
    drop(productId) {
      waiting.delete(productId)
    },
    clear() {
      waiting.clear()
      shown.clear()
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
 * Holds the bytes of a PDF this phone is about to save onto a product — an
 * edit or a Replace, called BEFORE the write — until the product's new URL is
 * known (see `createUploadedPdfs`). `previousKey` is the product's PDF URL on
 * the row the person acted on, or null.
 */
export function rememberUpload(
  productId: string,
  previousKey: string | null,
  blob: Blob,
): void {
  uploaded.expect(productId, previousKey, blob)
}

/**
 * Holds the bytes of the PDF a new product was just created with — called
 * AFTER the write, the only time its id is known — until its URL is.
 */
export function rememberNewProductUpload(productId: string, blob: Blob): void {
  const handed = uploaded.expectNew(productId, blob)
  if (handed) shared.set(handed.key, handed.blob)
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
 * Tells the memory what the products list shows now, every time it changes.
 * An upload waiting for its URL is settled the moment the list shows it —
 * whether or not anything opens it — so it can never be handed out later as
 * the bytes of a different file the product gets after.
 */
export function noteListedPdfs(
  rows: ReadonlyArray<{
    id: string
    pdf: { url: string | null; size?: number | null } | null
  }>,
): void {
  for (const row of rows) {
    const handed = uploaded.listed(row.id, row.pdf?.url ?? null, row.pdf?.size)
    if (handed) shared.set(handed.key, handed.blob)
  }
}

/**
 * A PDF this page already holds, or null. Given the product it belongs to,
 * this also finds bytes that product's last Save uploaded from this phone —
 * only if they are the size the server reports for the file at `key`
 * (`size`, when known), so a later file from someone else never gets them.
 */
export function recallPdf(
  key: string | null | undefined,
  productId?: string,
  size?: number | null,
): Blob | null {
  if (!key) return null
  const held = shared.get(key)
  if (held || productId === undefined) return held
  const fresh = uploaded.claim(productId, key, size)
  if (fresh) shared.set(key, fresh)
  return fresh
}
