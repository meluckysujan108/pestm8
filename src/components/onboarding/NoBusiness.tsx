import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { authClient } from '#/lib/auth-client'
import { beginSignOut, forgetCachedPages } from '#/lib/rootState'
import { useHydrated } from '#/lib/useHydrated'
import { SECONDARY_BUTTON } from '#/components/primitives/buttons'

/**
 * A signed-in account that belongs to no business and may not start one —
 * most often a technician the team has let go, signing in again. They used to
 * be handed "Set up your business", a form the server now refuses without a
 * link (businessInvites.ts). This says what is true instead, and what to do.
 */
export function NoBusiness({ email }: { email: string | null }) {
  const hydrated = useHydrated()
  // A team invitation already waiting for this address, so "open your link"
  // is pointed, not a guess.
  const { data: waiting } = useQuery(
    convexQuery(api.invitations.mineExists, {}),
  )

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6">
      <p className="section-label mb-2">PestM8</p>
      <h1 className="text-page-title text-ink">
        This account isn’t part of a business
      </h1>
      <p className="mt-2 text-body text-muted">
        {waiting
          ? 'You have an invitation waiting. Open the link you were sent to join the team.'
          : 'To join a team, open the invitation link you were sent. To set up your own business, you’ll need a link to start one.'}
      </p>

      {email && (
        <p className="mt-6 text-body text-ink-2">
          Signed in as <span className="text-ink">{email}</span>
        </p>
      )}
      <button
        type="button"
        disabled={!hydrated}
        onClick={() => {
          // As Settings' sign-out: a document load, so the next person to
          // sign in on this phone starts clean (rootState.ts has why).
          beginSignOut()
          void authClient
            .signOut()
            .then(forgetCachedPages)
            .then(() => window.location.replace('/login'))
        }}
        className={`${SECONDARY_BUTTON} mt-3 w-full`}
      >
        Sign out
      </button>
    </main>
  )
}
