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
      },
    },
  })

  convexQueryClient.connect(queryClient)

  return { queryClient, convexQueryClient }
}
