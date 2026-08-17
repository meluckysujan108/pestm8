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
import { authClient } from '#/lib/auth-client'
import { getToken } from '#/lib/auth-server'
import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'
import type { ConvexQueryClient } from '@convex-dev/react-query'

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
      { title: 'PestM8' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
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
})

function RootComponent() {
  const { convexQueryClient, token } = useRouteContext({ from: Route.id })

  return (
    <ConvexBetterAuthProvider
      client={convexQueryClient.convexClient}
      authClient={authClient}
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
