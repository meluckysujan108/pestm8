import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Trash2, Upload } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { LICENCE_ACCEPT } from '../../../convex/lib/licences'
import { MAX_LICENCE_FILES } from '../../../convex/lib/memberLicences'
import { FormAlert } from '#/components/forms/FormAlert'
import {
  licenceErrorCopy,
  licenceRefusal,
  missingFilesWords,
} from '#/lib/licenceErrors'
import { formatBytes } from '#/lib/pdfFiles'
import { useHydrated } from '#/lib/useHydrated'
import { ConfirmDialog } from './ConfirmDialog'
import { FileThumb, UploadSpinner } from './LicenceBits'
import { LicenceViewer } from './LicenceViewer'
import {
  ADD_FILE_WAIT_MS,
  keepAddedLicenceFile,
  prepareLicenceFile,
  stageText,
  uploadLicenceFile,
  withinMs,
} from './licenceUpload'
import { ROW_CLASS, RowBody, SettingsGroup } from './ui'
import type { ChangeEvent } from 'react'
import type { LicenceFileView } from './licenceSource'
import type { UploadStage } from './licenceUpload'
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
 * when Save is pressed. A photo is made smaller first, a PDF goes up as it
 * is (`licenceUpload.ts`, whose steps Add new shares).
 */

export function LicenceFiles({
  businessId,
  membershipId,
  licence,
  readOnly,
  fromPhone,
  expectedFiles,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  licence: WalletLicence
  /** Nothing can be changed: shown from the copy on this phone. */
  readOnly: boolean
  fromPhone: boolean
  /** Arrived from Add new, which sent this many files and did not hear back
   * about all of them: the page says how many have not arrived, until they
   * have. */
  expectedFiles?: number
}) {
  const hydrated = useHydrated()
  const picker = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<LicenceFileView | null>(null)
  // Its name stays in the dialog's title while the dialog fades out.
  const confirmed = useRef<LicenceFileView | null>(null)
  if (confirming) confirmed.current = confirming
  const [stage, setStage] = useState<UploadStage | null>(null)
  const [leftOut, setLeftOut] = useState(0)
  // Said until the files arrive, or this person adds or takes off a file
  // here: by then they have seen what is on it, and acted on it.
  const [missingNoticed, setMissingNoticed] = useState(false)

  const count = licence.files.length
  const room = Math.max(0, MAX_LICENCE_FILES - count)
  const missing =
    expectedFiles === undefined || missingNoticed
      ? 0
      : Math.max(0, expectedFiles - count)

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
    // Run even when the phone says it is offline, so `uploadLicenceFile`
    // says so: react-query's default would pause it, "Uploading…" and all,
    // until the signal came back.
    networkMode: 'always',
    mutationFn: async (files: Array<File>) => {
      for (const [i, file] of files.entries()) {
        const n = i + 1
        const prepared = await prepareLicenceFile(file, () =>
          setStage({ step: 'preparing', n, of: files.length }),
        )
        setStage({ step: 'uploading', n, of: files.length })
        const storageId = await uploadLicenceFile(
          prepared,
          () => convexUploadUrl({ businessId }),
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
        keepAddedLicenceFile({
          businessId,
          membershipId,
          fileId,
          uploadedAt,
          prepared,
        })
      }
    },
    onSettled: () => setStage(null),
  })

  const convexRemoveFile = useConvexMutation(api.memberLicences.removeFile)
  const removeFile = useMutation({
    networkMode: 'always',
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
    setMissingNoticed(true)
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
              leading={stage ? <UploadSpinner /> : undefined}
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
                room === 0
                  ? `${MAX_LICENCE_FILES} of ${MAX_LICENCE_FILES} — remove one to add another`
                  : count > 0
                    ? `${count} of ${MAX_LICENCE_FILES}`
                    : undefined
              }
            />
          </button>
        )}
        {readOnly && count === 0 && (
          <div className={`${ROW_CLASS} text-body text-muted`}>
            {fromPhone ? 'No files kept on this phone.' : 'No files yet.'}
          </div>
        )}

        {(actionError || leftOut > 0 || missing > 0) && (
          <div className="flex flex-col gap-2 px-3.5 py-3">
            {missing > 0 && <FormAlert>{missingFilesWords(missing)}</FormAlert>}
            {actionError && (
              <FormAlert
                error={actionError.error}
                copy={licenceErrorCopy(actionError.action)}
              />
            )}
            {leftOut > 0 && (
              <FormAlert>
                {leftOut === 1 ? 'One file was' : `${leftOut} files were`} left
                out: up to {MAX_LICENCE_FILES} files fit here.
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
        body="It goes from here and from this phone. You can add it again at any time."
        cancel="Keep file"
        confirm="Remove"
        onConfirm={() => {
          if (confirming) removeFile.mutate(confirming._id)
          setConfirming(null)
          setMissingNoticed(true)
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
