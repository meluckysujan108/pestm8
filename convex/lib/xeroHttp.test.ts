import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { bytesToBase64Url } from './base64'
import {
  XeroError,
  classify,
  decodeJwtPayload,
  deleteConnection,
  exchangeCode,
  getOrganisation,
  listConnections,
  refreshTokens,
  revokeRefreshToken,
} from './xeroHttp'
import type { Classified } from './xeroHttp'
import type { MockInstance } from 'vitest'

const NOW = Date.parse('2026-10-06T02:00:00Z')
const headers = (init: Record<string, string> = {}) => new Headers(init)

/** Xero's 403 body, as the API and /connections send it. */
const forbidden = (detail: string) => ({
  Type: null,
  Title: 'Forbidden',
  Status: 403,
  Detail: detail,
  Instance: '00000000-0000-0000-0000-000000000000',
  Extensions: {},
})

describe('classify', () => {
  test.each([200, 201, 204])('%i → ok', (status) => {
    expect(classify(status, headers(), null, NOW)).toEqual({ kind: 'ok' })
  })

  test('401 → refresh', () => {
    expect(classify(401, headers(), null, NOW)).toEqual({ kind: 'refresh' })
  })

  test.each(['AuthenticationUnsuccessful', 'AuthorizationUnsuccessful'])(
    '403 %s → reconnect',
    (detail) => {
      expect(classify(403, headers(), forbidden(detail), NOW)).toEqual({
        kind: 'reconnect',
        code: detail,
      })
    },
  )

  test('403 AuthenticationUnsuccessful as plain text → reconnect', () => {
    expect(classify(403, headers(), 'AuthenticationUnsuccessful', NOW)).toEqual(
      { kind: 'reconnect', code: 'AuthenticationUnsuccessful' },
    )
  })

  test('403 for anything else → stop', () => {
    expect(
      classify(403, headers(), { Type: 'NoPermission', Title: 'Nope' }, NOW),
    ).toEqual({ kind: 'stop', code: 'NoPermission', status: 403 })
    expect(classify(403, headers(), null, NOW)).toEqual({
      kind: 'stop',
      code: 'http_403',
      status: 403,
    })
  })

  test('400 invalid_grant (a dead refresh token) → reconnect', () => {
    expect(classify(400, headers(), { error: 'invalid_grant' }, NOW)).toEqual({
      kind: 'reconnect',
      code: 'invalid_grant',
    })
  })

  test('400 stop, coded from the OAuth error or the API type', () => {
    expect(classify(400, headers(), { error: 'invalid_client' }, NOW)).toEqual({
      kind: 'stop',
      code: 'invalid_client',
      status: 400,
    })
    expect(
      classify(
        400,
        headers(),
        { Type: 'ValidationException', Message: 'A validation exception…' },
        NOW,
      ),
    ).toEqual({ kind: 'stop', code: 'ValidationException', status: 400 })
  })

  test('a code-shaped code only: free text falls back to the status', () => {
    expect(
      classify(400, headers(), { error: 'something <b>odd</b>' }, NOW),
    ).toEqual({ kind: 'stop', code: 'http_400', status: 400 })
    expect(classify(404, headers(), 'Not Found', NOW)).toEqual({
      kind: 'stop',
      code: 'http_404',
      status: 404,
    })
  })

  test('429 minute with Retry-After → pause until then', () => {
    expect(
      classify(
        429,
        headers({ 'Retry-After': '42', 'X-Rate-Limit-Problem': 'minute' }),
        null,
        NOW,
      ),
    ).toEqual({ kind: 'pause', until: NOW + 42_000, why: 'minute' })
  })

  test('429 day → pause for the day', () => {
    expect(
      classify(
        429,
        headers({ 'Retry-After': '36000', 'X-Rate-Limit-Problem': 'day' }),
        null,
        NOW,
      ),
    ).toEqual({ kind: 'pause', until: NOW + 36_000_000, why: 'day' })
  })

  test('429 app-wide minute, or unnamed, counts as a minute', () => {
    for (const problem of ['appminute', '']) {
      expect(
        classify(
          429,
          headers({ 'Retry-After': '5', 'X-Rate-Limit-Problem': problem }),
          null,
          NOW,
        ),
      ).toEqual({ kind: 'pause', until: NOW + 5000, why: 'minute' })
    }
  })

  test('429 with Retry-After as an HTTP date', () => {
    const at = new Date(NOW + 90_000).toUTCString()
    expect(
      classify(
        429,
        headers({ 'retry-after': at, 'x-rate-limit-problem': 'Minute' }),
        null,
        NOW,
      ),
    ).toEqual({ kind: 'pause', until: NOW + 90_000, why: 'minute' })
  })

  test('429 without Retry-After (too many at once) → retry', () => {
    expect(
      classify(
        429,
        headers({ 'X-Rate-Limit-Problem': 'concurrent' }),
        null,
        NOW,
      ),
    ).toEqual({ kind: 'retry', afterMs: 1000 })
    expect(classify(429, headers(), null, NOW)).toEqual({
      kind: 'retry',
      afterMs: 1000,
    })
  })

  test('429 concurrent never pauses, even with a Retry-After', () => {
    expect(
      classify(
        429,
        headers({ 'Retry-After': '3', 'X-Rate-Limit-Problem': 'concurrent' }),
        null,
        NOW,
      ),
    ).toEqual({ kind: 'retry', afterMs: 3000 })
  })

  test('503 with Retry-After (a planned outage) → pause', () => {
    expect(classify(503, headers({ 'Retry-After': '600' }), null, NOW)).toEqual(
      { kind: 'pause', until: NOW + 600_000, why: 'server' },
    )
  })

  test.each([500, 502, 503, 504])('%i without Retry-After → retry', (s) => {
    expect(classify(s, headers(), 'Service Unavailable', NOW)).toEqual({
      kind: 'retry',
      afterMs: 5000,
    })
  })

  test('an unreadable Retry-After is no Retry-After', () => {
    expect(
      classify(429, headers({ 'Retry-After': 'soon' }), null, NOW),
    ).toEqual({ kind: 'retry', afterMs: 1000 })
  })
})

