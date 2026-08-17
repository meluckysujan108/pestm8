import { createFileRoute, redirect } from '@tanstack/react-router'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../convex/_generated/api'
import { createServerFn } from '@tanstack/react-start'
import { fetchAuthMutation } from '#/lib/auth-server'

const claimInvitations = createServerFn({ method: 'POST' }).handler(() =>
  fetchAuthMutation(api.memberships.claimInvitations, {}),
)

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })

    // Claim any invitation sent to this address before deciding where to land,
    // so an invited subcontractor goes to the business rather than being asked
    // to create one of their own.
    await claimInvitations()

    const businesses = await context.queryClient.ensureQueryData(
      convexQuery(api.businesses.listForUser, {}),
    )

    if (businesses.length === 0) throw redirect({ to: '/onboarding' })

    throw redirect({
      to: '/$businessSlug/dashboard',
      params: { businessSlug: businesses[0].slug },
    })
  },
})
