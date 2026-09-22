import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { ConvexProvider } from 'convex/react'
import { routeTree } from './routeTree.gen'
import { getContext } from './integrations/tanstack-query/root-provider'
import { PagePending } from './components/shell/Pending'

export function getRouter() {
  const context = getContext()

  const router = createTanStackRouter({
    routeTree,
    context,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    // Gives every route its own Suspense boundary. Without one, the root
    // Outlet's was the only boundary and its fallback is nothing, so any page
    // that suspended on its data blanked the header, sidebar and dock with it.
    defaultPendingComponent: PagePending,
    // Only for a navigation still unresolved this long (a cold route chunk,
    // a loader); from cache is a few frames and shows nothing.
    defaultPendingMs: 200,
    // No floor. These pages fetch their own data, so a route that showed
    // pending commits into a page that suspends straight into the same
    // placeholder — there is no flash to guard against — and the router
    // holding the commit for a minimum would only postpone the fetch the page
    // is about to start. That reasoning is for loader-less routes only: the
    // one route with a loader (reports/$reportId) opts out of pending, and a
    // route that gains a loader needs a floor or an opt-out of its own.
    defaultPendingMinMs: 0,
    Wrap: ({ children }) => (
      <ConvexProvider client={context.convexQueryClient.convexClient}>
        {children}
      </ConvexProvider>
    ),
  })

  setupRouterSsrQueryIntegration({ router, queryClient: context.queryClient })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
