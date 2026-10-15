import { vi } from 'vitest'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import type { TestApp, TestAs } from './harness'

/**
 * Xero, faked: its sign-in (identity.xero.com) and the few API calls Release 1
 * makes (api.xero.com), with `fetch` stubbed and the env set as a configured
 * deployment would have it. Modelled on `fakeResend`
 * (convex/emailCopySend.test.ts) and `fakeNetwork` (convex/weather.test.ts).
 *
 * It keeps a small model of Xero rather than canned answers, because the
 * things worth testing are Xero's rules, not its JSON:
 *
 * - A token set belongs to a Xero USER, reaches every organisation that user
 *   connected, and a new consent supersedes the last (old refresh tokens die).
 * - Refresh tokens rotate on every use; the one just replaced keeps working
 *   for 30 minutes, as Xero's does.
 * - A connection is one (Xero user, organisation) pair with its own id, which
 *   is what `DELETE /connections/{id}` takes. Re-consenting to an organisation
 *   keeps the id and stamps a new auth event.
 * - Revoking a refresh token removes every connection that user had.
 * - Access tokens are JWTs whose payload carries `xero_userid` and
 *   `authentication_event_id`, unsigned (the app never checks the signature:
 *   it got them from Xero's token endpoint over TLS).
 *
 * Every request is recorded with its headers and body, so a test can assert
 * exactly what was sent — and, as importantly, that nothing else was.
 * Anything it does not model answers 500, loudly.
 */

export const XERO_TEST_CLIENT_ID = 'TEST0CLIENT0ID0000000000000000000'
export const XERO_TEST_CLIENT_SECRET = 'test-client-secret-never-real'
/** 32 bytes (1, 2 … 32), base64: the token key every test encrypts with. */
export const XERO_TEST_KEY = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA='
export const XERO_TEST_KEYS = `1:${XERO_TEST_KEY}`
/** The Convex site origin in tests, so the redirect URI is a real one. */
export const TEST_CONVEX_SITE = 'https://coastal-test.convex.site'
export const TEST_REDIRECT_URI = `${TEST_CONVEX_SITE}/xero/callback`
/** `SITE_URL` from vitest.config.ts, where the callback sends the browser. */
export const TEST_SITE_URL = 'http://localhost:3000'

/** What Release 1 asks Xero for, spelled out rather than imported, so a
 * change to the scopes has to change a test too. */
export const EXPECTED_SCOPES =
  'offline_access openid profile email accounting.contacts accounting.settings.read'

const ACCESS_TTL_S = 30 * 60
const CODE_TTL_MS = 5 * 60 * 1000
/** How long Xero honours a refresh token after it has been rotated. */
const ROTATION_GRACE_MS = 30 * 60 * 1000

export type TenantType = 'ORGANISATION' | 'PRACTICE'

type Tenant = {
  tenantId: string
  name: string
  shortCode: string
  type: TenantType
}

type Connection = {
  id: string
  xeroUserId: string
  tenantId: string
  authEventId: string
  createdDateUtc: string
  updatedDateUtc: string
}

type IssuedCode = {
  xeroUserId: string
  authEventId: string
  expiresAt: number
  used: boolean
}

type IssuedAccess = {
  xeroUserId: string
  expiresAt: number
  revoked: boolean
}

type IssuedRefresh = {
  xeroUserId: string
  /** Infinity while it is the current one. */
  validUntil: number
}

export type XeroRequest = {
  /** When it arrived, by the (possibly fake) clock. */
  at: number
  method: string
  url: string
  host: string
  path: string
  query: URLSearchParams
  /** Lower-cased names, as `Headers` gives them. */
  headers: Record<string, string | undefined>
  body: string
  /** The body parsed as a form, for the identity endpoints. */
  form: Record<string, string | undefined>
}

export type FakeXeroOptions = {
  /** `false`: the deployment is not set up for Xero (no client id, secret or
   * key). `fetch` is still stubbed, so a test can prove nothing was called. */
  configured?: boolean
}

export type FakeXero = ReturnType<typeof makeFake>

/** The fake the current test made; `connectVia` drives it. */
let active: FakeXero | null = null

/**
 * Stubs the Xero env and `fetch`, and returns the fake. Undo with
 * `vi.unstubAllEnvs()` and `vi.unstubAllGlobals()` in `afterEach`.
 */
