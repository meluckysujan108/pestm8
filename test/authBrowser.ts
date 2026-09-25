import { passesOn, pickAuthCookie } from '../src/lib/authCookies'

/**
 * A browser and an authenticator app, as much of each as driving Better
 * Auth's two-step endpoints over HTTP needs — shared by the convex-test flow
 * tests (convex/twoStepFlow.test.ts, convex/twoStepRateLimit.test.ts) and any
 * Playwright spec that signs someone in with a code, so the two can never
 * disagree about what a code is or which cookie survives the auth proxy.
 *
 * Why shared rather than copied: a TOTP helper that is subtly wrong (the
 * counter's byte order, a base32 padding slip) makes every code "not match",
 * which is exactly the production bug the set-up screen was fixed for — and
 * a copy that drifted would have a test suite blaming the server for its own
 * arithmetic. One copy, checked against the real endpoints by the flow tests.
 *
 * Plain TypeScript on purpose, so either runner can import it:
 *
 * - no `#/` imports — Playwright's loader does not read the app's path
 *   aliases, and this is run outside Vite;
 * - nothing from vitest, convex-test or Playwright — the caller hands in its
 *   own `fetch`, and asserts with its own `expect`;
 * - only Web APIs both runtimes have (fetch's Response, `crypto.subtle`,
 *   `Headers.getSetCookie`).
 *
 * From vitest, requests go straight into the test deployment:
 *
 *     new AuthBrowser((path, init) => t.fetch(`/api/auth${path}`, init))
 *
 * From Playwright, through the app's real proxy, with `direct` reaching the
 * Convex site for what server rendering does behind it:
 *
 *     new AuthBrowser(
 *       (path, init) => fetch(`${SITE_URL}/api/auth${path}`, init),
 *       { origin: SITE_URL, direct: (path, init) =>
 *           fetch(`${CONVEX_SITE_URL}/api/auth${path}`, init) },
 *     )
 */

/** Sends one request to the auth routes; `path` is under `/api/auth`. */
export type AuthFetch = (path: string, init: RequestInit) => Promise<Response>

/**
 * A browser's cookie jar, as much of one as these endpoints need — behind the
 * app's auth proxy, which passes on ONE Set-Cookie per response
 * (src/routes/api/auth/$.ts), and none that clears the session in answer to
 * a read (`passesOn`). Applying only the cookie the proxy would pass on is
 * the point: two-step sign-in writes several per response, and the flow
 * has to work with the one that gets through. Through the real proxy (a
 * Playwright spec) the choice has already been made, and making it again
 * over one cookie changes nothing.
 */
export class AuthBrowser {
  /** Every Set-Cookie the last response carried, before the proxy chose. */
  sent: Array<string> = []
  private jar = new Map<string, string>()
  private send: AuthFetch
  private direct: AuthFetch
  private origin: string

  constructor(
    send: AuthFetch,
    options: { origin?: string; direct?: AuthFetch } = {},
  ) {
    this.send = send
    this.direct = options.direct ?? send
    // What the vitest config sets SITE_URL to, which Better Auth checks the
    // Origin against. A Playwright spec passes its own site.
    this.origin = options.origin ?? 'http://localhost:3000'
  }

  async post(path: string, body: unknown, headers?: Record<string, string>) {
    return this.request('POST', path, body, headers)
  }

  /**
   * `stale` sends the Cookie header the browser held earlier instead of the
   * jar's: a request that went out before an answer since then changed the
   * cookie, and whose own answer lands after it — as a page's background
   * reads do while a code is being checked.
   */
  async get(path: string, options: { stale?: string } = {}) {
    return this.request('GET', path, undefined, undefined, options.stale)
  }

  /** Straight to Convex with this browser's cookies, as server rendering's
   * token fetch does — no proxy, so nothing lands in the jar. */
  async serverSide(path: string) {
    const response = await this.direct(path, {
      method: 'GET',
      headers: { origin: this.origin, cookie: this.cookieHeader() },
    })
    return response.headers.getSetCookie()
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    cookie = this.cookieHeader(),
  ) {
    const response = await this.send(path, {
      method,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...headers,
        origin: this.origin,
        cookie,
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    })
    this.sent = response.headers.getSetCookie()
    const kept = pickAuthCookie(this.sent)
    const applied = kept !== null && passesOn(method, kept) ? [kept] : []
    for (const line of applied) {
      const [pair, ...attributes] = line.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const expired =
        value === '' || attributes.some((a) => /^\s*max-age=0\s*$/i.test(a))
      if (expired) this.jar.delete(name)
      else this.jar.set(name, value)
    }
    const text = await response.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    return { status: response.status, json: json as Record<string, unknown> }
  }

  has(fragment: string) {
    return [...this.jar.keys()].some((k) => k.includes(fragment))
  }

  /** A cookie's value as the jar holds it (still URL-encoded). */
  value(fragment: string): string | undefined {
    for (const [k, v] of this.jar) if (k.includes(fragment)) return v
    return undefined
  }

  /** The jar as a `Cookie` header — also how a Playwright spec would hand
   * this sign-in to a page (`context.addCookies`). */
  cookieHeader() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

/** The raw secret an otpauth:// URI carries, still base32. */
export function secretOf(uri: string): string | null {
  return new URL(uri).searchParams.get('secret')
}

/** RFC 4648 base32, for the secret in an otpauth:// URI. */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = input.replace(/=+$/, '').toUpperCase()
  const bytes: Array<number> = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    value = (value << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(bytes)
}

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — what an authenticator app shows for
 * this otpauth:// URI at `at` (ms since epoch; now by default).
 */
export async function totp(uri: string, at = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secretOf(uri) ?? ''),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const counter = Math.floor(at / 1000 / 30)
  const message = new ArrayBuffer(8)
  new DataView(message).setUint32(4, counter)
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  const offset = hmac[hmac.length - 1] & 0x0f
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3]) %
    1_000_000
  return String(code).padStart(6, '0')
}
