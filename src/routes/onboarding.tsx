import {
  Navigate,
  createFileRoute,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { z } from 'zod'
import { api } from '../../convex/_generated/api'
import { BrandStep } from '#/components/onboarding/BrandStep'
import { BusinessStep } from '#/components/onboarding/BusinessStep'
import { LicenceStep } from '#/components/onboarding/LicenceStep'
import { NoBusiness } from '#/components/onboarding/NoBusiness'
import { ReadyStep } from '#/components/onboarding/ReadyStep'
import { TeamStep } from '#/components/onboarding/TeamStep'
import { authClient } from '#/lib/auth-client'
import { beginSignOut, forgetCachedPages } from '#/lib/rootState'
import { rq } from '#/lib/routeQueries'
import { isMfaEnrolmentError } from '#/lib/twoStep'
import { useHydrated } from '#/lib/useHydrated'
import type { SetupStep } from '#/components/onboarding/SetupFrame'
import type { TeamShape } from '#/components/onboarding/TeamStep'

/**
 * Setting up a business: four short steps, one question each, and a finish.
 *
 *   business → brand → licence → team → ready
 *
 * The first creates the business; after that the business is in the URL
 * (`?business=<slug>&step=<step>`) and each step edits it. The step the owner
 * has reached is also kept on the business (`businesses.setup`), because an
 * iPhone Home Screen app that reloads comes back at `/`, not here — and `/`
 * sends an owner with set-up still open back to that step.
 *
 * Everything after the name is optional ("Add later"). What the steps ask
 * for is what stops work when it is missing: the letterhead every report
 * prints, and the licence number a certificate will not finalise without.
 *
 * With sign-up invitation-only, only an account holding a claimed
 * start-a-business link may create one (`businessInvites.setupAccess`);
 * anyone else with no business is told so (`NoBusiness`).
 */

const STEPS = ['business', 'brand', 'licence', 'team', 'ready'] as const

const searchSchema = z.object({
  business: z.string().optional(),
  step: z.enum(STEPS).optional().catch(undefined),
})

export const Route = createFileRoute('/onboarding')({
  validateSearch: searchSchema,
  beforeLoad: async ({ context, search, location }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })
    // Creating a business comes after two-step sign-in where that is
    // compulsory, like everything else the server does for a signed-in
    // person — asked here rather than discovered on Create, so nobody fills
    // the form in first.
    const status = await context.queryClient.ensureQueryData(
      convexQuery(api.auth.twoFactorStatus, {}),
    )
    if (status.required && !status.enabled) {
      throw redirect({ to: '/two-step', search: { next: location.href } })
    }
    const enrol = (error: unknown): never => {
      if (isMfaEnrolmentError(error)) {
        throw redirect({ to: '/two-step', search: { next: location.href } })
      }
      throw error
    }

    if (search.business) {
      // Warmed here so the step renders without a placeholder, and read
      // live from there. Only the owner sets up; anyone else, or a slug that
      // is not theirs, goes where `/` would send them.
      // The account too: its email starts the letterhead's, and a field
      // cannot take a value that arrives after it first renders.
      const [business] = await Promise.all([
        context.queryClient.ensureQueryData(
          convexQuery(api.businesses.getBySlug, { slug: search.business }),
        ),
        context.queryClient.ensureQueryData(rq.currentUser()),
      ]).catch(enrol)
      if (!business || business.membership.role !== 'owner') {
        throw redirect({ to: '/' })
      }
      return { mode: 'setup' as const }
    }

    const [access, businesses] = await Promise.all([
      context.queryClient.ensureQueryData(
        convexQuery(api.businessInvites.setupAccess, {}),
      ),
      context.queryClient.ensureQueryData(
        convexQuery(api.businesses.listForUser, {}),
      ),
    ]).catch(enrol)
    if (access.canCreate) return { mode: 'create' as const }
    // In a business already, with nothing to set up: not a page for them.
    if (businesses.length > 0) throw redirect({ to: '/' })
    return { mode: 'none' as const }
  },
  // A redirect or a form, nothing slow: keep the screen you came from.
  pendingMs: Infinity,
  component: OnboardingPage,
})

