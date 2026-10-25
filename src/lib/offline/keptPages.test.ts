import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { logConnection } from '#/lib/connectionLog'
import { isOffline } from '#/lib/online'
import { signedInUserId } from '#/lib/rootState'
import {
  keepStartPage,
  keepStartPageIfMissing,
  pagesToPurge,
  pagesToRefresh,
  purgeOtherBusinessPages,
  refreshKeptPages,
} from './keptPages'
import {
  HOME_MARKER,
  PAGES_CACHE,
  homeFromMarker,
  opensAsPage,
} from './pagesCache'

/**
 * The pages kept for opening with no signal: which are fetched again after a
 * deploy, which go at a switch of business, and the order every put follows
 * so a sign-out landing part-way never leaves a page behind.
 */

vi.mock('#/lib/rootState', () => ({ signedInUserId: vi.fn() }))
vi.mock('#/lib/online', () => ({ isOffline: vi.fn() }))
vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))

const ORIGIN = 'https://app.test'
const at = (path: string) => `${ORIGIN}${path}`

describe('pagesToRefresh', () => {
  test("fetches `/` and this business's pages again, `/` and the start page first", () => {
    expect(
      pagesToRefresh(
        [
          at('/acme/clients'),
          at('/login'),
          at('/acme/schedule'),
          at('/other/schedule'),
          at('/'),
          at(HOME_MARKER),
          at('/acme/job/j1?tab=notes'),
        ],
        'acme',
      ),
    ).toEqual([
      at('/'),
      at('/acme/schedule'),
      at('/acme/clients'),
      at('/acme/job/j1?tab=notes'),
    ])
  })

  test('with no business known, only `/`', () => {
    expect(
      pagesToRefresh([at('/acme/schedule'), at('/'), at('/login')], null),
    ).toEqual([at('/')])
  })

  test("a business whose name starts with this one's is another business", () => {
    expect(
      pagesToRefresh([at('/acme-pest/schedule'), at('/acme')], 'acme'),
    ).toEqual([at('/acme')])
  })

  test('each page once, and at most 12', () => {
    const pages = Array.from({ length: 20 }, (_, i) => at(`/acme/job/j${i}`))
    const due = pagesToRefresh(
      [at('/'), at('/'), ...pages, at('/acme/schedule')],
      'acme',
    )
    expect(due).toHaveLength(12)
    expect(due.slice(0, 3)).toEqual([
      at('/'),
      at('/acme/schedule'),
      at('/acme/job/j0'),
    ])
  })
})

describe('pagesToPurge', () => {
  test("drops every page but `/`, the marker and this business's", () => {
    expect(
      pagesToPurge(
        [
          at('/'),
          at(HOME_MARKER),
          at('/acme/schedule'),
          at('/acme'),
          at('/other/schedule'),
          at('/other/job/j1'),
          at('/acme-pest/schedule'),
          at('/login'),
        ],
        'acme',
      ),
    ).toEqual([
      at('/other/schedule'),
      at('/other/job/j1'),
      at('/acme-pest/schedule'),
      at('/login'),
    ])
  })

  test('never `/`, whatever its query', () => {
    expect(pagesToPurge([at('/?from=home')], 'acme')).toEqual([])
  })
})

describe('the home marker', () => {
  test.each([
    ['/acme/schedule', '/acme/schedule'],
    ['  /acme/schedule\n', '/acme/schedule'],
    ['//elsewhere.com/x', null],
    ['/\\elsewhere.com', null],
    ['https://elsewhere.com/', null],
    [HOME_MARKER, null],
    ['', null],
    [null, null],
  ])('%j names %j', (body, home) => {
    expect(homeFromMarker(body)).toBe(home)
  })
})

