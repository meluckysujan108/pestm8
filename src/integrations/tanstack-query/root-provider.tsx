import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { ConvexQueryClient } from '@convex-dev/react-query'
import { authClient } from '#/lib/auth-client'
import { HandoverConvexClient } from '#/lib/convexClient'
import { KEPT_FNS } from '#/lib/offline/keptSet'
import { watchLineDown } from '#/lib/offline/useLineDown'
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
  //
  // The token is refreshed a minute before it runs out rather than Convex's
  // default ten seconds, so a refresh that has to retry — one bar, a VPN
  // finding its feet — has had time to get through before the socket's token
  // lapses and the server stops answering it. Asking Better Auth whether
  // anyone is signed in gives up after ten seconds: the retry goes on either
  // way (lib/tokenRefresh.ts), and a request that never answers would only
  // hold a connection open.
  //
  // And in the browser it watches its own line (`watchSocket`): a socket that
  // died while the phone was on a call is given up within seconds of the app
  // coming back, rather than after the minute the Convex client waits
  // (lib/socketWatch.ts).
  const convexQueryClient = new ConvexQueryClient(
    new HandoverConvexClient(convexUrl, {
      holdForSignIn: typeof window !== 'undefined',
      // A page to watch from: not the server, nor a test with a `window` and
      // no `document`.
      watchSocket: typeof document !== 'undefined',
      authRefreshTokenLeewaySeconds: 60,
      refreshRetry: browserRefreshRetry(() =>
        authClient.getSession({ fetchOptions: { timeout: 10_000 } }),
      ),
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
      // A save runs the moment it is tapped, signal or not, so one that
      // checks `isOffline()` first (lib/online.ts) gets to say so.
      // React-query's default holds back any mutation started after the
      // browser has fired `offline`: the check never ran, the button said
      // "Saving…" for as long as the phone was out of range, and the save
      // went through by itself when the signal came back — a licence made
      // minutes later, after the person had given up on it.
      //
      // A save with no check of its own still waits for signal, in Convex's
      // queue instead of react-query's: the Convex client holds a mutation
      // or action asked for on a dropped socket, and sends it when the
      // socket is back. One that skips Convex (Better Auth's, over HTTP) now
      // fails at once instead, and FormAlert says the phone is offline. None
      // relied on react-query's queue: nothing here persists or resumes a
      // paused mutation.
      mutations: { networkMode: 'always' },
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

  // What New Job is made of: every client and site to pick from, the team
  // to assign, the job types. Kept for as long as the app is open, and live
  // all that time, so New Job opens at once on what the phone already has —
  // even while a line is being rebuilt after a phone call, which is exactly
  // when someone is booking the caller (25 Oct 2026). Dropped after fifteen
  // minutes, as everything else is, New Job waited on the network for the
  // whole client list again; the Schedule warming it did not reset that
  // clock.
  for (const name of [
    'clients:directory',
    'memberships:listForBusiness',
    'jobTypes:list',
  ]) {
    queryClient.setQueryDefaults(['convexQuery', name], { gcTime: Infinity })
  }

  // The queries this phone keeps a copy of (lib/offline/keptSet.ts) are
  // asked even when the phone says it has no signal. React-query's default
  // holds a fetch back, before its query function runs, from the moment the
  // browser fires `offline` until it fires `online`, and the kept copy can
  // only answer from inside the query function: a day opened after the
  // signal went would never be asked for. 'offlineFirst' calls it once and
  // holds back only the retries. Where nothing answers from the phone, the
  // call waits on the Convex socket instead, as the held fetch waited on
  // react-query, and ConnectionNotice counts it as waiting either way. Every
  // other query keeps the default.
  for (const name of KEPT_FNS) {
    const key = ['convexQuery', name]
    queryClient.setQueryDefaults(key, {
      // Merged with the pin above: a second default for the same key would
      // replace it.
      ...queryClient.getQueryDefaults(key),
      networkMode: 'offlineFirst',
    })
  }

  // Pushed refusals (see the top of this file). Only on the client: the
  // server renders a request at a time and has nobody to prompt.
  if (typeof window !== 'undefined') watchForTwoStepRefusals(queryClient)

  convexQueryClient.connect(queryClient)

  // Whether the line is down, for the words above a save that waits for it
  // (lib/offline/useLineDown.ts). From now, so a socket that dies before New
  // Job opens has had its time counted by then. A page to watch from only.
  if (typeof document !== 'undefined') {
    watchLineDown(convexQueryClient.convexClient)
  }

  return { queryClient, convexQueryClient }
}
