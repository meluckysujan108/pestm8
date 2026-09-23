import { createFileRoute, redirect } from '@tanstack/react-router'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../convex/_generated/api'

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })

    // This used to claim invitations here, on every single visit, by matching
    // the signed-in email address — which is how anyone who registered an
    // invited address ended up inside the business. Joining now happens once,
    // deliberately, by redeeming a link (`/join/$token`).
    const businesses = await context.queryClient.ensureQueryData(
      convexQuery(api.businesses.listForUser, {}),
    )

    if (businesses.length === 0) throw redirect({ to: '/onboarding' })

    throw redirect({
      to: '/$businessSlug/schedule',
      params: { businessSlug: businesses[0].slug },
    })
  },
  // Only ever redirects, so a placeholder here would stand in for the whole
  // app, shell and all. Keep the screen you came from, with the progress bar.
  pendingMs: Infinity,
})
