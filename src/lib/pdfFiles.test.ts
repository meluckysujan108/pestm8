import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  FileTransferError,
  asPdfFile,
  fetchWithProgress,
  formatBytes,
  isAppleTouch,
  looksLikePdf,
  productShareText,
  shareLink,
  sharePdf,
  shareProduct,
  uploadToStorage,
} from './pdfFiles'
import type { LoadProgress } from '#/components/pdf/types'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const CHROME_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1'

describe('isAppleTouch', () => {
  test('an iPhone, in Safari or in Chrome (WebKit either way)', () => {
    expect(
      isAppleTouch({
        userAgent: IPHONE_UA,
        platform: 'iPhone',
        maxTouchPoints: 5,
      }),
    ).toBe(true)
    expect(
      isAppleTouch({
        userAgent: CHROME_IOS_UA,
        platform: 'iPhone',
        maxTouchPoints: 5,
      }),
    ).toBe(true)
  })

  test('an iPad asking for desktop sites says Mac, and has a touch screen', () => {
    expect(
      isAppleTouch({
        userAgent: IPAD_DESKTOP_UA,
        platform: 'MacIntel',
        maxTouchPoints: 5,
      }),
    ).toBe(true)
  })

  test('a Mac says the same, with no touch screen', () => {
    expect(
      isAppleTouch({
        userAgent: IPAD_DESKTOP_UA,
        platform: 'MacIntel',
        maxTouchPoints: 0,
      }),
    ).toBe(false)
  })

  test('the platform can be blank; the user agent still gives an iPad away', () => {
    expect(
      isAppleTouch({
        userAgent: IPAD_DESKTOP_UA,
        platform: '',
        maxTouchPoints: 5,
      }),
    ).toBe(true)
  })

  test('Android phones and touch-screen Windows laptops are not Apple', () => {
    expect(
      isAppleTouch({
        userAgent: ANDROID_UA,
        platform: 'Linux armv8l',
        maxTouchPoints: 5,
      }),
    ).toBe(false)
    expect(
      isAppleTouch({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        platform: 'Win32',
        maxTouchPoints: 10,
      }),
    ).toBe(false)
  })
})

describe('productShareText', () => {
  test('name, description and link, a blank line between each', () => {
    expect(
      productShareText({
        name: 'Termidor HE',
        description: 'Liquid termiticide.\nMix 60 mL per 10 L.',
        url: 'https://example.com/termidor',
      }),
    ).toBe(
      'Termidor HE\n\nLiquid termiticide.\nMix 60 mL per 10 L.\n\nhttps://example.com/termidor',
    )
  })

  test('leaves out what is missing or blank, without leaving gaps', () => {
    expect(
      productShareText({
        name: 'Termidor HE',
        description: null,
        url: 'https://example.com/termidor',
      }),
    ).toBe('Termidor HE\n\nhttps://example.com/termidor')
    expect(
      productShareText({ name: 'Termidor HE', description: '   ', url: '' }),
    ).toBe('Termidor HE')
  })

  test('trims each part', () => {
    expect(
      productShareText({
        name: '  Termidor HE ',
        description: ' Liquid termiticide. ',
      }),
    ).toBe('Termidor HE\n\nLiquid termiticide.')
  })
})

describe('formatBytes', () => {
  test('decimal units, as the phone’s Files app counts', () => {
    expect(formatBytes(842_000)).toBe('842 KB')
    expect(formatBytes(1_200_000)).toBe('1.2 MB')
    expect(formatBytes(12_000_000)).toBe('12 MB')
    expect(formatBytes(12_340_000)).toBe('12.3 MB')
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB')
  })

  test('bytes below a kilobyte, singular for one', () => {
    expect(formatBytes(0)).toBe('0 bytes')
    expect(formatBytes(1)).toBe('1 byte')
    expect(formatBytes(999)).toBe('999 bytes')
    expect(formatBytes(1000)).toBe('1 KB')
  })

  test('rounds before choosing the unit: never "1,000 KB"', () => {
    expect(formatBytes(999_999)).toBe('1 MB')
    expect(formatBytes(999_960_000)).toBe('1 GB')
  })

  test('nonsense reads as nothing rather than NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('0 bytes')
    expect(formatBytes(-5)).toBe('0 bytes')
  })
})

