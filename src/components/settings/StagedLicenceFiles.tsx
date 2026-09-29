import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Trash2, Upload } from 'lucide-react'
import {
  LICENCE_ACCEPT,
  cleanLicenceFileName,
} from '../../../convex/lib/licences'
import { MAX_LICENCE_FILES } from '../../../convex/lib/memberLicences'
import { FormAlert } from '#/components/forms/FormAlert'
import { licenceErrorCopy } from '#/lib/licenceErrors'
import { formatBytes } from '#/lib/pdfFiles'
import { useHydrated } from '#/lib/useHydrated'
import { ConfirmDialog } from './ConfirmDialog'
import { UploadSpinner } from './LicenceBits'
import { prepareLicenceFile, stageText } from './licenceUpload'
import { ROW_CLASS, RowBody, SettingsGroup } from './ui'
import type { ChangeEvent } from 'react'
import type { PreparedLicenceFile, UploadStage } from './licenceUpload'

/**
 * The files on Add new: picked with the rest of the form and sent with it
 * when Add is pressed, so a licence is made in one go — its name, number,
 * expiry and its photos or PDFs — and nobody is sent to a second page to
 * finish it.
 *
 * Unlike a licence's own page (`LicenceFiles`), nothing is uploaded when a
 * file is picked: there is no licence yet to put it on, and a file sent for
 * an Add that never happens would sit in storage with nothing pointing at it.
 * What is done at once is the part that can refuse: each file is checked, and
 * a photo made smaller (`prepareLicenceFile`), so a Word document or a 30 MB
 * scan is turned away the moment it is picked, not after Add.
 */

/** A file picked on Add new, ready to send. */
export type StagedLicenceFile = PreparedLicenceFile & {
  /** This page's own name for it, for the list and for taking it off. */
  id: string
  /** A photo's bytes to draw small; null for a PDF. */
  previewUrl: string | null
}

export type StagedFiles = ReturnType<typeof useStagedLicenceFiles>

/**
 * The picked files, and picking and taking off. Held by the page, which sends
 * them on Add; drawn by `StagedLicenceFiles`.
 */
export function useStagedLicenceFiles() {
  const [files, setFiles] = useState<Array<StagedLicenceFile>>([])
  // The files as they are now, for the room a pick has and the file a remove
  // means — not as they were when the callback was made.
  const current = useRef(files)
  current.current = files
  const [preparing, setPreparing] = useState<UploadStage | null>(null)
  const [pickError, setPickError] = useState<unknown>(null)
  const [leftOut, setLeftOut] = useState(0)
  const nextId = useRef(0)
  // Every preview made, so none outlives the page.
  const previews = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const made = previews.current
    return () => {
      mounted.current = false
      for (const url of made) URL.revokeObjectURL(url)
      made.clear()
    }
  }, [])

  const pick = useCallback(async (picked: Array<File>) => {
    setPickError(null)
    // As many as fit; the rest are named, not silently dropped.
    const room = Math.max(0, MAX_LICENCE_FILES - current.current.length)
    const taken = picked.slice(0, room)
    setLeftOut(picked.length - taken.length)
    for (const [i, file] of taken.entries()) {
      try {
        const prepared = await prepareLicenceFile(file, () =>
          setPreparing({ step: 'preparing', n: i + 1, of: taken.length }),
        )
        if (!mounted.current) return
        const previewUrl =
          prepared.type.kind === 'image'
            ? URL.createObjectURL(prepared.blob)
            : null
        if (previewUrl) previews.current.add(previewUrl)
        const id = `staged-${nextId.current++}`
        const next = [...current.current, { ...prepared, id, previewUrl }]
        current.current = next
        setFiles(next)
      } catch (error) {
        // One refused says why; the others still go on.
        setPickError(error)
      }
    }
    setPreparing(null)
  }, [])

  const remove = useCallback((id: string) => {
    setPickError(null)
    setLeftOut(0)
    const gone = current.current.find((file) => file.id === id)
    if (gone?.previewUrl) {
      URL.revokeObjectURL(gone.previewUrl)
      previews.current.delete(gone.previewUrl)
    }
    const next = current.current.filter((file) => file.id !== id)
    current.current = next
    setFiles(next)
  }, [])

  return { files, preparing, pickError, leftOut, pick, remove }
}

