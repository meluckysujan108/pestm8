import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildIsGone } from './versionSkew'

const MODULE_URL = 'https://app.example/assets/versionSkew-ABC123.js'

function stubFetch(implementation: typeof fetch) {
  vi.stubGlobal('fetch', vi.fn(implementation))
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>
}

afterEach(() => vi.unstubAllGlobals())

describe('buildIsGone', () => {
  /**
   * The signal that separates the two failures a 500 from a server function
   * cannot tell apart on its own: a renamed endpoint, where reloading is the
   * whole cure, and a backend that is down, where wiping every client's offline
   * cache would turn something transient into something lasting.
   */
  it('reports skew when this build’s own chunk is gone', async () => {
    stubFetch(async () => new Response(null, { status: 404 }))

    await expect(buildIsGone(MODULE_URL)).resolves.toBe(true)
  })

  it('reports no skew while the chunk is still served', async () => {
    stubFetch(async () => new Response(null, { status: 200 }))

    await expect(buildIsGone(MODULE_URL)).resolves.toBe(false)
  })

  /**
   * A 500 from the asset host says the server is unwell, not that this build
   * has been replaced. Only an outright 404 is evidence.
   */
  it('reports no skew for any other status', async () => {
    for (const status of [200, 304, 403, 500, 503]) {
      stubFetch(async () => new Response(null, { status }))
      await expect(buildIsGone(MODULE_URL)).resolves.toBe(false)
    }
  })

  it('reports no skew when the probe cannot be sent at all', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch')
    })

    await expect(buildIsGone(MODULE_URL)).resolves.toBe(false)
  })

  /**
   * `no-store` handles the HTTP cache, but the service worker is the one
   * holding the copy whose existence is in question — its `assets` cache would
   * happily answer with the very file being asked about. A URL it has never
   * seen misses both that cache and the precache, so the probe reaches the
   * network.
   */
  it('asks for a URL no cache can already be holding', async () => {
    const fetchMock = stubFetch(async () => new Response(null, { status: 404 }))

    await buildIsGone(MODULE_URL)

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.origin + url.pathname).toBe(MODULE_URL)
    expect(url.searchParams.get('skew')).toBeTruthy()
    expect(init.cache).toBe('no-store')
    expect(init.method).toBe('HEAD')
  })
})
