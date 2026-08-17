import { createFileRoute } from '@tanstack/react-router'
import { handler } from '#/lib/auth-server'

/**
 * This TanStack Start / Nitro build emits only the LAST Set-Cookie header on a
 * response — verified with a scratch route returning two cookies, where the
 * first vanished. Nothing to do with Convex.
 *
 * Convex sends two cookies on sign-in: better-auth.session_token and
 * better-auth.convex_jwt. Passing the response straight through meant the JWT
 * (sent second) clobbered the session cookie, so no session ever persisted —
 * get-session returned null right after a successful sign-in, and every
 * authenticated route bounced back to /login.
 *
 * The session cookie is the one worth keeping: getToken() mints a fresh Convex
 * JWT from it via /api/auth/convex/token, so the JWT is derivable from the
 * session while the reverse is not. The JWT cookie is only a cache, and only
 * when jwtCache is enabled (it is not here).
 *
 * Revisit if Start starts preserving repeated Set-Cookie headers — then both
 * can simply pass through.
 */
const JWT_COOKIE = 'better-auth.convex_jwt'

async function proxy(request: Request): Promise<Response> {
  const response = await handler(request)
  const cookies = response.headers.getSetCookie()

  if (cookies.length < 2) return response

  const durable = cookies.filter((c) => !c.startsWith(`${JWT_COOKIE}=`))
  if (durable.length === 0) return response

  const headers = new Headers()
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') headers.set(key, value)
  })
  // Only the last survives, so emit the session cookie alone rather than
  // letting the JWT overwrite it.
  headers.set('set-cookie', durable[durable.length - 1])

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => proxy(request),
      POST: ({ request }) => proxy(request),
    },
  },
})
