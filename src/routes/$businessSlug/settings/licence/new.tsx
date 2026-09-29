import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../../../convex/_generated/api'
import { MAX_LICENCES } from '../../../../../convex/lib/memberLicences'
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
import { addedFromList } from '#/components/settings/licenceNav'
import {
  ADD_FILE_WAIT_MS,
  keepAddedLicenceFile,
  uploadLicenceFile,
  uploadStagedFiles,
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
import type {
  LicenceUploadMemo,
  UploadStage,
} from '#/components/settings/licenceUpload'
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
 *  3. Its files put on it, all sent at once in the order picked (Convex runs
 *     one client's mutations in the order they are sent), then waited on
 *     together. Should one not be heard back about in time (the signal
 *     dropping at just that moment), the licence exists without it for now:
 *     Add goes to its own page instead, which says how many have not arrived
 *     until they have, and has everything to put it right. That is the only
 *     time Add ends anywhere but the list.
 *
 * Leaving the page stops it where it is: an upload under way is abandoned,
 * nothing is made that was not already, and a finished Add never pulls the
 * person back from wherever they went.
 *
 * Titled "Add new", not "Add licence or insurance": a page title is cut
 * rather than wrapped, and that one does not fit beside the owner's view
 * menu on a 375pt phone. The back link above it says where it adds to.
 */
function AddLicencePage() {
  const { business, membership } = Route.useRouteContext()
  const navigate = useNavigate()
  const router = useRouter()
  const hydrated = useHydrated()
  const [draft, setDraft] = useState<LicenceDraft>(EMPTY)
  const [errors, setErrors] = useState<LicenceFieldErrors>({})
  const staged = useStagedLicenceFiles()
  const [uploading, setUploading] = useState<UploadStage | null>(null)

  // What reached storage for each picked file, and when: a second Add, after
  // one that failed, sends only what is missing or aged (`uploadStagedFiles`).
  const uploads = useRef<LicenceUploadMemo>(new WeakMap())
  // Fired when this page goes, so an upload still on its way stops, and
  // nothing is made after.
  const leaving = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    leaving.current = controller
    return () => controller.abort()
  }, [])
  // Set on the press itself, not on the next render: two quick presses must
  // not start two Adds.
  const adding = useRef(false)

  // Held open while this page is, so the list is live when Add goes back to
  // it and has the new one at once — and so a full list is known before
  // anything is sent.
  const list = useQuery(rq.memberLicences(business._id, membership._id))

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
      // failing. Say so now instead.
      if (isOffline()) {
        throw new Error('offline')
      }
      // Full already: said before a single file is sent. The server keeps
      // the same rule in case this list is behind.
      if ((list.data?.licences.length ?? 0) >= MAX_LICENCES) {
        throw licenceRefusal('TOO_MANY_LICENCES')
      }

      // 1. Every file to storage, before anything is made.
      await uploadStagedFiles(files, uploads.current, (file, n, of) => {
        setUploading({ step: 'uploading', n, of })
        return uploadLicenceFile(
          file,
          () => convexUploadUrl({ businessId: business._id }),
          leaving.current?.signal,
        )
      })
      setUploading(null)
      // Gone meanwhile: nothing is made that the person has walked away from.
      leaving.current?.signal.throwIfAborted()

      // 2. The licence.
      const licenceId = await convexCreate({
        businessId: business._id,
        ...value,
      })

      // 3. Its files, all sent now in the order picked, then waited on
      // together: on a dropped socket they queue, and go when it is back.
      const attached = await Promise.allSettled(
        files.map((file) => {
          const storageId = uploads.current.get(file.blob)?.storageId
          if (storageId === undefined) {
            return Promise.reject(new Error('Not uploaded'))
          }
          return withinMs(
            convexAddFile({
              businessId: business._id,
              licenceId,
              storageId: storageId as Id<'_storage'>,
              fileName: file.fileName,
            }),
            ADD_FILE_WAIT_MS,
            () => licenceRefusal('ADD_FILE_UNCONFIRMED'),
          )
        }),
      )
      let heard = 0
      attached.forEach((result, i) => {
        if (result.status !== 'fulfilled') return
        heard++
        keepAddedLicenceFile({
          businessId: business._id,
          membershipId: membership._id,
          fileId: result.value.fileId,
          uploadedAt: result.value.uploadedAt,
          prepared: files[i],
        })
      })
      // Claimed now, or on the way to it: sent again they would be refused
      // as already on a licence.
      for (const file of files) uploads.current.delete(file.blob)
      return { licenceId, sent: files.length, heard }
    },
    onSettled: () => {
      adding.current = false
      setUploading(null)
    },
    onSuccess: ({ licenceId, sent, heard }) => {
      // Only from this page: on a weak signal Add can finish after the
      // person has gone somewhere else, which this must not undo.
      if (!router.latestLocation.pathname.endsWith('/licence/new')) return
      if (heard < sent) {
        void navigate({
          to: '/$businessSlug/settings/licence/$licenceId',
          params: { businessSlug: business.slug, licenceId },
          search: { expected: sent },
          replace: true,
        })
      } else if (addedFromList(router.history.location.state)) {
        // Back to the list this came from, rather than a second copy of it.
        router.history.back()
      } else {
        void navigate({
          to: '/$businessSlug/settings/licence',
          params: { businessSlug: business.slug },
          replace: true,
        })
      }
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
            if (adding.current || staged.preparing) return
            const checked = checkLicenceDraft(draft)
            if (!checked.ok) {
              setErrors(checked.errors)
              return
            }
            setErrors({})
            adding.current = true
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
