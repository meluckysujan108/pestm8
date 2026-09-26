import { useEffect, useId, useRef, useState } from 'react'
import {
  Navigate,
  createFileRoute,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { z } from 'zod'
import { api } from '../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass } from '#/components/forms/FormField'
import {
  HomeScreenCard,
  useHomeScreenOffer,
} from '#/components/onboarding/HomeScreenCard'
import {
  AsideButton,
  ContinueButton,
  SetupFrame,
} from '#/components/onboarding/SetupFrame'
import { FieldRow, SettingsGroup } from '#/components/settings/ui'
import { LICENCE_LABEL } from '#/lib/au'
import { roleLabel } from '#/lib/assignees'
import { isMfaEnrolmentError } from '#/lib/twoStep'
import { useHydrated } from '#/lib/useHydrated'
import type { Id } from '../../convex/_generated/dataModel'
import type { Role } from '../../convex/lib/capabilities'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'

/**
 * The welcome for someone who has just joined a business through a link:
 * their licence number, then the Home Screen, then their jobs. Two screens,
 * each skippable, and none of them the owner's set-up — a technician's first
 * minute is about being ready for the first job they are given.
 *
 * The licence step is skipped for someone whose number is already on file;
 * the Home Screen one wherever there is nothing to offer (already installed,
 * or a browser with no way to). Nothing here is kept: a reload lands on the
 * schedule, and the licence notice on a report catches a skipped number
 * later, when it matters.
 */

const searchSchema = z.object({
  business: z.string().optional(),
  step: z.enum(['licence', 'home']).optional().catch(undefined),
})

export const Route = createFileRoute('/welcome')({
  validateSearch: searchSchema,
  beforeLoad: async ({ context, search, location }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })
    if (!search.business) throw redirect({ to: '/' })
    const business = await context.queryClient
      .ensureQueryData(
        convexQuery(api.businesses.getBySlug, { slug: search.business }),
      )
      .catch((error: unknown) => {
        if (isMfaEnrolmentError(error)) {
          throw redirect({ to: '/two-step', search: { next: location.href } })
        }
        throw error
      })
    // Not `/`: straight after signing up the socket can answer as nobody
    // for a moment, and `/` would then pick some other business. The
    // business's own page asks again, and tells a real "not yours" apart.
    if (!business) {
      throw redirect({
        to: '/$businessSlug/schedule',
        params: { businessSlug: search.business },
      })
    }
  },
  pendingMs: Infinity,
  component: WelcomePage,
})

function WelcomePage() {
  const search = Route.useSearch()
  const slug = search.business ?? ''
  const navigate = useNavigate()
  const { data: business } = useSuspenseQuery(
    convexQuery(api.businesses.getBySlug, { slug }),
  )

  // The step is fixed as the page opens, not followed live: an owner adding
  // this person's number from Settings meanwhile must not snatch the field
  // from under their thumb.
  const [firstStep] = useState(() =>
    business?.membership.licenceNumber ? 'home' : 'licence',
  )

  if (!business) {
    return (
      <Navigate
        to="/$businessSlug/schedule"
        params={{ businessSlug: slug }}
        replace
      />
    )
  }

  const toJobs = () =>
    navigate({
      to: '/$businessSlug/schedule',
      params: { businessSlug: slug },
      replace: true,
    })
  const step = search.step ?? firstStep

  if (step === 'licence') {
    return (
      <LicenceWelcome
        businessId={business._id}
        businessName={business.name}
        membershipId={business.membership._id}
        role={business.membership.role}
        state={business.state}
        onDone={() =>
          navigate({
            to: '/welcome',
            search: { business: slug, step: 'home' },
            replace: true,
          })
        }
      />
    )
  }
  return <HomeWelcome businessName={business.name} onDone={toJobs} />
}

function LicenceWelcome({
  businessId,
  businessName,
  membershipId,
  role,
  state,
  onDone,
}: {
  businessId: Id<'businesses'>
  businessName: string
  membershipId: Id<'memberships'>
  role: Role
  state: string
  onDone: () => void
}) {
  const hydrated = useHydrated()
  const inputId = useId()
  const [value, setValue] = useState('')
  const setLicence = useConvexMutation(api.memberships.setLicence)
  const save = useMutation({
    mutationFn: async (licenceNumber: string) => {
      if (licenceNumber.trim()) {
        await setLicence({ businessId, membershipId, licenceNumber })
      }
    },
    onSuccess: onDone,
  })

  return (
    <SetupFrame
      step="ready"
      title={`Welcome to ${businessName}`}
      lede={`You’re on the team as a ${roleLabel(role).toLowerCase()}. First, the licence number that goes on the reports you sign.`}
      aside={<AsideButton onClick={onDone}>Add later</AsideButton>}
    >
      <form
        className="mt-6 flex flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate(value)
        }}
      >
        <SettingsGroup footer="Certificates and inspection reports can’t be finalised without it.">
          <FieldRow
            id={inputId}
            label={LICENCE_LABEL[state] ?? 'Licence number'}
          >
            <input
              id={inputId}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="done"
              maxLength={64}
              className={fieldInputClass()}
            />
          </FieldRow>
        </SettingsGroup>

        <FormAlert error={save.isError ? save.error : null} className="mt-4" />
        <ContinueButton pending={save.isPending} disabled={!hydrated} />
      </form>
    </SetupFrame>
  )
}

function HomeWelcome({
  businessName,
  onDone,
}: {
  businessName: string
  onDone: () => void
}) {
  const hydrated = useHydrated()
  const offer = useHomeScreenOffer()
  // Nothing to offer here — installed already, or no way to — so straight
  // on, once.
  const skipped = useRef(false)
  useEffect(() => {
    if (offer !== 'none' || skipped.current) return
    skipped.current = true
    onDone()
  }, [offer, onDone])

  return (
    <SetupFrame
      step="ready"
      title="Keep PestM8 on your Home Screen"
      lede={`So ${businessName}’s jobs are one tap away, and your licence is on this phone for sites with no signal.`}
    >
      <div className="mt-6">
        <HomeScreenCard bare />
      </div>
      <button
        type="button"
        onClick={onDone}
        disabled={!hydrated}
        className={`${PRIMARY_BUTTON} mt-8 w-full shrink-0`}
      >
        Go to my jobs
      </button>
    </SetupFrame>
  )
}
