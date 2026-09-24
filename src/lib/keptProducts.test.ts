import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  KEPT_CACHE,
  KeepError,
  claimKept,
  forgetAllKept,
  forgetKeptProduct,
  keepProduct,
  keepRequestFor,
  listKept,
  planKeptSync,
  readKeptPdf,
  readKeptPhoto,
  syncKept,
  useKeptProducts,
} from './keptProducts'
import {
  forgetCachedPages,
  forgetRootState,
  resolveRootState,
  userIdOfToken,
} from './rootState'
import { getInitialState } from '#/lib/initialState'
import type {
  KeepRequest,
  KeptProduct,
  KeptProductsState,
  LiveProduct,
} from './keptProducts'

// rootState.ts answers "who is signed in" from the root route's server
// function; `signIn` below hands it a token.
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))

// ── planKeptSync ────────────────────────────────────────────────────────────

function kept(overrides: Partial<KeptProduct> = {}): KeptProduct {
  return {
    productId: 'p1',
    businessId: 'b1',
    name: 'Termidor HE',
    description: 'Liquid termiticide.',
    url: 'https://example.com/termidor',
    fileName: 'termidor-sds.pdf',
    size: 842_000,
    pdfUrl: 'https://store/pdf-1',
    photoUrl: 'https://store/photo-1',
    keptAt: 1_000,
    ...overrides,
  }
}

function live(overrides: Partial<LiveProduct> = {}): LiveProduct {
  return {
    id: 'p1',
    name: 'Termidor HE',
    description: 'Liquid termiticide.',
    url: 'https://example.com/termidor',
    photoUrl: 'https://store/photo-1',
    pdf: {
      url: 'https://store/pdf-1',
      fileName: 'termidor-sds.pdf',
      size: 842_000,
    },
    ...overrides,
  }
}

describe('planKeptSync', () => {
  test('nothing changed: nothing to do', () => {
    expect(planKeptSync([kept()], [live()])).toEqual({
      forget: [],
      redownload: [],
      update: [],
    })
  })

  test('a deleted product, and one left without a PDF, are forgotten', () => {
    const plan = planKeptSync(
      [kept({ productId: 'gone' }), kept({ productId: 'p2' })],
      [live({ id: 'p2', pdf: null })],
    )
    expect(plan.forget).toEqual(['gone', 'p2'])
    expect(plan.redownload).toEqual([])
    expect(plan.update).toEqual([])
  })

  test('a replaced PDF is re-downloaded, with the new file’s name and size', () => {
    const plan = planKeptSync(
      [kept()],
      [
        live({
          pdf: {
            url: 'https://store/pdf-2',
            fileName: 'termidor-sds-2026.pdf',
            size: 900_000,
          },
        }),
      ],
    )
    expect(plan.redownload).toHaveLength(1)
    expect(plan.redownload[0]?.next).toMatchObject({
      pdfUrl: 'https://store/pdf-2',
      fileName: 'termidor-sds-2026.pdf',
      size: 900_000,
      keptAt: 1_000,
    })
    expect(plan.redownload[0]?.previous).toEqual(kept())
    expect(plan.update).toEqual([])
  })

  test('a replaced PDF with no reported size keeps the old size until measured', () => {
    const plan = planKeptSync(
      [kept()],
      [
        live({
          pdf: { url: 'https://store/pdf-2', fileName: 'x.pdf', size: null },
        }),
      ],
    )
    expect(plan.redownload[0]?.next.size).toBe(842_000)
  })

  test('new words on the same PDF are an update, not a download', () => {
    const plan = planKeptSync(
      [kept()],
      [
        live({
          name: 'Termidor HE (400 mL)',
          description: null,
          url: null,
        }),
      ],
    )
    expect(plan.redownload).toEqual([])
    expect(plan.update).toHaveLength(1)
    expect(plan.update[0]).toMatchObject({
      photo: 'same',
      next: {
        name: 'Termidor HE (400 mL)',
        description: null,
        url: null,
        pdfUrl: 'https://store/pdf-1',
        size: 842_000,
      },
    })
  })

  test('a renamed file on the same bytes is an update', () => {
    const plan = planKeptSync(
      [kept()],
      [
        live({
          pdf: {
            url: 'https://store/pdf-1',
            fileName: 'renamed.pdf',
            size: 842_000,
          },
        }),
      ],
    )
    expect(plan.update[0]?.next.fileName).toBe('renamed.pdf')
  })

  test('a changed photo is re-fetched; a removed one dropped', () => {
    const changed = planKeptSync(
      [kept()],
      [live({ photoUrl: 'https://store/photo-2' })],
    )
    expect(changed.update[0]?.photo).toBe('refetch')
    expect(changed.update[0]?.next.photoUrl).toBe('https://store/photo-2')

    const removed = planKeptSync([kept()], [live({ photoUrl: null })])
    expect(removed.update[0]?.photo).toBe('drop')
  })

  test('a photo that failed to keep is tried again', () => {
    const plan = planKeptSync([kept({ photoUrl: null })], [live()])
    expect(plan.update[0]?.photo).toBe('refetch')
  })

  test('a PDF gone from storage keeps its copy — it may be the only one left', () => {
    const plan = planKeptSync(
      [kept()],
      [
        live({
          name: 'Renamed',
          pdf: { url: null, fileName: 'other.pdf', size: null },
        }),
      ],
    )
    expect(plan.forget).toEqual([])
    expect(plan.redownload).toEqual([])
    expect(plan.update[0]?.next).toMatchObject({
      name: 'Renamed',
      pdfUrl: 'https://store/pdf-1',
      fileName: 'termidor-sds.pdf',
    })
  })

  test('products nobody kept are left alone', () => {
    const plan = planKeptSync([], [live(), live({ id: 'p2' })])
    expect(plan).toEqual({ forget: [], redownload: [], update: [] })
  })
})

