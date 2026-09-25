/**
 * Which ONE Set-Cookie the auth proxy (src/routes/api/auth/$.ts) passes on.
 *
 * This build of TanStack Start / Nitro emits only one Set-Cookie header per
 * response, so the proxy has to choose, and "the last one that is not the
 * Convex JWT" stopped being the right choice the day two-step sign-in
 * arrived. Better Auth now writes several cookies per response and the one
 * that matters is not always last:
 *
 * - A correct code: the new session cookie is set, THEN the `two_factor`
 *   challenge cookie is cleared. "Last wins" kept the clearing and dropped
 *   the session, so a right code signed nobody in (convex/twoStepFlow.test.ts
 *   fails exactly that way under the old rule).
 * - A correct password on an account with two-step sign-in: the session
 *   cookie is cleared (the plugin deletes the session the password created)
 *   and the challenge cookie is set. The challenge is the one to keep —
 *   without it the code screen can only say the sign-in expired.
 * - Sign-out: the session cookie is cleared, then two others. "Last wins"
 *   kept one of the others, so the browser went on sending a dead session
 *   token; harmless, but not signed out.
 *
 * So the rule is by what each cookie ends up as, not by position: collapse
 * repeats of a name to their final write, then keep, in order,
 *
 * 1. a session cookie being SET — someone has just signed in;
 * 2. a `two_factor` challenge being set — a sign-in is half done;
 * 3. a session cookie being CLEARED — sign-out;
 * 4. otherwise the last cookie that is not the JWT, as before.
 *
 * A challenge cookie that is not cleared after a successful code (case 1
 * drops that write) is harmless: its server-side record was consumed by the
 * code, and it expires within ten minutes anyway.
 *
 * The Convex JWT cookie is never chosen: it is derivable from the session
 * (getToken mints one via /api/auth/convex/token) and only a cache.
 *
 * Names are matched with `includes`, because Better Auth prefixes every
 * cookie with `__Secure-` when `baseURL` is https — production — and not in
 * local dev.
 */
const JWT = 'better-auth.convex_jwt'
const SESSION = 'better-auth.session_token'
const CHALLENGE = 'better-auth.two_factor'

type Parsed = { raw: string; name: string; cleared: boolean }

function parse(raw: string): Parsed {
  const [pair = '', ...attributes] = raw.split(';')
  const eq = pair.indexOf('=')
  const name = (eq === -1 ? pair : pair.slice(0, eq)).trim()
  const value = eq === -1 ? '' : pair.slice(eq + 1).trim()
  const cleared =
    value === '' ||
    attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a)) ||
    attributes.some((a) => {
      const m = /^\s*expires\s*=(.*)$/i.exec(a)
      if (!m) return false
      const at = Date.parse(m[1].trim())
      return !Number.isNaN(at) && at <= Date.now()
    })
  return { raw, name, cleared }
}

export function pickAuthCookie(cookies: Array<string>): string | null {
  const durable = cookies.map(parse).filter((c) => !c.name.includes(JWT))
  if (durable.length === 0) return null

  // Final write per name.
  const finals = new Map<string, Parsed>()
  for (const cookie of durable) finals.set(cookie.name, cookie)
  const all = [...finals.values()]

  const find = (fragment: string, cleared: boolean) =>
    all.find((c) => c.name.includes(fragment) && c.cleared === cleared)

  return (
    find(SESSION, false)?.raw ??
    find(CHALLENGE, false)?.raw ??
    find(SESSION, true)?.raw ??
    // Unchanged behaviour for everything else: the last durable write.
    durable[durable.length - 1].raw
  )
}
