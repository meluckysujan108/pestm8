import {
  checkLicenceFile,
  cleanLicenceFileName,
} from '../../../convex/lib/licences'
import { CLAIM_WINDOW_MS } from '../../../convex/lib/products'
import { prepareUpload } from '#/lib/images/prepareUpload'
import { keepLicenceFile, makeLicenceThumbnail } from '#/lib/keptLicence'
import { licenceRefusal } from '#/lib/licenceErrors'
import { isOffline } from '#/lib/online'
import { uploadToStorage } from '#/lib/pdfFiles'
import { holdLicenceFile, licenceFileKeyOf } from './licenceSource'
import type { LicenceType } from '../../../convex/lib/licences'
import type { LicenceFileView } from './licenceSource'

/**
 * Getting a file onto a licence, in the steps both places that do it share:
 * a licence's own page (`LicenceFiles`), which puts each file on the moment
 * it is picked, and Add new (`StagedLicenceFiles`), which holds them until
 * Add and then sends them with the licence.
 *
 *  1. `prepareLicenceFile` — checked, and a photo made smaller — as soon as
 *     it is picked, so a Word document or a 30 MB scan is turned away before
 *     anything is sent.
 *  2. `uploadLicenceFile` — to storage, where it belongs to nothing until
 *     `memberLicences.addFile` claims it.
 *  3. `keepAddedLicenceFile` — once it is on the licence, kept on this phone.
 */

/** How long to wait for an upload URL before calling it no signal. */
export const UPLOAD_URL_WAIT_MS = 20_000

/** How long to wait for the file, once uploaded, to be put on the licence
 * before saying it has not been confirmed. */
export const ADD_FILE_WAIT_MS = 20_000

/**
 * How long an upload may take before it is given up on: a minute, and a
 * second more for every 16 KB — about what one bar of signal still manages.
 * A few hundred KB photo gets a minute and a half; the largest PDF allowed,
 * over twenty minutes.
 *
 * A deadline rather than a stall timer (`fetchWithProgress`'s `stallMs`),
 * because `fetch` reports nothing while a body goes UP: an upload still
 * crawling and one that died cannot be told apart until it answers. So this
 * is sized for the slowest link worth waiting on, and is there for the one
 * that will never answer — which otherwise leaves "Uploading…" on the row
 * for as long as the page is open.
 */
const UPLOAD_FLOOR_MS = 60_000
const UPLOAD_SLOWEST_BYTES_PER_SECOND = 16 * 1024

function uploadDeadlineMs(bytes: number): number {
  return UPLOAD_FLOOR_MS + (bytes / UPLOAD_SLOWEST_BYTES_PER_SECOND) * 1000
}

/** A photo's long side as uploaded: a card's small print legible, the file
 * a few hundred KB rather than several MB. */
const PHOTO_MAX_EDGE = 2400

/**
 * `promise`, or `late()` — by default a "timed out" error, which reads as no
 * signal — once `ms` has passed without it.
 */
export function withinMs<T>(
  promise: Promise<T>,
  ms: number,
  late: () => Error = () => new Error('Timed out'),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(late()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * `uploadToStorage`, given up on when the page goes (`leaving`) — nobody is
 * left to see it arrive, and a phone on one bar should not keep sending a
 * 20 MB scan for nothing — or once it is past `uploadDeadlineMs`, when it is
 * UPLOAD_STALLED, which the row puts into words.
 */
async function uploadWithin(
  uploadUrl: string,
  blob: Blob,
  contentType: string,
  leaving: AbortSignal | undefined,
): Promise<string> {
  const controller = new AbortController()
  const onLeaving = () => controller.abort(leaving?.reason)
  if (leaving?.aborted) onLeaving()
  else leaving?.addEventListener('abort', onLeaving, { once: true })
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException('The upload took too long.', 'TimeoutError'),
    )
  }, uploadDeadlineMs(blob.size))
  try {
    return await uploadToStorage(
      uploadUrl,
      blob,
      contentType,
      controller.signal,
    )
  } catch (error) {
    // Given up on, and not because the page went: the deadline passed.
    if (controller.signal.aborted && !leaving?.aborted) {
      throw licenceRefusal('UPLOAD_STALLED')
    }
    throw error
  } finally {
    clearTimeout(timer)
    leaving?.removeEventListener('abort', onLeaving)
  }
}