describe('keepRequestFor', () => {
  test('a product with a PDF: everything keep needs, bar the business', () => {
    expect(keepRequestFor(live())).toEqual({
      productId: 'p1',
      name: 'Termidor HE',
      description: 'Liquid termiticide.',
      url: 'https://example.com/termidor',
      fileName: 'termidor-sds.pdf',
      pdfUrl: 'https://store/pdf-1',
      photoUrl: 'https://store/photo-1',
    })
  })

  test('no PDF, or one gone from storage: nothing to keep', () => {
    expect(keepRequestFor(live({ pdf: null }))).toBeNull()
    expect(
      keepRequestFor(
        live({ pdf: { url: null, fileName: 'x.pdf', size: null } }),
      ),
    ).toBeNull()
  })
})

// ── The cache ───────────────────────────────────────────────────────────────

type Stored = { body: Blob; headers: Headers }

/** Cache Storage, in memory, with a hook to make a write fail. */
class FakeCache {
  entries = new Map<string, Stored>()
  failPut: ((key: string) => Error | null) | null = null

  async put(key: string, res: Response) {
    const failure = this.failPut?.(key)
    if (failure) throw failure
    this.entries.set(key, { body: await res.blob(), headers: res.headers })
  }

  async match(key: string) {
    const hit = this.entries.get(key)
    return hit ? new Response(hit.body, { headers: hit.headers }) : undefined
  }

  async delete(key: string) {
    return this.entries.delete(key)
  }
}

class FakeCacheStorage {
  named = new Map<string, FakeCache>()

  async open(name: string) {
    let cache = this.named.get(name)
    if (!cache) {
      cache = new FakeCache()
      this.named.set(name, cache)
    }
    return cache
  }

  async has(name: string) {
    return this.named.has(name)
  }

  async match(key: string) {
    for (const cache of this.named.values()) {
      const hit = await cache.match(key)
      if (hit) return hit
    }
    return undefined
  }

  async delete(name: string) {
    return this.named.delete(name)
  }

  async keys() {
    return [...this.named.keys()]
  }
}

/** A token shaped like Better Auth's: its `sub` is the user's id. */
function jwtFor(sub: string): string {
  const part = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  // The name's characters put `-` and `_` in the base64url, as real ones do.
  return `${part({ alg: 'EdDSA' })}.${part({ sub, name: 'Zoë ~~~>>>???', iat: 1 })}.signature`
}

/** Signs `userId` in (null: nobody), as the root route's guard would see it. */
async function signIn(userId: string | null) {
  forgetRootState()
  vi.mocked(getInitialState).mockResolvedValueOnce({
    token: userId === null ? undefined : jwtFor(userId),
    theme: 'system',
  })
  await resolveRootState()
}

