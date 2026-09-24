import { signedInUserId } from '#/lib/rootState'

/**
 * The person's own licence document, kept on their phone (Phase 8.1).
 *
 * A technician is asked for their licence on site — by a client, a builder,
 * an inspector — and on site is where there is no signal. So the holder's own
 * licence is kept here as soon as it is on the phone anyway: the moment it is
 * uploaded from this phone, or the first time it is opened. Only the holder's
 * own: the owner opening a member's licence from Team never leaves a copy.
 *
 * The same approach as `keptProducts.ts`, cut down to one file per person:
 *
 *  - Cache Storage, one cache (`KEPT_LICENCE_CACHE`) written only here, under
 *    same-origin keys nothing ever fetches:
 *
 *      /__kept-licence/<businessId>/<membershipId>
 *
 *  - Each entry carries who kept it and which upload it is (`META_HEADER`).
 *    The upload is named by its `uploadedAt`, not its URL: the query hands
 *    out a URL and never the storage id, and `uploadedAt` is set once per
 *    upload by the server, so it names these exact bytes wherever the URL
 *    is served from.
 *  - Cleared whenever the person signed in changes — `forgetCachedPages`
 *    (rootState.ts) drops the whole cache at every sign-in and sign-out — and
 *    checked against the signed-in person before every read anyway, so a
 *    copy can never be shown to anyone but the person who kept it. Unlike a
 *    product's SDS, a licence card is personal information: losing the copy
 *    to a lapsed session costs one re-download on the next open with signal.
 *
 * Every call is guarded and never throws: `caches` is missing on the server,
 * outside a secure context and in Firefox's private windows, and any write
 * can fail on quota. A copy is a convenience; the network is still there.
 */

export const KEPT_LICENCE_CACHE = 'pestm8-kept-licence-v1'

const ROOT = '/__kept-licence'
const META_HEADER = 'X-Kept-Licence'

/** What is kept alongside the bytes. */
export type KeptLicenceMeta = {
  /** The upload these bytes are — `licences.file`'s `uploadedAt`. */
  uploadedAt: number
  fileName: string
  kind: 'pdf' | 'image'
  contentType: string
  size: number
}

export type KeptLicence = { blob: Blob; meta: KeptLicenceMeta }

type StoredMeta = KeptLicenceMeta & { userId: string }

const keyOf = (businessId: string, membershipId: string) =>
  `${ROOT}/${encodeURIComponent(businessId)}/${encodeURIComponent(membershipId)}`

function cachesAvailable(): boolean {
  try {
    return typeof caches !== 'undefined'
  } catch {
    return false
  }
}

function metaOf(res: Response): StoredMeta | null {
  const raw = res.headers.get(META_HEADER)
  if (!raw) return null
  try {
    const data = JSON.parse(decodeURIComponent(raw)) as Partial<StoredMeta>
    if (
      typeof data.userId !== 'string' ||
      typeof data.uploadedAt !== 'number' ||
      typeof data.fileName !== 'string' ||
      (data.kind !== 'pdf' && data.kind !== 'image') ||
      typeof data.contentType !== 'string' ||
      typeof data.size !== 'number'
    ) {
      return null
    }
    return data as StoredMeta
  } catch {
    return null
  }
}

/**
 * Keeps this person's licence. Nothing is kept while nobody is known to be
 * signed in: a copy nobody's name is on could not be checked before it was
 * shown. Resolves true when it was kept.
 */
export async function keepLicence(
  businessId: string,
  membershipId: string,
  meta: KeptLicenceMeta,
  blob: Blob,
): Promise<boolean> {
  const userId = signedInUserId()
  if (!userId || !cachesAvailable()) return false
  const stored: StoredMeta = { ...meta, userId }
  try {
    const cache = await caches.open(KEPT_LICENCE_CACHE)
    await cache.put(
      keyOf(businessId, membershipId),
      new Response(blob, {
        headers: {
          'Content-Type': meta.contentType,
          'Content-Length': String(blob.size),
          [META_HEADER]: encodeURIComponent(JSON.stringify(stored)),
        },
      }),
    )
    return true
  } catch {
    return false
  }
}

/**
 * This person's kept licence, or null — none kept, unreadable, or kept by
 * someone else (in which case every kept licence goes).
 */
export async function readKeptLicence(
  businessId: string,
  membershipId: string,
): Promise<KeptLicence | null> {
  if (!cachesAvailable()) return null
  try {
    // Reading never creates the cache.
    if (!(await caches.has(KEPT_LICENCE_CACHE))) return null
    const cache = await caches.open(KEPT_LICENCE_CACHE)
    const res = await cache.match(keyOf(businessId, membershipId))
    if (!res) return null
    const meta = metaOf(res)
    const userId = signedInUserId()
    if (!meta || !userId || meta.userId !== userId) {
      // Not provably this person's: nobody's, then.
      if (meta && userId && meta.userId !== userId) await forgetKeptLicences()
      return null
    }
    return {
      blob: await res.blob(),
      meta: {
        uploadedAt: meta.uploadedAt,
        fileName: meta.fileName,
        kind: meta.kind,
        contentType: meta.contentType,
        size: meta.size,
      },
    }
  } catch {
    return null
  }
}

/** Drops this person's kept licence — they removed it. */
export async function forgetKeptLicence(
  businessId: string,
  membershipId: string,
): Promise<void> {
  if (!cachesAvailable()) return
  try {
    if (!(await caches.has(KEPT_LICENCE_CACHE))) return
    const cache = await caches.open(KEPT_LICENCE_CACHE)
    await cache.delete(keyOf(businessId, membershipId))
  } catch {
    // Unreachable to anyone else anyway; the next sign-in change drops it.
  }
}

/** Drops every kept licence. `forgetCachedPages` does the same by name. */
export async function forgetKeptLicences(): Promise<void> {
  try {
    if (cachesAvailable()) await caches.delete(KEPT_LICENCE_CACHE)
  } catch {
    // A browser that refuses the cache has nothing kept in it.
  }
}
