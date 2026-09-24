import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { ConvexQueryClient } from '@convex-dev/react-query'
import { TWO_STEP_PATH, isMfaEnrolmentError, twoStepHref } from '#/lib/twoStep'

/**
 * The global answer to MFA_ENROLMENT_REQUIRED: the set-up screen, not a
 * "Server Error".
 *
 * The route guards already send an un-enrolled person there before a page
 * loads (`/`, `$businessSlug`, `/onboarding`). This is for the moment they
 * cannot: a person already inside the app when two-step sign-in became
 * compulsory, whose live queries start being refused mid-screen. A full load
 * rather than a router navigation, because this module has no router — and
 * because the set-up ends in one anyway.
 *
 * Only queries something is showing (`observers > 0`): a guard's
 * `ensureQueryData` has none, and handles the refusal itself with a proper
 * redirect that this would otherwise race.
 */
function sendToTwoStep(error: unknown): void {
  if (typeof window === 'undefined' || !isMfaEnrolmentError(error)) return
  if (window.location.pathname === TWO_STEP_PATH) return
  window.location.replace(
    twoStepHref(window.location.pathname + window.location.search),
  )
}

export function getContext() {
  const convexUrl = import.meta.env.VITE_CONVEX_URL
  if (!convexUrl) throw new Error('VITE_CONVEX_URL is not set')

  // `expectAuth: true` holds every query/action back until the first auth
  // token is sent — meant for apps where every page needs a signed-in
  // client. This one has an exception: `/join/$token` deliberately works
  // signed out (see its own header comment), and asks for its preview
  // before anyone has signed in. `ConvexProviderWithAuth` only calls
  // `client.setAuth(...)` on the AUTHENTICATED branch (convex/react's
  // ConvexAuthStateFirstEffect), so for a genuinely signed-out visitor no
  // token is ever sent — and with `expectAuth: true`, that queue never
  // opens. The join page hung on "Checking your invitation…" forever,
  // for every invite, for anyone who was not already signed in somewhere
  // else in the same browser. Every route past `/join` still enforces its
  // own membership check server-side, so an early, unauthenticated request
  // firing here is a non-issue — it either succeeds against a function that
  // needs no auth (this one) or is refused and quietly refetched once the
  // real token lands.
  const convexQueryClient = new ConvexQueryClient(convexUrl)

  const queryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.getObserversCount() > 0) sendToTwoStep(error)
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => sendToTwoStep(error),
    }),
    defaultOptions: {
      queries: {
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
        // A Convex query is live while react-query keeps it, and react-query
        // drops it five minutes after the last FETCH — a push does not restart
        // that clock. So a tab opened six minutes ago had lost its
        // subscription and paid a round trip to come back, though nothing had
        // changed in it. Fifteen minutes covers a morning of moving between
        // tabs; on the server every request gets its own client, where a timer
        // would only keep it alive past the response.
        gcTime: typeof window === 'undefined' ? Infinity : 15 * 60_000,
      },
    },
  })

  // Nothing renders this one: `$businessSlug`'s beforeLoad reads it and hands
  // the business on. With no observer it is evicted on the same timer as any
  // other query, and the next navigation then waits a round trip inside
  // beforeLoad, where there is nothing to show but the page you came from.
  // Set as a default rather than per call, because the query that matters is
  // usually built by hydration, which does not see a call's options.
  queryClient.setQueryDefaults(['convexQuery', 'businesses:getBySlug'], {
    gcTime: Infinity,
  })

  convexQueryClient.connect(queryClient)

  return { queryClient, convexQueryClient }
}
