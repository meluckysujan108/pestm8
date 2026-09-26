import { createFileRoute, redirect } from '@tanstack/react-router'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../convex/_generated/api'
import { isMfaEnrolmentError } from '#/lib/twoStep'

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })

    // This used to claim invitations here, on every single visit, by matching
    // the signed-in email address — which is how anyone who registered an
    // invited address ended up inside the business. Joining now happens once,
    // deliberately, by redeeming a link (`/join/$token`).
    const businesses = await context.queryClient
      .ensureQueryData(convexQuery(api.businesses.listForUser, {}))
      .catch((error: unknown) => {
        // Signed in without two-step sign-in set up — at the first sign-in
        // after it became compulsory, or after the owner reset it. The server
        // refuses everything until it is done, so that is where to go.
        if (isMfaEnrolmentError(error)) throw redirect({ to: '/two-step' })
        throw error
      })

    if (businesses.length === 0) throw redirect({ to: '/onboarding' })

    // An owner who left set-up half-way — often not by choice: an iPhone
    // Home Screen app reopens here, not where it was. Back to that step.
    // (`setupStep` is absent from a backend before set-up existed.)
    const unfinished = businesses.find((b) => b.setupStep)
    if (unfinished?.setupStep) {
      throw redirect({
        to: '/onboarding',
        search: { business: unfinished.slug, step: unfinished.setupStep },
      })
    }

    throw redirect({
      to: '/$businessSlug/schedule',
      params: { businessSlug: businesses[0].slug },
    })
  },
  // Only ever redirects, so a placeholder here would stand in for the whole
  // app, shell and all. Keep the screen you came from, with the progress bar.
  pendingMs: Infinity,
})
