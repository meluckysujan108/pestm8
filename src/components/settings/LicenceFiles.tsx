import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { LoaderCircle, Trash2, Upload } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import {
  LICENCE_ACCEPT,
  checkLicenceFile,
  cleanLicenceFileName,
} from '../../../convex/lib/licences'
import { MAX_LICENCE_FILES } from '../../../convex/lib/memberLicences'
import { FormAlert } from '#/components/forms/FormAlert'
import { prepareUpload } from '#/lib/images/prepareUpload'
import { keepLicenceFile, makeLicenceThumbnail } from '#/lib/keptLicence'
import { licenceErrorCopy, licenceRefusal } from '#/lib/licenceErrors'
import { formatBytes, uploadToStorage } from '#/lib/pdfFiles'
import { useHydrated } from '#/lib/useHydrated'
import { ConfirmDialog } from './ConfirmDialog'
import { FileThumb } from './LicenceBits'
import { LicenceViewer } from './LicenceViewer'
import { holdLicenceFile, licenceFileKeyOf } from './licenceSource'
import { ROW_CLASS, RowBody, SettingsGroup } from './ui'
import type { ChangeEvent } from 'react'
import type { LicenceFileView } from './licenceSource'
import type { WalletLicence } from './useMyLicences'
import type { Id } from '../../../convex/_generated/dataModel'
import { isOffline } from '#/lib/online'

/**
 * A licence's files, on its own page: each opens in the viewer, each can be
 * taken off, and "Add photo or PDF" puts another on — up to six, a PDF, PNG
 * or JPG each: the card's front and back, the regulator's certificate.
 *
 * A file is saved the moment it is picked, which is what every phone does
 * with a file it has been handed; the name, number and expiry above save
 * when Save is pressed. A photo is made smaller first (2400px on its long
 * side — every word on a card stays sharp at that — and the location a phone
 * camera writes into it goes), a PDF goes up as it is.
 */

/** How long to wait for an upload URL before calling it no signal. */
const UPLOAD_URL_WAIT_MS = 20_000

/** How long to wait for the file, once uploaded, to be put on the licence
 * before saying it has not been confirmed. */
