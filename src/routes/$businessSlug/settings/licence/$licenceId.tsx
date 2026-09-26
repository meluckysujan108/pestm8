import { useId, useRef, useState } from 'react'
import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { z } from 'zod'
import { api } from '../../../../../convex/_generated/api'
import {
  checkExpiresOn,
  cleanLicenceName,
  cleanLicenceNumber,
} from '../../../../../convex/lib/memberLicences'
import { FormAlert } from '#/components/forms/FormAlert'
import { EmptyState } from '#/components/primitives/EmptyState'
import { PageHeader } from '#/components/shell/PageHeader'
import { SectionPending } from '#/components/shell/Pending'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import {
  LicenceFields,
  checkLicenceDraft,
} from '#/components/settings/LicenceFields'
import { LicenceFiles } from '#/components/settings/LicenceFiles'
import {
  BackLink,
  DANGER_ROW_CLASS,
  DangerGroup,
  SaveBar,
  SettingsBody,
  SettingsGroup,
} from '#/components/settings/ui'
import { useMyLicences } from '#/components/settings/useMyLicences'
import { useSavedFlash } from '#/components/settings/useJustSaved'
import { licenceErrorCopy } from '#/lib/licenceErrors'
import { browserOnly, rq, settleWithin, warm } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import type { ReactNode } from 'react'
import type {
  LicenceDraft,
  LicenceFieldErrors,
} from '#/components/settings/LicenceFields'
import type { WalletLicence } from '#/components/settings/useMyLicences'
import type { Id } from '../../../../../convex/_generated/dataModel'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute(
  '/$businessSlug/settings/licence/$licenceId',
)({
  validateSearch: z.object({
    // Set by Add licence, so the page says what comes next. Lenient: a
    // mangled value is no hint, not an error page.
    added: z.boolean().optional().catch(undefined),
  }),
  // Warmed, never waited on past LOADER_WAIT_MS: with no signal a Convex
  // query never answers, and this page falls back to the copy kept on the
  // phone — its files open from there, for the inspector on site.
  loader: ({ context: { queryClient, business, membership } }) =>
    settleWithin(
      LOADER_WAIT_MS,
      warm(
        queryClient,
        // In the browser only: never in the HTML (`keptOutOfHtml`).
        ...browserOnly(rq.memberLicences(business._id, membership._id)),
      ),
    ),
  component: LicencePage,
})

/**
 * One licence of the signed-in person's: its name, number and expiry (one
 * form, one Save), its files, and — last, in red — deleting it.
 *
 * Found in the person's own list, never asked for by id: a licence that is
 * not theirs (someone else's id in the address), or one deleted since, is
 * simply not there, and the page says so.
 */
function LicencePage() {
  const { business, membership } = Route.useRouteContext()
  const { licenceId } = Route.useParams()
  const { added } = Route.useSearch()
  const { live, shown, nothing } = useMyLicences(business._id, membership._id)

  // Deleting it from here: the list answers without it a moment before the
  // page has gone back to Licences, and "deleted" must not flash up first.
  const [leaving, setLeaving] = useState(false)
  const last = useRef<WalletLicence | undefined>(undefined)
  const found = shown?.licences.find((licence) => licence._id === licenceId)
  if (found) last.current = found
  const licence = found ?? (leaving ? last.current : undefined)

  if (licence && shown) {
    return (
      <LicenceFrame title={licence.name}>
        <LicenceLoaded
          businessId={business._id}
          businessSlug={business.slug}
          membershipId={membership._id}
          licence={licence}
          fromPhone={shown.fromPhone}
          justAdded={added === true}
          onLeaving={setLeaving}
        />
      </LicenceFrame>
    )
  }

  if (shown === undefined) {
    return (
      <LicenceFrame title="Licence">
        {live.isError ? (
          <FormAlert error={live.error} copy={licenceErrorCopy('load')} />
        ) : nothing ? (
          <EmptyState
            title="No signal"
            body="Your licences show here once this phone has signal."
          />
        ) : (
          <SectionPending />
        )}
      </LicenceFrame>
    )
  }

  return (
    <LicenceFrame title="Not found">
      <EmptyState
        title={
          shown.fromPhone
            ? 'That licence isn’t on this phone.'
            : 'That licence isn’t in your list.'
        }
        body={
          shown.fromPhone
            ? 'It may have been added since this phone last had signal.'
            : 'It has been deleted, or the link was for someone else’s.'
        }
      />
      <div className="mt-4 text-center">
        <Link
          to="/$businessSlug/settings/licence"
          params={{ businessSlug: business.slug }}
          className="text-body font-semibold text-blue"
        >
          Back to Licences
        </Link>
      </div>
    </LicenceFrame>
  )
}

