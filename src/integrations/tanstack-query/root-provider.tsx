import { QueryClient } from '@tanstack/react-query'
import { ConvexQueryClient } from '@convex-dev/react-query'

export function getContext() {
  const convexUrl = import.meta.env.VITE_CONVEX_URL
  if (!convexUrl) throw new Error('VITE_CONVEX_URL is not set')

  const convexQueryClient = new ConvexQueryClient(convexUrl, {
    expectAuth: true,
  })

  const queryClient = new QueryClient({
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
