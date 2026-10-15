import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { bytesToBase64Url } from './base64'
import {
  CONTACTS_PAGE_SIZE,
  CONTACT_IDS_PER_READ,
  XeroError,
  checkAppCredentials,
  classify,
  decodeJwtPayload,
  deleteConnection,
  exchangeCode,
  getContactByName,
  getContactsByIds,
  getContactsPage,
  getOrganisation,
  isAppSetupRefusal,
  isNameClash,
  listConnections,
  newIdempotencyKey,
  postContacts,
  putContacts,
  rateFrom,
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

  test.each([
    [400, 'invalid_client'],
    [401, 'invalid_client'],
    [400, 'unauthorized_client'],
    [400, 'invalid_request'],
  ])(
    '%i %s (Xero refusing the app’s own keys) → stop, whatever the status',
    (status, error) => {
      expect(classify(status, headers(), { error }, NOW)).toEqual({
        kind: 'stop',
        code: error,
        status,
      })
    },
  )

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

  test('checkAppCredentials: a client-credentials ask with Basic auth; the token it is given is dropped unread', async () => {
    reply = () =>
      json({
        access_token: 'APP-ONLY-TOKEN',
        expires_in: 1800,
        token_type: 'Bearer',
      })
    expect(await checkAppCredentials()).toEqual({ ok: true })
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request.url).toBe('https://identity.xero.com/connect/token')
    expect(request.method).toBe('POST')
    expect(request.headers.authorization).toBe(
      `Basic ${btoa('the-client-id:the-client-secret')}`,
    )
    expect(new URLSearchParams(request.body).get('grant_type')).toBe(
      'client_credentials',
    )
    expect(logged()).not.toContain('APP-ONLY-TOKEN')
  })

  test.each([
    ['a wrong secret', 'invalid_client'],
    ['a secret pasted twice (over 100 characters)', 'invalid_request'],
  ])(
    'checkAppCredentials: %s → its code, and isAppSetupRefusal knows it',
    async (_why, error) => {
      reply = () => json({ error }, 400)
      expect(await checkAppCredentials()).toEqual({ ok: false, error })
      reply = () => json({ error }, 400)
      const thrown = await exchangeCode('a-code').then(
        () => null,
        (e: unknown) => e,
      )
      expect(isAppSetupRefusal(thrown)).toBe(true)
    },
  )

  test('isAppSetupRefusal: a used code or Xero being down is not the app’s keys', async () => {
    reply = () => json({ error: 'invalid_grant' }, 400)
    const usedCode = await exchangeCode('a-code').then(
      () => null,
      (e: unknown) => e,
    )
    expect(isAppSetupRefusal(usedCode)).toBe(false)
    reply = () => json({}, 503)
    const down = await exchangeCode('a-code').then(
      () => null,
      (e: unknown) => e,
    )
    expect(isAppSetupRefusal(down)).toBe(false)
    expect(isAppSetupRefusal(new Error('anything else'))).toBe(false)
  })

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

  describe('getContactsPage', () => {
    test('asks for one page of 1,000, archived included, of its tenant', async () => {
      reply = () => json({ Contacts: [] })
      expect(await getContactsPage('AT-1', 'tenant-1', 3)).toEqual({
        contacts: [],
        rate: {},
      })
      const [request] = requests
      expect(request.method).toBe('GET')
      expect(request.url).toBe(
        'https://api.xero.com/api.xro/2.0/Contacts?page=3&pageSize=1000&includeArchived=true',
      )
      expect(request.headers['xero-tenant-id']).toBe('tenant-1')
      expect(request.headers.authorization).toBe('Bearer AT-1')
      expect(request.headers.accept).toBe('application/json')
      expect(request.body).toBe('')
      expect(CONTACTS_PAGE_SIZE).toBe(1000)
    })

    test('maps Xero’s fields, trimmed, leaving out what is empty', async () => {
      reply = () =>
        json({
          Id: 'x',
          Status: 'OK',
          Contacts: [
            {
              ContactID: 'c-1',
              ContactStatus: 'ACTIVE',
              Name: ' John Smith ',
              FirstName: 'John',
              LastName: 'Smith',
              EmailAddress: 'john@example.com',
              AccountNumber: '0042',
              Phones: [
                { PhoneType: 'DDI', PhoneNumber: '' },
                { PhoneType: 'FAX', PhoneNumber: '9999 0000' },
                {
                  PhoneType: 'MOBILE',
                  PhoneNumber: '0412 345 678',
                  PhoneAreaCode: '',
                },
                {
                  PhoneType: 'DEFAULT',
                  PhoneNumber: '9123 4567',
                  PhoneAreaCode: '08',
                  PhoneCountryCode: '61',
                },
              ],
              Addresses: [
                { AddressType: 'POBOX', City: '' },
                { AddressType: 'STREET', City: 'Nightcliff' },
              ],
            },
            {
              ContactID: 'c-2',
              ContactStatus: 'ARCHIVED',
              Name: 'Old Co',
              EmailAddress: '',
              AccountNumber: '   ',
              Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: '' }],
              Addresses: [],
            },
            { ContactID: 'c-3', ContactStatus: 'GDPRREQUEST', Name: 'Gone' },
          ],
        })
      const { contacts } = await getContactsPage('AT-1', 'tenant-1', 1)
      expect(contacts).toEqual([
        {
          contactId: 'c-1',
          name: 'John Smith',
          status: 'ACTIVE',
          email: 'john@example.com',
          accountNumber: '0042',
          phone: '08 9123 4567',
          place: 'Nightcliff',
          firstName: 'John',
          lastName: 'Smith',
        },
        { contactId: 'c-2', name: 'Old Co', status: 'ARCHIVED' },
        { contactId: 'c-3', name: 'Gone', status: 'GDPRREQUEST' },
      ])
    })

    test('the main line first, then mobile; a fax is never the phone', async () => {
      reply = () =>
        json({
          Contacts: [
            {
              ContactID: 'c-1',
              Name: 'A',
              Phones: [
                { PhoneType: 'FAX', PhoneNumber: '9999 0000' },
                { PhoneType: 'MOBILE', PhoneNumber: '0412 345 678' },
              ],
            },
            {
              ContactID: 'c-2',
              Name: 'B',
              Phones: [{ PhoneType: 'FAX', PhoneNumber: '9999 0000' }],
            },
          ],
        })
      const { contacts } = await getContactsPage('AT-1', 'tenant-1', 1)
      expect(contacts.map((c) => c.phone)).toEqual(['0412 345 678', undefined])
    })

    test('a missing status is ACTIVE; one Xero adds later is never a candidate', async () => {
      reply = () =>
        json({
          Contacts: [
            { ContactID: 'c-1', Name: 'No status' },
            { ContactID: 'c-2', Name: 'Odd', ContactStatus: 'SOMETHINGNEW' },
          ],
        })
      const { contacts } = await getContactsPage('AT-1', 'tenant-1', 1)
      expect(contacts.map((c) => c.status)).toEqual(['ACTIVE', 'ARCHIVED'])
    })

    test('a row without a ContactID is dropped; one without a Name is kept', async () => {
      reply = () =>
        json({
          Contacts: [
            { Name: 'No id' },
            { ContactID: '  ', Name: 'Blank id' },
            'junk',
            null,
            { ContactID: 'c-1' },
          ],
        })
      const { contacts } = await getContactsPage('AT-1', 'tenant-1', 1)
      expect(contacts).toEqual([
        { contactId: 'c-1', name: '', status: 'ACTIVE' },
      ])
    })

    test('reads what is left of the allowance from the headers', async () => {
      reply = () =>
        json({ Contacts: [] }, 200, {
          'X-DayLimit-Remaining': '4987',
          'X-MinLimit-Remaining': '58',
          'X-AppMinLimit-Remaining': '9999',
        })
      expect((await getContactsPage('AT-1', 'tenant-1', 1)).rate).toEqual({
        dayRemaining: 4987,
        minRemaining: 58,
      })
    })

    test('an unreadable allowance is left out', () => {
      expect(
        rateFrom(
          headers({
            'X-DayLimit-Remaining': 'lots',
            'X-MinLimit-Remaining': ' 0 ',
          }),
        ),
      ).toEqual({ minRemaining: 0 })
    })

    test('a 2xx without Contacts → stop', async () => {
      reply = () => json({ Organisations: [] })
      expect(await classified(getContactsPage('AT-1', 'tenant-1', 1))).toEqual({
        kind: 'stop',
        code: 'bad_response',
        status: 200,
      })
    })

    test('refusals are classified like every other call', async () => {
      reply = () => json(forbidden('AuthorizationUnsuccessful'), 403)
      expect(await classified(getContactsPage('AT-1', 'tenant-1', 1))).toEqual({
        kind: 'reconnect',
        code: 'AuthorizationUnsuccessful',
      })

      reply = () =>
        json({ Title: 'Too Many Requests' }, 429, {
          'Retry-After': '20',
          'X-Rate-Limit-Problem': 'minute',
          'X-MinLimit-Remaining': '0',
        })
      expect(
        await classified(getContactsPage('AT-1', 'tenant-1', 1)),
      ).toMatchObject({ kind: 'pause', why: 'minute' })

      reply = () => new Response('Service Unavailable', { status: 503 })
      expect(await classified(getContactsPage('AT-1', 'tenant-1', 1))).toEqual({
        kind: 'retry',
        afterMs: 5000,
      })
      expect(logged()).not.toContain('AT-1')
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

  describe('contact writes and reads (Release 3)', () => {
    const ID_1 = '6d3c1b2a-0000-4000-8000-000000000001'
    const ID_2 = '6d3c1b2a-0000-4000-8000-000000000002'
    const NO_ID = '00000000-0000-0000-0000-000000000000'
    const KEY = 'k'.repeat(128)

    /** A contact as Xero answers a write or a read: everything there, most
     * of it blank. */
    const answered = (over: Record<string, unknown> = {}) => ({
      ContactID: ID_1,
      ContactStatus: 'ACTIVE',
      Name: 'John Smith',
      FirstName: 'John',
      LastName: 'Smith',
      EmailAddress: 'john@example.com',
      AccountNumber: '1916',
      BankAccountDetails: '',
      TaxNumber: '',
      Addresses: [
        { AddressType: 'POBOX', City: '', Region: '', PostalCode: '' },
        {
          AddressType: 'STREET',
          AddressLine1: '12 Casuarina Drive',
          City: 'Nightcliff',
          Region: 'NT',
          PostalCode: '0810',
          Country: 'Australia',
        },
      ],
      Phones: [
        { PhoneType: 'DDI', PhoneNumber: '', PhoneAreaCode: '' },
        { PhoneType: 'DEFAULT', PhoneNumber: '', PhoneAreaCode: '' },
        { PhoneType: 'FAX', PhoneNumber: '', PhoneAreaCode: '' },
        {
          PhoneType: 'MOBILE',
          PhoneNumber: '0412 345 678',
          PhoneAreaCode: '',
          PhoneCountryCode: '',
        },
      ],
      ContactPersons: [],
      UpdatedDateUTC: '/Date(1790000000000+0000)/',
      IsSupplier: false,
      IsCustomer: false,
      HasValidationErrors: false,
      ...over,
    })

    /** A failed element of a batch, as Xero sends it under
     * summarizeErrors=false: all-zero id, and why. */
    const refused = (name: string, message: string) => ({
      ContactID: NO_ID,
      Name: name,
      StatusAttributeString: 'ERROR',
      HasValidationErrors: true,
      ValidationErrors: [{ Message: message }],
      Phones: [],
      Addresses: [],
    })

    const CLASH =
      'The contact name John Smith is already assigned to another contact. The contact name must be unique across all active contacts.'

    test('newIdempotencyKey: 128 hex characters, fresh every time', () => {
      const keys = Array.from({ length: 20 }, newIdempotencyKey)
      for (const key of keys) expect(key).toMatch(/^[0-9a-f]{128}$/)
      expect(new Set(keys).size).toBe(keys.length)
    })

    test('isNameClash knows Xero’s words for a name already taken', () => {
      expect(isNameClash(CLASH)).toBe(true)
      expect(
        isNameClash(
          'The contact name O’Brien & Co is already assigned to another contact.',
        ),
      ).toBe(true)
      expect(isNameClash('Email address must be valid.')).toBe(false)
      expect(
        isNameClash(
          'The account number is already assigned to another contact',
        ),
      ).toBe(false)
      expect(isNameClash('')).toBe(false)
    })

    test('putContacts: PUT, per-item errors, its tenant and its key', async () => {
      reply = () =>
        json({ Contacts: [answered(), refused('Jane Doe', CLASH)] }, 200, {
          'X-DayLimit-Remaining': '4321',
          'X-MinLimit-Remaining': '57',
        })
      const sent = [{ Name: 'John Smith' }, { Name: 'Jane Doe' }]
      const { results, rate } = await putContacts('AT-1', 'tenant-1', sent, KEY)

      const [request] = requests
      expect(requests).toHaveLength(1)
      expect(request.method).toBe('PUT')
      expect(request.url).toBe(
        'https://api.xero.com/api.xro/2.0/Contacts?summarizeErrors=false',
      )
      expect(request.headers).toMatchObject({
        authorization: 'Bearer AT-1',
        accept: 'application/json',
        'content-type': 'application/json',
        'xero-tenant-id': 'tenant-1',
        'idempotency-key': KEY,
      })
      expect(JSON.parse(request.body)).toEqual({ Contacts: sent })

      expect(rate).toEqual({ dayRemaining: 4321, minRemaining: 57 })
      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({
        name: 'John Smith',
        errors: [],
        contact: {
          ContactID: ID_1,
          Name: 'John Smith',
          FirstName: 'John',
          LastName: 'Smith',
          EmailAddress: 'john@example.com',
          AccountNumber: '1916',
          TaxNumber: '',
          ContactStatus: 'ACTIVE',
          Phones: answered().Phones,
          Addresses: answered().Addresses,
          ContactPersons: [],
        },
      })
      // The failed one: no contact (its id was all zeros), and why.
      expect(results[1]).toEqual({ name: 'Jane Doe', errors: [CLASH] })
      expect(isNameClash(results[1].errors[0])).toBe(true)
      // A success is never logged; it carries the client's details.
      expect(errors).not.toHaveBeenCalled()
    })

    test('a failed element without words, or a written one without an id', async () => {
      reply = () =>
        json({
          Contacts: [
            { ContactID: NO_ID, Name: 'A', StatusAttributeString: 'ERROR' },
            { ContactID: NO_ID, Name: 'B' },
            'junk',
          ],
        })
      const { results } = await putContacts(
        'AT-1',
        'tenant-1',
        [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }],
        KEY,
      )
      expect(results.map((r) => r.contact)).toEqual([
        undefined,
        undefined,
        undefined,
      ])
      for (const result of results) expect(result.errors).toHaveLength(1)
      expect(results.map((r) => r.name)).toEqual(['A', 'B', undefined])
    })

    test('an answer without one result per contact sent cannot be read', async () => {
      reply = () => json({ Contacts: [answered()] })
      expect(
        await classified(
          putContacts('AT-1', 'tenant-1', [{ Name: 'A' }, { Name: 'B' }], KEY),
        ),
      ).toEqual({ kind: 'stop', code: 'bad_response', status: 200 })
    })

    test('nothing to create, a blank tenant or a bad key sends nothing', async () => {
      expect(await putContacts('AT-1', 'tenant-1', [], KEY)).toEqual({
        results: [],
        rate: {},
      })
      await expect(
        putContacts('AT-1', ' ', [{ Name: 'A' }], KEY),
      ).rejects.toThrow('xero-tenant-id')
      await expect(
        putContacts('AT-1', 'tenant-1', [{ Name: 'A' }], 'k'.repeat(129)),
      ).rejects.toThrow('Idempotency-Key')
      await expect(
        putContacts('AT-1', 'tenant-1', [{ Name: 'A' }], ''),
      ).rejects.toThrow('Idempotency-Key')
      expect(requests).toEqual([])
    })

    test('a refused write is classified, and the token never logged', async () => {
      reply = () =>
        json({ Title: 'Too Many Requests' }, 429, {
          'Retry-After': '30',
          'X-Rate-Limit-Problem': 'day',
        })
      expect(
        await classified(
          putContacts('AT-SECRET', 'tenant-1', [{ Name: 'A' }], KEY),
        ),
      ).toMatchObject({ kind: 'pause', why: 'day' })

      reply = () => new Response('Service Unavailable', { status: 503 })
      expect(
        await classified(
          postContacts('AT-SECRET', 'tenant-1', [{ ContactID: ID_1 }], KEY),
        ),
      ).toEqual({ kind: 'retry', afterMs: 5000 })
      expect(logged()).not.toContain('AT-SECRET')
      expect(logged()).not.toContain(KEY)
    })

    test('postContacts: POST, every element naming its contact', async () => {
      reply = () =>
        json({
          Contacts: [
            answered({ EmailAddress: 'new@example.com' }),
            {
              ...answered({ ContactID: ID_2, Name: 'Acme' }),
              StatusAttributeString: 'ERROR',
              ValidationErrors: [{ Message: 'Email address must be valid.' }],
            },
          ],
        })
      const sent = [
        { ContactID: ID_1, EmailAddress: 'new@example.com' },
        { ContactID: ID_2, EmailAddress: 'not an email' },
      ]
      const { results } = await postContacts('AT-1', 'tenant-1', sent, KEY)

      const [request] = requests
      expect(request.method).toBe('POST')
      expect(request.url).toBe(
        'https://api.xero.com/api.xro/2.0/Contacts?summarizeErrors=false',
      )
      expect(request.headers['xero-tenant-id']).toBe('tenant-1')
      expect(request.headers['idempotency-key']).toBe(KEY)
      expect(JSON.parse(request.body)).toEqual({ Contacts: sent })

      expect(results[0].contact?.EmailAddress).toBe('new@example.com')
      // Refused: no contact, even though Xero echoed its real id.
      expect(results[1]).toEqual({
        name: 'Acme',
        errors: ['Email address must be valid.'],
      })
    })

    test.each([
      ['no ContactID', { Name: 'A' }],
      ['a blank one', { ContactID: '' }],
      ['Xero’s “no contact”', { ContactID: NO_ID }],
    ])(
      'postContacts refuses an element with %s, sending nothing',
      async (_why, element) => {
        await expect(
          postContacts('AT-1', 'tenant-1', [{ ContactID: ID_1 }, element], KEY),
        ).rejects.toThrow('ContactID')
        expect(requests).toEqual([])
      },
    )

    test('getContactsByIds: up to 50, archived included, in full', async () => {
      reply = () =>
        json(
          {
            Contacts: [
              answered({
                ContactPersons: [
                  {
                    FirstName: 'Sue',
                    LastName: 'Brown',
                    EmailAddress: 'sue@acme.com',
                    IncludeInEmails: true,
                  },
                  'junk',
                ],
              }),
              answered({
                ContactID: ID_2,
                ContactStatus: 'ARCHIVED',
                MergedToContactID: ID_1,
                Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: 7 }, { nope: 1 }],
              }),
              answered({ ContactID: NO_ID }),
            ],
          },
          200,
          { 'X-DayLimit-Remaining': '100' },
        )
      const { contacts, rate } = await getContactsByIds('AT-1', 'tenant-1', [
        ID_1,
        ID_2,
      ])

      const [request] = requests
      expect(request.method).toBe('GET')
      expect(request.url).toBe(
        `https://api.xero.com/api.xro/2.0/Contacts?IDs=${ID_1},${ID_2}&includeArchived=true&page=1`,
      )
      expect(request.headers['xero-tenant-id']).toBe('tenant-1')
      expect(request.headers.authorization).toBe('Bearer AT-1')
      expect(rate).toEqual({ dayRemaining: 100 })

      expect(contacts.map((c) => c.ContactID)).toEqual([ID_1, ID_2])
      expect(contacts[0].ContactPersons).toEqual([
        {
          FirstName: 'Sue',
          LastName: 'Brown',
          EmailAddress: 'sue@acme.com',
          IncludeInEmails: true,
        },
      ])
      expect(contacts[1]).toMatchObject({
        ContactStatus: 'ARCHIVED',
        MergedToContactID: ID_1,
        // Only strings are kept; a phone with no type is no phone.
        Phones: [{ PhoneType: 'DEFAULT' }],
      })
    })

    test('a merge into nothing (all zeros) is no merge', async () => {
      reply = () => json({ Contacts: [answered({ MergedToContactID: NO_ID })] })
      const { contacts } = await getContactsByIds('AT-1', 'tenant-1', [ID_1])
      expect('MergedToContactID' in contacts[0]).toBe(false)
    })

    test('getContactsByIds: none asks for nothing; more than 50 is refused', async () => {
      expect(await getContactsByIds('AT-1', 'tenant-1', [])).toEqual({
        contacts: [],
        rate: {},
      })
      expect(await getContactsByIds('AT-1', 'tenant-1', [' '])).toEqual({
        contacts: [],
        rate: {},
      })
      const many = Array.from({ length: CONTACT_IDS_PER_READ + 1 }, () => ID_1)
      await expect(getContactsByIds('AT-1', 'tenant-1', many)).rejects.toThrow(
        'at most 50',
      )
      expect(CONTACT_IDS_PER_READ).toBe(50)
      expect(requests).toEqual([])
    })

    test('getContactByName: an exact match, ACTIVE first', async () => {
      reply = () =>
        json({
          Contacts: [
            answered({ ContactID: ID_2, Name: 'John Smithers' }),
            answered({ ContactID: NO_ID, Name: 'John Smith' }),
            answered({
              ContactID: '6d3c1b2a-0000-4000-8000-000000000003',
              Name: 'john  smith',
              ContactStatus: 'GDPRREQUEST',
            }),
            answered({ ContactID: ID_1, Name: 'JOHN SMITH' }),
          ],
        })
      const found = await getContactByName('AT-1', 'tenant-1', ' John Smith ')
      expect(found?.ContactID).toBe(ID_1)

      const [request] = requests
      expect(request.method).toBe('GET')
      const url = new URL(request.url)
      expect(url.pathname).toBe('/api.xro/2.0/Contacts')
      expect(url.searchParams.get('where')).toBe('Name=="John Smith"')
      expect(url.searchParams.get('page')).toBe('1')
      expect(request.headers['xero-tenant-id']).toBe('tenant-1')
    })

    test('getContactByName: none is null; a frozen holder is still the holder', async () => {
      reply = () => json({ Contacts: [answered({ Name: 'John Smithers' })] })
      expect(
        await getContactByName('AT-1', 'tenant-1', 'John Smith'),
      ).toBeNull()

      reply = () =>
        json({
          Contacts: [
            answered({ Name: 'John Smith', ContactStatus: 'GDPRREQUEST' }),
          ],
        })
      expect(
        (await getContactByName('AT-1', 'tenant-1', 'John Smith'))
          ?.ContactStatus,
      ).toBe('GDPRREQUEST')
    })

    test('getContactByName: a quote or backslash is escaped in the filter', async () => {
      reply = () =>
        json({
          Contacts: [
            answered({ Name: 'Bob "The Builder" Jones' }),
            answered({ ContactID: ID_2, Name: 'Bob The Builder Jones' }),
          ],
        })
      const found = await getContactByName(
        'AT-1',
        'tenant-1',
        'Bob "The Builder" Jones',
      )
      expect(found?.ContactID).toBe(ID_1)
      const where = new URL(requests[0].url).searchParams.get('where')
      expect(where).toBe('Name=="Bob \\"The Builder\\" Jones"')

      await getContactByName('AT-1', 'tenant-1', 'A\\B Holdings')
      expect(new URL(requests[1].url).searchParams.get('where')).toBe(
        'Name=="A\\\\B Holdings"',
      )
    })

    test('getContactByName: a blank name or tenant asks nothing', async () => {
      expect(await getContactByName('AT-1', 'tenant-1', '  ')).toBeNull()
      await expect(getContactByName('AT-1', '', 'A')).rejects.toThrow(
        'xero-tenant-id',
      )
      expect(requests).toEqual([])
    })
  })
})
