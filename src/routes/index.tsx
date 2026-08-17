import { createFileRoute, redirect } from '@tanstack/react-router'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../convex/_generated/api'

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })

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