describe('decodeJwtPayload', () => {
  const segment = (value: unknown) =>
    bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)))
  const jwt = (payload: unknown) =>
    `${segment({ alg: 'RS256', typ: 'JWT' })}.${segment(payload)}.c2lnbmF0dXJl`

  test('reads the claims the callback keys on', () => {
    const claims = {
      xero_userid: '9a1b2c3d-0000-4000-8000-000000000001',
      authentication_event_id: 'ae-123',
      name: 'Kévin Ñ',
      exp: 1_790_000_000,
    }
    expect(decodeJwtPayload(jwt(claims))).toEqual(claims)
  })

  test('throws on anything that is not a JWT with an object inside', () => {
    const good = jwt({ a: 1 })
    const [head, body] = good.split('.')
    const bad = [
      '',
      'opaque-token',
      `${head}.${body}`,
      `${good}.extra`,
      `${head}.!!!.sig`,
      `${head}.${bytesToBase64Url(new TextEncoder().encode('not json'))}.sig`,
      jwt([1, 2]),
      jwt('text'),
      jwt(null),
    ]
    for (const token of bad) {
      expect(() => decodeJwtPayload(token)).toThrow('Not a JWT')
    }
  })
})

describe('calls to Xero', () => {
  type Request = {
    url: string
    method: string
    headers: Record<string, string>
    body: string
  }
  let requests: Request[]
  let reply: (request: Request) => Response | Promise<Response>
  let errors: MockInstance<typeof console.error>

  const json = (body: unknown, status = 200, extra = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...extra },
    })

  beforeEach(() => {
    vi.stubEnv('XERO_CLIENT_ID', 'the-client-id')
    vi.stubEnv('XERO_CLIENT_SECRET', 'the-client-secret')
    vi.stubEnv('XERO_REDIRECT_URI', undefined)
    vi.stubEnv('CONVEX_SITE_URL', 'https://example-123.convex.site/')
    requests = []
    reply = () => json({})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const request = {
          url: String(input),
          method: init?.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: typeof init?.body === 'string' ? init.body : '',
        }
        requests.push(request)
        return await reply(request)
      }),
    )
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** What a call threw, as `classify` judged it. */
  async function classified(promise: Promise<unknown>): Promise<Classified> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(XeroError)
    return (error as XeroError).classified
  }

  const logged = () => errors.mock.calls.map((c) => c.join(' ')).join('\n')

  test('exchangeCode: Basic auth, the code, and the same redirect_uri', async () => {
    reply = () =>
      json({
        access_token: 'AT-1',
        refresh_token: 'RT-1',
        expires_in: 1800,
        token_type: 'Bearer',
        scope: 'openid  offline_access accounting.contacts',
        id_token: 'ID-1',
      })
    const set = await exchangeCode('the-code')

    expect(set).toEqual({
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      expiresIn: 1800,
      scopes: ['openid', 'offline_access', 'accounting.contacts'],
      idToken: 'ID-1',
    })
    const [request] = requests
    expect(request.url).toBe('https://identity.xero.com/connect/token')
    expect(request.method).toBe('POST')
    expect(request.headers.authorization).toBe(
      `Basic ${btoa('the-client-id:the-client-secret')}`,
    )
    expect(request.headers['content-type']).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://example-123.convex.site/xero/callback',
    })
  })

  test('refreshTokens: a dead refresh token → reconnect, logged without it', async () => {
    reply = () =>
      json({ error: 'invalid_grant', error_description: 'grant expired' }, 400)
    expect(await classified(refreshTokens('RT-SECRET'))).toEqual({
      kind: 'reconnect',
      code: 'invalid_grant',
    })
    expect(Object.fromEntries(new URLSearchParams(requests[0].body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'RT-SECRET',
    })
    expect(logged()).toContain('HTTP 400')
    expect(logged()).toContain('invalid_grant')
    expect(logged()).not.toContain('RT-SECRET')
    expect(logged()).not.toContain('the-client-secret')
  })

  test('a 2xx without a token set → stop, and its body is never logged', async () => {
    reply = () => json({ access_token: 'AT-LEAK', expires_in: 1800 })
    expect(await classified(refreshTokens('RT-1'))).toEqual({
      kind: 'stop',
      code: 'bad_response',
      status: 200,
    })
    expect(logged()).not.toContain('AT-LEAK')
  })

  test('could not reach Xero → retry in 5 s', async () => {
    reply = () => {
      throw new TypeError('fetch failed')
    }
    expect(await classified(refreshTokens('RT-1'))).toEqual({
      kind: 'retry',
      afterMs: 5000,
    })
  })

  test('no answer in 20 s → aborted, retry in 5 s', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init?.signal ?? undefined
            signal?.addEventListener('abort', () => reject(signal?.reason))
          }),
      ),
    )
    const outcome = classified(refreshTokens('RT-1'))
    await vi.advanceTimersByTimeAsync(19_999)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signal?.aborted).toBe(true)
    expect(await outcome).toEqual({ kind: 'retry', afterMs: 5000 })
    expect(logged()).toContain('no answer in 20 s')
  })

  test('revokeRefreshToken posts the token with Basic auth', async () => {
    reply = () => new Response(null, { status: 200 })
    await revokeRefreshToken('RT-1')
    const [request] = requests
    expect(request.url).toBe('https://identity.xero.com/connect/revocation')
    expect(request.method).toBe('POST')
    expect(request.headers.authorization).toMatch(/^Basic /)
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      token: 'RT-1',
    })
  })

  test('listConnections: by auth event, every field, newest first', async () => {
    reply = () =>
      json([
        {
          id: 'c-old',
          authEventId: 'ae-1',
          tenantId: 't-old',
          tenantType: 'ORGANISATION',
          tenantName: 'Old Org',
          createdDateUtc: '2026-01-01T00:00:00.0000000',
          updatedDateUtc: '2026-01-01T00:00:00.0000000',
        },
        {
          id: 'c-new',
          authEventId: 'ae-1',
          tenantId: 't-new',
          tenantType: 'PRACTICE',
          tenantName: null,
          updatedDateUtc: '2026-10-06T01:00:00.1234567',
        },
        { id: 'missing-tenant' },
        'junk',
      ])
    const tenants = await listConnections('AT-1', 'ae 1/2')

    expect(requests[0].url).toBe(
      'https://api.xero.com/connections?authEventId=ae%201%2F2',
    )
    expect(requests[0].headers.authorization).toBe('Bearer AT-1')
    expect(tenants).toEqual([
      {
        id: 'c-new',
        authEventId: 'ae-1',
        tenantId: 't-new',
        tenantType: 'PRACTICE',
        tenantName: '',
        updatedAt: Date.parse('2026-10-06T01:00:00.123Z'),
      },
      {
        id: 'c-old',
        authEventId: 'ae-1',
        tenantId: 't-old',
        tenantType: 'ORGANISATION',
        tenantName: 'Old Org',
        updatedAt: Date.parse('2026-01-01T00:00:00Z'),
      },
    ])
  })

  test('listConnections without an auth event asks for them all', async () => {
    reply = () => json([])
    expect(await listConnections('AT-1')).toEqual([])
    expect(requests[0].url).toBe('https://api.xero.com/connections')
  })

  test('deleteConnection: 204 and 404 are both done; 403 is not', async () => {
    reply = () => new Response(null, { status: 204 })
    await deleteConnection('AT-1', 'conn/1')
    expect(requests[0]).toMatchObject({
      url: 'https://api.xero.com/connections/conn%2F1',
      method: 'DELETE',
    })

    reply = () => new Response(null, { status: 404 })
    await deleteConnection('AT-1', 'conn-1')
    expect(errors).not.toHaveBeenCalled()

    reply = () => json(forbidden('AuthenticationUnsuccessful'), 403)
    expect(await classified(deleteConnection('AT-1', 'conn-1'))).toEqual({
      kind: 'reconnect',
      code: 'AuthenticationUnsuccessful',
    })
  })

  test('getOrganisation names its tenant and reads the name and short code', async () => {
    reply = () =>
      json({
        Id: 'x',
        Status: 'OK',
        Organisations: [{ Name: 'Pest M8 Pest Control', ShortCode: '!k3Lp9' }],
      })
    expect(await getOrganisation('AT-1', 'tenant-1')).toEqual({
      name: 'Pest M8 Pest Control',
      shortCode: '!k3Lp9',
    })
    const [request] = requests
    expect(request.url).toBe('https://api.xero.com/api.xro/2.0/Organisation')
    expect(request.headers['xero-tenant-id']).toBe('tenant-1')
    expect(request.headers.authorization).toBe('Bearer AT-1')
    expect(request.headers.accept).toBe('application/json')
  })

  test('getOrganisation without a short code leaves it out', async () => {
    reply = () => json({ Organisations: [{ Name: 'Demo Company (AU)' }] })
    expect(await getOrganisation('AT-1', 'tenant-1')).toEqual({
      name: 'Demo Company (AU)',
    })
  })

  test('a rate limit comes back as a pause', async () => {
    reply = () =>
      json({ Title: 'Too Many Requests' }, 429, {
        'Retry-After': '30',
        'X-Rate-Limit-Problem': 'minute',
      })
    const outcome = await classified(getOrganisation('AT-1', 'tenant-1'))
    expect(outcome).toMatchObject({ kind: 'pause', why: 'minute' })
  })
})
