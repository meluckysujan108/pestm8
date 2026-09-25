import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import {
  ChevronRight,
  FileText,
  ImageIcon,
  LoaderCircle,
  Upload,
} from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import {
  LICENCE_ACCEPT,
  checkLicenceFile,
  cleanLicenceFileName,
} from '../../../convex/lib/licences'
import { FormAlert } from '#/components/forms/FormAlert'
import { useObjectUrl } from '#/components/products/hooks'
import { forgetKeptLicence, keepLicence } from '#/lib/keptLicence'
import { formatBytes, uploadToStorage } from '#/lib/pdfFiles'
import { useHydrated } from '#/lib/useHydrated'
import { LicenceViewer } from './LicenceViewer'
import { heldLicence, holdLicence, licenceKeyOf } from './licenceSource'
import { ROW_CLASS, RowBody, SettingsGroup } from './ui'
import { useMyLicence } from './useMyLicence'
import type { ChangeEvent } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The licence document on Settings → Licence (Phase 8.1): add a PDF, PNG or
 * JPG of your licence, see it inside the app, replace or remove it.
 *
 * Its own group, apart from the licence number and its Save: the number
 * saves when Save is pressed; a file is saved the moment it is picked, which
 * is what every phone does with a file it has been handed.
 *
 * With no signal the query waits rather than fails, so after a few seconds
 * the copy kept on this phone (`keptLicence.ts`) stands in for it, and opens
 * as the live one would (`useMyLicence`).
 */

/** Words for the refusals `licences.setFile` can make. */
const LICENCE_ERRORS = {
  WRONG_FILE_TYPE: 'That file isn’t a PDF, PNG or JPG. Choose one of those.',
  FILE_TOO_LARGE:
    'That file is too big: a PDF can be up to 20 MB, a photo up to 10 MB.',
  FILE_NOT_FOUND: 'The upload took too long to finish. Try again.',
  ALREADY_ATTACHED: 'That file is already used elsewhere. Choose another.',
  NO_ACCESS: 'You can only change your own licence.',
  offline: 'This phone is offline. Try again when you have signal.',
  default: 'Could not upload your licence. Check your signal and try again.',
}

/** How long to wait for an upload URL before calling it no signal. */
const UPLOAD_URL_WAIT_MS = 20_000

/** `promise`, or a "timed out" error once `ms` has passed without it. */
function withinMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms)
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