describe('looksLikePdf', () => {
  test('a file that starts with the PDF header', async () => {
    expect(await looksLikePdf(new Blob(['%PDF-1.7\n%âãÏÓ\n1 0 obj']))).toBe(
      true,
    )
  })

  test('the header may sit anywhere in the first 1024 bytes', async () => {
    const junk = 'x'.repeat(1000)
    expect(await looksLikePdf(new Blob([junk, '%PDF-1.4']))).toBe(true)
  })

  test('but not after them', async () => {
    const junk = 'x'.repeat(1024)
    expect(await looksLikePdf(new Blob([junk, '%PDF-1.4']))).toBe(false)
  })

  test('a Word document with a .pdf name, or nothing at all', async () => {
    expect(await looksLikePdf(new Blob(['PK\u0003\u0004word/document']))).toBe(
      false,
    )
    expect(await looksLikePdf(new Blob([]))).toBe(false)
    expect(await looksLikePdf(new Blob(['%PDF']))).toBe(false)
  })
})

describe('asPdfFile', () => {
  test('keeps a name that already ends in .pdf and types it as a PDF', () => {
    const file = asPdfFile(new Blob(['%PDF-']), 'Termidor SDS.PDF')
    expect(file.name).toBe('Termidor SDS.PDF')
    expect(file.type).toBe('application/pdf')
  })

  test('adds .pdf to a name without it, and names a nameless file', () => {
    expect(asPdfFile(new Blob([]), 'Termidor SDS').name).toBe(
      'Termidor SDS.pdf',
    )
    expect(asPdfFile(new Blob([]), '  ').name).toBe('document.pdf')
  })
})

/** A response whose body arrives in the chunks given. */
function streamed(
  chunks: Array<string>,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status, headers })
}

describe('fetchWithProgress', () => {
  test('reports progress against Content-Length and returns the bytes', async () => {
    const fetchMock = vi.fn(async () =>
      streamed(['%PDF-', '1.7', '\n'], {
        'Content-Length': '9',
        'Content-Type': 'application/pdf',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const seen: Array<LoadProgress> = []

    const blob = await fetchWithProgress('https://files/a', (p) => seen.push(p))

    expect(await blob.text()).toBe('%PDF-1.7\n')
    expect(blob.type).toBe('application/pdf')
    expect(seen).toEqual([
      { loaded: 0, total: 9 },
      { loaded: 5, total: 9 },
      { loaded: 8, total: 9 },
      { loaded: 9, total: 9 },
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://files/a',
      expect.objectContaining({ credentials: 'omit' }),
    )
  })

  test('no length means no total; no type means a PDF', async () => {
    vi.stubGlobal('fetch', async () => streamed(['%PDF-']))
    const seen: Array<LoadProgress> = []

    const blob = await fetchWithProgress('https://files/a', (p) => seen.push(p))

    expect(blob.type).toBe('application/pdf')
    expect(seen.every((p) => p.total === null)).toBe(true)
  })

  test('octet-stream is taken as a PDF too; a real type is kept', async () => {
    vi.stubGlobal('fetch', async () =>
      streamed(['%PDF-'], { 'Content-Type': 'application/octet-stream' }),
    )
    expect((await fetchWithProgress('u', () => {})).type).toBe(
      'application/pdf',
    )

    vi.stubGlobal('fetch', async () =>
      streamed(['<html>'], { 'Content-Type': 'text/html; charset=utf-8' }),
    )
    expect((await fetchWithProgress('u', () => {})).type).toBe('text/html')
  })

  test('a body that outgrows its length stops claiming a total', async () => {
    vi.stubGlobal('fetch', async () =>
      streamed(['%PDF-', '1.7'], { 'Content-Length': '5' }),
    )
    const seen: Array<LoadProgress> = []
    await fetchWithProgress('u', (p) => seen.push(p))
    expect(seen.at(-1)).toEqual({ loaded: 8, total: null })
  })

  test('an HTTP error is an http FileTransferError with the status', async () => {
    vi.stubGlobal('fetch', async () => streamed(['nope'], {}, 404))
    const error = await fetchWithProgress('u', () => {}).catch((e) => e)
    expect(error).toBeInstanceOf(FileTransferError)
    expect(error).toMatchObject({ kind: 'http', status: 404 })
  })

  test('no connection is a network FileTransferError', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    const error = await fetchWithProgress('u', () => {}).catch((e) => e)
    expect(error).toBeInstanceOf(FileTransferError)
    expect(error).toMatchObject({ kind: 'network', status: null })
  })

  test('an abort comes through as the AbortError it is', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', async () => {
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    const error = await fetchWithProgress(
      'u',
      () => {},
      controller.signal,
    ).catch((e) => e)
    expect(error).not.toBeInstanceOf(FileTransferError)
    expect(error).toMatchObject({ name: 'AbortError' })
  })
})

/**
 * A response that sends `first`, then one chunk per entry of `later` after
 * that many milliseconds each — and then, unless `close`, nothing ever again.
 */
function trickled(
  first: string,
  later: Array<[number, string]>,
  close: boolean,
): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first))
      let at = 0
      for (const [after, chunk] of later) {
        at += after
        setTimeout(() => controller.enqueue(encoder.encode(chunk)), at)
      }
      if (close) setTimeout(() => controller.close(), at)
    },
  })
  return new Response(body)
}