/**
 * How old an upload may be and still be put on a licence: the server's claim
 * window (`claimLicenceFile`), less room for the mutation to get there. The
 * rule `productSave.ts` keeps for the same window, for the same reasons: an
 * upload that went up for an Add that then failed is worth sending again only
 * once it has aged, and never in a write past that.
 */
export const UPLOAD_FRESH_MS = CLAIM_WINDOW_MS - 2 * 60 * 1000

/** A picked file as it will be sent: checked, and a photo made smaller. */
export type PreparedLicenceFile = {
  blob: Blob
  type: LicenceType
  /** The name it had on the phone; the server tidies it. */
  fileName: string
}

/**
 * A picked file made ready to send, or refused (thrown as the refusal the
 * server would make, for FormAlert to word): its type first, from what the
 * phone says it is, so a Word document is turned away before anything is
 * done with it; then a photo made smaller (2400px on its long side — every
 * word on a card stays sharp at that — and the location a phone camera
 * writes into it goes), and the size checked on what will actually be sent.
 * A PDF goes as it is. `onPreparing` is told when a photo starts being made
 * smaller, which takes a moment worth saying so.
 */
export async function prepareLicenceFile(
  file: File,
  onPreparing?: () => void,
): Promise<PreparedLicenceFile> {
  const typed = checkLicenceFile({ contentType: file.type, size: 0 }, file.name)
  if (!typed.ok) throw licenceRefusal(typed.refusal)

  let blob: Blob = file
  let contentType: string = typed.type.contentType
  if (typed.type.kind === 'image') {
    onPreparing?.()
    const prepared = await prepareUpload(file, { maxEdge: PHOTO_MAX_EDGE })
    // One this browser cannot draw goes up as it came; the server takes a
    // PNG or a JPEG either way.
    if (!prepared.passthrough) {
      blob = prepared.blob
      contentType = 'image/jpeg'
    }
  }
  // The check the server will make, made on what will be sent: nobody waits
  // for a 30 MB scan to upload only to be told it is too big.
  const checked = checkLicenceFile({ contentType, size: blob.size }, file.name)
  if (!checked.ok) throw licenceRefusal(checked.refusal)
  return { blob, type: checked.type, fileName: file.name }
}

/**
 * Sends a prepared file to storage and answers with its storage id — which
 * belongs to nothing until `memberLicences.addFile` claims it, within the
 * server's claim window.
 *
 * With no signal a Convex mutation waits for the socket rather than failing,
 * and the row would say "Uploading…" for as long as the phone is out of
 * range. So this says offline at once, and gives up on an upload URL that
 * has not come back in a while — both worded as offline.
 */
export async function uploadLicenceFile(
  prepared: PreparedLicenceFile,
  generateUploadUrl: () => Promise<string>,
  leaving: AbortSignal | undefined,
): Promise<string> {
  if (isOffline()) {
    throw new Error('offline')
  }
  const uploadUrl = await withinMs(generateUploadUrl(), UPLOAD_URL_WAIT_MS)
  return uploadWithin(
    uploadUrl,
    prepared.blob,
    prepared.type.contentType,
    leaving,
  )
}

/**
 * A file just put on a licence, kept on this phone: opening it next costs
 * nothing, the background keep need not download it again, and it is there
 * on site with no signal. Never waited on, and never throws.
 */
export function keepAddedLicenceFile({
  businessId,
  membershipId,
  fileId,
  uploadedAt,
  prepared,
}: {
  businessId: string
  membershipId: string
  fileId: string
  uploadedAt: number
  prepared: PreparedLicenceFile
}): void {
  const { blob, type } = prepared
  holdLicenceFile(licenceFileKeyOf(membershipId, fileId, uploadedAt), blob)
  const kept: LicenceFileView = {
    _id: fileId,
    url: null,
    kind: type.kind,
    contentType: type.contentType,
    fileName: cleanLicenceFileName(prepared.fileName, type),
    size: blob.size,
    uploadedAt,
  }
  void (async () => {
    const thumbnail =
      type.kind === 'image' ? await makeLicenceThumbnail(blob) : null
    await keepLicenceFile(businessId, membershipId, kept, blob, thumbnail)
  })()
}

/** Where a batch of files is up to, for the row to say. */
export type UploadStage = {
  step: 'preparing' | 'uploading'
  /** Which of the files, from 1, and how many. */
  n: number
  of: number
}

export function stageText(stage: UploadStage): string {
  const which = stage.of > 1 ? ` ${stage.n} of ${stage.of}` : ''
  return stage.step === 'preparing'
    ? `Preparing photo${which}…`
    : `Uploading${which}…`
}