function OnboardingPage() {
  const { mode } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const { data: session } = authClient.useSession()
  const email = session?.user.email ?? null

  if (mode === 'none') return <NoBusiness email={email} />

  if (mode === 'setup' && search.business) {
    return (
      <SetupFor
        key={search.business}
        slug={search.business}
        step={search.step ?? 'brand'}
      />
    )
  }

  return (
    <BusinessStep
      business={null}
      // `replace`: Back from the next step is this business's own step 1,
      // never the empty form that would make a second one.
      onDone={(slug) =>
        navigate({
          to: '/onboarding',
          search: { business: slug, step: 'brand' },
          replace: true,
        })
      }
      footer={<SignedInAs email={email} />}
    />
  )
}

function SetupFor({ slug, step }: { slug: string; step: SetupStep }) {
  const navigate = useNavigate()
  const { data: user } = useSuspenseQuery(rq.currentUser())
  const accountEmail = user.email || null
  const accountName = user.name || undefined
  // Live, so a logo shows the moment it lands and each step opens on what
  // the last one saved.
  const { data: business } = useSuspenseQuery(
    convexQuery(api.businesses.getBySlug, { slug }),
  )
  const setSetup = useConvexMutation(api.businesses.setSetup)

  if (!business) return <Navigate to="/" replace />
  const businessId = business._id

  const go = (next: SetupStep) =>
    navigate({ to: '/onboarding', search: { business: slug, step: next } })

  // Where to resume is a convenience, so it never holds anyone up: offline,
  // the write waits for signal while they carry on, and at worst `/` opens
  // a step early next time.
  const reach = (
    patch: Omit<Parameters<typeof setSetup>[0], 'businessId'>,
  ): void => {
    void setSetup({ businessId, ...patch }).catch(() => {})
  }
  const advance = async (next: 'licence' | 'team') => {
    reach({ step: next })
    await go(next)
  }

  const toSchedule = (newJob: boolean) =>
    navigate({
      to: '/$businessSlug/schedule',
      params: { businessSlug: slug },
      search: newJob ? { newJob: true } : {},
      replace: true,
    })

  switch (step) {
    case 'business':
      return <BusinessStep business={business} onDone={() => go('brand')} />
    case 'brand':
      return (
        <BrandStep
          business={business}
          accountEmail={accountEmail}
          licenceNumber={business.membership.licenceNumber}
          onBack={() => void go('business')}
          onDone={() => advance('licence')}
          onLater={() => void advance('licence')}
        />
      )
    case 'licence':
      return (
        <LicenceStep
          business={business}
          onBack={() => void go('brand')}
          onDone={() => advance('team')}
          onLater={() => void advance('team')}
        />
      )
    case 'team':
      return (
        <TeamStep
          business={business}
          inviterName={accountName}
          onBack={() => void go('licence')}
          onDone={async (team: TeamShape | null) => {
            reach({ ...(team ? { team } : {}), finished: true })
            await go('ready')
          }}
        />
      )
    case 'ready':
      return (
        <ReadyStep
          business={business}
          onBook={() => void toSchedule(true)}
          onSchedule={() => void toSchedule(false)}
        />
      )
  }
}

/** Under the first step: whose account this is going on, and the way out
 * for a shared phone. */
function SignedInAs({ email }: { email: string | null }) {
  const hydrated = useHydrated()
  if (!email) return null
  return (
    <p className="mt-6 text-center text-caption text-muted">
      Signed in as {email} ·{' '}
      <button
        type="button"
        disabled={!hydrated}
        onClick={() => {
          beginSignOut()
          void authClient
            .signOut()
            .then(forgetCachedPages)
            .then(() => window.location.replace('/login'))
        }}
        className="text-blue"
      >
        Sign out
      </button>
    </p>
  )
}
