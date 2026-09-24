import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  KEPT_LICENCE_CACHE,
  forgetKeptLicence,
  keepLicence,
  readKeptLicence,
} from './keptLicence'
import {
  forgetCachedPages,
  forgetRootState,
  resolveRootState,
} from './rootState'
import { getInitialState } from '#/lib/initialState'
import type { KeptLicenceMeta } from './keptLicence'

/**
 * Phase 8.1: the holder's own licence kept on their phone. What matters is
 * that it is never shown to anyone but the person who kept it — a licence
 * card is personal — and that it goes whenever the person signed in changes.
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

const META: KeptLicenceMeta = {
  uploadedAt: 1_700_000_000_000,
  fileName: 'WA licence.pdf',
  kind: 'pdf',
  contentType: 'application/pdf',
  size: 12,
}

let storage: FakeCacheStorage

beforeEach(async () => {
  storage = new FakeCacheStorage()
  vi.stubGlobal('caches', storage)
  await signIn('u1')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the kept licence', () => {
  test('comes back as kept, for the person who kept it', async () => {
    const blob = new Blob(['%PDF-1.7 licence'], { type: 'application/pdf' })
    expect(await keepLicence('b1', 'm1', META, blob)).toBe(true)
    const copy = await readKeptLicence('b1', 'm1')
    expect(copy?.meta).toEqual(META)
    expect(await copy?.blob.text()).toBe('%PDF-1.7 licence')
    // Another membership's slot is empty.
    expect(await readKeptLicence('b1', 'm2')).toBeNull()
  })

  test('is never shown to someone else signed in on the phone, and goes', async () => {
    await keepLicence('b1', 'm1', META, new Blob(['x']))
    await signIn('u2')
    expect(await readKeptLicence('b1', 'm1')).toBeNull()
    expect(storage.named.has(KEPT_LICENCE_CACHE)).toBe(false)
  })

  test('is not kept while nobody is known to be signed in', async () => {
    await signIn(null)
    expect(await keepLicence('b1', 'm1', META, new Blob(['x']))).toBe(false)
    expect(storage.named.has(KEPT_LICENCE_CACHE)).toBe(false)
  })

  test('goes at every sign-in and sign-out', async () => {
    await keepLicence('b1', 'm1', META, new Blob(['x']))
    await forgetCachedPages()
    expect(storage.named.has(KEPT_LICENCE_CACHE)).toBe(false)
  })

  test('goes when its holder removes it', async () => {
    await keepLicence('b1', 'm1', META, new Blob(['x']))
    await forgetKeptLicence('b1', 'm1')
    expect(await readKeptLicence('b1', 'm1')).toBeNull()
  })

  test('reads nothing where there is no Cache Storage', async () => {
    vi.stubGlobal('caches', undefined)
    expect(await keepLicence('b1', 'm1', META, new Blob(['x']))).toBe(false)
    expect(await readKeptLicence('b1', 'm1')).toBeNull()
  })

  test('uses the cache name rootState.ts drops by name', () => {
    expect(KEPT_LICENCE_CACHE).toBe('pestm8-kept-licence-v1')
  })
})
