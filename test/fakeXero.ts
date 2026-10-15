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
 * Release 3 writes contacts, so the fake keeps Xero's rules for those too —
 * the ones that decide whether a sync is safe:
 *
 * - `PUT /Contacts` creates, `POST /Contacts` updates. A contact's Name is
 *   unique among ACTIVE contacts; a clash is a per-item ValidationError in
 *   Xero's own words, the item coming back with an all-zeros ContactID.
 *   With `summarizeErrors=false` the rest of the batch is saved and the
 *   answer is a 200; without it, one bad item fails the whole request (400)
 *   and nothing is saved.
 * - An update must name its contact (`ContactID`) on every element. Real
 *   Xero would quietly CREATE an element without one, which is exactly the
 *   mistake worth catching, so the fake refuses the request (400).
 * - Sending a contact's `Phones`, `Addresses` or `ContactPersons` REPLACES
 *   that list: a type not sent comes back blank, a person not sent is gone.
 *   Whether real Xero replaces or merges is unproven (the Demo Company gate
 *   in docs/xero.md); the fake takes the harsher answer, so an app that only
 *   ever sends whole lists passes either way. `knobs.arrays = 'merge'` has
 *   it merge instead.
 * - An ARCHIVED contact takes writes and stays archived; a merged one is
 *   ARCHIVED with `MergedToContactID`. Archived contacts are listed — by
 *   page, by `IDs=` or by `where=` — only with `includeArchived=true`.
 * - `Idempotency-Key` (at most 128 characters): the same key with the same
 *   request within six minutes is answered from the first answer, changing
 *   nothing; the same key with a different request is a 400.
 * - An `AccountNumber` another ACTIVE contact holds is refused, as Xero does
 *   (`knobs.uniqueAccountNumbers`).
 *
 * Knobs for what Xero does to a sync: `next429`, `next5xx`, `dayRemaining`,
 * `merge`, `archive`, `gdpr`, `editInXero`, `loseResponseAfterCommit`,
 * `normalise`, `refuseItems`, `expireAccessTokens`, `holdWrites`, and
 * `onRequest`, called with every request as it arrives.
 *
 * Every request is recorded with its method, headers and body (parsed, when
 * it is JSON), so a test can assert exactly what was sent — and, as
 * importantly, that nothing else was. Anything it does not model answers
 * 500, loudly.
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
const DAY_MS = 24 * 60 * 60 * 1000
/** How long Xero remembers an Idempotency-Key, and the longest it takes. */
const IDEMPOTENCY_MS = 6 * 60 * 1000
const IDEMPOTENCY_KEY_MAX = 128
/** The ContactID Xero gives an item it refused. */
export const ZERO_CONTACT_ID = '00000000-0000-0000-0000-000000000000'
/** The phones Xero keeps on every contact, in the order it lists them. */
const PHONE_TYPES = ['DDI', 'DEFAULT', 'FAX', 'MOBILE'] as const
/** The addresses Xero keeps on every contact, in the order it lists them. */
const ADDRESS_TYPES = ['POBOX', 'STREET'] as const
const ADDRESS_FIELDS = [
  'AddressLine1',
  'AddressLine2',
  'AddressLine3',
  'AddressLine4',
  'City',
  'Region',
  'PostalCode',
  'Country',
  'AttentionTo',
] as const
/** The most people Xero keeps on a contact besides the contact itself. */
const MAX_CONTACT_PERSONS = 5
const CONTACTS_PATH = '/api.xro/2.0/Contacts'

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
  AddressLine2?: string
  AddressLine3?: string
  AddressLine4?: string
  City: string
  Region: string
  PostalCode: string
  Country: string
  AttentionTo?: string
}

/** One of a contact's people besides the contact itself (a business's
 * bookkeeper, say), in Xero's own words. */
export type XeroContactPerson = {
  FirstName?: string
  LastName?: string
  EmailAddress?: string
  IncludeInEmails?: boolean
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
  taxNumber?: string
  contactPersons?: Array<XeroContactPerson>
  /** Set by a merge in Xero: the contact this one was merged into. */
  mergedToContactId?: string
}