function LicenceLoaded({
  businessId,
  businessSlug,
  membershipId,
  licence,
  fromPhone,
  justAdded,
  onLeaving,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  membershipId: Id<'memberships'>
  licence: WalletLicence
  fromPhone: boolean
  justAdded: boolean
  /** On its way back to Licences, having been deleted — or not, after all. */
  onLeaving: (leaving: boolean) => void
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const hydrated = useHydrated()
  const formId = useId()
  const readOnly = fromPhone

  // What has been typed, or null for "as saved": the fields show the live
  // licence until someone types, so a change made meanwhile on another phone
  // shows through rather than reading as an edit here — a Save appearing by
  // itself, and pressing it writing the old values back.
  const [draft, setDraft] = useState<LicenceDraft | null>(null)
  const saved: LicenceDraft = {
    name: licence.name,
    number: licence.number ?? '',
    expiresOn: licence.expiresOn ?? '',
  }
  const fields = draft ?? saved
  const [errors, setErrors] = useState<LicenceFieldErrors>({})
  const flash = useSavedFlash()
  const dirty = draft !== null && !matchesSaved(draft, licence)

  const convexUpdate = useConvexMutation(api.memberLicences.update)
  const save = useMutation({
    mutationFn: async (args: {
      name: string
      number: string | null
      expiresOn: string | null
    }) => {
      // With no signal a Convex mutation waits rather than fails; say so.
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        throw new Error('offline')
      }
      return convexUpdate({
        businessId,
        licenceId: licence._id as Id<'memberLicences'>,
        ...args,
      })
    },
  })

  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const convexRemove = useConvexMutation(api.memberLicences.remove)
  const remove = useMutation({
    mutationFn: async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        throw new Error('offline')
      }
      return convexRemove({
        businessId,
        licenceId: licence._id as Id<'memberLicences'>,
      })
    },
    onSuccess: () => {
      // Only from this page: on a slow connection the delete can land after
      // the person has gone somewhere else, which this must not undo.
      if (!router.latestLocation.pathname.endsWith(`/licence/${licence._id}`)) {
        return
      }
      void navigate({
        to: '/$businessSlug/settings/licence',
        params: { businessSlug },
        // The licence is gone; Back should not bring its page up again.
        replace: true,
      })
    },
  })

  return (
    <>
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault()
          if (readOnly || !dirty || save.isPending) return
          const checked = checkLicenceDraft(fields)
          if (!checked.ok) {
            setErrors(checked.errors)
            return
          }
          setErrors({})
          const sent = draft
          save.mutate(
            {
              name: checked.value.name,
              // Empty clears it (null), as the server takes it.
              number: checked.value.number ?? null,
              expiresOn: checked.value.expiresOn ?? null,
            },
            {
              onSuccess: () => {
                flash.mark()
                // Back to the saved licence, unless more was typed meanwhile.
                setDraft((now) => (now === sent ? null : now))
              },
            },
          )
        }}
      >
        <SettingsGroup
          title="Licence"
          footer={
            readOnly
              ? 'No signal — showing the copy kept on this phone.'
              : undefined
          }
        >
          <LicenceFields
            draft={fields}
            onChange={(next) => {
              setDraft(next)
              setErrors((was) => ({
                name: next.name === fields.name ? was.name : undefined,
                number: next.number === fields.number ? was.number : undefined,
                expiresOn:
                  next.expiresOn === fields.expiresOn
                    ? was.expiresOn
                    : undefined,
              }))
            }}
            errors={errors}
            disabled={readOnly}
          />
        </SettingsGroup>
        <FormAlert
          error={save.isError ? save.error : null}
          copy={licenceErrorCopy('save')}
          className="mt-3"
        />
      </form>

      <LicenceFiles
        businessId={businessId}
        membershipId={membershipId}
        licence={licence}
        readOnly={readOnly}
        fromPhone={fromPhone}
        justAdded={justAdded}
      />

      {!readOnly && (
        <DangerGroup>
          <button
            ref={deleteButton}
            type="button"
            onClick={() => {
              remove.reset()
              setConfirmDelete(true)
            }}
            disabled={!hydrated || remove.isPending}
            className={DANGER_ROW_CLASS}
          >
            {remove.isPending ? 'Deleting…' : 'Delete licence'}
          </button>
        </DangerGroup>
      )}
      <FormAlert
        error={remove.isError ? remove.error : null}
        copy={licenceErrorCopy('delete')}
        className="mt-3"
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${licence.name}?`}
        body="It goes from your licences with its files, here and from this phone. The number on your reports stays as it is."
        confirm="Delete"
        cancel="Keep it"
        onConfirm={() => {
          onLeaving(true)
          remove.mutate(undefined, { onError: () => onLeaving(false) })
        }}
        // Kept: back on the button. Deleted: the page is on its way to the
        // list, and this does nothing.
        returnFocus={() => deleteButton.current}
      />

      <SaveBar
        form={formId}
        visible={!readOnly && (dirty || save.isPending || flash.recently)}
        pending={save.isPending}
        label={flash.recently && !dirty ? 'Saved' : 'Save'}
        disabled={!hydrated || !dirty}
      />
    </>
  )
}

/**
 * Whether what is typed is what is saved, as the server would keep it —
 * "White  card " is not a change from "White card".
 */
function matchesSaved(draft: LicenceDraft, licence: WalletLicence): boolean {
  const name = cleanLicenceName(draft.name)
  const number = cleanLicenceNumber(draft.number)
  const expiresOn = checkExpiresOn(draft.expiresOn)
  return (
    name.ok &&
    number.ok &&
    expiresOn.ok &&
    name.value === licence.name &&
    number.value === licence.number &&
    expiresOn.value === licence.expiresOn
  )
}

/** The header and body every state of this page shares. */
function LicenceFrame({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const { business } = Route.useRouteContext()
  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title={title}
        back={
          <BackLink
            to="/$businessSlug/settings/licence"
            params={{ businessSlug: business.slug }}
          >
            Licences
          </BackLink>
        }
      />
      <SettingsBody>{children}</SettingsBody>
    </>
  )
}