export function fakeXero(opts: FakeXeroOptions = {}): FakeXero {
  const configured = opts.configured ?? true
  vi.stubEnv('XERO_CLIENT_ID', configured ? XERO_TEST_CLIENT_ID : '')
  vi.stubEnv('XERO_CLIENT_SECRET', configured ? XERO_TEST_CLIENT_SECRET : '')
  vi.stubEnv('XERO_TOKEN_KEYS', configured ? XERO_TEST_KEYS : '')
  vi.stubEnv('CONVEX_SITE_URL', TEST_CONVEX_SITE)
  // Each test says what it wants of these, or gets the defaults.
  vi.stubEnv('XERO_REDIRECT_URI', '')
  vi.stubEnv('XERO_MAX_ORGS', '')
  vi.stubEnv('XERO_SYNC_PAUSED', '')

  const fake = makeFake()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      fake.handle(new Request(input, init)),
    ),
  )
  active = fake
  return fake
}

function makeFake() {
  const requests: Array<XeroRequest> = []
  const tenants = new Map<string, Tenant>()
  const connections = new Map<string, Connection>()
  const codes = new Map<string, IssuedCode>()
  const accessTokens = new Map<string, IssuedAccess>()
  const refreshTokens = new Map<string, IssuedRefresh>()
  const idTokens = new Set<string>()
  /** Who each successful refresh was for, in order. */
  const refreshed: Array<{ xeroUserId: string }> = []
  const revoked: Array<{ xeroUserId: string | null }> = []
  const deleted: Array<{ id: string; xeroUserId: string; tenantId: string }> =
    []

  const knobs = {
    /** Xero answers every refresh with this: `invalid_grant` (400, the
     * token is dead) or `server` (503). */
    failRefresh: null as null | 'invalid_grant' | 'server',
    /** The next consents are to an accounting PRACTICE, not an
     * organisation — what an accountant's own login can pick. */
    practiceOnly: false,
    /** `GET /connections?authEventId=` answers `[]`, as Xero sometimes does
     * straight after a consent. Unfiltered still lists everything. */
    emptyAuthEvent: false,
    /** Re-consenting to an organisation this user already connected leaves
     * its connection as it was: no new auth event, no new date. Whether real
     * Xero does is unproven; the callback must not guess either way. */
    reconsentKeepsEvent: false,
    /** `DELETE /connections/{id}` answers this: `server` (503, no
     * Retry-After) or `forbidden` (403 AuthorizationUnsuccessful). */
    failDelete: null as null | 'server' | 'forbidden',
    /** The revocation endpoint answers 503. */
    failRevoke: false,
  }

  let seq = 0
  let lastStamp = 0
  /** Xero's clock as an ISO string, strictly increasing even under fake
   * timers, so "most recently updated" always has one answer. */
  const stamp = () => {
    lastStamp = Math.max(Date.now(), lastStamp + 1)
    return new Date(lastStamp).toISOString()
  }
  const opaque = (prefix: string) => {
    const bytes = new Uint8Array(24)
    crypto.getRandomValues(bytes)
    return `${prefix}${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
  }
  const uuid = () => crypto.randomUUID()

  /** Holding refreshes: every refresh waits on this until released — on
   * arrival, or with Xero's answer already made and on its way back. */
  let hold: {
    at: 'arrival' | 'answer'
    release: () => void
    released: Promise<void>
    arrive: () => void
  } | null = null

  function tenant(t: {
    tenantId: string
    name?: string
    shortCode?: string
    type?: TenantType
  }): Tenant {
    const existing = tenants.get(t.tenantId)
    const next: Tenant = {
      tenantId: t.tenantId,
      name: t.name ?? existing?.name ?? `${t.tenantId} Pty Ltd`,
      shortCode:
        t.shortCode ?? existing?.shortCode ?? `!${t.tenantId.slice(-5)}`,
      type: t.type ?? existing?.type ?? 'ORGANISATION',
    }
    tenants.set(t.tenantId, next)
    return next
  }

  /**
   * The person signs in to Xero as `xeroUserId` and ticks `tenantId` (or
   * several). Returns the authorisation code Xero would put on the callback.
   */
  function consent(c: {
    xeroUserId: string
    tenantId: string | Array<string>
  }): string {
    const authEventId = uuid()
    const ids = Array.isArray(c.tenantId) ? c.tenantId : [c.tenantId]
    for (const tenantId of ids) {
      tenant({
        tenantId,
        ...(knobs.practiceOnly ? { type: 'PRACTICE' as const } : {}),
      })
      const existing = [...connections.values()].find(
        (row) => row.xeroUserId === c.xeroUserId && row.tenantId === tenantId,
      )
      if (existing) {
        if (!knobs.reconsentKeepsEvent) {
          existing.authEventId = authEventId
          existing.updatedDateUtc = stamp()
        }
      } else {
        const at = stamp()
        const row: Connection = {
          id: uuid(),
          xeroUserId: c.xeroUserId,
          tenantId,
          authEventId,
          createdDateUtc: at,
          updatedDateUtc: at,
        }
        connections.set(row.id, row)
      }
    }
    const code = opaque('code-')
    codes.set(code, {
      xeroUserId: c.xeroUserId,
      authEventId,
      expiresAt: Date.now() + CODE_TTL_MS,
      used: false,
    })
    return code
  }

  // ───────────────────────────────────────────────────────────── responses

  const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })

  const b64url = (text: string) => {
    let binary = ''
    for (const byte of new TextEncoder().encode(text)) {
      binary += String.fromCharCode(byte)
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }
  const jwt = (payload: Record<string, unknown>) =>
    [
      b64url(JSON.stringify({ alg: 'RS256', kid: 'fake-xero', typ: 'JWT' })),
      b64url(JSON.stringify(payload)),
      b64url(opaque('signature-')),
    ].join('.')

  function issue(
    xeroUserId: string,
    authEventId: string,
    withIdToken: boolean,
  ) {
    seq += 1
    const now = Date.now()
    const nowS = Math.floor(now / 1000)
    const accessToken = jwt({
      nbf: nowS,
      exp: nowS + ACCESS_TTL_S,
      iss: 'https://identity.xero.com',
      aud: 'https://identity.xero.com/resources',
      client_id: XERO_TEST_CLIENT_ID,
      sub: `sub-${xeroUserId}`,
      auth_time: nowS,
      xero_userid: xeroUserId,
      global_session_id: uuid(),
      jti: `jti-${seq}`,
      authentication_event_id: authEventId,
      scope: EXPECTED_SCOPES.split(' '),
    })
    accessTokens.set(accessToken, {
      xeroUserId,
      expiresAt: now + ACCESS_TTL_S * 1000,
      revoked: false,
    })
    const refreshToken = opaque('rt-')
    refreshTokens.set(refreshToken, { xeroUserId, validUntil: Infinity })
    const body: Record<string, unknown> = {
      access_token: accessToken,
      expires_in: ACCESS_TTL_S,
      token_type: 'Bearer',
      refresh_token: refreshToken,
      scope: EXPECTED_SCOPES,
    }
    if (withIdToken) {
      const idToken = jwt({
        sub: `sub-${xeroUserId}`,
        xero_userid: xeroUserId,
        email: `${xeroUserId}@xero.test`,
        given_name: 'Test',
        family_name: xeroUserId,
      })
      idTokens.add(idToken)
      body.id_token = idToken
    }
    return body
  }

  /** Every refresh token of this user stops working now. */
  function killRefreshTokensOf(xeroUserId: string) {
    for (const row of refreshTokens.values()) {
      if (row.xeroUserId === xeroUserId) row.validUntil = 0
    }
  }

  const basicOk = (headers: Record<string, string | undefined>) =>
    headers.authorization ===
    `Basic ${btoa(`${XERO_TEST_CLIENT_ID}:${XERO_TEST_CLIENT_SECRET}`)}`

  async function token(r: XeroRequest): Promise<Response> {
    if (!basicOk(r.headers)) return json({ error: 'invalid_client' }, 401)
    const grantType = r.form.grant_type

    if (grantType === 'authorization_code') {
      const issued = codes.get(r.form.code ?? '')
      if (
        !issued ||
        issued.used ||
        issued.expiresAt <= Date.now() ||
        r.form.redirect_uri !== TEST_REDIRECT_URI
      ) {
        return json({ error: 'invalid_grant' }, 400)
      }
      issued.used = true
      // A new consent supersedes the set before it, whatever was ticked.
      killRefreshTokensOf(issued.xeroUserId)
      return json(issue(issued.xeroUserId, issued.authEventId, true))
    }

    if (grantType === 'refresh_token') {
      if (hold?.at === 'arrival') {
        hold.arrive()
        await hold.released
      }
      const answer = refresh(r)
      if (hold?.at === 'answer') {
        hold.arrive()
        await hold.released
      }
      return answer
    }

    return json({ error: 'unsupported_grant_type' }, 400)
  }

  function refresh(r: XeroRequest): Response {
    if (knobs.failRefresh === 'invalid_grant') {
      return json({ error: 'invalid_grant' }, 400)
    }
    if (knobs.failRefresh === 'server') {
      return new Response('Service Unavailable', { status: 503 })
    }
    const presented = refreshTokens.get(r.form.refresh_token ?? '')
    if (!presented || presented.validUntil <= Date.now()) {
      return json({ error: 'invalid_grant' }, 400)
    }
    presented.validUntil = Math.min(
      presented.validUntil,
      Date.now() + ROTATION_GRACE_MS,
    )
    for (const [key, row] of refreshTokens) {
      if (
        key !== r.form.refresh_token &&
        row.xeroUserId === presented.xeroUserId &&
        row.validUntil === Infinity
      ) {
        row.validUntil = Date.now() + ROTATION_GRACE_MS
      }
    }
    refreshed.push({ xeroUserId: presented.xeroUserId })
    const latest = [...connections.values()]
      .filter((row) => row.xeroUserId === presented.xeroUserId)
      .map((row) => row.authEventId)
    return json(issue(presented.xeroUserId, latest[0] ?? uuid(), false))
  }

  function revoke(r: XeroRequest): Response {
    if (!basicOk(r.headers)) return json({ error: 'invalid_client' }, 401)
    if (knobs.failRevoke) {
      return new Response('Service Unavailable', { status: 503 })
    }
    const presented = refreshTokens.get(r.form.token ?? '')
    // RFC 7009: an unknown token is still a 200.
    revoked.push({ xeroUserId: presented?.xeroUserId ?? null })
    if (presented) {
      const who = presented.xeroUserId
      killRefreshTokensOf(who)
      for (const row of accessTokens.values()) {
        if (row.xeroUserId === who) row.revoked = true
      }
      // Revoking removes every connection that user had, in one go.
      for (const [id, row] of connections) {
        if (row.xeroUserId === who) connections.delete(id)
      }
    }
    return new Response(null, { status: 200 })
  }

  function bearer(r: XeroRequest): IssuedAccess | null {
    const match = /^Bearer (.+)$/.exec(r.headers.authorization ?? '')
    const access = match ? accessTokens.get(match[1]) : undefined
    if (!access || access.revoked || access.expiresAt <= Date.now()) return null
    return access
  }

  const unauthorised = () =>
    json(
      {
        Type: null,
        Title: 'Unauthorized',
        Status: 401,
        Detail: 'TokenExpired: token expired',
      },
      401,
      { 'www-authenticate': 'Bearer error="invalid_token"' },
    )

  const shape = (row: Connection) => {
    const t = tenants.get(row.tenantId)!
    return {
      id: row.id,
      authEventId: row.authEventId,
      tenantId: row.tenantId,
      tenantType: t.type,
      tenantName: t.name,
      createdDateUtc: row.createdDateUtc,
      updatedDateUtc: row.updatedDateUtc,
    }
  }

  function listConnections(r: XeroRequest): Response {
    const access = bearer(r)
    if (!access) return unauthorised()
    const authEventId = r.query.get('authEventId')
    if (authEventId && knobs.emptyAuthEvent) return json([])
    return json(
      [...connections.values()]
        .filter((row) => row.xeroUserId === access.xeroUserId)
        .filter((row) => !authEventId || row.authEventId === authEventId)
        .map(shape),
    )
  }

  function deleteConnection(r: XeroRequest, id: string): Response {
    const access = bearer(r)
    if (!access) return unauthorised()
    if (knobs.failDelete === 'server') {
      return new Response('Service Unavailable', { status: 503 })
    }
    if (knobs.failDelete === 'forbidden') {
      return json(
        {
          Type: null,
          Title: 'Forbidden',
          Status: 403,
          Detail: 'AuthorizationUnsuccessful',
        },
        403,
      )
    }
    const row = connections.get(id)
    if (!row || row.xeroUserId !== access.xeroUserId) {
      return json({ Title: 'Not Found', Status: 404 }, 404)
    }
    connections.delete(id)
    deleted.push({ id, xeroUserId: row.xeroUserId, tenantId: row.tenantId })
    return new Response(null, { status: 204 })
  }

  function organisation(r: XeroRequest): Response {
    const access = bearer(r)
    if (!access) return unauthorised()
    const tenantId = r.headers['xero-tenant-id'] ?? ''
    const connected = [...connections.values()].some(
      (row) =>
        row.xeroUserId === access.xeroUserId && row.tenantId === tenantId,
    )
    if (!connected) {
      return json(
        {
          Type: null,
          Title: 'Forbidden',
          Status: 403,
          Detail: 'AuthorizationUnsuccessful',
        },
        403,
      )
    }
    const t = tenants.get(tenantId)!
    // Xero answers XML unless asked otherwise, which no JSON.parse survives.
    if (r.headers.accept !== 'application/json') {
      return new Response(
        `<Response><Organisations><Organisation><Name>${t.name}</Name></Organisation></Organisations></Response>`,
        {
          status: 200,
          headers: { 'content-type': 'text/xml' },
        },
      )
    }
    return json({
      Id: uuid(),
      Status: 'OK',
      ProviderName: 'PestM8',
      DateTimeUTC: `/Date(${Date.now()})/`,
      Organisations: [
        {
          OrganisationID: t.tenantId,
          Name: t.name,
          LegalName: t.name,
          ShortCode: t.shortCode,
          Version: 'AU',
          OrganisationType: 'COMPANY',
          BaseCurrency: 'AUD',
          CountryCode: 'AU',
        },
      ],
    })
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? ''
        : await request.text()
    const r: XeroRequest = {
      at: Date.now(),
      method: request.method,
      url: url.href,
      host: url.host,
      path: url.pathname,
      query: url.searchParams,
      headers: Object.fromEntries(request.headers.entries()),
      body,
      form: (request.headers.get('content-type') ?? '').includes(
        'application/x-www-form-urlencoded',
      )
        ? Object.fromEntries(new URLSearchParams(body))
        : {},
    }
    requests.push(r)

    if (url.host === 'identity.xero.com' && r.method === 'POST') {
      if (r.path === '/connect/token') return token(r)
      if (r.path === '/connect/revocation') return revoke(r)
    }
    if (url.host === 'api.xero.com') {
      if (r.path === '/connections' && r.method === 'GET') {
        return listConnections(r)
      }
      const one = /^\/connections\/([^/]+)$/.exec(r.path)
      if (one && r.method === 'DELETE') return deleteConnection(r, one[1])
      if (r.path === '/api.xro/2.0/Organisation' && r.method === 'GET') {
        return organisation(r)
      }
    }
    return new Response(`not faked: ${r.method} ${url.origin}${url.pathname}`, {
      status: 500,
    })
  }

  // ───────────────────────────────────────────────────────────── reading it

  const where = (host: string, path: string | RegExp, method?: string) =>
    requests.filter(
      (r) =>
        r.host === host &&
        (typeof path === 'string' ? r.path === path : path.test(r.path)) &&
        (!method || r.method === method),
    )

  return {
    handle,
    knobs,
    /** Every request, in order. */
    requests,
    tenant,
    consent,
    /** Xero's id for the connection between this user and organisation. */
    connectionIdOf(xeroUserId: string, tenantId: string): string | null {
      return (
        [...connections.values()].find(
          (row) => row.xeroUserId === xeroUserId && row.tenantId === tenantId,
        )?.id ?? null
      )
    },
    /** The person removes PestM8 from one organisation in Xero → Settings →
     * Connected apps: that connection is gone, the sign-in itself is not. */
    removeInXero(xeroUserId: string, tenantId: string): void {
      for (const [id, row] of connections) {
        if (row.xeroUserId === xeroUserId && row.tenantId === tenantId) {
          connections.delete(id)
        }
      }
    },
    /** The organisations this user is still connected to, at Xero. */
    connectedAtXero(xeroUserId: string): Array<string> {
      return [...connections.values()]
        .filter((row) => row.xeroUserId === xeroUserId)
        .map((row) => row.tenantId)
    },
    /** Code exchanges (consents turned into tokens), successful or not. */
    exchanges: () =>
      where('identity.xero.com', '/connect/token', 'POST').filter(
        (r) => r.form.grant_type === 'authorization_code',
      ),
    /** Refresh REQUESTS, whatever Xero said. */
    refreshRequests: () =>
      where('identity.xero.com', '/connect/token', 'POST').filter(
        (r) => r.form.grant_type === 'refresh_token',
      ),
    /** Refreshes Xero granted, and whose. */
    refreshed,
    revocations: () =>
      where('identity.xero.com', '/connect/revocation', 'POST'),
    /** Who each revocation was for (null: a token Xero did not know). */
    revoked,
    connectionLists: () => where('api.xero.com', '/connections', 'GET'),
    deleteRequests: () => where('api.xero.com', /^\/connections\/.+/, 'DELETE'),
    /** Connections Xero actually removed on a DELETE. */
    deleted,
    organisationReads: () =>
      where('api.xero.com', '/api.xro/2.0/Organisation', 'GET'),
    /** Requests that hit nothing this fake models. */
    unmodelled: () =>
      requests.filter(
        (r) =>
          !(
            (r.host === 'identity.xero.com' &&
              ['/connect/token', '/connect/revocation'].includes(r.path)) ||
            (r.host === 'api.xero.com' &&
              (r.path === '/connections' ||
                r.path.startsWith('/connections/') ||
                r.path === '/api.xro/2.0/Organisation'))
          ),
      ),
    /** Every secret Xero handed out: codes, access, refresh and id tokens.
     * None of them may ever be readable in the database. */
    secrets(): Array<string> {
      return [
        ...codes.keys(),
        ...accessTokens.keys(),
        ...refreshTokens.keys(),
        ...idTokens,
      ]
    },
    /**
     * Makes every refresh wait until `release()`. `arrived` resolves once the
     * first one is waiting — the moment its caller holds the refresh lease.
     * `at: 'answer'` holds it after Xero has refreshed (the old refresh token
     * rotated, the new tokens issued), as an answer slow to come back.
     */
    holdRefreshes({ at = 'arrival' }: { at?: 'arrival' | 'answer' } = {}) {
      let release!: () => void
      let arrive!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      const arrived = new Promise<void>((resolve) => (arrive = resolve))
      hold = { at, release, released, arrive }
      return {
        arrived,
        release: () => {
          hold = null
          release()
        },
      }
    },
  }
}

// ───────────────────────────────────────────────────────── driving a connect

function activeFake(): FakeXero {
  if (!active) throw new Error('call fakeXero() before connecting')
  return active
}

/** The `state` Xero would carry back, from the authorise URL. */
export function stateFrom(authorizeUrl: string): string {
  const state = new URL(authorizeUrl).searchParams.get('state')
  if (!state) throw new Error(`no state in ${authorizeUrl}`)
  return state
}

/** Xero sends the browser back: `GET /xero/callback?…` on the Convex site. */
export function xeroCallback(
  t: TestApp,
  params: Record<string, string>,
): Promise<Response> {
  return t.fetch(`/xero/callback?${new URLSearchParams(params).toString()}`, {
    method: 'GET',
  })
}

/** The callback, which must answer with a redirect; where it points. */
export async function callbackLocation(
  t: TestApp,
  params: Record<string, string>,
): Promise<string> {
  const res = await xeroCallback(t, params)
  const location = res.headers.get('Location')
  if (res.status !== 302 || !location) {
    throw new Error(`the callback answered ${res.status}, not a redirect`)
  }
  return location
}

/**
 * One "Connect Xero", start to callback: `startConnect` as `as`, the person
 * consents at Xero as `xeroUserId` to `tenantId`, and Xero sends the browser
 * back. Returns where the callback redirected (`…?finish=` or `…?xero=`).
 */
export async function connectVia(
  t: TestApp,
  as: TestAs,
  opts: {
    businessId: Id<'businesses'>
    kind: 'business' | 'member'
    xeroUserId: string
    tenantId: string | Array<string>
  },
): Promise<string> {
  const xero = activeFake()
  const { url } = await as.action(api.xero.startConnect, {
    businessId: opts.businessId,
    kind: opts.kind,
  })
  const code = xero.consent({
    xeroUserId: opts.xeroUserId,
    tenantId: opts.tenantId,
  })
  return callbackLocation(t, { code, state: stateFrom(url) })
}

/** The one-time finish token from the callback's redirect. */
export function finishFrom(location: string): string {
  const token = new URL(location).searchParams.get('finish')
  if (!token) throw new Error(`no finish token in ${location}`)
  return token
}

/** The `?xero=` outcome code from the callback's redirect, if any. */
export function outcomeOf(location: string): string | null {
  return new URL(location).searchParams.get('xero')
}

/**
 * `connectVia`, then finished by the same person, with what that schedules
 * (the organisation read) run. Needs fake timers. Returns the callback's
 * redirect.
 */
export async function connectAndFinish(
  t: TestApp,
  as: TestAs,
  opts: Parameters<typeof connectVia>[2],
): Promise<string> {
  const location = await connectVia(t, as, opts)
  await as.action(api.xero.finishConnect, {
    businessId: opts.businessId,
    token: finishFrom(location),
  })
  await t.finishAllScheduledFunctions(vi.runAllTimers)
  return location
}
