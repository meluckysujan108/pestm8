import { describe, expect, test, vi } from 'vitest'
import { RELOAD_INIT, loadEditableImage } from './editableImage'
import type { EditableImageDeps } from './editableImage'

const PHOTO = 'https://example.convex.cloud/api/storage/abc'
const BLOB_URL = 'blob:http://localhost/1'

/** Stands in for a loaded <img>: only its src matters to these tests. */
function fakeImage(src: string): HTMLImageElement {
  return { src } as HTMLImageElement
}

/**
 * Deps where the photo's CORS load does whatever `cors` says, the blob: URL
 * loads unless `blobLoads` is false, and `fetch` answers `fetched`.
 */
function deps({
  cors,
  blobLoads = true,
  fetched = () => Promise.resolve(new Response(new Blob(['jpeg']))),
}: {
  cors: 'loads' | 'fails'
  blobLoads?: boolean
  fetched?: () => Promise<Response>
}) {
  const d = {
    loadImage: vi.fn((src: string, crossOrigin?: 'anonymous') => {
      if (src === PHOTO) {
        return cors === 'loads' && crossOrigin === 'anonymous'
          ? Promise.resolve(fakeImage(src))
          : Promise.reject(new Error('net::ERR_FAILED'))
      }
      return blobLoads
        ? Promise.resolve(fakeImage(src))
        : Promise.reject(new Error('not an image'))
    }),
    fetch: vi.fn((_url: string, _init: RequestInit) => fetched()),
    createObjectURL: vi.fn((_blob: Blob) => BLOB_URL),
    revokeObjectURL: vi.fn((_url: string) => {}),
  } satisfies EditableImageDeps
  return d
}

describe('loadEditableImage', () => {
  test('a photo that loads with CORS is used as it is, and nothing is fetched', async () => {
    const d = deps({ cors: 'loads' })
    const loaded = await loadEditableImage(PHOTO, { deps: d })

    expect(loaded.image.src).toBe(PHOTO)
    expect(d.loadImage).toHaveBeenCalledWith(PHOTO, 'anonymous')
    expect(d.fetch).not.toHaveBeenCalled()
    loaded.release()
    expect(d.revokeObjectURL).not.toHaveBeenCalled()
  })

  test('a refused CORS load — the opaque copy a service worker kept — is fetched again past every cache and shown from a blob: URL', async () => {
    const d = deps({ cors: 'fails' })
    const loaded = await loadEditableImage(PHOTO, { deps: d })

    expect(d.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = d.fetch.mock.calls[0]
    expect(url).toBe(PHOTO)
    expect(init).toMatchObject({
      mode: 'cors',
      credentials: 'omit',
      cache: 'reload',
    })
    expect(init).toMatchObject(RELOAD_INIT)
    expect(await d.createObjectURL.mock.calls[0][0].text()).toBe('jpeg')
    // Loaded from the blob: URL, with no crossOrigin: it is this page's own,
    // so the canvas that draws it can still be saved.
    expect(d.loadImage).toHaveBeenLastCalledWith(BLOB_URL)
    expect(loaded.image.src).toBe(BLOB_URL)

    expect(d.revokeObjectURL).not.toHaveBeenCalled()
    loaded.release()
    expect(d.revokeObjectURL).toHaveBeenCalledWith(BLOB_URL)
  })

  test('tries only twice: no signal on the second try fails the load', async () => {
    const d = deps({
      cors: 'fails',
      fetched: () => Promise.reject(new TypeError('Failed to fetch')),
    })
    await expect(loadEditableImage(PHOTO, { deps: d })).rejects.toThrow(
      'Failed to fetch',
    )
    expect(d.fetch).toHaveBeenCalledTimes(1)
    expect(d.createObjectURL).not.toHaveBeenCalled()
  })

  test('a photo storage no longer has fails the load, with nothing made of the error page', async () => {
    const d = deps({
      cors: 'fails',
      fetched: () => Promise.resolve(new Response('gone', { status: 404 })),
    })
    await expect(loadEditableImage(PHOTO, { deps: d })).rejects.toThrow('404')
    expect(d.createObjectURL).not.toHaveBeenCalled()
  })

  test('a fetched file that is not an image fails the load and lets go of its blob: URL', async () => {
    const d = deps({ cors: 'fails', blobLoads: false })
    await expect(loadEditableImage(PHOTO, { deps: d })).rejects.toThrow()
    expect(d.revokeObjectURL).toHaveBeenCalledWith(BLOB_URL)
  })

  test('closed before the first try failed: nothing is fetched', async () => {
    const controller = new AbortController()
    const d = deps({ cors: 'fails' })
    d.loadImage.mockImplementationOnce(() => {
      controller.abort()
      return Promise.reject(new Error('net::ERR_FAILED'))
    })
    await expect(
      loadEditableImage(PHOTO, { signal: controller.signal, deps: d }),
    ).rejects.toThrow()
    expect(d.fetch).not.toHaveBeenCalled()
  })

  test('closed while the second try loaded: its blob: URL is let go', async () => {
    const controller = new AbortController()
    const d = deps({ cors: 'fails' })
    d.loadImage.mockImplementation((src: string) => {
      if (src === PHOTO) return Promise.reject(new Error('net::ERR_FAILED'))
      controller.abort()
      return Promise.resolve(fakeImage(src))
    })
    await expect(
      loadEditableImage(PHOTO, { signal: controller.signal, deps: d }),
    ).rejects.toThrow()
    expect(d.fetch.mock.calls[0][1].signal).toBe(controller.signal)
    expect(d.revokeObjectURL).toHaveBeenCalledWith(BLOB_URL)
  })
})