/**
 * The Files group on Add new: each picked file with its thumbnail and a way
 * to take it off, and "Add photo or PDF" — up to six, a PDF, PNG or JPG
 * each: the card's front and back, the certificate of currency.
 */
export function StagedLicenceFiles({
  staged,
  uploading,
  locked,
}: {
  staged: StagedFiles
  /** Where Add is up to while it sends them. */
  uploading: UploadStage | null
  /** Add is under way, or done: the files are no longer this page's to
   * change. */
  locked: boolean
}) {
  const hydrated = useHydrated()
  const picker = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const [confirming, setConfirming] = useState<StagedLicenceFile | null>(null)
  // Its name stays in the dialog's title while the dialog fades out.
  const confirmed = useRef<StagedLicenceFile | null>(null)
  if (confirming) confirmed.current = confirming
  const { files, preparing, pickError, leftOut } = staged
  const count = files.length
  const room = Math.max(0, MAX_LICENCE_FILES - count)
  const stage = uploading ?? preparing
  const busy = locked || preparing !== null

  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? [])
    // So picking the same file again still fires a change.
    event.target.value = ''
    if (picked.length > 0) void staged.pick(picked)
  }

  return (
    <>
      <SettingsGroup
        title="Files"
        footer="PDF, PNG or JPG — front, back, certificate. Up to 6."
      >
        {files.map((file) => {
          // As it will be kept: a photo made smaller is a JPEG.
          const name = cleanLicenceFileName(file.fileName, file.type)
          return (
            <div key={file.id} className="flex items-center">
              <div className={`${ROW_CLASS} min-w-0 flex-1`}>
                <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-muted">
                  {file.previewUrl ? (
                    <img
                      src={file.previewUrl}
                      alt=""
                      draggable={false}
                      className="size-full object-cover"
                    />
                  ) : (
                    <FileText aria-hidden size={22} strokeWidth={1.7} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-ink">
                    {name}
                  </span>
                  <span className="block truncate text-caption text-muted">
                    {file.type.kind === 'pdf' ? 'PDF' : 'Photo'} ·{' '}
                    {formatBytes(file.blob.size)}
                  </span>
                </span>
              </div>
              <button
                type="button"
                data-staged-remove={file.id}
                onClick={() => setConfirming(file)}
                disabled={busy || !hydrated}
                aria-label={`Remove ${name}`}
                className="mr-1.5 flex size-11 shrink-0 items-center justify-center rounded-full text-red outline-none transition active:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue disabled:opacity-40"
              >
                <Trash2 aria-hidden size={19} strokeWidth={1.7} />
              </button>
            </div>
          )
        })}

        <button
          ref={addButton}
          type="button"
          onClick={() => picker.current?.click()}
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

        {(pickError !== null || leftOut > 0) && (
          <div className="flex flex-col gap-2 px-3.5 py-3">
            {pickError !== null && (
              <FormAlert error={pickError} copy={licenceErrorCopy('upload')} />
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

      {/* Asked, not done on one tap: a photo taken with the camera from the
          picker is on this page and nowhere else. */}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
        title={`Remove ${
          confirmed.current
            ? cleanLicenceFileName(
                confirmed.current.fileName,
                confirmed.current.type,
              )
            : 'this file'
        }?`}
        body="It won’t be added. A photo just taken isn’t kept anywhere else."
        cancel="Keep file"
        confirm="Remove"
        onConfirm={() => {
          if (confirming) staged.remove(confirming.id)
          setConfirming(null)
        }}
        returnFocus={(removed) => {
          const file = confirmed.current
          if (!file) return null
          if (!removed) return removeButton(file.id)
          // Its row is going, and focus with it: the next file's button
          // instead, or the one before, or Add when it was the only one.
          const at = files.findIndex((f) => f.id === file.id)
          const rest = files.filter((f) => f.id !== file.id)
          const neighbour = rest.at(Math.min(at, rest.length - 1))
          return neighbour ? removeButton(neighbour.id) : addButton.current
        }}
      />
    </>
  )
}

/** A picked file's Remove button, by the file's id. */
function removeButton(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-staged-remove="${CSS.escape(id)}"]`,
  )
}
