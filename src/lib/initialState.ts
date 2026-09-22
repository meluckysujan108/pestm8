import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { getToken } from '#/lib/auth-server'
import { THEME_COOKIE, normaliseThemePref } from '#/lib/theme'

/**
 * Who is signed in, and the theme cookie riding along in the same round trip.
 *
 * On the server this answers the root route's `beforeLoad` for every request.
 * In the browser it is asked only while nobody is signed in, or when a cached
 * sign-in is in doubt — src/lib/rootState.ts answers every other navigation
 * without it. Its own module, not the root route's, because the business
 * layout asks it too, and route files are split into chunks of their own.
 */
export const getInitialState = createServerFn({ method: 'GET' }).handler(
  async () => ({
    token: await getToken(),
    theme: normaliseThemePref(getCookie(THEME_COOKIE)),
  }),
)
