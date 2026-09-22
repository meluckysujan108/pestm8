import { describe, expect, it } from 'vitest'
import {
  RUNTIME_CACHES,
  manifestVersion,
  previousRuntimeCaches,
  runtimeCacheName,
} from './swCaches'
import type { PrecacheEntry } from 'serwist'

const entry = (url: string, revision: string | null): PrecacheEntry => ({
  url,
  revision,
})

describe('manifestVersion', () => {
  it('changes when an asset hash changes', () => {
    const before = [entry('/assets/index-AAA.js', null)]
    const after = [entry('/assets/index-BBB.js', null)]

    expect(manifestVersion(before)).not.toBe(manifestVersion(after))
  })

  it('changes when an unhashed file is revised', () => {
    const before = [entry('/manifest.webmanifest', 'r1')]
    const after = [entry('/manifest.webmanifest', 'r2')]

    expect(manifestVersion(before)).not.toBe(manifestVersion(after))
  })

  /**
   * The whole reason it is derived from the manifest rather than stamped with a
   * timestamp: a deploy that changed only the backend must not throw away every
   * client's warm cache.
   */
  it('is stable across builds that emit the same assets', () => {
    const manifest = [
      entry('/assets/index-AAA.js', null),
      entry('/manifest.webmanifest', 'r1'),
    ]

    expect(manifestVersion([...manifest])).toBe(manifestVersion([...manifest]))
  })

  it('survives an absent or empty manifest', () => {
    expect(manifestVersion(undefined)).toBe(manifestVersion([]))
    expect(manifestVersion(undefined)).toMatch(/^[a-z0-9]+$/)
  })
})

describe('previousRuntimeCaches', () => {
  it('keeps this build and retires the one before it', () => {
    const existing = [
      ...RUNTIME_CACHES.map((base) => runtimeCacheName(base, 'old')),
      ...RUNTIME_CACHES.map((base) => runtimeCacheName(base, 'new')),
    ]

    expect(previousRuntimeCaches(existing, 'new').sort()).toEqual(
      RUNTIME_CACHES.map((base) => runtimeCacheName(base, 'old')).sort(),
    )
  })

  /**
   * The case that shipped the outage. Workers from before this versioning named
   * their caches `pages` and `assets` plain, and those are the caches holding
   * the stale document and the stale bundle it asks for.
   */
  it('retires the unversioned caches of older workers', () => {
    expect(previousRuntimeCaches(['pages', 'assets', 'images'], 'new')).toEqual(
      ['pages', 'assets', 'images'],
    )
  })

  /**
   * Serwist's precache shares this storage and is Serwist's to manage. Deleting
   * it here would fight its own cleanup and drop the offline shell.
   */
  it('leaves caches that are not ours alone', () => {
    const existing = [
      'serwist-precache-v2-http://localhost:3000/',
      'googleAnalytics',
      'runtime',
      'pages-new',
    ]

    expect(previousRuntimeCaches(existing, 'new')).toEqual([])
  })

  /**
   * A cache whose name merely *begins* with one of ours is not one of ours —
   * same anchoring hazard `themeInitScript` guards against in its cookie regex.
   */
  it('does not match a name that only starts with a runtime cache name', () => {
    expect(previousRuntimeCaches(['pagespeed', 'assetstore'], 'new')).toEqual(
      [],
    )
  })

  it('deletes nothing when nothing is cached', () => {
    expect(previousRuntimeCaches([], 'new')).toEqual([])
  })
})
