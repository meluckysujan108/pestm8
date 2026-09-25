import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  KEEP_BUDGET_BYTES,
  KEPT_LICENCE_CACHE,
  OLD_KEPT_LICENCE_CACHE,
  forgetKeptLicences,
  keepLicenceFile,
  keepWalletIndex,
  onKeptLicencesChange,
  readKeptLicenceFile,
  readKeptThumbnail,
  readKeptWallet,
  syncKeptWallet,
} from './keptLicence'
import { FileTransferError } from './pdfFiles'
import {
  forgetCachedPages,
  forgetRootState,
  resolveRootState,
} from './rootState'
import { getInitialState } from '#/lib/initialState'
import type {
  KeptLicenceFile,
  LiveLicence,
  LiveWallet,
  SyncOptions,
} from './keptLicence'

/**
 * My licences, kept on the holder's phone for sites with no signal: the list
 * and every file, refreshed whenever the list answers. What matters is that a
 * copy is never shown to anyone but the person who kept it — a licence card
 * is personal — that it goes whenever the person signed in changes, that it
 * follows the list (a file taken off goes from the phone too), and that it
 * stops at its budget rather than fill the phone.
 */

vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))

class FakeCache {
  entries = new Map<string, { body: Blob; headers: Headers }>()
  async put(key: string, res: Response) {
    this.entries.set(key, { body: await res.blob(), headers: res.headers })
  }
  async match(key: string) {
    const hit = this.entries.get(key)
    return hit ? new Response(hit.body, { headers: hit.headers }) : undefined
  }
  async delete(key: string) {
    return this.entries.delete(key)
  }
  // As a browser answers: whole URLs, not the paths that were put.
  async keys() {
    return [...this.entries.keys()].map((key) => ({
      url: `https://app.test${key}`,
    }))
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
  async delete(name: string) {
    return this.named.delete(name)
  }
}

function jwtFor(sub: string): string {
  const part = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  return `${part({ alg: 'EdDSA' })}.${part({ sub, iat: 1 })}.signature`
}

async function signIn(userId: string | null) {
  forgetRootState()
  vi.mocked(getInitialState).mockResolvedValueOnce({
    token: userId === null ? undefined : jwtFor(userId),
    theme: 'system',
  })
  await resolveRootState()
}

const FRONT: KeptLicenceFile = {
  _id: 'f1',
  kind: 'image',
  contentType: 'image/jpeg',
  fileName: 'Front.jpg',
  size: 40,
  uploadedAt: 1_700_000_000_000,
}
const CERTIFICATE: KeptLicenceFile = {
  _id: 'f2',
  kind: 'pdf',
  contentType: 'application/pdf',
  fileName: 'Certificate.pdf',
  size: 70,
  uploadedAt: 1_700_000_000_500,
}

function live(
  files: Array<KeptLicenceFile>,
  extra: Partial<LiveLicence> = {},
): LiveLicence {
  return {
    _id: 'l1',
    name: 'Pest management licence',
    number: 'PMT-4471',
    expiresOn: '2027-06-30',
    files: files.map((file) => ({
      ...file,
      url: `https://files.test/${file._id}`,
    })),
    ...extra,
  }
}

const mine = (...licences: Array<LiveLicence>): LiveWallet => ({
  mine: true,
  licences,
})

/** A fetch that answers every URL with its own name, and counts. */
function fakeNetwork() {
  const asked: Array<string> = []
  const fetchFile = (url: string) => {
    asked.push(url)
    return Promise.resolve(new Blob([`bytes of ${url}`]))
  }
  return { asked, fetchFile }
}

const thumbnails: SyncOptions['makeThumbnail'] = (blob) =>
  Promise.resolve(new Blob([`thumb (${blob.size})`], { type: 'image/jpeg' }))

let storage: FakeCacheStorage

beforeEach(async () => {
  storage = new FakeCacheStorage()
  vi.stubGlobal('caches', storage)
  await signIn('u1')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the kept list', () => {
  test('comes back as kept, for the person who kept it, without URLs', async () => {
    const licence = live([FRONT])
    expect(await keepWalletIndex('b1', 'm1', [licence])).toBe(true)
    const kept = await readKeptWallet('b1', 'm1')
    expect(kept?.licences).toEqual([
      {
        _id: 'l1',
        name: 'Pest management licence',
        number: 'PMT-4471',
        expiresOn: '2027-06-30',
        files: [FRONT],
      },
    ])
    // A URL on the phone would outlive the licence it opened.
    expect(JSON.stringify(kept)).not.toContain('https://')
    // Another membership's is empty.
    expect(await readKeptWallet('b1', 'm2')).toBeNull()
  })

  test('is never shown to someone else signed in on the phone, and goes', async () => {
    await keepWalletIndex('b1', 'm1', [live([FRONT])])
    await keepLicenceFile('b1', 'm1', FRONT, new Blob(['front']))
    await signIn('u2')
    expect(await readKeptWallet('b1', 'm1')).toBeNull()
    expect(await readKeptLicenceFile('b1', 'm1', 'f1', FRONT.uploadedAt)).toBe(
      null,
    )
    expect(storage.named.has(KEPT_LICENCE_CACHE)).toBe(false)
  })

  test('someone else keeping their own clears the first person’s first', async () => {
    await keepWalletIndex('b1', 'm1', [live([FRONT])])
    await signIn('u2')
    await keepWalletIndex('b1', 'm2', [live([])])
    await signIn('u1')
    // u2's wallet is not u1's to read, and u1's own went when u2 kept theirs.
    expect(await readKeptWallet('b1', 'm1')).toBeNull()
    expect(await readKeptWallet('b1', 'm2')).toBeNull()
  })

  test('one still being labelled is neither shown nor taken away', async () => {
    // Made, not yet labelled: what a first keep looks like for a moment.
    const cache = await storage.open(KEPT_LICENCE_CACHE)
    await cache.put(
      '/__kept-licence/b1/m1/index.json',
      new Response(JSON.stringify({ keptAt: 1, licences: [] })),
    )
    expect(await readKeptWallet('b1', 'm1')).toBeNull()
    expect(storage.named.has(KEPT_LICENCE_CACHE)).toBe(true)
    // The write it was waiting on labels it, and it reads.
    await keepWalletIndex('b1', 'm1', [live([FRONT])])
    expect((await readKeptWallet('b1', 'm1'))?.licences).toHaveLength(1)
  })

  test('is not kept while nobody is known to be signed in', async () => {
    await signIn(null)
    expect(await keepWalletIndex('b1', 'm1', [live([FRONT])])).toBe(false)
    expect(await keepLicenceFile('b1', 'm1', FRONT, new Blob(['x']))).toBe(
      false,
    )
    expect(storage.named.has(KEPT_LICENCE_CACHE)).toBe(false)
  })

  test('goes at every sign-in and sign-out, with the old single document', async () => {
    await keepWalletIndex('b1', 'm1', [live([FRONT])])
    await storage.open(OLD_KEPT_LICENCE_CACHE)
    await forgetCachedPages()
    expect(storage.named.has(KEPT_LICENCE_CACHE)).toBe(false)
    expect(storage.named.has(OLD_KEPT_LICENCE_CACHE)).toBe(false)
  })

  test('reads nothing where there is no Cache Storage', async () => {
    vi.stubGlobal('caches', undefined)
    expect(await keepWalletIndex('b1', 'm1', [live([FRONT])])).toBe(false)
    expect(await readKeptWallet('b1', 'm1')).toBeNull()
    await expect(
      syncKeptWallet('b1', 'm1', mine(live([FRONT])), fakeNetwork()),
    ).resolves.toBeUndefined()
  })

  test('says when it changes', async () => {
    const heard = vi.fn()
    const stop = onKeptLicencesChange(heard)
    await keepWalletIndex('b1', 'm1', [live([])])
    expect(heard).toHaveBeenCalled()
    stop()
    heard.mockClear()
    await forgetKeptLicences()
    expect(heard).not.toHaveBeenCalled()
  })

  test('uses the cache names rootState.ts drops by name', () => {
    expect(KEPT_LICENCE_CACHE).toBe('pestm8-kept-licence-v2')
    expect(OLD_KEPT_LICENCE_CACHE).toBe('pestm8-kept-licence-v1')
  })
})

describe('a kept file', () => {
  test('is kept under its id and upload, with its thumbnail', async () => {
    const thumb = new Blob(['small'], { type: 'image/jpeg' })
    expect(
      await keepLicenceFile('b1', 'm1', FRONT, new Blob(['front']), thumb),
    ).toBe(true)
    const blob = await readKeptLicenceFile('b1', 'm1', 'f1', FRONT.uploadedAt)
    expect(await blob?.text()).toBe('front')
    expect(
      await (
        await readKeptThumbnail('b1', 'm1', 'f1', FRONT.uploadedAt)
      )?.text(),
    ).toBe('small')
    // Another upload of the same id is other bytes.
    expect(await readKeptLicenceFile('b1', 'm1', 'f1', 1)).toBeNull()
  })
})

describe('keeping the wallet up to date', () => {
  test('keeps the list and every file, one at a time, with thumbnails for photos', async () => {
    const network = fakeNetwork()
    await syncKeptWallet('b1', 'm1', mine(live([FRONT, CERTIFICATE])), {
      ...network,
      makeThumbnail: thumbnails,
    })
    expect(network.asked).toEqual([
      'https://files.test/f1',
      'https://files.test/f2',
    ])
    expect((await readKeptWallet('b1', 'm1'))?.licences[0].files).toEqual([
      FRONT,
      CERTIFICATE,
    ])
    expect(
      await (
        await readKeptLicenceFile('b1', 'm1', 'f2', CERTIFICATE.uploadedAt)
      )?.text(),
    ).toBe('bytes of https://files.test/f2')
    expect(
      await readKeptThumbnail('b1', 'm1', 'f1', FRONT.uploadedAt),
    ).not.toBeNull()
    // Never a thumbnail of a PDF.
    expect(
      await readKeptThumbnail('b1', 'm1', 'f2', CERTIFICATE.uploadedAt),
    ).toBeNull()
  })

  test('downloads nothing already kept, or already in hand', async () => {
    await keepLicenceFile('b1', 'm1', FRONT, new Blob(['front']))
    const network = fakeNetwork()
    await syncKeptWallet('b1', 'm1', mine(live([FRONT, CERTIFICATE])), {
      ...network,
      // Just uploaded from this phone.
      inHand: (fileId) => (fileId === 'f2' ? new Blob(['uploaded']) : null),
    })
    expect(network.asked).toEqual([])
    expect(
      await (
        await readKeptLicenceFile('b1', 'm1', 'f2', CERTIFICATE.uploadedAt)
      )?.text(),
    ).toBe('uploaded')
  })

  test('forgets files no longer on any licence', async () => {
    const network = fakeNetwork()
    await syncKeptWallet('b1', 'm1', mine(live([FRONT, CERTIFICATE])), network)
    // The certificate taken off on another phone.
    await syncKeptWallet('b1', 'm1', mine(live([FRONT])), network)
    expect(
      await readKeptLicenceFile('b1', 'm1', 'f2', CERTIFICATE.uploadedAt),
    ).toBeNull()
    expect(
      await readKeptLicenceFile('b1', 'm1', 'f1', FRONT.uploadedAt),
    ).not.toBeNull()
    // And the licence deleted.
    await syncKeptWallet('b1', 'm1', mine(), network)
    expect(
      await readKeptLicenceFile('b1', 'm1', 'f1', FRONT.uploadedAt),
    ).toBeNull()
    expect((await readKeptWallet('b1', 'm1'))?.licences).toEqual([])
  })

  test('stops at its budget rather than skip ahead', async () => {
    const small: KeptLicenceFile = { ...FRONT, _id: 'f3', size: 10 }
    const network = fakeNetwork()
    await syncKeptWallet(
      'b1',
      'm1',
      // 40 fits; 40 + 70 does not; the 10 after it is not tried.
      mine(live([FRONT, CERTIFICATE, small])),
      { ...network, budget: 100 },
    )
    expect(network.asked).toEqual(['https://files.test/f1'])
    // The list is kept whole all the same.
    expect((await readKeptWallet('b1', 'm1'))?.licences[0].files).toHaveLength(
      3,
    )
  })

  test('the budget is about sixty megabytes', () => {
    expect(KEEP_BUDGET_BYTES).toBe(60 * 1024 * 1024)
  })

  test('keeps nothing of someone else’s list', async () => {
    const network = fakeNetwork()
    await syncKeptWallet(
      'b1',
      'm2',
      { mine: false, licences: [live([FRONT])] },
      network,
    )
    expect(network.asked).toEqual([])
    expect(storage.named.has(KEPT_LICENCE_CACHE)).toBe(false)
  })

  test('with no signal it stops; a file gone from storage is passed over', async () => {
    const asked: Array<string> = []
    await syncKeptWallet('b1', 'm1', mine(live([FRONT, CERTIFICATE])), {
      fetchFile: (url) => {
        asked.push(url)
        return Promise.reject(
          new FileTransferError('network', 'no signal', null),
        )
      },
    })
    expect(asked).toEqual(['https://files.test/f1'])

    asked.length = 0
    await syncKeptWallet('b1', 'm1', mine(live([FRONT, CERTIFICATE])), {
      fetchFile: (url) => {
        asked.push(url)
        return url.endsWith('f1')
          ? Promise.reject(new FileTransferError('http', 'gone', 404))
          : Promise.resolve(new Blob(['certificate']))
      },
    })
    expect(asked).toEqual(['https://files.test/f1', 'https://files.test/f2'])
    expect(
      await readKeptLicenceFile('b1', 'm1', 'f2', CERTIFICATE.uploadedAt),
    ).not.toBeNull()
  })

  test('drops the old single-document copy', async () => {
    await storage.open(OLD_KEPT_LICENCE_CACHE)
    await syncKeptWallet('b1', 'm1', mine(live([])), fakeNetwork())
    expect(storage.named.has(OLD_KEPT_LICENCE_CACHE)).toBe(false)
  })

  test('asked again while it runs, runs once more with the latest list', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const asked: Array<string> = []
    const fetchFile = async (url: string) => {
      asked.push(url)
      await gate
      return new Blob(['x'])
    }
    const first = syncKeptWallet('b1', 'm1', mine(live([FRONT])), {
      fetchFile,
    })
    // Two more answers while the first is still downloading: only the last
    // is acted on, once.
    void syncKeptWallet('b1', 'm1', mine(live([FRONT, CERTIFICATE])), {
      fetchFile,
    })
    const last = syncKeptWallet('b1', 'm1', mine(live([CERTIFICATE])), {
      fetchFile,
    })
    release()
    await Promise.all([first, last])
    expect(asked).toEqual(['https://files.test/f1', 'https://files.test/f2'])
    // The front, no longer listed by the last answer, went again.
    expect(
      await readKeptLicenceFile('b1', 'm1', 'f1', FRONT.uploadedAt),
    ).toBeNull()
  })
})
