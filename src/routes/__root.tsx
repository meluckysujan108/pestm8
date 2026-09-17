import {
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
  createRootRouteWithContext,
  useRouteContext,
} from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react'
import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'
import { ServiceWorker } from '#/components/shell/ServiceWorker'
import { useHydrated } from '#/lib/useHydrated'
import { authClient } from '#/lib/auth-client'
import { getToken } from '#/lib/auth-server'
import { THEME_COOKIE, normaliseThemePref, themeInitScript } from '#/lib/theme'
import { useSystemThemeSync } from '#/lib/useTheme'
import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'
import type { ConvexQueryClient } from '@convex-dev/react-query'
import type { AuthClient } from '@convex-dev/better-auth/react'

interface RouterContext {
  queryClient: QueryClient
  convexQueryClient: ConvexQueryClient
}

// One round trip, not two: `beforeLoad` already pays for this on every client
// navigation, so the theme cookie rides along with the token.
const getInitialState = createServerFn({ method: 'GET' }).handler(async () => ({
  token: await getToken(),
  theme: normaliseThemePref(getCookie(THEME_COOKIE)),
}))

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
    const { token, theme } = await getInitialState()
    if (token) {
      context.convexQueryClient.serverHttpClient?.setAuth(token)
    }
    // `theme` seeds React state only. The attribute on <html> belongs to
    // themeInitScript alone — see src/lib/theme.ts for why.
    return { isAuthenticated: !!token, token, theme }
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

  // Mounted once, at the root: while the preference is `system`, this is what
  // makes the app follow a phone that flips to dark at sunset.
  useSystemThemeSync()

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

/**
 * The devtools launcher is a fixed overlay pinned to a screen corner, so it
 * necessarily sits on top of whatever the app puts there — the mobile dock's
 * last tab at one corner, a settings toggle at another. A person can drag or
 * dismiss it; an automated click just lands on the launcher and the test times
 * out somewhere unrelated to what it was testing. So it is not rendered under
 * automation, which `navigator.webdriver` reports.
 *
 * Gated on hydration as well because `navigator` does not exist server-side,
 * and rendering it on the server then removing it on the client is a mismatch.
 */
function Devtools() {
  const hydrated = useHydrated()
  if (!hydrated || navigator.webdriver) return null

  return (
    <TanStackDevtools
      config={{ position: 'bottom-right' }}
      plugins={[
        {
          name: 'Tanstack Router',
          render: <TanStackRouterDevtoolsPanel />,
        },
        TanStackQueryDevtools,
      ]}
    />
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // ScriptOnce sets data-theme and data-theme-pref while the head is being
    // parsed, so the first paint is already the right theme. React renders no
    // theme attribute of its own, which leaves reconciliation nothing to
    // clobber later; suppressHydrationWarning covers the two attributes React
    // did not put there. It renders server-side only and removes its own node,
    // so the client's empty head matches.
    <html lang="en-AU" suppressHydrationWarning>
      <head>
        <ScriptOnce>{themeInitScript}</ScriptOnce>
        <HeadContent />
      </head>
      <body>
        {children}
        <ServiceWorker />
        <Devtools />
        <Scripts />
      </body>
    </html>
  )
}
