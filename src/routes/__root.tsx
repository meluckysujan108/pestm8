import { useEffect, useRef } from 'react'
import {
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
  createRootRouteWithContext,
  useRouteContext,
  useRouter,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react'
import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'
import { NavProgress } from '#/components/shell/NavProgress'
import { ServiceWorker } from '#/components/shell/ServiceWorker'
import { TwoStepPromptHost } from '#/components/auth/TwoStepPrompt'
import { useHydrated } from '#/lib/useHydrated'
import { authClient } from '#/lib/auth-client'
import { openSignedOut } from '#/lib/convexClient'
import { getInitialState } from '#/lib/initialState'
import {
  forgetRootState,
  hasRootState,
  resolveRootState,
  seedRootState,
} from '#/lib/rootState'
import { themeInitScript } from '#/lib/theme'
import { useSystemThemeSync } from '#/lib/useTheme'
import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'
import type { ConvexQueryClient } from '@convex-dev/react-query'
import type { AuthClient } from '@convex-dev/better-auth/react'

interface RouterContext {
  queryClient: QueryClient
  convexQueryClient: ConvexQueryClient
}

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
    const { token, theme } =
      typeof window === 'undefined'
        ? await getInitialState()
        : await resolveRootState()
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
  const { convexQueryClient, token, theme } = useRouteContext({
    from: Route.id,
  })

  // Idempotent and outside React state, so safe during render: the first
  // client render is the only moment the SSR answer is to hand, because
  // hydration restores this context without running `beforeLoad`.
  seedRootState({ token, theme })

  // The socket says nothing until it knows who this page load is for
  // (`holdForSignIn` in lib/convexClient.ts). Signed in,
  // ConvexBetterAuthProvider below lets it go with the server render's token.
  // Signed out, nothing would, so this does. Decided by how the page loaded:
  // a sign-in or sign-out after that is the provider's to pass on.
  const loadedSignedOut = useRef(!token).current
  useEffect(() => {
    if (loadedSignedOut) openSignedOut(convexQueryClient.convexClient)
  }, [loadedSignedOut, convexQueryClient])

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

  // Nothing here outside <Outlet /> may suspend. This match has a Suspense
  // boundary of its own (it has a shellComponent), and its fallback would
  // replace ConvexBetterAuthProvider — signing the Convex client out.
  return (
    <ConvexBetterAuthProvider
      client={convexQueryClient.convexClient}
      authClient={providerAuthClient}
      initialToken={token}
    >
      <SessionWatch />
      <NavProgress />
      <Outlet />
    </ConvexBetterAuthProvider>
  )
}

/**
 * Ends the browser's cached sign-in (src/lib/rootState.ts) when the session
 * ends, by invalidating the router so the guards redirect as they did when
 * every navigation asked the server.
 *
 * Better Auth's session store is the signal. It hears a sign-out in this tab,
 * and one in another through its storage broadcast. It re-checks the server
 * only when the tab becomes visible or comes back online, though, so a phone
 * held in the foreground — or a desktop tab — would never notice an
 * offboarding or an expiry; hence the re-check below, at most once a minute
 * and only while the person is navigating, which is when they used to find
 * out.
 *
 * Signed out means the server said so: no session, or a 401. A failed request
 * keeps the last session and reports an error without a 401, and that is
 * someone in a backyard with no signal, not someone signed out.
 */
function SessionWatch() {
  const router = useRouter()
  const session = authClient.useSession()
  const signedOut =
    !session.isPending &&
    session.data == null &&
    (session.error == null || session.error.status === 401)

  useEffect(() => {
    if (!signedOut || !hasRootState()) return
    forgetRootState()
    void router.invalidate()
  }, [signedOut, router])

  const { refetch } = session
  useEffect(() => {
    let checkedAt = Date.now()
    return router.subscribe('onResolved', () => {
      if (!hasRootState() || Date.now() - checkedAt < 60_000) return
      checkedAt = Date.now()
      void refetch()
    })
  }, [router, refetch])

  return null
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
        <TwoStepPromptHost />
        <Devtools />
        <Scripts />
      </body>
    </html>
  )
}
