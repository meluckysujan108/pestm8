import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useRouteContext,
} from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react'
import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'
import { ServiceWorker } from '#/components/shell/ServiceWorker'
import { authClient } from '#/lib/auth-client'
import { getToken } from '#/lib/auth-server'
import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'
import type { ConvexQueryClient } from '@convex-dev/react-query'
import type { AuthClient } from '@convex-dev/better-auth/react'

interface RouterContext {
  queryClient: QueryClient
  convexQueryClient: ConvexQueryClient
}

const getAuth = createServerFn({ method: 'GET' }).handler(() => getToken())

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      { name: 'theme-color', content: '#FF3B30' },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { title: 'PestM8' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'apple-touch-icon', href: '/icon-192.png' },
    ],
  }),
  beforeLoad: async ({ context }) => {
    const token = await getAuth()
    if (token) {
      context.convexQueryClient.serverHttpClient?.setAuth(token)
    }
    return { isAuthenticated: !!token, token }
  },
  component: RootComponent,
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
})

/**
 * Also what a signed-in user sees for a tenant they are not a member of —
 * §6.5 requires that case be indistinguishable from a business that does not
 * exist, so this deliberately says nothing about which it was.
 */
function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6">
      <p className="section-label mb-2">PestM8</p>
      <h1 className="text-page-title text-ink">Not found</h1>
      <p className="mt-2 text-body text-muted">
        This page does not exist, or you do not have access to it.
      </p>
      <a href="/" className="mt-6 text-body text-blue">
        Back to your schedule
      </a>
    </main>
  )
}

function RootComponent() {
  const { convexQueryClient, token } = useRouteContext({ from: Route.id })

  // @convex-dev/better-auth 0.12.5 declares AuthClient as
  // createAuthClient<BetterAuthClientPlugin & { plugins }>, intersecting a
  // plugin's own shape with the options object. No normally-constructed client
  // satisfies it — $Infer collapses useSession().data to never. The runtime
  // shape is correct (this is the documented pattern), so the cast is confined
  // here. Recheck when the package moves past 0.12.5.
  const providerAuthClient = authClient as unknown as AuthClient

  return (
    <ConvexBetterAuthProvider
      client={convexQueryClient.convexClient}
      authClient={providerAuthClient}
      initialToken={token}
    >
      <Outlet />
    </ConvexBetterAuthProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <ServiceWorker />
        <TanStackDevtools
          config={{ position: 'bottom-right' }}
          plugins={[
            { name: 'Tanstack Router', render: <TanStackRouterDevtoolsPanel /> },
            TanStackQueryDevtools,
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