/** The hook's actions, which work outside a render once handed out. */
function hookFor(businessId: string): KeptProductsState {
  let state: KeptProductsState | undefined
  function Probe() {
    state = useKeptProducts(businessId)
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  if (!state) throw new Error('The probe did not render.')
  return state
}

/** A response that sends the start of a PDF and then nothing, ever. */
function stalled(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('%PDF-'))
      },
    }),
  )
}

/** A fetch that never answers, until its signal gives up on it. */
function unanswered(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    )
  })
}

let storage: FakeCacheStorage
let served: Map<string, string>
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  storage = new FakeCacheStorage()
  vi.stubGlobal('caches', storage)
  served = new Map([
    ['https://store/pdf-1', '%PDF-1.7 first'],
    ['https://store/pdf-2', '%PDF-1.7 second, longer'],
    ['https://store/photo-1', 'JPEG-1'],
    ['https://store/photo-2', 'JPEG-2'],
  ])
  fetchMock = vi.fn(serve)
  vi.stubGlobal('fetch', fetchMock)
  await signIn('u1')
  // Settled here, so a test that opens the cache itself first is not taken
  // for someone else's files by the check the first keep makes.
  await claimKept('u1')
})

async function serve(url: string): Promise<Response> {
  const body = served.get(url)
  if (body === undefined) return new Response('', { status: 404 })
  return new Response(body)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

let seq = 0
/** A business of its own per test: the module's state outlives each one. */
function freshBusiness() {
  seq++
  return `biz${seq}`
}

function request(businessId: string, overrides: Partial<KeepRequest> = {}) {
  const { keptAt: _keptAt, size: _size, ...rest } = kept({ businessId })
  return { ...rest, ...overrides }
}

async function keptCache() {
  return storage.open(KEPT_CACHE)
}

describe('keepProduct', () => {
  test('downloads the PDF and photo, and lists the product as kept', async () => {
    const b = freshBusiness()
    const progress: Array<number> = []

    const entry = await keepProduct(request(b), undefined, (p) =>
      progress.push(p.loaded),
    )

    expect(entry).toMatchObject({
      productId: 'p1',
      businessId: b,
      size: '%PDF-1.7 first'.length,
      pdfUrl: 'https://store/pdf-1',
      photoUrl: 'https://store/photo-1',
    })
    expect(typeof entry.keptAt).toBe('number')
    expect(progress.at(-1)).toBe('%PDF-1.7 first'.length)
    expect(await listKept(b)).toEqual([entry])

    const pdf = await readKeptPdf(b, 'p1')
    expect(await pdf?.blob.text()).toBe('%PDF-1.7 first')
    expect(pdf?.blob.type).toBe('application/pdf')
    expect(pdf?.pdfUrl).toBe('https://store/pdf-1')
    expect(await (await readKeptPhoto(b, 'p1'))?.text()).toBe('JPEG-1')
  })

  test('a PDF already in memory is stored without downloading it again', async () => {
    const b = freshBusiness()
    await keepProduct(request(b), new Blob(['%PDF-in memory']))

    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://store/pdf-1',
      expect.anything(),
    )
    expect(await (await readKeptPdf(b, 'p1'))?.blob.text()).toBe(
      '%PDF-in memory',
    )
  })

  test('keeping again replaces the copy rather than listing it twice', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))
    await keepProduct(request(b, { name: 'Termidor HE v2' }))

    const entries = await listKept(b)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('Termidor HE v2')
  })

  test('two keeps at once for one business both land', async () => {
    const b = freshBusiness()
    await Promise.all([
      keepProduct(request(b, { productId: 'a', name: 'Alpha' })),
      keepProduct(request(b, { productId: 'z', name: 'Zulu' })),
      keepProduct(request(b, { productId: 'm', name: 'mid' })),
    ])
    // A to Z, ignoring case.
    expect((await listKept(b)).map((e) => e.productId)).toEqual(['a', 'm', 'z'])
  })

  test('a photo that will not download does not stop the PDF', async () => {
    const b = freshBusiness()
    served.delete('https://store/photo-1')

    const entry = await keepProduct(request(b))
    expect(entry.photoUrl).toBeNull()
    expect(await readKeptPhoto(b, 'p1')).toBeNull()
    expect(await readKeptPdf(b, 'p1')).not.toBeNull()
  })

  test('no signal: a network KeepError, and nothing kept', async () => {
    const b = freshBusiness()
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch')
    })

    const error = await keepProduct(request(b)).catch((e) => e)
    expect(error).toBeInstanceOf(KeepError)
    expect(error.reason).toBe('network')
    expect(await listKept(b)).toEqual([])
  })

  test('a file gone from the server: an http KeepError', async () => {
    const b = freshBusiness()
    const error = await keepProduct(
      request(b, { pdfUrl: 'https://store/missing' }),
    ).catch((e) => e)
    expect(error).toBeInstanceOf(KeepError)
    expect(error.reason).toBe('http')
  })

  test('a full phone: a quota KeepError, and no file left taking up room', async () => {
    const b = freshBusiness()
    const cache = await keptCache()
    cache.failPut = (key) =>
      key.endsWith('manifest.json')
        ? new DOMException('full', 'QuotaExceededError')
        : null

    const error = await keepProduct(request(b)).catch((e) => e)
    expect(error).toBeInstanceOf(KeepError)
    expect(error.reason).toBe('quota')
    cache.failPut = null
    expect(await listKept(b)).toEqual([])
    expect(await readKeptPdf(b, 'p1')).toBeNull()
    expect(await readKeptPhoto(b, 'p1')).toBeNull()
  })

  test('the manifest is written last: a failed PDF write lists nothing', async () => {
    const b = freshBusiness()
    const cache = await keptCache()
    cache.failPut = (key) =>
      key.endsWith('/pdf')
        ? new DOMException('full', 'QuotaExceededError')
        : null

    await expect(keepProduct(request(b))).rejects.toMatchObject({
      reason: 'quota',
    })
    expect(cache.entries.has(`/__kept/${b}/manifest.json`)).toBe(false)
  })

  test('an abort during the download is an AbortError, not a KeepError', async () => {
    const b = freshBusiness()
    const controller = new AbortController()
    fetchMock.mockImplementation(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })

    const error = await keepProduct(
      request(b),
      undefined,
      undefined,
      controller.signal,
    ).catch((e) => e)
    expect(error).not.toBeInstanceOf(KeepError)
    expect(error.name).toBe('AbortError')
  })
})