const ADD_FILE_WAIT_MS = 20_000

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
function withinMs<T>(
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

/** Where an upload is up to, for the row to say. */
type Stage = {
  step: 'preparing' | 'uploading'
  /** Which of the picked files, from 1, and how many. */
  n: number
  of: number
}

function stageText(stage: Stage): string {
  const which = stage.of > 1 ? ` ${stage.n} of ${stage.of}` : ''
  return stage.step === 'preparing'
    ? `Preparing photo${which}…`
    : `Uploading${which}…`
}

export function LicenceFiles({
  businessId,
  membershipId,
  licence,
  readOnly,
  fromPhone,
  justAdded,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  licence: WalletLicence
  /** Nothing can be changed: shown from the copy on this phone. */
  readOnly: boolean
  fromPhone: boolean
  /** Arrived from Add licence: say what comes next. */
  justAdded: boolean
}) {
  const hydrated = useHydrated()
  const picker = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<LicenceFileView | null>(null)
  // Its name stays in the dialog's title while the dialog fades out.
  const confirmed = useRef<LicenceFileView | null>(null)
  if (confirming) confirmed.current = confirming
  const [stage, setStage] = useState<Stage | null>(null)
  const [leftOut, setLeftOut] = useState(0)

  const count = licence.files.length
  const room = Math.max(0, MAX_LICENCE_FILES - count)

  // Fired when this page goes, so an upload still on its way stops.
  const leaving = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    leaving.current = controller
    return () => controller.abort()
  }, [])

  const convexUploadUrl = useConvexMutation(
    api.memberLicences.generateUploadUrl,
  )
  const convexAddFile = useConvexMutation(api.memberLicences.addFile)
  const upload = useMutation({
    mutationFn: async (files: Array<File>) => {
      for (const [i, file] of files.entries()) {
        const n = i + 1
        // The type first, from what the phone says the file is: a Word
        // document is turned away before anything is done with it.
        const typed = checkLicenceFile(
          { contentType: file.type, size: 0 },
          file.name,
        )
        if (!typed.ok) throw licenceRefusal(typed.refusal)

        let blob: Blob = file
        let contentType: string = typed.type.contentType
        if (typed.type.kind === 'image') {
          setStage({ step: 'preparing', n, of: files.length })
          const prepared = await prepareUpload(file, {
            maxEdge: PHOTO_MAX_EDGE,
          })
          // One this browser cannot draw goes up as it came; the server
          // takes a PNG or a JPEG either way.
          if (!prepared.passthrough) {
            blob = prepared.blob
            contentType = 'image/jpeg'
          }
        }
        // The check the server will make, made on what will be sent: nobody
        // waits for a 30 MB scan to upload only to be told it is too big.
        const checked = checkLicenceFile(
          { contentType, size: blob.size },
          file.name,
        )
        if (!checked.ok) throw licenceRefusal(checked.refusal)
        const { type } = checked

        // With no signal a Convex mutation waits for the socket rather than
        // failing, and the row would say "Uploading…" for as long as the
        // phone is out of range. Say so now instead, and give up on a URL
        // that has not come back in a while — both are worded as offline.
        if (isOffline()) {
          throw new Error('offline')
        }
        setStage({ step: 'uploading', n, of: files.length })
        const uploadUrl = await withinMs(
          convexUploadUrl({ businessId }),
          UPLOAD_URL_WAIT_MS,
        )
        const storageId = await uploadWithin(
          uploadUrl,
          blob,
          type.contentType,
          leaving.current?.signal,
        )
        // Not cancellable once sent — a Convex mutation queued on a dropped
        // socket goes when it comes back — so a slow answer is "not
        // confirmed yet", never "failed".
        const { fileId, uploadedAt } = await withinMs(
          convexAddFile({
            businessId,
            licenceId: licence._id as Id<'memberLicences'>,
            storageId: storageId as Id<'_storage'>,
            fileName: file.name,
          }),
          ADD_FILE_WAIT_MS,
          () => licenceRefusal('ADD_FILE_UNCONFIRMED'),
        )

        // On the phone already: opening it next costs nothing, the
        // background keep need not download it again, and it is there on
        // site with no signal.
        holdLicenceFile(
          licenceFileKeyOf(membershipId, fileId, uploadedAt),
          blob,
        )
        const kept: LicenceFileView = {
          _id: fileId,
          url: null,
          kind: type.kind,
          contentType: type.contentType,
          fileName: cleanLicenceFileName(file.name, type),
          size: blob.size,
          uploadedAt,
        }
        void (async () => {
          const thumbnail =
            type.kind === 'image' ? await makeLicenceThumbnail(blob) : null
          await keepLicenceFile(businessId, membershipId, kept, blob, thumbnail)
        })()
      }
    },
    onSettled: () => setStage(null),
  })

  const convexRemoveFile = useConvexMutation(api.memberLicences.removeFile)
  const removeFile = useMutation({
    mutationFn: async (fileId: string) => {
      if (isOffline()) {
        throw new Error('offline')
      }
      return convexRemoveFile({
        businessId,
        fileId: fileId as Id<'memberLicenceFiles'>,
      })
    },
  })

  const choose = () => {
    upload.reset()
    removeFile.reset()
    setLeftOut(0)
    picker.current?.click()
  }

  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? [])
    // So picking the same file again still fires a change.
    event.target.value = ''
    if (picked.length === 0) return
    // As many as fit; the rest are named, not silently dropped.
    const taken = picked.slice(0, room)
    setLeftOut(picked.length - taken.length)
    if (taken.length > 0) upload.mutate(taken)
  }

  const busy = upload.isPending || removeFile.isPending
  const actionError = upload.isError
    ? { error: upload.error, action: 'upload' as const }
    : removeFile.isError
      ? { error: removeFile.error, action: 'removeFile' as const }
      : null

  return (
    <>
      <SettingsGroup
        title="Files"
        footer="PDF, PNG or JPG — front, back, certificate. Up to 6."
      >
        {licence.files.map((file) => (
          <div key={file._id} className="flex items-center">
            <button
              type="button"
              data-licence-file-open={file._id}
              onClick={() => setViewing(file._id)}
              disabled={!hydrated}
              className={`${ROW_CLASS} min-w-0 flex-1 disabled:opacity-60`}
            >
              <FileThumb
                businessId={businessId}
                membershipId={membershipId}
                file={file}
                mine
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body text-ink">
                  {file.fileName}
                </span>
                <span className="block truncate text-caption text-muted">
                  {file.kind === 'pdf' ? 'PDF' : 'Photo'} ·{' '}
                  {formatBytes(file.size)}
                </span>
              </span>
            </button>
            {!readOnly && (
              <button
                type="button"
                data-licence-file-remove={file._id}
                onClick={() => {
                  upload.reset()
                  removeFile.reset()
                  setConfirming(file)
                }}
                disabled={busy || !hydrated}
                aria-label={`Remove ${file.fileName}`}
                className="mr-1.5 flex size-11 shrink-0 items-center justify-center rounded-full text-red outline-none transition active:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue disabled:opacity-40"
              >
                <Trash2 aria-hidden size={19} strokeWidth={1.7} />
              </button>
            )}
          </div>
        ))}

        {!readOnly && (
          <button
            ref={addButton}
            type="button"
            onClick={choose}
            disabled={busy || !hydrated || room === 0}
            className={`${ROW_CLASS} disabled:opacity-60`}
          >
            <RowBody
              icon={Upload}
              tint="blue"
              leading={stage ? <Spinner /> : undefined}
              title={
                stage ? (
                  stageText(stage)
                ) : (
                  <span className="font-semibold text-blue">
                    Add photo or PDF
                  </span>
                )
              }
              subtitle={
                room === 0 ? (
                  `${MAX_LICENCE_FILES} of ${MAX_LICENCE_FILES} — remove one to add another`
                ) : justAdded && count === 0 && !stage ? (
                  <span className="text-blue-ink">
                    Added. Now add a photo or PDF of it.
                  </span>
                ) : count > 0 ? (
                  `${count} of ${MAX_LICENCE_FILES}`
                ) : undefined
              }
            />
          </button>
        )}
        {readOnly && count === 0 && (
          <div className={`${ROW_CLASS} text-body text-muted`}>
            {fromPhone ? 'No files kept on this phone.' : 'No files yet.'}
          </div>
        )}

        {(actionError || leftOut > 0) && (
          <div className="flex flex-col gap-2 px-3.5 py-3">
            {actionError && (
              <FormAlert
                error={actionError.error}
                copy={licenceErrorCopy(actionError.action)}
              />
            )}
            {leftOut > 0 && (
              <FormAlert>
                {leftOut === 1 ? 'One file was' : `${leftOut} files were`} left
                out: a licence holds up to {MAX_LICENCE_FILES}.
              </FormAlert>
            )}
          </div>
        )}
      </SettingsGroup>

      {/* After the group, not in it: the card's hairlines go between its
          children, and a hidden child would draw one of its own. */}
      <input
        ref={picker}
        type="file"
        accept={LICENCE_ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={onPicked}
      />

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
        title={`Remove ${confirmed.current?.fileName ?? 'this file'}?`}
        body="It goes from this licence, and from this phone. You can add it again at any time."
        confirm="Remove"
        onConfirm={() => {
          if (confirming) removeFile.mutate(confirming._id)
          setConfirming(null)
        }}
        returnFocus={(removed) => {
          const file = confirmed.current
          if (!file) return null
          if (!removed) return fileButton('remove', file._id)
          // Its row is about to go, and focus with it: the next file's
          // instead, or the one before, or Add when it was the only one.
          const at = licence.files.findIndex((f) => f._id === file._id)
          const rest = licence.files.filter((f) => f._id !== file._id)
          const neighbour = rest.at(Math.min(at, rest.length - 1))
          return neighbour
            ? fileButton('open', neighbour._id)
            : addButton.current
        }}
      />

      {viewing !== null && (
        <LicenceViewer
          businessId={businessId}
          membershipId={membershipId}
          licence={licence}
          mine
          fromPhone={fromPhone}
          startAt={viewing}
          title={licence.name}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  )
}

/** A file row's button — to open it, or to remove it — by the file's id. */
function fileButton(
  which: 'open' | 'remove',
  fileId: string,
): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-licence-file-${which}="${CSS.escape(fileId)}"]`,
  )
}

/** An upload in flight, in the icon tile's place. */
function Spinner() {
  return (
    <span
      aria-hidden
      className="flex size-[30px] shrink-0 items-center justify-center"
    >
      <LoaderCircle
        size={20}
        strokeWidth={1.7}
        className="animate-spin text-muted"
      />
    </span>
  )
}