describe('fetchWithProgress with stallMs', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('a body that stops arriving is a network error, not a wait for ever', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => trickled('%PDF-', [], false))

    const settled = fetchWithProgress('u', () => {}, undefined, {
      stallMs: 30_000,
    }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(30_000)

    const error = await settled
    expect(error).toBeInstanceOf(FileTransferError)
    expect(error).toMatchObject({ kind: 'network', status: null })
  })

  test('a server that never answers is the same', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))

    const settled = fetchWithProgress('u', () => {}, undefined, {
      stallMs: 30_000,
    }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(await settled).toMatchObject({ kind: 'network' })
  })

  test('a slow file that keeps arriving is never cut off', async () => {
    vi.useFakeTimers()
    // 100 s in all, but never 30 s without a byte.
    vi.stubGlobal('fetch', async () =>
      trickled(
        '%PDF-',
        [
          [25_000, 'a'],
          [25_000, 'b'],
          [25_000, 'c'],
          [25_000, 'd'],
        ],
        true,
      ),
    )

    const settled = fetchWithProgress('u', () => {}, undefined, {
      stallMs: 30_000,
    })
    await vi.advanceTimersByTimeAsync(100_000)

    expect(await (await settled).text()).toBe('%PDF-abcd')
  })

  test('the caller’s abort is still an AbortError', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => trickled('%PDF-', [], false))
    const controller = new AbortController()

    const settled = fetchWithProgress('u', () => {}, controller.signal, {
      stallMs: 30_000,
    }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()

    const error = await settled
    expect(error).not.toBeInstanceOf(FileTransferError)
    expect(error).toMatchObject({ name: 'AbortError' })
  })
})

describe('uploadToStorage', () => {
  test('posts the bytes with their type and returns the storage id', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ storageId: 'kg2abc' })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const blob = new Blob(['%PDF-'])

    expect(
      await uploadToStorage('https://upload', blob, 'application/pdf'),
    ).toBe('kg2abc')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://upload',
      expect.objectContaining({
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': 'application/pdf' },
      }),
    )
  })

  test('a refused upload, or one with no id, throws', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 413 }))
    await expect(
      uploadToStorage('u', new Blob([]), 'application/pdf'),
    ).rejects.toMatchObject({ kind: 'http', status: 413 })

    vi.stubGlobal('fetch', async () => new Response('{}'))
    await expect(
      uploadToStorage('u', new Blob([]), 'application/pdf'),
    ).rejects.toBeInstanceOf(FileTransferError)
  })
})

/** A navigator with a share sheet that takes files, and a clipboard. */
function stubNavigator(overrides: Record<string, unknown> = {}) {
  const nav = {
    userAgent: ANDROID_UA,
    platform: 'Linux armv8l',
    maxTouchPoints: 5,
    share: vi.fn(async (_data: ShareData) => {}),
    canShare: vi.fn((_data: ShareData) => true),
    clipboard: { writeText: vi.fn(async (_text: string) => {}) },
    ...overrides,
  }
  vi.stubGlobal('navigator', nav)
  return nav
}

const PRODUCT = {
  name: 'Termidor HE',
  description: 'Liquid termiticide.',
  url: 'https://example.com/termidor',
}

