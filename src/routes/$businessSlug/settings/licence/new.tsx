import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { PageHeader } from '#/components/shell/PageHeader'
import {
  LicenceFields,
  checkLicenceDraft,
} from '#/components/settings/LicenceFields'
import {
  StagedLicenceFiles,
  useStagedLicenceFiles,
} from '#/components/settings/StagedLicenceFiles'
import {
  ADD_FILE_WAIT_MS,
  UPLOAD_FRESH_MS,
  keepAddedLicenceFile,
  uploadLicenceFile,
  withinMs,
} from '#/components/settings/licenceUpload'
import {
  BackLink,
  SaveBar,
  SettingsBody,
  SettingsGroup,
} from '#/components/settings/ui'
import { licenceErrorCopy, licenceRefusal } from '#/lib/licenceErrors'
import { browserOnly, rq, settleWithin, warm } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import type {
  LicenceDraft,
  LicenceFieldErrors,
} from '#/components/settings/LicenceFields'
import type { StagedLicenceFile } from '#/components/settings/StagedLicenceFiles'
import type { UploadStage } from '#/components/settings/licenceUpload'
import type { Id } from '../../../../../convex/_generated/dataModel'
import { isOffline } from '#/lib/online'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/licence/new')({
  // The list this licence joins, so the list Add goes back to has it at
  // once. Never waited on past LOADER_WAIT_MS, like every page
  // that may be opened with no signal.
  loader: ({ context: { queryClient, business, membership } }) =>
    settleWithin(
      LOADER_WAIT_MS,
      warm(
        queryClient,
        // In the browser only: never in the HTML (`keptOutOfHtml`).
        ...browserOnly(rq.memberLicences(business._id, membership._id)),
      ),
    ),
  component: AddLicencePage,
})

const EMPTY: LicenceDraft = { name: '', number: '', expiresOn: '' }

/** Rounds of "send whatever has aged" before the licence is made: the second
 * catches a photo that aged while a big PDF was still going up (the rule
 * `productSave.ts` keeps for the same window). */
const UPLOAD_ROUNDS = 2

/**
 * Add new — a licence or an insurance policy, in one go: its name, number
 * and expiry, and its photos or PDFs. Add sends the lot and goes back to the
 * list, where it is, with its picture. There is no second page to finish it
 * on.
 *
 * Add does it in the order that leaves nothing half made:
 *
 *  1. Every file to storage. This is the part a weak signal breaks, so it
 *     comes before the licence exists: an upload that fails leaves nothing
 *     made, the files stay picked, and Add again sends only what did not
 *     get there (`uploads`, until it ages past the server's claim window).
 *  2. The licence.
 *  3. Its files put on it, in the order picked — each a small mutation
 *     straight after the last. Should one not confirm in time (the signal
 *     dropping at just that moment), the licence exists without it: Add goes
 *     to its own page instead, which says so and has everything to put it
 *     right. That is the only time Add ends anywhere but the list.
 *
 * Titled "Add new", not "Add licence or insurance": a page title is cut
 * rather than wrapped, and that one does not fit beside the owner's view
 * menu on a 375pt phone. The back link above it says where it adds to.
 */