/** CacheStorage, enough of it: a deleted cache's reference keeps working. */
class FakeCaches {
  named = new Map<string, FakeCache>()
  open(name: string) {
    let cache = this.named.get(name)
    if (!cache) {
      cache = new FakeCache()
      this.named.set(name, cache)
    }
    return Promise.resolve(cache)
  }
  has(name: string) {
    return Promise.resolve(this.named.has(name))
  }
  delete(name: string) {
    return Promise.resolve(this.named.delete(name))
  }
  /** What a page reads back from `name` by URL, as the worker would. */
  async text(name: string, path: string) {
    return (await this.named.get(name)?.match(path))?.text()
  }
}

class FakeCache {
  entries = new Map<string, Response>()
  keys() {
    return Promise.resolve([...this.entries.keys()].map((u) => new Request(u)))
  }
  match(url: string) {
    return Promise.resolve(this.entries.get(new URL(url, ORIGIN).href))
  }
  put(url: string, res: Response) {
    this.entries.set(new URL(url, ORIGIN).href, res)
    return Promise.resolve()
  }
  delete(url: string) {
    return Promise.resolve(this.entries.delete(new URL(url, ORIGIN).href))
  }
}

/** What `fetch` answers with `redirect: 'manual'`: a redirect is opaque. */
function opaqueRedirect(): Response {
  return {
    type: 'opaqueredirect',
    ok: false,
    redirected: false,
    status: 0,
  } as Response
}

const page = (body: string) => new Response(body, { status: 200 })

let storage: FakeCaches
let answers: Map<string, () => Response | Promise<Response>>
let fetched: Array<{ url: string; init: RequestInit | undefined }>