describe('without Cache Storage (a private window, the server)', () => {
  test('keeping says so; reading finds nothing; nothing throws', async () => {
    vi.stubGlobal('caches', undefined)
    const b = freshBusiness()

    await expect(keepProduct(request(b))).rejects.toMatchObject({
      reason: 'unsupported',
    })
    expect(await listKept(b)).toEqual([])
    expect(await readKeptPdf(b, 'p1')).toBeNull()
    await expect(forgetKeptProduct(b, 'p1')).resolves.toBeUndefined()
    await expect(forgetAllKept()).resolves.toBeUndefined()
    await expect(syncKept(b, [])).resolves.toBeUndefined()
  })

  test('a cache that refuses to open reads as unsupported', async () => {
    vi.stubGlobal('caches', {
      open: async () => {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    await expect(keepProduct(request(freshBusiness()))).rejects.toMatchObject({
      reason: 'unsupported',
    })
  })
})

describe('forgetting', () => {
  test('one product: gone from the list, its files deleted', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))
    await keepProduct(request(b, { productId: 'p2', name: 'Other' }))

    await forgetKeptProduct(b, 'p1')

    expect((await listKept(b)).map((e) => e.productId)).toEqual(['p2'])
    expect(await readKeptPdf(b, 'p1')).toBeNull()
    expect(await readKeptPhoto(b, 'p1')).toBeNull()
  })

  test('everything, for every business, when the person changes', async () => {
    const b1 = freshBusiness()
    const b2 = freshBusiness()
    await keepProduct(request(b1))
    await keepProduct(request(b2))

    await forgetAllKept()

    expect(storage.named.has(KEPT_CACHE)).toBe(false)
    expect(await listKept(b1)).toEqual([])
    expect(await listKept(b2)).toEqual([])
  })

  test('a keep still downloading when the person signs out is not written', async () => {
    const b = freshBusiness()
    let release: () => void = () => {}
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://store/pdf-1') {
        await new Promise<void>((resolve) => (release = resolve))
      }
      return new Response(served.get(url) ?? '')
    })

    const keeping = keepProduct(request(b)).catch((e) => e)
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'https://store/pdf-1',
        expect.anything(),
      ),
    )
    await forgetAllKept()
    release()

    expect(await keeping).toBeInstanceOf(KeepError)
    expect(await listKept(b)).toEqual([])
  })
})