/** A contact as Xero lists it, in Xero's own words (`view`). */
export type XeroContactView = {
  ContactID: string
  ContactStatus: ContactStatus
  Name: string
  FirstName?: string
  LastName?: string
  EmailAddress: string
  AccountNumber?: string
  TaxNumber?: string
  MergedToContactID?: string
  Phones: Array<XeroPhone>
  Addresses: Array<XeroAddress>
  ContactPersons: Array<XeroContactPerson>
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
  /** The body parsed as JSON, for the contact writes; undefined otherwise. */
  json: unknown
  /** What the fake answered, once it has. */
  status?: number
  /** Answered from the Idempotency-Key cache: nothing was written. */
  replayed?: boolean
  /** Xero acted on it, and its answer never reached the app
   * (`loseResponseAfterCommit`). */
  lost?: boolean
}

export type FakeXeroOptions = {
  /** `false`: the deployment is not set up for Xero (no client id, secret or
   * key). `fetch` is still stubbed, so a test can prove nothing was called. */
  configured?: boolean
}

export type FakeXero = ReturnType<typeof makeFake>

/** The fake the current test made; `connectVia` drives it. */
let active: FakeXero | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The contacts one write sent, as the app sent them (`{ Contacts: [...] }`,
 * or a lone contact). */
export function contactsIn(r: XeroRequest): Array<Record<string, unknown>> {
  const doc = r.json
  if (!isRecord(doc)) return []
  if (Array.isArray(doc.Contacts)) return doc.Contacts.filter(isRecord)
  return [doc]
}

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
    /** What sending a contact's Phones, Addresses or ContactPersons does to
     * what Xero held: `replace` (a type or person not sent is gone — the
     * harsher answer, and the default) or `merge` (only what was sent
     * changes). Unproven either way until the Demo Company gate. */
    arrays: 'replace' as 'replace' | 'merge',
    /** Xero refuses an AccountNumber another ACTIVE contact holds. */
    uniqueAccountNumbers: true,
  }

  // ─────────────────────────────────────────── Release 3: what Xero does

  /** Answers Xero remembers by Idempotency-Key, for six minutes. */
  const idempotency = new Map<
    string,
    { fingerprint: string; at: number; status: number; body: string }
  >()
  /** `next429`: the next Accounting calls answer this instead. */
  const rateLimits: Array<{
    problem: 'minute' | 'day' | 'concurrent'
    retryAfter?: number
    tenantId?: string
  }> = []
  /** `next5xx`: how many Accounting calls answer 503 next, and where. */
  const outages: Array<{ tenantId?: string }> = []
  /** `loseResponseAfterCommit`: answers that never come back. */
  let losing: { left: number; retries: boolean; key: string | null } | null =
    null
  /** `normalise`: how Xero rewrites a field it is sent, by Xero's name. */
  const normalisers = new Map<string, (value: string) => string>()
  /** `refuseItems`: a validation Xero makes that the fake doesn't model. */
  let refuser: ((contact: Record<string, unknown>) => string | null) | null =
    null
  /** `onRequest`: called with every request as it arrives. */
  const requestHooks: Array<(r: XeroRequest) => void | Promise<void>> = []
  /** Accounting calls under way per organisation, and the most at once. */
  const inFlight = new Map<string, number>()
  const mostInFlight = new Map<string, number>()
  /** Holding requests: every one `match` picks waits until released —
   * counted as under way while it waits, as a slow answer would be. */
  let requestsHold: {
    match: (r: XeroRequest) => boolean
    released: Promise<void>
    arrive: () => void
  } | null = null

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
    const forTenant = (knob: { tenantId?: string }) =>
      knob.tenantId === undefined || knob.tenantId === tenantId
    const limited = rateLimits.findIndex(forTenant)
    if (limited !== -1) {
      const [{ problem, retryAfter }] = rateLimits.splice(limited, 1)
      return {
        refused: json({ Title: 'Too Many Requests', Status: 429 }, 429, {
          'X-Rate-Limit-Problem': problem,
          ...(retryAfter === undefined
            ? {}
            : { 'Retry-After': String(retryAfter) }),
        }),
      }
    }
    const down = outages.findIndex(forTenant)
    if (down !== -1) {
      outages.splice(down, 1)
      return {
        refused: new Response('Service Unavailable', { status: 503 }),
      }
    }

    const calls = (accountingCalls.get(tenantId) ?? []).filter(
      (at) => at > now - DAY_MS,
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
      ...(c.taxNumber !== undefined ? { TaxNumber: c.taxNumber } : {}),
      ...(c.mergedToContactId !== undefined
        ? { MergedToContactID: c.mergedToContactId }
        : {}),
      BankAccountDetails: '',
      Addresses: addressesOf(c),
      Phones: phonesOf(c),
      UpdatedDateUTC: `/Date(${c.updatedAt}+0000)/`,
      ContactGroups: [],
      IsSupplier: false,
      IsCustomer: true,
      ContactPersons: (c.contactPersons ?? []).map((p) => ({ ...p })),
      HasAttachments: false,
      HasValidationErrors: false,
    }
  }

  /** The same name to Xero: it compares them ignoring case and the spaces
   * around them. */
  const sameName = (a: string, b: string) =>
    a.trim().toLowerCase() === b.trim().toLowerCase()

  /** Splits a `where` on `&&` outside its quoted values. */
  function clausesOf(where: string): Array<string> {
    const clauses: Array<string> = []
    let current = ''
    let quoted = false
    for (let i = 0; i < where.length; i++) {
      const ch = where[i]
      if (quoted && ch === '\\') {
        current += ch + (where[i + 1] ?? '')
        i += 1
        continue
      }
      if (ch === '"') quoted = !quoted
      if (!quoted && where.startsWith('&&', i)) {
        clauses.push(current)
        current = ''
        i += 1
        continue
      }
      current += ch
    }
    clauses.push(current)
    return clauses
  }

  /**
   * The few `where` filters the app has reason to use — `Name=="…"`,
   * `AccountNumber=="…"`, `EmailAddress=="…"`, `ContactStatus=="…"`, joined
   * by `&&`, with `\"` for a quote inside a value. Anything else is null, and
   * the read a 400: a filter the fake can't honour must not quietly match
   * everything.
   */
  function whereTest(where: string): ((c: StoredContact) => boolean) | null {
    const tests = clausesOf(where).map((clause) => {
      const m = /^\s*(\w+)\s*==\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(clause)
      if (!m) return null
      const value = m[2].replace(/\\(.)/g, '$1')
      switch (m[1]) {
        case 'Name':
          return (c: StoredContact) => sameName(c.name, value)
        case 'AccountNumber':
          return (c: StoredContact) => (c.accountNumber ?? '') === value
        case 'EmailAddress':
          return (c: StoredContact) =>
            (c.email ?? '').toLowerCase() === value.toLowerCase()
        case 'ContactStatus':
          return (c: StoredContact) => c.status === value
        default:
          return null
      }
    })
    if (tests.some((test) => test === null)) return null
    return (c) => tests.every((test) => test!(c))
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
    let all = (contactBook.get(checked.tenant.tenantId) ?? []).filter(
      (c) => includeArchived || c.status !== 'ARCHIVED',
    )
    // Release 3's reads of particular contacts: by id (`IDs=a,b`) and by a
    // filter (`where=Name=="…"`). Archived ones only when asked for, as for
    // a page.
    const ids = r.query.get('IDs')
    if (ids !== null) {
      const wanted = new Set(ids.split(',').map((id) => id.trim()))
      all = all.filter((c) => wanted.has(c.contactId))
    }
    const where = r.query.get('where')
    if (where !== null) {
      const test = whereTest(where)
      if (!test) {
        return json(
          {
            Title: 'Bad Request',
            Status: 400,
            Detail: `not faked: where ${where}`,
          },
          400,
          checked.limits,
        )
      }
      all = all.filter(test)
    }
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

  // ─────────────────────────────────────────────────── writing contacts

  const badRequest = (detail: string, headers: HeadersInit = {}) =>
    json({ Title: 'Bad Request', Status: 400, Detail: detail }, 400, headers)

  /** A field's text as Xero keeps it: the test's `normalise` rule for it,
   * if any. */
  const kept = (field: string, value: unknown): string => {
    const text = typeof value === 'string' ? value : String(value ?? '')
    const rule = normalisers.get(field)
    return rule ? rule(text) : text
  }

  const validEmail = (email: string) =>
    /^[\x21-\x7e]+$/.test(email) && /^[^@]+@[^@]+\.[^@]+$/.test(email)

  const blankPhone = (type: XeroPhone['PhoneType']): XeroPhone => ({
    PhoneType: type,
    PhoneNumber: '',
    PhoneAreaCode: '',
    PhoneCountryCode: '',
  })
  const blankAddress = (type: XeroAddress['AddressType']): XeroAddress => ({
    AddressType: type,
    City: '',
    Region: '',
    PostalCode: '',
    Country: '',
  })

  /** The four phones after a write that sent `sent`. */
  function writtenPhones(
    current: Array<XeroPhone>,
    sent: Array<unknown>,
  ): Array<XeroPhone> {
    const byType = new Map<string, Record<string, unknown>>()
    for (const p of sent) {
      if (isRecord(p)) byType.set(String(p.PhoneType ?? '').toUpperCase(), p)
    }
    return PHONE_TYPES.map((type) => {
      const p = byType.get(type)
      if (p) {
        return {
          PhoneType: type,
          PhoneNumber: kept('PhoneNumber', p.PhoneNumber ?? ''),
          PhoneAreaCode: kept('PhoneAreaCode', p.PhoneAreaCode ?? ''),
          PhoneCountryCode: kept('PhoneCountryCode', p.PhoneCountryCode ?? ''),
        }
      }
      return knobs.arrays === 'merge'
        ? (current.find((c) => c.PhoneType === type) ?? blankPhone(type))
        : blankPhone(type)
    })
  }

  /** The PO box and street address after a write that sent `sent`. */
  function writtenAddresses(
    current: Array<XeroAddress>,
    sent: Array<unknown>,
  ): Array<XeroAddress> {
    const byType = new Map<string, Record<string, unknown>>()
    for (const a of sent) {
      if (isRecord(a)) {
        byType.set(String(a.AddressType ?? '').toUpperCase(), a)
      }
    }
    return ADDRESS_TYPES.map((type) => {
      const a = byType.get(type)
      if (a) {
        const address: XeroAddress = blankAddress(type)
        for (const field of ADDRESS_FIELDS) {
          if (a[field] !== undefined) address[field] = kept(field, a[field])
        }
        return address
      }
      return knobs.arrays === 'merge'
        ? (current.find((c) => c.AddressType === type) ?? blankAddress(type))
        : blankAddress(type)
    })
  }

  function personOf(p: Record<string, unknown>): XeroContactPerson {
    const person: XeroContactPerson = {}
    if (p.FirstName !== undefined) {
      person.FirstName = kept('FirstName', p.FirstName)
    }
    if (p.LastName !== undefined) person.LastName = kept('LastName', p.LastName)
    if (p.EmailAddress !== undefined) {
      person.EmailAddress = kept('EmailAddress', p.EmailAddress)
    }
    if (typeof p.IncludeInEmails === 'boolean') {
      person.IncludeInEmails = p.IncludeInEmails
    }
    return person
  }

  /** The contact's people after a write that sent `sent`: the list sent,
   * or (merging) each matched by email, else by name, the rest kept. */
  function writtenPersons(
    current: Array<XeroContactPerson>,
    sent: Array<unknown>,
  ): Array<XeroContactPerson> {
    const people = sent.filter(isRecord).map(personOf)
    if (knobs.arrays === 'replace') return people
    const merged = current.map((p) => ({ ...p }))
    for (const person of people) {
      const email = person.EmailAddress?.toLowerCase()
      const name = `${person.FirstName ?? ''} ${person.LastName ?? ''}`.trim()
      const at = merged.findIndex(
        (p) =>
          (email && p.EmailAddress?.toLowerCase() === email) ||
          (name !== '' &&
            sameName(`${p.FirstName ?? ''} ${p.LastName ?? ''}`, name)),
      )
      if (at === -1) merged.push(person)
      else merged[at] = { ...merged[at], ...person }
    }
    return merged
  }

  /** Writes one element of a PUT or POST into `target`. */
  function writeFields(target: StoredContact, e: Record<string, unknown>) {
    const text = (field: string) => {
      const value = kept(field, e[field])
      return value === '' ? undefined : value
    }
    if (typeof e.Name === 'string') target.name = kept('Name', e.Name)
    if (e.FirstName !== undefined) target.firstName = text('FirstName')
    if (e.LastName !== undefined) target.lastName = text('LastName')
    if (e.EmailAddress !== undefined) target.email = text('EmailAddress')
    if (e.AccountNumber !== undefined) {
      target.accountNumber = text('AccountNumber')
    }
    if (e.TaxNumber !== undefined) target.taxNumber = text('TaxNumber')
    if (Array.isArray(e.Phones)) {
      target.phones = writtenPhones(phonesOf(target), e.Phones)
    }
    if (Array.isArray(e.Addresses)) {
      target.addresses = writtenAddresses(addressesOf(target), e.Addresses)
    }
    if (Array.isArray(e.ContactPersons)) {
      target.contactPersons = writtenPersons(
        target.contactPersons ?? [],
        e.ContactPersons,
      )
    }
    target.updatedAt = Date.now()
  }

  /**
   * What Xero refuses about one element, in its own words — checked against
   * the organisation's contacts as they stand at that point of the request,
   * so the second of two new contacts of one name clashes with the first.
   */
  function refusals(
    e: Record<string, unknown>,
    existing: StoredContact | null,
    book: Array<StoredContact>,
  ): Array<string> {
    const errors: Array<string> = []
    const others = book.filter(
      (c) =>
        c.status === 'ACTIVE' &&
        (existing === null || c.contactId !== existing.contactId),
    )

    if (existing === null && (typeof e.Name !== 'string' || !e.Name.trim())) {
      errors.push('The contact name must be specified.')
    }
    if (typeof e.Name === 'string') {
      const name = kept('Name', e.Name)
      if (name.length > 255) {
        errors.push('The contact name must be 255 characters or less.')
      } else if (
        name.trim() !== '' &&
        others.some((c) => sameName(c.name, name))
      ) {
        errors.push(
          `The contact name ${name} is already assigned to another contact. The contact name must be unique across all active contacts.`,
        )
      }
    }

    const emails = [
      e.EmailAddress,
      ...(Array.isArray(e.ContactPersons)
        ? e.ContactPersons.filter(isRecord).map((p) => p.EmailAddress)
        : []),
    ]
    for (const email of emails) {
      if (typeof email === 'string' && email !== '' && !validEmail(email)) {
        errors.push('Email address must be valid.')
        break
      }
    }

    if (Array.isArray(e.ContactPersons)) {
      const after = writtenPersons(
        existing?.contactPersons ?? [],
        e.ContactPersons,
      )
      if (after.length > MAX_CONTACT_PERSONS) {
        errors.push(
          `A contact can have no more than ${MAX_CONTACT_PERSONS} contact persons.`,
        )
      }
    }

    if (Array.isArray(e.Phones)) {
      for (const p of e.Phones) {
        const type = isRecord(p) ? String(p.PhoneType ?? '').toUpperCase() : ''
        if (!(PHONE_TYPES as ReadonlyArray<string>).includes(type)) {
          errors.push(`${type || 'A blank'} is not a valid PhoneType.`)
          break
        }
      }
    }

    const accountNumber =
      e.AccountNumber === undefined
        ? ''
        : kept('AccountNumber', e.AccountNumber)
    if (
      knobs.uniqueAccountNumbers &&
      accountNumber !== '' &&
      others.some((c) => (c.accountNumber ?? '') === accountNumber)
    ) {
      errors.push(
        'Account Number already exists. Please enter a different Account Number.',
      )
    }

    const extra = refuser?.(e)
    if (extra) errors.push(extra)
    return errors
  }

  /**
   * `PUT /Contacts` (create) and `POST /Contacts` (update), both batched as
   * `{ Contacts: [...] }`. Every element is checked and written in order on a
   * copy of the organisation's contacts, which replaces it only if the
   * request as a whole succeeds.
   */
  function applyContactWrite(
    r: XeroRequest,
    tenantId: string,
  ): { status: number; body: unknown } {
    const doc = r.json
    const elements: Array<unknown> | null = isRecord(doc)
      ? Array.isArray(doc.Contacts)
        ? doc.Contacts
        : 'Contacts' in doc
          ? null
          : [doc]
      : null
    const fail = (detail: string) => ({
      status: 400,
      body: { Title: 'Bad Request', Status: 400, Detail: detail },
    })
    if (!elements || elements.length === 0 || !elements.every(isRecord)) {
      return fail('A contact write needs { Contacts: [ … ] }.')
    }
    const items = elements
    const update = r.method === 'POST'
    if (update && items.some((e) => typeof e.ContactID !== 'string')) {
      // Real Xero would create a new contact for it: the mistake this
      // catches.
      return fail('not faked: an update element without its ContactID')
    }
    if (!update && items.some((e) => e.ContactID !== undefined)) {
      return fail('not faked: a create element with a ContactID')
    }
    const summarise =
      (r.query.get('summarizeErrors') ?? '').toLowerCase() !== 'false'

    const original = contactBook.get(tenantId) ?? []
    const working = original.map((c) => ({ ...c }))
    const results: Array<
      | { element: Record<string, unknown>; contact: StoredContact }
      | { element: Record<string, unknown>; errors: Array<string> }
    > = []
    for (const element of items) {
      const existing = update
        ? (working.find((c) => c.contactId === element.ContactID) ?? null)
        : null
      if (update && existing === null) {
        results.push({ element, errors: ['The contact could not be found.'] })
        continue
      }
      const errors = refusals(element, existing, working)
      if (errors.length > 0) {
        results.push({ element, errors })
        continue
      }
      const target: StoredContact = existing ?? {
        contactId: uuid(),
        name: '',
        status: 'ACTIVE',
        updatedAt: Date.now(),
      }
      // An archived contact takes the write, and stays archived.
      writeFields(target, element)
      if (!existing) working.push(target)
      results.push({ element, contact: target })
    }

    const refused = results.filter(
      (x): x is { element: Record<string, unknown>; errors: Array<string> } =>
        'errors' in x,
    )
    if (summarise && refused.length > 0) {
      return {
        status: 400,
        body: {
          ErrorNumber: 10,
          Type: 'ValidationException',
          Message: 'A validation exception occurred',
          Elements: refused.map((x) => ({
            ...x.element,
            ValidationErrors: x.errors.map((Message) => ({ Message })),
          })),
        },
      }
    }

    // Saved: the held contacts take the written fields, so a test's
    // references to them stay current; the new ones join the end.
    working.forEach((row, i) => {
      if (i < original.length) Object.assign(original[i], row)
      else original.push(row)
    })
    contactBook.set(tenantId, original)
    return {
      status: 200,
      body: {
        Id: uuid(),
        Status: 'OK',
        ProviderName: 'PestM8',
        DateTimeUTC: `/Date(${Date.now()})/`,
        Contacts: results.map((x) =>
          'errors' in x
            ? {
                ...x.element,
                ContactID: ZERO_CONTACT_ID,
                StatusAttributeString: 'ERROR',
                HasValidationErrors: true,
                ValidationErrors: x.errors.map((Message) => ({ Message })),
              }
            : {
                ...contactJson(
                  original.find((c) => c.contactId === x.contact.contactId)!,
                ),
                StatusAttributeString: 'OK',
              },
        ),
      },
    }
  }

  async function writeContacts(r: XeroRequest): Promise<Response> {
    const checked = accounting(r)
    if ('refused' in checked) return checked.refused
    const { tenantId } = checked.tenant
    if (!wantsJson(r)) {
      return badRequest('not faked: a write that does not ask for JSON')
    }
    if (!(r.headers['content-type'] ?? '').includes('application/json')) {
      return badRequest('not faked: a write whose body is not JSON')
    }

    const key = r.headers['idempotency-key']
    const fingerprint = JSON.stringify([
      r.method,
      r.path,
      r.query.toString(),
      tenantId,
      r.body,
    ])
    if (key !== undefined) {
      if (key.length > IDEMPOTENCY_KEY_MAX) {
        return badRequest(
          `Idempotency-Key must be ${IDEMPOTENCY_KEY_MAX} characters or less`,
          checked.limits,
        )
      }
      const cached = idempotency.get(key)
      if (cached && Date.now() - cached.at < IDEMPOTENCY_MS) {
        if (cached.fingerprint !== fingerprint) {
          return badRequest(
            'This Idempotency-Key was used for a different request',
            checked.limits,
          )
        }
        r.replayed = true
        return new Response(cached.body, {
          status: cached.status,
          headers: { 'content-type': 'application/json', ...checked.limits },
        })
      }
    }

    const answer = applyContactWrite(r, tenantId)
    if (key !== undefined) {
      idempotency.set(key, {
        fingerprint,
        at: Date.now(),
        status: answer.status,
        body: JSON.stringify(answer.body),
      })
    }
    return json(answer.body, answer.status, checked.limits)
  }

  const isContactWrite = (r: XeroRequest) =>
    r.host === 'api.xero.com' &&
    r.path === CONTACTS_PATH &&
    (r.method === 'PUT' || r.method === 'POST')

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? ''
        : await request.text()
    let parsed: unknown = undefined
    if ((request.headers.get('content-type') ?? '').includes('json')) {
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = undefined
      }
    }
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
      json: parsed,
    }
    requests.push(r)
    for (const hook of [...requestHooks]) await hook(r)

    const accountingCall =
      r.host === 'api.xero.com' && r.path.startsWith('/api.xro/')
    const tenantId = r.headers['xero-tenant-id'] ?? ''
    if (accountingCall) {
      const now = (inFlight.get(tenantId) ?? 0) + 1
      inFlight.set(tenantId, now)
      mostInFlight.set(tenantId, Math.max(mostInFlight.get(tenantId) ?? 0, now))
    }
    let response: Response
    try {
      if (requestsHold?.match(r)) {
        requestsHold.arrive()
        await requestsHold.released
      }
      response = await route(r)
    } finally {
      if (accountingCall) {
        inFlight.set(tenantId, (inFlight.get(tenantId) ?? 1) - 1)
      }
    }
    r.status = response.status

    // Xero did it; the answer never got back (a dropped connection, the
    // action's own timeout).
    if (losing && isContactWrite(r) && response.status === 200) {
      const key = r.headers['idempotency-key'] ?? null
      const again = losing.retries && key !== null && key === losing.key
      if (losing.left > 0 || again) {
        if (losing.left > 0) {
          losing.left -= 1
          losing.key = key
        }
        r.lost = true
        throw new TypeError('fetch failed')
      }
    }
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
      if (r.path === CONTACTS_PATH && r.method === 'GET') {
        return listContacts(r)
      }
      if (isContactWrite(r)) return writeContacts(r)
    }
    return new Response(`not faked: ${r.method} https://${r.host}${r.path}`, {
      status: 500,
    })
  }

  function holdWhere(match: (r: XeroRequest) => boolean) {
    let release!: () => void
    let arrive!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const arrived = new Promise<void>((resolve) => (arrive = resolve))
    requestsHold = { match, released, arrive }
    return {
      arrived,
      release: () => {
        requestsHold = null
        release()
      },
    }
  }

  /** One contact as Xero holds it now, in whichever organisation. */
  function findContact(contactId: string): StoredContact | undefined {
    for (const book of contactBook.values()) {
      const found = book.find((c) => c.contactId === contactId)
      if (found) return found
    }
    return undefined
  }

  /** Someone changes a contact in Xero itself. */
  function editInXero(contactId: string, change: Partial<FakeContact>): void {
    const found = findContact(contactId)
    if (!found) throw new Error(`no Xero contact ${contactId}`)
    Object.assign(found, change, { updatedAt: Date.now() })
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
                r.path === '/api.xro/2.0/Organisation' ||
                (r.path === CONTACTS_PATH &&
                  ['GET', 'PUT', 'POST'].includes(r.method))))
          ),
      ),
    /** Contact writes, whatever Xero said: creates (PUT) and updates
     * (POST). */
    contactWrites: () =>
      requests.filter(
        (r) =>
          r.host === 'api.xero.com' &&
          r.path === CONTACTS_PATH &&
          (r.method === 'PUT' || r.method === 'POST'),
      ),
    creates: () => where('api.xero.com', CONTACTS_PATH, 'PUT'),
    updates: () => where('api.xero.com', CONTACTS_PATH, 'POST'),
    /** `GET /Contacts?IDs=…`: particular contacts, by id. */
    idReads: () =>
      where('api.xero.com', CONTACTS_PATH, 'GET').filter((r) =>
        r.query.has('IDs'),
      ),
    /** `GET /Contacts?where=…`: contacts by name or account number. */
    whereReads: () =>
      where('api.xero.com', CONTACTS_PATH, 'GET').filter((r) =>
        r.query.has('where'),
      ),
    /** `GET /Contacts` of the whole book, page by page. */
    bookReads: () =>
      where('api.xero.com', CONTACTS_PATH, 'GET').filter(
        (r) => !r.query.has('IDs') && !r.query.has('where'),
      ),
    /** One contact as Xero holds it now, in whichever organisation. */
    contact: findContact,
    /** One contact as Xero would list it (`GET /Contacts`): every phone and
     * address slot, its people, its status. */
    view(contactId: string): XeroContactView {
      const found = findContact(contactId)
      if (!found) throw new Error(`no Xero contact ${contactId}`)
      return contactJson(found)
    },
    /** The organisation's contacts of this name (Xero ignores case). */
    named(tenantId: string, name: string): Array<StoredContact> {
      return (contactBook.get(tenantId) ?? []).filter((c) =>
        sameName(c.name, name),
      )
    },
    /** Adds contacts to an organisation's, after those it has — someone
     * adding them in Xero. Returns them as held. */
    addContacts(
      tenantId: string,
      rows: Array<FakeContact>,
    ): Array<StoredContact> {
      tenant({ tenantId })
      const stored = rows.map((row): StoredContact => ({
        ...row,
        contactId: row.contactId ?? uuid(),
        status: row.status ?? 'ACTIVE',
        updatedAt: Date.now(),
      }))
      contactBook.set(tenantId, [
        ...(contactBook.get(tenantId) ?? []),
        ...stored,
      ])
      return stored
    },
    /** Someone changes a contact in Xero itself. */
    editInXero,
    /** Someone merges contact `from` into `into` in Xero: `from` is
     * ARCHIVED, pointing at the one it was merged into. */
    merge(from: string, into: string): void {
      editInXero(from, { status: 'ARCHIVED', mergedToContactId: into })
    },
    /** Someone archives a contact in Xero. */
    archive(contactId: string): void {
      editInXero(contactId, { status: 'ARCHIVED' })
    },
    /** A privacy request: Xero is erasing the contact. */
    gdpr(contactId: string): void {
      editInXero(contactId, { status: 'GDPRREQUEST' })
    },
    /** The next Accounting call (to `tenantId`, when given) is refused as
     * over a limit: the minute's or the day's, with `retryAfter` seconds to
     * wait; or too many at once, with none. Queued, so several can be set. */
    next429(
      problem: 'minute' | 'day' | 'concurrent',
      retryAfter?: number,
      opts: { tenantId?: string } = {},
    ): void {
      rateLimits.push({ problem, retryAfter, tenantId: opts.tenantId })
    },
    /** The next `count` Accounting calls (to `tenantId`, when given) answer a
     * bare 503: Xero is down, with no word on when it is back. */
    next5xx(count = 1, opts: { tenantId?: string } = {}): void {
      for (let i = 0; i < count; i++) outages.push({ tenantId: opts.tenantId })
    },
    /** Other apps have used the organisation's day: `remaining` calls are
     * left (when that is fewer than now), spent two minutes ago so the
     * minute's allowance is untouched. */
    dayRemaining(remaining: number, tenantId: string): void {
      const now = Date.now()
      const log = (accountingCalls.get(tenantId) ?? []).filter(
        (at) => at > now - DAY_MS,
      )
      const spent = DAY_LIMIT - remaining - log.length
      for (let i = 0; i < spent; i++) log.push(now - 2 * 60_000)
      accountingCalls.set(
        tenantId,
        log.sort((a, b) => a - b),
      )
    },
    /**
     * The next contact write that Xero saves never gets its answer back to
     * the app: Xero acted, the app is told the call failed. With `retries`,
     * every later write with the same Idempotency-Key loses its answer too —
     * the line stays down for that request's retries, and a new key gets
     * through.
     */
    loseResponseAfterCommit({ retries = false }: { retries?: boolean } = {}) {
      losing = { left: 1, retries, key: null }
    },
    /** Xero rewrites `field` (Xero's name: 'PhoneNumber', 'EmailAddress',
     * 'Name', 'AddressLine1' …) as `rule` says when it is written. */
    normalise(field: string, rule: (value: string) => string): void {
      normalisers.set(field, rule)
    },
    /** Xero refuses an element of a write, with this message, when `rule`
     * returns one: a validation the fake doesn't model itself. `null` puts
     * it back. */
    refuseItems(
      rule: ((contact: Record<string, unknown>) => string | null) | null,
    ): void {
      refuser = rule
    },
    /** Every access token handed out so far has lapsed at Xero (a 401),
     * though PestM8's own record says it has time left. */
    expireAccessTokens(): void {
      for (const row of accessTokens.values()) row.expiresAt = 0
    },
    /** Called with every request as it arrives, before Xero answers it.
     * Returns a function that stops it. */
    onRequest(hook: (r: XeroRequest) => void | Promise<void>): () => void {
      requestHooks.push(hook)
      return () => {
        const at = requestHooks.indexOf(hook)
        if (at !== -1) requestHooks.splice(at, 1)
      }
    },
    /** Makes every request `match` picks wait until `release()`;
     * `arrived` resolves once the first is waiting — mid-drain, the
     * organisation held. */
    holdRequests: holdWhere,
    /** `holdRequests` for contact writes (PUT and POST). */
    holdWrites: () => holdWhere(isContactWrite),
    /** The most Accounting calls to one organisation ever under way at
     * once. */
    mostAtOnce(tenantId: string): number {
      return mostInFlight.get(tenantId) ?? 0
    },
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