describe('shareProduct', () => {
  test('with a file and a sheet that takes files: the PDF and the words', async () => {
    const nav = stubNavigator()
    const file = asPdfFile(new Blob(['%PDF-']), 'termidor.pdf')

    expect(await shareProduct({ ...PRODUCT, file })).toBe('shared')
    expect(nav.share).toHaveBeenCalledWith({
      title: 'Termidor HE',
      text: 'Termidor HE\n\nLiquid termiticide.\n\nhttps://example.com/termidor',
      files: [file],
    })
  })

  test('without a file: the words, the link inside them and not again as url', async () => {
    const nav = stubNavigator()

    expect(await shareProduct(PRODUCT)).toBe('shared')
    const data = nav.share.mock.calls[0]?.[0]
    expect(data).toEqual({
      title: 'Termidor HE',
      text: 'Termidor HE\n\nLiquid termiticide.\n\nhttps://example.com/termidor',
    })
    expect(data).not.toHaveProperty('url')
  })

  test('a sheet that cannot take files still shares the words', async () => {
    const nav = stubNavigator({ canShare: vi.fn(() => false) })
    const file = asPdfFile(new Blob(['%PDF-']), 'termidor.pdf')

    expect(await shareProduct({ ...PRODUCT, file })).toBe('shared')
    expect(nav.share.mock.calls[0]?.[0]).not.toHaveProperty('files')
  })

  test('closing the sheet is "cancelled"; anything else is "failed"', async () => {
    stubNavigator({
      share: vi.fn(async () => {
        throw new DOMException('Share canceled', 'AbortError')
      }),
    })
    expect(await shareProduct(PRODUCT)).toBe('cancelled')

    stubNavigator({
      share: vi.fn(async () => {
        throw new DOMException(
          'Must be handling a user gesture',
          'NotAllowedError',
        )
      }),
    })
    expect(await shareProduct(PRODUCT)).toBe('failed')
  })

  test('no share sheet at all: copied to the clipboard', async () => {
    const nav = stubNavigator({ share: undefined, canShare: undefined })

    expect(await shareProduct(PRODUCT)).toBe('copied')
    expect(nav.clipboard.writeText).toHaveBeenCalledWith(
      'Termidor HE\n\nLiquid termiticide.\n\nhttps://example.com/termidor',
    )
  })

  test('no share sheet and no clipboard: failed, not a throw', async () => {
    stubNavigator({
      share: undefined,
      canShare: undefined,
      clipboard: undefined,
    })
    expect(await shareProduct(PRODUCT)).toBe('failed')
  })
})

describe('sharePdf', () => {
  test('shares the file alone unless words are asked for', async () => {
    const nav = stubNavigator()
    const file = asPdfFile(new Blob(['%PDF-']), 'sds.pdf')

    await sharePdf(file)
    expect(nav.share).toHaveBeenCalledWith({ files: [file] })
  })

  test('a closed sheet resolves quietly; a refusal rejects', async () => {
    const file = asPdfFile(new Blob(['%PDF-']), 'sds.pdf')
    stubNavigator({
      share: vi.fn(async () => {
        throw new DOMException('Share canceled', 'AbortError')
      }),
    })
    await expect(sharePdf(file)).resolves.toBeUndefined()

    stubNavigator({
      share: vi.fn(async () => {
        throw new DOMException('no gesture', 'NotAllowedError')
      }),
    })
    await expect(sharePdf(file)).rejects.toMatchObject({
      name: 'NotAllowedError',
    })
  })

  test('calls share() before awaiting anything, so the tap still counts', () => {
    const nav = stubNavigator()
    const file = asPdfFile(new Blob(['%PDF-']), 'sds.pdf')

    void sharePdf(file)
    // Synchronously — no microtask has run yet.
    expect(nav.share).toHaveBeenCalledTimes(1)
  })
})

describe('shareLink', () => {
  test('a lone link goes as the url, so targets preview it', async () => {
    const nav = stubNavigator()
    expect(
      await shareLink({ title: 'Termidor HE', url: 'https://example.com/t' }),
    ).toBe('shared')
    expect(nav.share).toHaveBeenCalledWith({
      title: 'Termidor HE',
      url: 'https://example.com/t',
    })
  })

  test('with no share sheet the link is copied', async () => {
    const nav = stubNavigator({ share: undefined })
    expect(await shareLink({ url: 'https://example.com/t' })).toBe('copied')
    expect(nav.clipboard.writeText).toHaveBeenCalledWith(
      'https://example.com/t',
    )
  })
})
