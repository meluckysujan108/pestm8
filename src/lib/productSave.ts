import { CLAIM_WINDOW_MS } from '../../convex/lib/products'
import { changesAnything, productChanges } from './productForm'
import { productErrorCode, uploadsSpent } from './productErrors'
import type { ProductBaseline, ProductDraft } from './productForm'

/**
 * A product form's Save: upload what was picked, then write only what
 * changed.
 *
 * Kept apart from the sheet, with the network (and the clock) handed in,
 * because four rules meet here and each is easy to break without noticing:
 *
 *  - `products.update` reads a field left out as "leave it alone" and `null`
 *    as "clear it" (`productChanges` works out which is which), so the write
 *    carries only what this person changed.
 *  - Files upload on Save, not when picked, each to its own upload URL, the
 *    photo and the PDF at the same time — on a van's signal the second should
 *    not wait for the first.
 *  - An upload is worth keeping when the write after it fails. A Save refused
 *    for a duplicate name, or dropped by the signal, would otherwise send the
 *    same 20 MB again on the retry. So each uploaded file's storage id is
 *    remembered against the very Blob it came from (`UploadMemo`), and reused.
 *  - But not for ever: the server takes an upload only within
 *    `CLAIM_WINDOW_MS` (15 minutes) of it finishing. On one bar of signal a
 *    20 MB PDF can take longer than that, and the photo that went up beside
 *    it in seconds has expired by the time the PDF lands. So an upload older
 *    than `UPLOAD_FRESH_MS` is never sent in a write — it goes up again first,
 *    which for a shrunk photo is seconds — and a write the server still
 *    refuses as too old (FILE_NOT_FOUND) is retried once, by itself, after
 *    re-sending only the uploads that aged. Forgetting everything instead
 *    would throw away the PDF that had only just arrived, and on that signal
 *    the next Save would run into the same wall.
 */

/** A file that reached the server: its storage id, and when it finished
 * uploading by this phone's clock (`SaveDeps.now`). */
export type MemoUpload = { storageId: string; at: number }

/** What reached the server for a file, by the Blob that was sent. */
export type UploadMemo = WeakMap<Blob, MemoUpload>

export function createUploadMemo(): UploadMemo {
  return new WeakMap()
}

/**
 * How old an upload may be and still go in a write: the server's claim
 * window, less room for the write itself to get there — a mutation queued on
 * a weak signal, and the gap between the server storing the file and this
 * phone hearing that it had.
 */
export const UPLOAD_FRESH_MS = CLAIM_WINDOW_MS - 2 * 60 * 1000

/** Rounds of "send whatever has aged" before the write goes regardless. The
 * second catches a photo that aged while a big PDF was still going up; past
 * that, one file on its own is outlasting the window, and sending the others
 * again cannot fix it. */
const UPLOAD_ROUNDS = 2

/**
 * A write, in `products.update`'s terms: a field left out is unchanged, and
 * `null` clears it. A create is sent the same shape with no nulls in it.
 * Storage ids are plain strings here; the caller casts them to
 * `Id<'_storage'>` for the mutation, which is where they are checked.
 */
export type ProductWrite = {
  name?: string
  description?: string | null
  url?: string | null
  photoStorageId?: string | null
  pdf?: { storageId: string; fileName: string } | null
}

export type SavePhase = 'uploading' | 'saving'

export type SaveDeps<T> = {
  /** Uploads one file (a fresh upload URL each time) and returns its id. */
  uploadFile: (blob: Blob, contentType: string) => Promise<string>
  /** Called once, or twice when a first write finds an upload expired. */
  write: (fields: ProductWrite) => Promise<T>
  uploads: UploadMemo
  onPhase?: (phase: SavePhase) => void
  /** The clock uploads are aged by. `Date.now` unless a test says otherwise. */
  now?: () => number
}

export type SaveResult<T> =
  | { written: false }
  | {
      written: true
      result: T
      /** The PDF just uploaded, if one was: the page can open it at once. */
      pdf: File | null
    }

const PDF_TYPE = 'application/pdf'

