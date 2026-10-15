import { vi } from 'vitest'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import type { TestApp, TestAs } from './harness'

/**
 * Xero, faked: its sign-in (identity.xero.com) and the few API calls Releases
 * 1 and 2 make (api.xero.com), with `fetch` stubbed and the env set as a
 * configured deployment would have it. Modelled on `fakeResend`
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
 * - An organisation holds contacts (`contacts`), which `GET /Contacts` pages
 *   as Xero does: 100 a page unless `pageSize` says otherwise (1,000 at
 *   most), every one without `page`, archived ones only with
 *   `includeArchived=true`, and the blanks Xero really sends — an empty
 *   `EmailAddress`, four phones of which most are empty, a PO box with no
 *   city ahead of the street address — so the app's reading of them is
 *   tested against Xero's shape, not a tidy one.
 * - Every Accounting call counts against the organisation's limits (60 a
 *   minute, 5,000 a day), answered in `X-MinLimit-Remaining` and
 *   `X-DayLimit-Remaining`, and past them with a 429 as Xero would.
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
/** Xero's page size for `GET /Contacts` when none is asked for, and the
 * most it will give. */
const CONTACTS_PAGE_DEFAULT = 100
const CONTACTS_PAGE_MAX = 1000
/** Xero's per-organisation limits on the Accounting API. */
const MINUTE_LIMIT = 60
const DAY_LIMIT = 5000

export type TenantType = 'ORGANISATION' | 'PRACTICE'

export type ContactStatus = 'ACTIVE' | 'ARCHIVED' | 'GDPRREQUEST'

/** One of a contact's phones, in Xero's own words. */
export type XeroPhone = {
  PhoneType: 'DEFAULT' | 'DDI' | 'MOBILE' | 'FAX'
  PhoneNumber: string
  PhoneAreaCode: string
  PhoneCountryCode: string
}

/** One of a contact's addresses, in Xero's own words. */
export type XeroAddress = {
  AddressType: 'POBOX' | 'STREET'
  AddressLine1?: string
  City: string
  Region: string
  PostalCode: string
  Country: string
}

/**
 * A contact as a test seeds it. Only `name` is needed; the rest is what Xero
 * would hold. `phone` and `mobile` fill the DEFAULT and MOBILE phones of the
 * four Xero always lists, `city` the STREET address (after an empty PO box);
 * `phones` / `addresses` replace those lists outright when a test needs a
 * particular shape.
 */
export type FakeContact = {
  contactId?: string
  name: string
  email?: string
  accountNumber?: string
  status?: ContactStatus
  firstName?: string
  lastName?: string
  phone?: { number: string; areaCode?: string }
  mobile?: { number: string; areaCode?: string }
  city?: string
  phones?: Array<XeroPhone>
  addresses?: Array<XeroAddress>
}

