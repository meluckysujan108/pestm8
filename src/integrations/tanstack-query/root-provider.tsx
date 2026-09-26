import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { ConvexQueryClient } from '@convex-dev/react-query'
import { authClient } from '#/lib/auth-client'
import { HandoverConvexClient } from '#/lib/convexClient'
import { browserRefreshRetry } from '#/lib/tokenRefresh'
import { flagIfTwoStepNeeded, watchForTwoStepRefusals } from '#/lib/twoStep'

/**
 * The global answer to MFA_ENROLMENT_REQUIRED: the "set up two-step sign-in"
 * prompt (components/auth/TwoStepPrompt), not a "Server Error".
 *
 * The route guards already send an un-enrolled person to the set-up screen
 * before a page loads (`/`, `$businessSlug`, `/onboarding`). This is for the
 * moment they cannot: a person already inside the app when two-step sign-in
 * became compulsory, whose queries and saves start being refused mid-screen.
 *
 * A prompt rather than a redirect, so the page they are on — a half-typed
 * note, the job they are driving to — is not thrown away under them; the
 * prompt's own header comment has the rest.
 *
 * Three ways the refusal arrives, and all three are listened for:
 *
 * - A save: the mutation cache's `onError`.
 * - A fetch: the query cache's `onError`, which only runs inside a fetch.
 * - A PUSH to a live query — the usual case, since every query on screen is
 *   re-run the moment the server starts refusing. @convex-dev/react-query
 *   delivers those with `setState`, which never reaches `onError`, so the
 *   cache's event stream is watched for an entry that has turned into this
 *   error. Only for entries something is showing: a guard's
 *   `ensureQueryData` has no observers, and redirects on its own.
 */
export function getContext() {
  const convexUrl = import.meta.env.VITE_CONVEX_URL
  if (!convexUrl) throw new Error('VITE_CONVEX_URL is not set')

  // The socket says nothing until this page load's sign-in is known, so no
  // query is ever answered as nobody while someone is signed in
  // (`holdForSignIn` in lib/convexClient.ts has how that happened, and why
  // it was "Not found"). An entry that has data keeps it when an error is
  // pushed onto it, but a null replaces it, and convex/react's own hooks
  // throw the error — the same reasons HandoverConvexClient never tells the
  // socket "nobody" mid-hand-over, and lib/tokenRefresh.ts not over a
  // refresh that failed for want of signal.
  //
  // Signed in, ConvexBetterAuthProvider's first `setAuth` lets the socket
  // go. Signed out, nothing would — convex/react only calls `setAuth` for
  // someone signed in — and `/join/$token` works signed out and asks for its
  // preview: holding with convex's own `expectAuth` once hung it on
  // "Checking your invitation…" for anyone not already signed in. So the
  // root route lets a signed-out page load go (`openSignedOut`, called from
  // __root.tsx). Only in the browser: the server renders with its own HTTP
  // client, and a held socket there would be opened for nothing.
  const convexQueryClient = new ConvexQueryClient(
    new HandoverConvexClient(convexUrl, {
      holdForSignIn: typeof window !== 'undefined',
      refreshRetry: browserRefreshRetry(() => authClient.getSession()),
    }),
  )

  const queryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.getObserversCount() > 0) flagIfTwoStepNeeded(error)
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => flagIfTwoStepNeeded(error),
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

  // Pushed refusals (see the top of this file). Only on the client: the
  // server renders a request at a time and has nobody to prompt.
  if (typeof window !== 'undefined') watchForTwoStepRefusals(queryClient)

  convexQueryClient.connect(queryClient)

  return { queryClient, convexQueryClient }
}
