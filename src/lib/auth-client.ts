import { createAuthClient } from 'better-auth/react'
import { twoFactorClient } from 'better-auth/client/plugins'
import { convexClient } from '@convex-dev/better-auth/client/plugins'

export const authClient = createAuthClient({
  plugins: [
    convexClient(),
    /**
     * No `twoFactorPage`, on purpose. Given one, the plugin answers a
     * password that needs a code with `window.location.href = …` — a full
     * page load in the middle of signing in, which on an iPhone home-screen
     * app flashes white and drops whatever the sign-in screen was holding.
     * Without it the plugin navigates nowhere, and the sign-in and join pages
     * read `twoFactorRedirect` off the result and show the code step in place.
     */
    twoFactorClient(),
  ],
})

/**
 * Whether a sign-in answered "now the code" rather than with a session. The
 * client's types do not model the plugin's extra response shape, so this
 * narrows it rather than casting at every call site.
 */
export function needsSecondStep(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { twoFactorRedirect?: unknown }).twoFactorRedirect === true
  )
}