/** A contact as the fake holds it: with its id and status settled. */
export type StoredContact = FakeContact & {
  contactId: string
  status: ContactStatus
  updatedAt: number
}

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
  /** What the fake answered, once it has. */
  status?: number
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
  /** Each organisation's contacts, in the order Xero lists them. */
  const contactBook = new Map<string, Array<StoredContact>>()
  /** When each Accounting call to an organisation arrived, for its limits. */
  const accountingCalls = new Map<string, Array<number>>()
  /** `contactsFail`: how `GET /Contacts` answers instead, and how often. */
  let contactsFailure: {
    status: number
    headers: Record<string, string>
    page: number | null
    left: number
  } | null = null

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
  /** Holding contact reads: every `GET /Contacts` waits until released. */
  let contactsHold: {
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

  const forbidden = () =>
    json(
      {
        Type: null,
        Title: 'Forbidden',
        Status: 403,
        Detail: 'AuthorizationUnsuccessful',
      },
      403,
    )

  /**
   * What every Accounting call checks first: a live access token, and an
   * organisation its Xero user has connected (named by `xero-tenant-id`).
   * Then the call is counted against that organisation's limits, and the
   * answer carries what is left of them — or is a 429 once they are spent.
   */
  function accounting(
    r: XeroRequest,
  ):
    { refused: Response } | { tenant: Tenant; limits: Record<string, string> } {
    const access = bearer(r)
    if (!access) return { refused: unauthorised() }
    const tenantId = r.headers['xero-tenant-id'] ?? ''
    const connected = [...connections.values()].some(
      (row) =>
        row.xeroUserId === access.xeroUserId && row.tenantId === tenantId,
    )
    if (!connected) return { refused: forbidden() }

    const now = Date.now()
    const calls = (accountingCalls.get(tenantId) ?? []).filter(
      (at) => at > now - 24 * 60 * 60 * 1000,
    )
    const inMinute = calls.filter((at) => at > now - 60_000)
    if (calls.length >= DAY_LIMIT || inMinute.length >= MINUTE_LIMIT) {
      const day = calls.length >= DAY_LIMIT
      const until = day ? calls[0] + 24 * 60 * 60 * 1000 : inMinute[0] + 60_000
      return {
        refused: json({ Title: 'Too Many Requests', Status: 429 }, 429, {
          'Retry-After': String(Math.max(1, Math.ceil((until - now) / 1000))),
          'X-Rate-Limit-Problem': day ? 'day' : 'minute',
          'X-DayLimit-Remaining': String(DAY_LIMIT - calls.length),
          'X-MinLimit-Remaining': String(MINUTE_LIMIT - inMinute.length),
        }),
      }
    }
    calls.push(now)
    accountingCalls.set(tenantId, calls)
    return {
      tenant: tenants.get(tenantId)!,
      limits: {
        'X-DayLimit-Remaining': String(DAY_LIMIT - calls.length),
        'X-MinLimit-Remaining': String(MINUTE_LIMIT - inMinute.length - 1),
        'X-AppMinLimit-Remaining': '9999',
      },
    }
  }

  /** Xero answers XML unless asked otherwise, which no JSON.parse survives. */
  const wantsJson = (r: XeroRequest) => r.headers.accept === 'application/json'

  function organisation(r: XeroRequest): Response {
    const checked = accounting(r)
    if ('refused' in checked) return checked.refused
    const t = checked.tenant
    if (!wantsJson(r)) {
      return new Response(
        `<Response><Organisations><Organisation><Name>${t.name}</Name></Organisation></Organisations></Response>`,
        {
          status: 200,
          headers: { 'content-type': 'text/xml', ...checked.limits },
        },
      )
    }
    return json(
      {
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
      },
      200,
      checked.limits,
    )
  }

  /** The four phones Xero lists on every contact, most of them empty. */
  function phonesOf(c: StoredContact): Array<XeroPhone> {
    if (c.phones) return c.phones
    const phone = (
      type: XeroPhone['PhoneType'],
      p?: { number: string; areaCode?: string },
    ): XeroPhone => ({
      PhoneType: type,
      PhoneNumber: p?.number ?? '',
      PhoneAreaCode: p?.areaCode ?? '',
      PhoneCountryCode: '',
    })
    return [
      phone('DDI'),
      phone('DEFAULT', c.phone),
      phone('FAX'),
      phone('MOBILE', c.mobile),
    ]
  }

  /** A PO box Xero keeps blank, then the street address. */
  function addressesOf(c: StoredContact): Array<XeroAddress> {
    if (c.addresses) return c.addresses
    const blank = { City: '', Region: '', PostalCode: '', Country: '' }
    return [
      { AddressType: 'POBOX', ...blank },
      c.city
        ? {
            AddressType: 'STREET',
            AddressLine1: '1 Test Street',
            City: c.city,
            Region: 'WA',
            PostalCode: '6000',
            Country: 'Australia',
          }
        : { AddressType: 'STREET', ...blank },
    ]
  }

  /** One contact as `GET /Contacts` lists it. */
  function contactJson(c: StoredContact) {
    return {
      ContactID: c.contactId,
      ContactStatus: c.status,
      Name: c.name,
      ...(c.firstName ? { FirstName: c.firstName } : {}),
      ...(c.lastName ? { LastName: c.lastName } : {}),
      // Xero sends an empty string, not nothing, for a contact without one.
      EmailAddress: c.email ?? '',
      ...(c.accountNumber !== undefined
        ? { AccountNumber: c.accountNumber }
        : {}),
      BankAccountDetails: '',
      Addresses: addressesOf(c),
      Phones: phonesOf(c),
      UpdatedDateUTC: `/Date(${c.updatedAt}+0000)/`,
      ContactGroups: [],
      IsSupplier: false,
      IsCustomer: true,
      ContactPersons: [],
      HasAttachments: false,
      HasValidationErrors: false,
    }
  }

  function failContacts(): Response {
    const failure = contactsFailure!
    const body =
      failure.status === 403
        ? {
            Type: null,
            Title: 'Forbidden',
            Status: 403,
            Detail: 'AuthorizationUnsuccessful',
          }
        : failure.status === 429
          ? { Title: 'Too Many Requests', Status: 429 }
          : failure.status >= 500
            ? null
            : {
                ErrorNumber: 10,
                Type: 'ValidationException',
                Message: 'A validation exception occurred',
              }
    if (body === null) {
      return new Response('Service Unavailable', {
        status: failure.status,
        headers: failure.headers,
      })
    }
    return json(body, failure.status, failure.headers)
  }

  async function listContacts(r: XeroRequest): Promise<Response> {
    if (contactsHold) {
      contactsHold.arrive()
      await contactsHold.released
    }
    const checked = accounting(r)
    if ('refused' in checked) return checked.refused

    const pageParam = r.query.get('page')
    const page = pageParam === null ? null : Math.max(1, Number(pageParam) || 1)
    if (
      contactsFailure &&
      contactsFailure.left > 0 &&
      (contactsFailure.page === null || contactsFailure.page === (page ?? 1))
    ) {
      contactsFailure.left -= 1
      return failContacts()
    }

    const includeArchived =
      (r.query.get('includeArchived') ?? '').toLowerCase() === 'true'
    const all = (contactBook.get(checked.tenant.tenantId) ?? []).filter(
      (c) => includeArchived || c.status !== 'ARCHIVED',
    )
    const pageSize = Math.min(
      CONTACTS_PAGE_MAX,
      Math.max(1, Number(r.query.get('pageSize')) || CONTACTS_PAGE_DEFAULT),
    )
    // Without `page`, Xero lists every contact at once.
    const rows =
      page === null ? all : all.slice((page - 1) * pageSize, page * pageSize)
    if (!wantsJson(r)) {
      return new Response('<Response><Contacts /></Response>', {
        status: 200,
        headers: { 'content-type': 'text/xml', ...checked.limits },
      })
    }
    return json(
      {
        Id: uuid(),
        Status: 'OK',
        ProviderName: 'PestM8',
        DateTimeUTC: `/Date(${Date.now()})/`,
        ...(page === null
          ? {}
          : {
              pagination: {
                page,
                pageSize,
                pageCount: Math.ceil(all.length / pageSize),
                itemCount: all.length,
              },
            }),
        Contacts: rows.map(contactJson),
      },
      200,
      checked.limits,
    )
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
    const response = await route(r)
    r.status = response.status
    return response
  }

  async function route(r: XeroRequest): Promise<Response> {
    if (r.host === 'identity.xero.com' && r.method === 'POST') {
      if (r.path === '/connect/token') return token(r)
      if (r.path === '/connect/revocation') return revoke(r)
    }
    if (r.host === 'api.xero.com') {
      if (r.path === '/connections' && r.method === 'GET') {
        return listConnections(r)
      }
      const one = /^\/connections\/([^/]+)$/.exec(r.path)
      if (one && r.method === 'DELETE') return deleteConnection(r, one[1])
      if (r.path === '/api.xro/2.0/Organisation' && r.method === 'GET') {
        return organisation(r)
      }
      if (r.path === '/api.xro/2.0/Contacts' && r.method === 'GET') {
        return listContacts(r)
      }
    }
    return new Response(`not faked: ${r.method} https://${r.host}${r.path}`, {
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
    /** `GET /Contacts` requests, whatever Xero said. */
    contactReads: () => where('api.xero.com', '/api.xro/2.0/Contacts', 'GET'),
    /** Every request to the Accounting API, any method, any path. */
    accountingRequests: () =>
      requests.filter(
        (r) => r.host === 'api.xero.com' && r.path.startsWith('/api.xro/'),
      ),
    /** Requests that hit nothing this fake models. A write to Contacts is
     * one: Release 2 only reads them. */
    unmodelled: () =>
      requests.filter(
        (r) =>
          !(
            (r.host === 'identity.xero.com' &&
              ['/connect/token', '/connect/revocation'].includes(r.path)) ||
            (r.host === 'api.xero.com' &&
              (r.path === '/connections' ||
                r.path.startsWith('/connections/') ||
                r.path === '/api.xro/2.0/Organisation' ||
                (r.path === '/api.xro/2.0/Contacts' && r.method === 'GET')))
          ),
      ),
    /**
     * Gives an organisation these contacts, in this order, in place of any
     * it had. Returns them as held, each with its `contactId` (made up when
     * the seed has none) — keep the ids for what the app should link.
     */
    contacts(tenantId: string, rows: Array<FakeContact>): Array<StoredContact> {
      tenant({ tenantId })
      const stored = rows.map((row): StoredContact => ({
        ...row,
        contactId: row.contactId ?? uuid(),
        status: row.status ?? 'ACTIVE',
        updatedAt: Date.now(),
      }))
      contactBook.set(tenantId, stored)
      return stored
    },
    /**
     * Calls to this organisation's Accounting API that something else made
     * — another app, the bookkeeper's — `ago` ms back (now by default), so a
     * test can start a run with the minute's or the day's allowance mostly
     * spent.
     */
    spend(tenantId: string, calls: number, { ago = 0 } = {}): void {
      const at = Date.now() - ago
      const log = accountingCalls.get(tenantId) ?? []
      for (let i = 0; i < calls; i++) log.push(at)
      accountingCalls.set(
        tenantId,
        log.sort((a, b) => a - b),
      )
    },
    /** The organisation's contacts as Xero holds them now. */
    contactsOf(tenantId: string): Array<StoredContact> {
      return contactBook.get(tenantId) ?? []
    },
    /**
     * `GET /Contacts` answers `status` (with `headers`) instead: every time,
     * or the next `times`, and only for `page` when given. `null` puts it
     * back. A 403 is Xero's AuthorizationUnsuccessful, a 429 its rate
     * limit (say which, and when, in the headers), a 5xx a bare outage.
     */
    contactsFail(
      status: number | null,
      headers: Record<string, string> = {},
      opts: { page?: number; times?: number } = {},
    ): void {
      contactsFailure =
        status === null
          ? null
          : {
              status,
              headers,
              page: opts.page ?? null,
              left: opts.times ?? Infinity,
            }
    },
    /** Makes every `GET /Contacts` wait until `release()`; `arrived`
     * resolves once the first is waiting — mid-run, lease held. */
    holdContacts() {
      let release!: () => void
      let arrive!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      const arrived = new Promise<void>((resolve) => (arrive = resolve))
      contactsHold = { released, arrive }
      return {
        arrived,
        release: () => {
          contactsHold = null
          release()
        },
      }
    },
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
 * (the organisation read, and from Release 2 the match run) run. Needs fake
 * timers. Returns the callback's redirect.
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