beforeEach(() => {
  storage = new FakeCaches()
  answers = new Map()
  fetched = []
  vi.stubGlobal('caches', storage)
  vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/` })
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    fetched.push({ url: new URL(url, ORIGIN).pathname, init })
    const answer = answers.get(new URL(url, ORIGIN).pathname)
    return answer
      ? Promise.resolve(answer())
      : Promise.reject(new TypeError('Failed to fetch'))
  })
  vi.mocked(signedInUserId).mockReturnValue('u1')
  vi.mocked(isOffline).mockReturnValue(false)
  vi.mocked(logConnection).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A 'pages' cache holding these paths, each as the text 'old'. */
async function kept(...paths: Array<string>) {
  const cache = await storage.open(PAGES_CACHE)
  for (const path of paths) await cache.put(path, page('old'))
  return cache
}

/** The marker, as keepStartPage writes it. */
async function markHome(start: string) {
  await (await storage.open(PAGES_CACHE)).put(HOME_MARKER, page(start))
}

describe('a page the worker may send a page with no copy to', () => {
  test('is a page in itself, never a redirect', () => {
    expect(opensAsPage(page('schedule'))).toBe(true)
    expect(opensAsPage(opaqueRedirect())).toBe(false)
    expect(
      opensAsPage({ ok: true, redirected: true, status: 200 } as Response),
    ).toBe(false)
    expect(opensAsPage(new Response('gone', { status: 404 }))).toBe(false)
  })
})

describe('refreshKeptPages', () => {
  test('keeps `/` only as a redirect, and a page only as itself', async () => {
    await kept('/', '/acme/schedule', '/acme/clients', '/acme/job/j1')
    await markHome('/acme/schedule')
    answers.set('/', opaqueRedirect)
    answers.set('/acme/schedule', () => page('new schedule'))
    // Signed out on the server: the business answers with a redirect.
    answers.set('/acme/clients', opaqueRedirect)
    answers.set('/acme/job/j1', () => new Response('gone', { status: 404 }))

    await refreshKeptPages()

    const cache = storage.named.get(PAGES_CACHE)
    expect((await cache?.match('/'))?.type).toBe('opaqueredirect')
    expect(await storage.text(PAGES_CACHE, '/acme/schedule')).toBe(
      'new schedule',
    )
    expect(await storage.text(PAGES_CACHE, '/acme/clients')).toBe('old')
    expect(await storage.text(PAGES_CACHE, '/acme/job/j1')).toBe('old')
    expect(fetched[0]?.init).toEqual({
      credentials: 'include',
      cache: 'no-store',
      redirect: 'manual',
    })
    expect(logConnection).toHaveBeenCalledWith('pages-refresh', {
      n: 4,
      ok: 2,
    })
  })

  test('a page that answers `/` with a page is not kept as `/`', async () => {
    await kept('/')
    answers.set('/', () => page('a page'))
    await refreshKeptPages()
    expect(await storage.text(PAGES_CACHE, '/')).toBe('old')
  })

  test('fetches nothing with no signal, or with nobody signed in', async () => {
    await kept('/')
    answers.set('/', opaqueRedirect)

    vi.mocked(isOffline).mockReturnValue(true)
    await refreshKeptPages()
    vi.mocked(isOffline).mockReturnValue(false)
    vi.mocked(signedInUserId).mockReturnValue(null)
    await refreshKeptPages()

    expect(fetched).toEqual([])
  })

  test('stops at the first page that cannot be fetched', async () => {
    await kept('/', '/acme/schedule', '/acme/clients')
    await markHome('/acme/schedule')
    answers.set('/', opaqueRedirect)
    // '/acme/schedule' has no answer: the fetch fails.
    answers.set('/acme/clients', () => page('new clients'))

    await refreshKeptPages()

    expect(fetched.map(({ url }) => url)).toEqual(['/', '/acme/schedule'])
  })

  test('stops once the phone has no signal part-way', async () => {
    await kept('/', '/acme/schedule')
    await markHome('/acme/schedule')
    answers.set('/', () => {
      vi.mocked(isOffline).mockReturnValue(true)
      return opaqueRedirect()
    })
    answers.set('/acme/schedule', () => page('new schedule'))

    await refreshKeptPages()

    expect(fetched.map(({ url }) => url)).toEqual(['/'])
    expect(await storage.text(PAGES_CACHE, '/acme/schedule')).toBe('old')
  })

  test('keeps nothing if the person changed while it was fetched', async () => {
    await kept('/acme/schedule')
    await markHome('/acme/schedule')
    answers.set('/acme/schedule', () => {
      vi.mocked(signedInUserId).mockReturnValue(null)
      return page('signed out by now')
    })

    await refreshKeptPages()

    expect(await storage.text(PAGES_CACHE, '/acme/schedule')).toBe('old')
  })

  test('puts into the cache it opened, so one deleted meanwhile stays gone', async () => {
    await kept('/', '/acme/schedule')
    await markHome('/acme/schedule')
    answers.set('/', async () => {
      // The person signs out in another tab and someone else signs in: the
      // cache goes, and the next navigation makes a new one.
      await storage.delete(PAGES_CACHE)
      await storage.open(PAGES_CACHE)
      return opaqueRedirect()
    })
    answers.set('/acme/schedule', () => page('the last person’s schedule'))

    await refreshKeptPages()

    // Both were fetched, and both went into the cache nobody can open.
    expect(fetched.map(({ url }) => url)).toEqual(['/', '/acme/schedule'])
    expect([...(storage.named.get(PAGES_CACHE)?.entries.keys() ?? [])]).toEqual(
      [],
    )
  })
})

describe('keepStartPage', () => {
  test('keeps the start page, and the marker naming it', async () => {
    answers.set('/acme/schedule', () => page('schedule'))

    await keepStartPage('acme')

    expect(await storage.text(PAGES_CACHE, '/acme/schedule')).toBe('schedule')
    expect(await storage.text(PAGES_CACHE, HOME_MARKER)).toBe('/acme/schedule')
  })

  test('writes no marker for a start page this phone does not have', async () => {
    answers.set('/acme/schedule', opaqueRedirect)

    await keepStartPage('acme')

    expect(await storage.text(PAGES_CACHE, HOME_MARKER)).toBeUndefined()
  })

  test('but does for one it already has, if it cannot be fetched now', async () => {
    await kept('/acme/schedule')

    await keepStartPage('acme')

    expect(await storage.text(PAGES_CACHE, HOME_MARKER)).toBe('/acme/schedule')
  })

  test('nor for one it has only as a redirect, which may lead to a page it has no copy of', async () => {
    // The worker kept the last visit's answer: sent to sign in again.
    await (
      await storage.open(PAGES_CACHE)
    ).put('/acme/schedule', opaqueRedirect())

    await keepStartPage('acme')

    expect(await storage.text(PAGES_CACHE, HOME_MARKER)).toBeUndefined()
  })

  test('writes nothing with nobody signed in, or with no signal', async () => {
    await kept('/acme/schedule')
    vi.mocked(signedInUserId).mockReturnValue(null)
    await keepStartPage('acme')
    vi.mocked(signedInUserId).mockReturnValue('u1')
    vi.mocked(isOffline).mockReturnValue(true)
    await keepStartPage('acme')

    expect(fetched).toEqual([])
    expect(await storage.text(PAGES_CACHE, HOME_MARKER)).toBeUndefined()
  })

  test('writes no marker once someone else is signed in', async () => {
    await kept('/acme/schedule')
    answers.set('/acme/schedule', () => {
      vi.mocked(signedInUserId).mockReturnValue('u2')
      return page('someone else’s schedule')
    })

    await keepStartPage('acme')

    expect(await storage.text(PAGES_CACHE, '/acme/schedule')).toBe('old')
    expect(await storage.text(PAGES_CACHE, HOME_MARKER)).toBeUndefined()
  })

  test('puts the page and the marker into the cache it opened', async () => {
    answers.set('/acme/schedule', async () => {
      await storage.delete(PAGES_CACHE)
      await storage.open(PAGES_CACHE)
      return page('the last person’s schedule')
    })

    await keepStartPage('acme')

    expect([...(storage.named.get(PAGES_CACHE)?.entries.keys() ?? [])]).toEqual(
      [],
    )
  })
})

describe('keepStartPageIfMissing', () => {
  test('fetches nothing when the marker names this business and its start page is a page', async () => {
    await kept('/acme/schedule')
    await markHome('/acme/schedule')

    expect(await keepStartPageIfMissing('acme')).toBe(false)
    expect(fetched).toEqual([])
  })

  test('keeps it when the marker is missing, names another business, or its page is only a redirect', async () => {
    answers.set('/acme/schedule', () => page('schedule'))
    expect(await keepStartPageIfMissing('acme')).toBe(true)
    expect(await storage.text(PAGES_CACHE, HOME_MARKER)).toBe('/acme/schedule')

    await markHome('/other/schedule')
    expect(await keepStartPageIfMissing('acme')).toBe(true)
    expect(await storage.text(PAGES_CACHE, HOME_MARKER)).toBe('/acme/schedule')

    await (
      await storage.open(PAGES_CACHE)
    ).put('/acme/schedule', opaqueRedirect())
    expect(await keepStartPageIfMissing('acme')).toBe(true)
    expect(fetched.map(({ url }) => url)).toEqual([
      '/acme/schedule',
      '/acme/schedule',
      '/acme/schedule',
    ])
  })
})

describe('purgeOtherBusinessPages', () => {
  test("drops the other business's pages, and a marker naming it", async () => {
    const cache = await kept('/', '/acme/schedule', '/other/schedule')
    await markHome('/other/schedule')

    await purgeOtherBusinessPages('acme')

    expect([...cache.entries.keys()]).toEqual([at('/'), at('/acme/schedule')])
  })

  test('keeps a marker naming this business', async () => {
    const cache = await kept('/acme/schedule', '/other/job/j1')
    await markHome('/acme/schedule')

    await purgeOtherBusinessPages('acme')

    expect([...cache.entries.keys()]).toEqual([
      at('/acme/schedule'),
      at(HOME_MARKER),
    ])
  })

  test('makes no cache where there was none', async () => {
    await purgeOtherBusinessPages('acme')
    expect(storage.named.has(PAGES_CACHE)).toBe(false)
  })
})