describe('whose they are', () => {
  test('signing out, and back in as the same person, keeps them', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))
    await storage.open('pages')

    // Settings' sign-out and the sign-in page both drop the cached pages...
    await forgetCachedPages()
    await signIn(null)
    // ...and a week later the session has lapsed, and the same person signs
    // in again: they still have what they kept.
    await signIn('u1')

    expect(storage.named.has('pages')).toBe(false)
    expect((await listKept(b)).map((e) => e.productId)).toEqual(['p1'])
    expect(await readKeptPdf(b, 'p1')).not.toBeNull()
  })

  test('the first page load that knows someone else is signed in drops them', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))

    // As the join page signs someone in: no reload, and nothing here reads
    // a kept file — rootState.ts's own check is what clears them.
    await signIn('u2')

    await vi.waitFor(() => expect(storage.named.has(KEPT_CACHE)).toBe(false))
  })

  test('nothing of someone else’s is read, even before that check has run', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))

    await signIn('u2')

    expect(await listKept(b)).toEqual([])
    expect(await readKeptPdf(b, 'p1')).toBeNull()
    expect(await readKeptPhoto(b, 'p1')).toBeNull()
  })

  test('the next person keeps their own, with nothing of the last person’s', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))
    await signIn('u2')

    await keepProduct(request(b, { productId: 'p2', name: 'Two' }))

    expect((await listKept(b)).map((e) => e.productId)).toEqual(['p2'])
    // And they are theirs: the first person back finds nothing.
    await signIn('u1')
    expect(await listKept(b)).toEqual([])
  })

  test('the cache that rootState.ts checks is the one kept files are in', async () => {
    // rootState.ts names it rather than importing this module; a rename on
    // one side only would leave someone else's files in place. The test just
    // above fails if the names differ; this says why.
    expect(KEPT_CACHE).toBe('pestm8-kept-products-v1')
  })
})

describe('userIdOfToken', () => {
  test('the sub claim of a Better Auth token', () => {
    expect(userIdOfToken(jwtFor('k57abc123'))).toBe('k57abc123')
  })

  test('anything else is nobody', () => {
    expect(userIdOfToken(undefined)).toBeNull()
    expect(userIdOfToken('')).toBeNull()
    expect(userIdOfToken('not-a-jwt')).toBeNull()
    expect(userIdOfToken('a.%%%.c')).toBeNull()
    const noSub = `x.${btoa(JSON.stringify({ email: 'a@b.c' }))}.y`
    expect(userIdOfToken(noSub)).toBeNull()
  })
})

describe('another tab', () => {
  test('signing someone else in there stops a keep still downloading here', async () => {
    const b = freshBusiness()
    let release: () => void = () => {}
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://store/pdf-1') {
        await new Promise<void>((resolve) => (release = resolve))
      }
      return serve(url)
    })
    const keeping = keepProduct(request(b)).catch((e) => e)
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'https://store/pdf-1',
        expect.anything(),
      ),
    )

    // The same app in another tab: its own copy of this module, sharing the
    // cache and a BroadcastChannel with this one.
    vi.resetModules()
    const otherTab = await import('./keptProducts')
    await otherTab.forgetAllKept()
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()

    expect(await keeping).toBeInstanceOf(KeepError)
    expect(storage.named.has(KEPT_CACHE)).toBe(false)
    expect(await otherTab.listKept(b)).toEqual([])
  })
})