export function LicenceDocument({
  businessId,
  membershipId,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
}) {
  const { live, kept, setKept, shown, online } = useMyLicence(
    businessId,
    membershipId,
  )
  const hydrated = useHydrated()

  const [open, setOpen] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  const convexUploadUrl = useConvexMutation(api.licences.generateUploadUrl)
  const convexSetFile = useConvexMutation(api.licences.setFile)
  const upload = useMutation({
    mutationFn: async (file: File) => {
      // The check the server will make, made first: nobody waits for a
      // 30 MB scan to upload only to be told it is too big.
      const checked = checkLicenceFile(
        { contentType: file.type, size: file.size },
        file.name,
      )
      // Thrown as the server would, so one set of words covers both.
      if (!checked.ok) {
        throw Object.assign(new Error(checked.refusal), {
          data: checked.refusal,
        })
      }
      const { type } = checked
      // With no signal a Convex mutation waits for the socket rather than
      // failing, and the button would say "Uploading…" for as long as the
      // phone is out of range. Say so now instead, and give up on a URL that
      // has not come back in a while — describeError words both as offline.
      if (!online) throw new Error('offline')
      const uploadUrl = await withinMs(
        convexUploadUrl({ businessId }),
        UPLOAD_URL_WAIT_MS,
      )
      const storageId = await uploadToStorage(uploadUrl, file, type.contentType)
      const uploadedAt = await convexSetFile({
        businessId,
        membershipId,
        storageId: storageId as Id<'_storage'>,
        fileName: file.name,
      })
      // On the phone already: opening it next costs nothing, and it is there
      // on site with no signal.
      holdLicence(licenceKeyOf(membershipId, uploadedAt), file)
      const meta = {
        uploadedAt,
        fileName: cleanLicenceFileName(file.name, type),
        kind: type.kind,
        contentType: type.contentType,
        size: file.size,
      }
      if (await keepLicence(businessId, membershipId, meta, file)) {
        setKept({ blob: file, meta })
      }
    },
  })

  const convexRemove = useConvexMutation(api.licences.removeFile)
  const remove = useMutation({
    mutationFn: async () => {
      await convexRemove({ businessId, membershipId })
      await forgetKeptLicence(businessId, membershipId)
      setKept(null)
    },
  })

  const choose = () => {
    upload.reset()
    remove.reset()
    picker.current?.click()
  }

  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // So picking the same file again still fires a change.
    event.target.value = ''
    if (file) upload.mutate(file)
  }

  const busy = upload.isPending || remove.isPending
  const actionError = upload.isError
    ? upload.error
    : remove.isError
      ? remove.error
      : null

  // The thumbnail: bytes this phone already has for this version — the kept
  // copy, or what this page load uploaded or opened — else the plain photo
  // tile. Never the file's own URL, for two reasons. An <img> of it is an
  // image request, which the service worker's 'images' rule stores (opaque,
  // cross-origin and all) in a cache nothing clears at sign-out — so on a
  // shared tablet the card, with its date of birth and home address, stayed
  // behind for the next person, under a storage URL that never stops working.
  // And it pulled a photo of up to 10 MB over mobile data to draw 48 pixels.
  // Never for a PDF, which has a plain tile.
  const photo =
    shown?.kind === 'image'
      ? kept?.meta.uploadedAt === shown.uploadedAt
        ? kept.blob
        : heldLicence(licenceKeyOf(membershipId, shown.uploadedAt))
      : null
  const thumbnail = useObjectUrl(photo)

  return (
    <>
      <SettingsGroup
        title="Licence document"
        // A copy is kept only once it has been opened (or uploaded) on this
        // phone (licenceSource.ts), so the line says to open it: one uploaded
        // from the office laptop is not here yet on a site with no signal.
        footer="Only you and the owner can see it. Open it once to keep it on this phone for sites with no signal."
      >
        {shown === undefined ? (
          live.isError ? (
            <div className="px-3.5 py-3">
              <FormAlert
                error={live.error}
                copy={{
                  default: 'Could not load your licence. Try again later.',
                }}
              />
            </div>
          ) : (
            <div className={`${ROW_CLASS} justify-center`}>
              <LoaderCircle
                aria-hidden
                size={20}
                strokeWidth={2}
                className="animate-spin text-muted"
              />
              <span className="sr-only" role="status">
                Loading your licence
              </span>
            </div>
          )
        ) : shown === null ? (
          <button
            type="button"
            onClick={choose}
            disabled={busy || !hydrated}
            className={`${ROW_CLASS} disabled:opacity-60`}
          >
            <RowBody
              icon={Upload}
              tint="blue"
              leading={upload.isPending ? <Spinner /> : undefined}
              title={upload.isPending ? 'Uploading…' : 'Add your licence'}
              subtitle="PDF, PNG or JPG"
            />
          </button>
        ) : (
          <>
            {/* The whole row opens it: there is no separate View button. */}
            <button
              type="button"
              onClick={() => setOpen(true)}
              disabled={!hydrated}
              aria-label={`View your licence, ${shown.fileName}`}
              className={`${ROW_CLASS} disabled:opacity-60`}
            >
              <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-muted">
                {thumbnail ? (
                  <img
                    src={thumbnail}
                    alt=""
                    draggable={false}
                    className="size-full object-cover"
                  />
                ) : shown.kind === 'pdf' ? (
                  <FileText aria-hidden size={22} strokeWidth={1.6} />
                ) : (
                  <ImageIcon aria-hidden size={22} strokeWidth={1.6} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-semibold text-ink">
                  {shown.fileName}
                </span>
                <span className="block truncate text-caption text-muted">
                  {shown.kind === 'pdf' ? 'PDF' : 'Photo'} ·{' '}
                  {formatBytes(shown.size)}
                  {/* The phone's own date, after hydration: the server
                      renders in UTC, and a licence added late in the evening
                      in Perth would otherwise disagree about the day. */}
                  {hydrated &&
                    ` · Added ${new Date(shown.uploadedAt).toLocaleDateString(
                      'en-AU',
                      { day: 'numeric', month: 'short', year: 'numeric' },
                    )}`}
                </span>
                {live.data === undefined && (
                  <span className="block text-caption text-orange-ink">
                    Showing the copy on this phone
                  </span>
                )}
                {live.data && live.data.url === null && (
                  <span className="block text-caption text-orange-ink">
                    The file is missing — upload it again.
                  </span>
                )}
              </span>
              <ChevronRight
                aria-hidden
                size={17}
                strokeWidth={2.2}
                className="shrink-0 text-muted-2"
              />
            </button>
            {/* Only once the live document has answered: while the kept copy
                stands in, there is no signal to send a change with. */}
            <div className="grid grid-cols-2 divide-x divide-hairline">
              <button
                type="button"
                onClick={choose}
                disabled={busy || !hydrated || live.data === undefined}
                className="min-h-11 text-body font-semibold text-blue transition active:bg-surface-2 disabled:opacity-50"
              >
                {upload.isPending ? 'Uploading…' : 'Replace'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      'Remove your licence document? You can add it again at any time.',
                    )
                  ) {
                    remove.mutate()
                  }
                }}
                disabled={busy || !hydrated || live.data === undefined}
                className="min-h-11 text-body font-semibold text-red transition active:bg-surface-2 disabled:opacity-50"
              >
                {remove.isPending ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </>
        )}
        {actionError && (
          <div className="px-3.5 py-3">
            <FormAlert error={actionError} copy={LICENCE_ERRORS} />
          </div>
        )}
      </SettingsGroup>

      {/* After the group, not in it: the card's hairlines go between its
          children, and a hidden first child would draw one above the top
          row. */}
      <input
        ref={picker}
        type="file"
        accept={LICENCE_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={onPicked}
      />

      {open && shown && (
        <LicenceViewer
          businessId={businessId}
          membershipId={membershipId}
          licence={shown}
          title="Your licence"
          onClose={() => setOpen(false)}
          onReplace={() => {
            setOpen(false)
            choose()
          }}
        />
      )}
    </>
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
        strokeWidth={2}
        className="animate-spin text-muted"
      />
    </span>
  )
}
