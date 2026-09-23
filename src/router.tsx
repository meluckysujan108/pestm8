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
    // No floor. A route whose loader is still out shows this placeholder and
    // then commits straight into the page, with no second wait to flash past:
    // measured, the tabs' loaders answer in one Convex round (~430-670 ms
    // cold) or from cache (~10-25 ms warm), so they land either side of the
    // 200 ms above rather than just after it. A floor would only postpone the
    // commit — and for a page that fetches in render, the fetch with it.
    // Revisit if a loader ever settles reliably around 200-300 ms.
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