describe('syncKept', () => {
  test('forgets the deleted, renames the renamed, and fetches the replaced', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))
    await keepProduct(request(b, { productId: 'p2', name: 'Doomed' }))
    await keepProduct(request(b, { productId: 'p3', name: 'Old name' }))

    await syncKept(b, [
      live({
        pdf: { url: 'https://store/pdf-2', fileName: 'v2.pdf', size: 1 },
      }),
      live({ id: 'p3', name: 'New name' }),
    ])

    const entries = await listKept(b)
    expect(entries.map((e) => e.productId)).toEqual(['p3', 'p1'])
    expect(entries.find((e) => e.productId === 'p3')?.name).toBe('New name')
    const p1 = entries.find((e) => e.productId === 'p1')
    expect(p1).toMatchObject({
      pdfUrl: 'https://store/pdf-2',
      fileName: 'v2.pdf',
      size: '%PDF-1.7 second, longer'.length,
    })
    const pdf = await readKeptPdf(b, 'p1')
    expect(await pdf?.blob.text()).toBe('%PDF-1.7 second, longer')
    expect(pdf?.pdfUrl).toBe('https://store/pdf-2')
    expect(await readKeptPdf(b, 'p2')).toBeNull()
  })

  test('a replacement that will not download leaves the old copy in place', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))

    await syncKept(b, [
      live({
        name: 'Renamed',
        pdf: { url: 'https://store/missing', fileName: 'v2.pdf', size: 1 },
      }),
    ])

    const [entry] = await listKept(b)
    // The words update; the file, its name and its URL stay the old one's,
    // so the next sync still sees the replacement and tries again.
    expect(entry).toMatchObject({
      name: 'Renamed',
      pdfUrl: 'https://store/pdf-1',
      fileName: 'termidor-sds.pdf',
    })
    expect(await (await readKeptPdf(b, 'p1'))?.blob.text()).toBe(
      '%PDF-1.7 first',
    )
    expect(
      planKeptSync(await listKept(b), [
        live({
          pdf: { url: 'https://store/missing', fileName: 'v2.pdf', size: 1 },
        }),
      ]).redownload,
    ).toHaveLength(1)
  })

  test('offline: updates the words, downloads nothing', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))
    vi.stubGlobal('navigator', { onLine: false })
    fetchMock.mockClear()

    await syncKept(b, [
      live({
        name: 'Renamed',
        photoUrl: 'https://store/photo-2',
        pdf: { url: 'https://store/pdf-2', fileName: 'v2.pdf', size: 1 },
      }),
    ])

    expect(fetchMock).not.toHaveBeenCalled()
    expect((await listKept(b))[0]).toMatchObject({
      name: 'Renamed',
      pdfUrl: 'https://store/pdf-1',
      photoUrl: 'https://store/photo-1',
    })
  })

  test('a changed photo is swapped; a removed one deleted', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))
    await keepProduct(request(b, { productId: 'p2', name: 'Two' }))

    await syncKept(b, [
      live({ photoUrl: 'https://store/photo-2' }),
      live({ id: 'p2', name: 'Two', photoUrl: null }),
    ])

    const entries = await listKept(b)
    expect(entries.find((e) => e.productId === 'p1')?.photoUrl).toBe(
      'https://store/photo-2',
    )
    expect(await (await readKeptPhoto(b, 'p1'))?.text()).toBe('JPEG-2')
    expect(entries.find((e) => e.productId === 'p2')?.photoUrl).toBeNull()
    expect(await readKeptPhoto(b, 'p2')).toBeNull()
  })

  test('a background refresh can be stopped: removing the product cancels it', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))
    let refresh: AbortSignal | null | undefined
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url !== 'https://store/pdf-2') return serve(url)
      refresh = init?.signal
      return unanswered(init)
    })

    const syncing = syncKept(b, [
      live({
        pdf: { url: 'https://store/pdf-2', fileName: 'v2.pdf', size: 1 },
      }),
    ])
    await vi.waitFor(() => expect(refresh).toBeTruthy())

    expect(await hookFor(b).forget('p1')).toEqual({ ok: true })
    expect(refresh?.aborted).toBe(true)
    await syncing
    expect(await listKept(b)).toEqual([])
    expect(await readKeptPdf(b, 'p1')).toBeNull()
  })

  test('a later list’s deletions land while an earlier refresh still downloads', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))
    await keepProduct(request(b, { productId: 'p9', name: 'Nine' }))
    let release: () => void = () => {}
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://store/pdf-2') {
        await new Promise<void>((resolve) => (release = resolve))
      }
      return serve(url)
    })
    const replaced = live({
      pdf: { url: 'https://store/pdf-2', fileName: 'v2.pdf', size: 1 },
    })

    const first = syncKept(b, [replaced, live({ id: 'p9', name: 'Nine' })])
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'https://store/pdf-2',
        expect.anything(),
      ),
    )
    const second = syncKept(b, [replaced])

    await vi.waitFor(async () =>
      expect((await listKept(b)).map((e) => e.productId)).toEqual(['p1']),
    )
    release()
    await Promise.all([first, second])
    expect((await listKept(b))[0]?.pdfUrl).toBe('https://store/pdf-2')
  })

  test('a refresh that stops arriving is given up, and the old copy stays', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))
    fetchMock.mockImplementation(async (url: string) =>
      url === 'https://store/pdf-2' ? stalled() : serve(url),
    )

    vi.useFakeTimers()
    try {
      const syncing = syncKept(b, [
        live({
          pdf: { url: 'https://store/pdf-2', fileName: 'v2.pdf', size: 1 },
        }),
      ])
      await vi.advanceTimersByTimeAsync(30_000)
      await syncing
    } finally {
      vi.useRealTimers()
    }

    expect((await listKept(b))[0]?.pdfUrl).toBe('https://store/pdf-1')
    expect(await (await readKeptPdf(b, 'p1'))?.blob.text()).toBe(
      '%PDF-1.7 first',
    )
  })

  test('a photo the phone had no room for is not fetched every sync, and nothing is rewritten', async () => {
    const b = freshBusiness()
    const cache = await keptCache()
    cache.failPut = (key) =>
      key.endsWith('/photo')
        ? new DOMException('full', 'QuotaExceededError')
        : null
    expect((await keepProduct(request(b))).photoUrl).toBeNull()
    const puts = vi.spyOn(cache, 'put')
    fetchMock.mockClear()

    for (let i = 0; i < 3; i++) await syncKept(b, [live()])

    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://store/photo-1',
      expect.anything(),
    )
    expect(puts).not.toHaveBeenCalled()
  })

  test('calls while one runs join it, and the newest list wins', async () => {
    const b = freshBusiness()
    await keepProduct(request(b))

    const first = syncKept(b, [live({ name: 'First' })])
    const second = syncKept(b, [live({ name: 'Second' })])
    const third = syncKept(b, [live({ name: 'Third' })])
    expect(second).toBe(third)
    await Promise.all([first, second, third])

    expect((await listKept(b))[0]?.name).toBe('Third')
  })
})