/**
 * Saves a draft: to `create` when `baseline` is null, to `update` otherwise
 * (the difference is only in what `write` calls). Resolves `{ written: false }`
 * without touching the network when nothing changed. Assumes the draft has
 * passed `draftProblems`. Rejects with whatever the upload or the write
 * rejected with.
 */
export async function saveProduct<T>(
  baseline: ProductBaseline | null,
  draft: ProductDraft,
  deps: SaveDeps<T>,
): Promise<SaveResult<T>> {
  const changes = productChanges(baseline, draft)
  if (!changesAnything(changes)) return { written: false }
  const now = deps.now ?? Date.now

  const photo =
    changes.photo === 'upload' && draft.photo.kind === 'new'
      ? draft.photo.file
      : null
  const pdf =
    changes.pdf === 'upload' && draft.pdf.kind === 'new' ? draft.pdf.file : null

  const files: Array<{ blob: Blob; contentType: string }> = []
  // A photo is re-encoded as JPEG by `prepareUpload`; one it could not decode
  // goes as it came, with whatever type the picker gave it.
  if (photo)
    files.push({ blob: photo, contentType: photo.type || 'image/jpeg' })
  // Always sent as a PDF: its bytes were checked (`looksLikePdf`) when it was
  // picked, whatever type the picker guessed.
  if (pdf) files.push({ blob: pdf, contentType: PDF_TYPE })

  const fresh = (blob: Blob) => {
    const known = deps.uploads.get(blob)
    return known !== undefined && now() - known.at < UPLOAD_FRESH_MS
  }
  const idOf = (blob: Blob | null) =>
    blob ? (deps.uploads.get(blob)?.storageId ?? null) : null
  const forget = (blobs: Array<Blob>) => {
    for (const blob of blobs) deps.uploads.delete(blob)
  }
  const everyFile = files.map((file) => file.blob)

  const uploadAll = async () => {
    if (files.length === 0) return
    deps.onPhase?.('uploading')
    for (let round = 0; round < UPLOAD_ROUNDS; round++) {
      await Promise.all(
        files.map(async ({ blob, contentType }) => {
          if (fresh(blob)) return
          const storageId = await deps.uploadFile(blob, contentType)
          deps.uploads.set(blob, { storageId, at: now() })
        }),
      )
      if (everyFile.every(fresh)) return
    }
  }

  const writeOnce = async () => {
    await uploadAll()
    const fields: ProductWrite = {}
    if (changes.name !== undefined) fields.name = changes.name
    if (changes.description !== undefined) {
      fields.description = changes.description
    }
    if (changes.url !== undefined) fields.url = changes.url
    const photoId = idOf(photo)
    if (photoId !== null) fields.photoStorageId = photoId
    else if (changes.photo === 'remove') fields.photoStorageId = null
    const pdfId = idOf(pdf)
    if (pdf && pdfId !== null) {
      fields.pdf = { storageId: pdfId, fileName: pdf.name }
    } else if (changes.pdf === 'remove') {
      fields.pdf = null
    }
    deps.onPhase?.('saving')
    return deps.write(fields)
  }

  let result: T
  try {
    result = await writeOnce()
  } catch (error) {
    if (!uploadsSpent(error)) throw error
    if (productErrorCode(error) !== 'FILE_NOT_FOUND' || files.length === 0) {
      // ALREADY_ATTACHED: claimed by a write that got through after all, or
      // by another product. Neither is fixed by sending it again unasked.
      forget(everyFile)
      throw error
    }
    // Too old for the server. Send again what has aged by this clock — or,
    // when nothing has, everything: the server could not find it, and which
    // one it meant is not said.
    const aged = everyFile.filter((blob) => !fresh(blob))
    forget(aged.length > 0 ? aged : everyFile)
    try {
      result = await writeOnce()
    } catch (again) {
      if (uploadsSpent(again)) forget(everyFile)
      throw again
    }
  }
  // Claimed now: sending the same id again would be ALREADY_ATTACHED.
  forget(everyFile)
  return { written: true, result, pdf }
}