function AddLicencePage() {
  const { business, membership } = Route.useRouteContext()
  const navigate = useNavigate()
  const hydrated = useHydrated()
  const [draft, setDraft] = useState<LicenceDraft>(EMPTY)
  const [errors, setErrors] = useState<LicenceFieldErrors>({})
  const staged = useStagedLicenceFiles()
  const [uploading, setUploading] = useState<UploadStage | null>(null)

  // What reached storage for each picked file, and when, by the Blob sent: a
  // second Add, after one that failed, sends only what is missing or aged.
  const uploads = useRef(new WeakMap<Blob, { storageId: string; at: number }>())
  // Fired when this page goes, so an upload still on its way stops.
  const leaving = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    leaving.current = controller
    return () => controller.abort()
  }, [])

  // Held open while this page is, so the list is live when Add goes back to
  // it and has the new one at once.
  useQuery(rq.memberLicences(business._id, membership._id))

  const convexUploadUrl = useConvexMutation(
    api.memberLicences.generateUploadUrl,
  )
  const convexCreate = useConvexMutation(api.memberLicences.create)
  const convexAddFile = useConvexMutation(api.memberLicences.addFile)
  const add = useMutation({
    mutationFn: async ({
      value,
      files,
    }: {
      value: { name: string; number?: string; expiresOn?: string }
      files: Array<StagedLicenceFile>
    }) => {
      // With no signal a Convex mutation waits for the socket rather than
      // failing, and the button would say "Saving…" for as long as the
      // phone is out of range. Say so now instead.
      if (isOffline()) {
        throw new Error('offline')
      }

      // 1. Every file to storage, before anything is made.
      const fresh = (file: StagedLicenceFile) => {
        const known = uploads.current.get(file.blob)
        return known !== undefined && Date.now() - known.at < UPLOAD_FRESH_MS
      }
      for (let round = 0; round < UPLOAD_ROUNDS; round++) {
        const due = files.filter((file) => !fresh(file))
        if (due.length === 0) break
        for (const [i, file] of due.entries()) {
          setUploading({ step: 'uploading', n: i + 1, of: due.length })
          const storageId = await uploadLicenceFile(
            file,
            () => convexUploadUrl({ businessId: business._id }),
            leaving.current?.signal,
          )
          uploads.current.set(file.blob, { storageId, at: Date.now() })
        }
      }
      setUploading(null)

      // 2. The licence.
      const licenceId = await convexCreate({
        businessId: business._id,
        ...value,
      })

      // 3. Its files, in the order picked. Each is sent even when one before
      // it did not confirm: on a dropped socket they queue, and go together
      // when it comes back.
      let unconfirmed = 0
      for (const file of files) {
        const storageId = uploads.current.get(file.blob)?.storageId
        if (storageId === undefined) {
          unconfirmed++
          continue
        }
        try {
          const { fileId, uploadedAt } = await withinMs(
            convexAddFile({
              businessId: business._id,
              licenceId,
              storageId: storageId as Id<'_storage'>,
              fileName: file.fileName,
            }),
            ADD_FILE_WAIT_MS,
            () => licenceRefusal('ADD_FILE_UNCONFIRMED'),
          )
          keepAddedLicenceFile({
            businessId: business._id,
            membershipId: membership._id,
            fileId,
            uploadedAt,
            prepared: file,
          })
        } catch {
          unconfirmed++
        }
        // Claimed now, or on its way to it: sent again it would be refused
        // as already on a licence.
        uploads.current.delete(file.blob)
      }
      return { licenceId, unconfirmed }
    },
    onSettled: () => setUploading(null),
    onSuccess: ({ licenceId, unconfirmed }) => {
      void navigate(
        unconfirmed === 0
          ? {
              to: '/$businessSlug/settings/licence',
              params: { businessSlug: business.slug },
              // Back from the list goes to Settings, not to a form that
              // would add it twice.
              replace: true,
            }
          : {
              to: '/$businessSlug/settings/licence/$licenceId',
              params: { businessSlug: business.slug, licenceId },
              search: { unconfirmed },
              replace: true,
            },
      )
    },
  })

  const dirty =
    draft.name !== '' ||
    draft.number !== '' ||
    draft.expiresOn !== '' ||
    staged.files.length > 0
  const locked = add.isPending || add.isSuccess

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Add new"
        back={
          <BackLink
            to="/$businessSlug/settings/licence"
            params={{ businessSlug: business.slug }}
          >
            Licences & insurance
          </BackLink>
        }
      />
      <SettingsBody>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (add.isPending || staged.preparing) return
            const checked = checkLicenceDraft(draft)
            if (!checked.ok) {
              setErrors(checked.errors)
              return
            }
            setErrors({})
            add.mutate({ value: checked.value, files: staged.files })
          }}
        >
          <SettingsGroup title="Details">
            <LicenceFields
              draft={draft}
              onChange={(next) => {
                setDraft(next)
                // A field put right loses its line; the others keep theirs.
                setErrors((was) => ({
                  name: next.name === draft.name ? was.name : undefined,
                  number: next.number === draft.number ? was.number : undefined,
                  expiresOn:
                    next.expiresOn === draft.expiresOn
                      ? was.expiresOn
                      : undefined,
                }))
              }}
              errors={errors}
              disabled={locked}
            />
          </SettingsGroup>
          <StagedLicenceFiles
            staged={staged}
            uploading={uploading}
            locked={locked}
          />
          <FormAlert
            error={add.isError ? add.error : null}
            copy={licenceErrorCopy('add')}
            className="mt-3"
          />
          <SaveBar
            visible={dirty || add.isPending}
            pending={add.isPending}
            label="Add"
            disabled={!hydrated || add.isSuccess || staged.preparing !== null}
          />
        </form>
      </SettingsBody>
    </>
  )
}
