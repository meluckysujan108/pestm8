import { createFileRoute } from '@tanstack/react-router'
import { handler } from '#/lib/auth-server'

/**
 * This TanStack Start / Nitro build emits only the LAST Set-Cookie header on a
 * response — verified with a scratch route returning two cookies, where the
 * first vanished. Nothing to do with Convex.
 *
 * Convex sends two cookies on sign-in: (__Secure-)better-auth.session_token
 * and (__Secure-)better-auth.convex_jwt. Passing the response straight
 * through meant the JWT (sent second) clobbered the session cookie, so no
 * session ever persisted — get-session returned null right after a
 * successful sign-in, and every authenticated route bounced back to /login.
 *
 * The session cookie is the one worth keeping: getToken() mints a fresh Convex
 * JWT from it via /api/auth/convex/token, so the JWT is derivable from the
 * session while the reverse is not. The JWT cookie is only a cache, and only
 * when jwtCache is enabled (it is not here).
 *
 * The `__Secure-` prefix matters: Better Auth only adds it when `baseURL` is
 * HTTPS, so local dev's cookies are named plainly (`better-auth.convex_jwt`)
 * while a real deployment's are prefixed (`__Secure-better-auth.convex_jwt`).
 * Matching with `startsWith(JWT_COOKIE)` only ever caught the unprefixed dev
 * form — in production neither cookie matched the JWT check, so *both* were
 * kept as "durable" and the last one (still the JWT, since Convex sends it
 * second) won anyway. Exactly the bug this function exists to prevent, just
 * surviving one dev/prod difference further than the fix originally covered.
 * `includes()` matches the cookie name regardless of a `__Secure-` prefix.
 *
 * Revisit if Start starts preserving repeated Set-Cookie headers — then both
 * can simply pass through.
 */
const JWT_COOKIE = 'better-auth.convex_jwt'

async function proxy(request: Request): Promise<Response> {
  const response = await handler(request)
  const cookies = response.headers.getSetCookie()

  if (cookies.length === 0) return response

  const durable = cookies.filter((c) => !c.includes(`${JWT_COOKIE}=`))
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