describe('pdf.js’s own files', () => {
  test('after a keep, what a kept page could need is fetched once, for the worker to keep', async () => {
    const b = freshBusiness()
    // An installed app: online, with the service worker in charge.
    vi.stubGlobal('navigator', {
      onLine: true,
      serviceWorker: { controller: {} },
    })
    served.set(
      '/pdfjs/version.json',
      JSON.stringify({
        version: '5.4.296',
        warm: {
          always: ['standard_fonts/FoxitSymbol.pfb'],
          wasm: ['wasm/openjpeg.wasm', 'iccs/cmyk.icc'],
          nowasm: ['wasm/openjpeg_nowasm_fallback.js'],
        },
      }),
    )
    for (const file of [
      'standard_fonts/FoxitSymbol.pfb',
      'wasm/openjpeg.wasm',
      'iccs/cmyk.icc',
      'wasm/openjpeg_nowasm_fallback.js',
    ]) {
      served.set(`/pdfjs/${file}`, 'bytes')
    }
    // One the worker already has from an earlier PDF.
    const workers = await storage.open('pdfjs-assets-5.4.296')
    await workers.put('/pdfjs/iccs/cmyk.icc', new Response('bytes'))
    const pdfjsAsked = () =>
      fetchMock.mock.calls
        .map(([url]) => url as string)
        .filter((url) => url.startsWith('/pdfjs/'))

    await keepProduct(request(b))

    await vi.waitFor(() =>
      expect(pdfjsAsked()).toEqual([
        '/pdfjs/version.json',
        '/pdfjs/standard_fonts/FoxitSymbol.pfb',
        '/pdfjs/wasm/openjpeg.wasm',
      ]),
    )

    // Once a page load: the next keep asks for none of it.
    fetchMock.mockClear()
    await keepProduct(request(b, { productId: 'p2', name: 'Two' }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(pdfjsAsked()).toEqual([])
  })
})

describe('useKeptProducts', () => {
  test('renders the same on the server as on the first client render', () => {
    const seen: Array<unknown> = []
    function Probe() {
      const state = useKeptProducts('b-ssr')
      seen.push({ supported: state.supported, entries: state.entries })
      return null
    }

    renderToStaticMarkup(createElement(Probe))

    // Cache Storage is stubbed as available, and still: nothing is read
    // during a server render, so there is nothing for hydration to disagree
    // with.
    expect(seen).toEqual([{ supported: false, entries: null }])
  })
})
