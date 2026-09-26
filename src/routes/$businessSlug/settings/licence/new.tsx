import { useState } from 'react'
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
  BackLink,
  SaveBar,
  SettingsBody,
  SettingsGroup,
} from '#/components/settings/ui'
import { licenceErrorCopy } from '#/lib/licenceErrors'
import { browserOnly, rq, settleWithin, warm } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import type {
  LicenceDraft,
  LicenceFieldErrors,
} from '#/components/settings/LicenceFields'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/licence/new')({
  // The list this licence joins, so the page it lands on after Add finds it
  // already in hand. Never waited on past LOADER_WAIT_MS, like every page
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
 * Add licence: a name (typed, or one of the suggestions), a number and an
 * expiry — the files come next, on the licence's own page, where Add lands
 * with a word saying so. A licence with no file is still worth having: the
 * number and the date are what the reminder needs.
 */
function AddLicencePage() {
  const { business, membership } = Route.useRouteContext()
  const navigate = useNavigate()
  const hydrated = useHydrated()
  const [draft, setDraft] = useState<LicenceDraft>(EMPTY)
  const [errors, setErrors] = useState<LicenceFieldErrors>({})

  // Held open while this page is, so the list is live when Add lands on the
  // new licence's page and has it at once.
  useQuery(rq.memberLicences(business._id, membership._id))

  const convexCreate = useConvexMutation(api.memberLicences.create)
  const add = useMutation({
    mutationFn: async (value: {
      name: string
      number?: string
      expiresOn?: string
    }) => {
      // With no signal a Convex mutation waits for the socket rather than
      // failing, and the button would say "Saving…" for as long as the
      // phone is out of range. Say so now instead.
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        throw new Error('offline')
      }
      return convexCreate({ businessId: business._id, ...value })
    },
    onSuccess: (licenceId) => {
      void navigate({
        to: '/$businessSlug/settings/licence/$licenceId',
        params: { businessSlug: business.slug, licenceId },
        search: { added: true },
        // Back from the licence goes to the list, not to an empty form that
        // would add it twice.
        replace: true,
      })
    },
  })

  const dirty =
    draft.name !== '' || draft.number !== '' || draft.expiresOn !== ''

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Add licence"
        back={
          <BackLink
            to="/$businessSlug/settings/licence"
            params={{ businessSlug: business.slug }}
          >
            Licences
          </BackLink>
        }
      />
      <SettingsBody>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (add.isPending) return
            const checked = checkLicenceDraft(draft)
            if (!checked.ok) {
              setErrors(checked.errors)
              return
            }
            setErrors({})
            add.mutate(checked.value)
          }}
        >
          <SettingsGroup
            title="Licence"
            footer="Add a photo or PDF of it on the next page."
          >
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
            />
          </SettingsGroup>
          <FormAlert
            error={add.isError ? add.error : null}
            copy={licenceErrorCopy('add')}
            className="mt-3"
          />
          <SaveBar
            visible={dirty || add.isPending}
            pending={add.isPending}
            label="Add"
            disabled={!hydrated || add.isSuccess}
          />
        </form>
      </SettingsBody>
    </>
  )
}
