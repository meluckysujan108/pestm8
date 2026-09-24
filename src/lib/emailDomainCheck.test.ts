import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  CLOUDFLARE_DOH,
  GOOGLE_DOH,
  checkEmailDomain,
  forgetDomainMail,
  knownDomainMail,
  readDnsReply,
} from './emailDomainCheck'

type Reply = { status?: number; json?: unknown } | 'network-error'

/** Answers each resolver URL from a table, and records what was asked. */
function stubFetch(answers: Record<string, Reply>) {
  const asked: Array<{ url: string; headers?: HeadersInit }> = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    asked.push({ url, headers: init?.headers })
    const reply = answers[url] as Reply | undefined
    if (reply === undefined || reply === 'network-error') {
      throw new TypeError('Failed to fetch')
    }
    return new Response(JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { asked, fetchMock }
}

const google = (domain: string, type: 'MX' | 'A') =>
  `${GOOGLE_DOH}?name=${domain}&type=${type}`
const cloudflare = (domain: string, type: 'MX' | 'A') =>
  `${CLOUDFLARE_DOH}?name=${domain}&type=${type}`

const MX_REPLY = {
  json: {
    Status: 0,
    Answer: [
      { name: 'gmail.com.', type: 15, data: '5 gmail-smtp-in.l.google.com.' },
    ],
  },
}

beforeEach(() => forgetDomainMail())
afterEach(() => vi.unstubAllGlobals())

describe('readDnsReply', () => {
  test('an MX record means the domain takes mail', () => {
    expect(readDnsReply(MX_REPLY.json, 15)).toBe('found')
  })

  test('NXDOMAIN is status 3', () => {
    expect(readDnsReply({ Status: 3 }, 15)).toBe('nxdomain')
  })

  test('a null MX says the domain takes no mail, with or without the dot', () => {
    expect(
      readDnsReply({ Status: 0, Answer: [{ type: 15, data: '0 .' }] }, 15),
    ).toBe('null-mx')
    expect(
      readDnsReply({ Status: 0, Answer: [{ type: 15, data: '0 ' }] }, 15),
    ).toBe('null-mx')
  })

  test('an answer of another type (a CNAME on the way) is not an MX', () => {
    expect(
      readDnsReply(
        { Status: 0, Answer: [{ type: 5, data: 'elsewhere.example.' }] },
        15,
      ),
    ).toBe('none')
  })

  test('server failure and garbage say nothing', () => {
    expect(readDnsReply({ Status: 2 }, 15)).toBe('unknown')
    expect(readDnsReply(null, 15)).toBe('unknown')
    expect(readDnsReply('nope', 15)).toBe('unknown')
  })
})

describe('checkEmailDomain', () => {
  test('asks Google first, with no custom header, and only the domain', async () => {
    const { asked } = stubFetch({ [google('gmail.com', 'MX')]: MX_REPLY })
    expect(await checkEmailDomain('Gmail.com')).toBe('receives')
    expect(asked).toEqual([
      { url: google('gmail.com', 'MX'), headers: undefined },
    ])
  })

  test('a domain that does not exist does not receive mail', async () => {
    stubFetch({ [google('gmial.com', 'MX')]: { json: { Status: 3 } } })
    expect(await checkEmailDomain('gmial.com')).toBe('no-mail')
  })

  test('a null MX does not receive mail', async () => {
    stubFetch({
      [google('example.com', 'MX')]: {
        json: { Status: 0, Answer: [{ type: 15, data: '0 .' }] },
      },
    })
    expect(await checkEmailDomain('example.com')).toBe('no-mail')
  })

  test('no MX falls back to the A record', async () => {
    stubFetch({
      [google('smallbiz.com.au', 'MX')]: { json: { Status: 0 } },
      [google('smallbiz.com.au', 'A')]: {
        json: { Status: 0, Answer: [{ type: 1, data: '203.0.113.7' }] },
      },
    })
    expect(await checkEmailDomain('smallbiz.com.au')).toBe('receives')
  })

  test('neither an MX nor an A record does not receive mail', async () => {
    stubFetch({
      [google('parked.com.au', 'MX')]: { json: { Status: 0 } },
      [google('parked.com.au', 'A')]: { json: { Status: 0 } },
    })
    expect(await checkEmailDomain('parked.com.au')).toBe('no-mail')
  })

  test('falls back to Cloudflare, with its accept header, when Google fails', async () => {
    const { asked } = stubFetch({
      [google('outlook.com', 'MX')]: 'network-error',
      [cloudflare('outlook.com', 'MX')]: {
        json: { Status: 0, Answer: [{ type: 15, data: '10 mx.outlook.com.' }] },
      },
    })
    expect(await checkEmailDomain('outlook.com')).toBe('receives')
    expect(asked[1]).toEqual({
      url: cloudflare('outlook.com', 'MX'),
      headers: { accept: 'application/dns-json' },
    })
  })

  test('both resolvers failing says nothing, and is not remembered', async () => {
    const { fetchMock } = stubFetch({
      [google('iinet.net.au', 'MX')]: { status: 500 },
      [cloudflare('iinet.net.au', 'MX')]: 'network-error',
    })
    expect(await checkEmailDomain('iinet.net.au')).toBe('unknown')
    expect(knownDomainMail('iinet.net.au')).toBeUndefined()
    await checkEmailDomain('iinet.net.au')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  test('a Google server failure (status 2) tries Cloudflare', async () => {
    stubFetch({
      [google('tpg.com.au', 'MX')]: { json: { Status: 2 } },
      [cloudflare('tpg.com.au', 'MX')]: { json: { Status: 3 } },
    })
    expect(await checkEmailDomain('tpg.com.au')).toBe('no-mail')
  })

  test('a settled answer is remembered, and a second caller shares the first question', async () => {
    const { fetchMock } = stubFetch({ [google('gmail.com', 'MX')]: MX_REPLY })
    const [first, second] = await Promise.all([
      checkEmailDomain('gmail.com'),
      checkEmailDomain('gmail.com'),
    ])
    expect([first, second]).toEqual(['receives', 'receives'])
    expect(await checkEmailDomain('gmail.com')).toBe('receives')
    expect(knownDomainMail('GMAIL.com')).toBe('receives')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('an aborted caller gets unknown straight away', async () => {
    // A request that hangs until its own time limit gives up on it.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
          }),
      ),
    )
    const controller = new AbortController()
    const answer = checkEmailDomain('slow.com.au', {
      signal: controller.signal,
    })
    controller.abort()
    expect(await answer).toBe('unknown')
  })
})
