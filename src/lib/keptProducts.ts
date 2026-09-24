import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  FileTransferError,
  PDF_TYPE,
  fetchWithProgress,
  isAbortError,
} from '#/lib/pdfFiles'
import { signedInUserId } from '#/lib/rootState'
import type { LoadProgress } from '#/components/pdf/types'

/**
 * "Keep on this phone": a copy of a product's PDF (and its photo) for sites
 * with no signal.
 *
 * The case this exists for is a technician in a roof void or under a house
 * who needs the label or the safety data sheet for what they are about to
 * spray. Convex's cached query results are in memory only and the PDF is a
 * file on Convex's storage domain, so with no signal the viewer has nothing to
 * open unless the bytes were put somewhere on the phone beforehand — and the
 * person chose which ones, because a phone on a capped plan should not
 * silently download every SDS the business has.
 *
 * ── Where the copies live ────────────────────────────────────────────────
 *
 * Cache Storage, one cache named `KEPT_CACHE`, written only by this module.
 * Not IndexedDB, which is what `draftMirror.ts` uses for small records:
 * storing multi-megabyte Blobs in IndexedDB has a history of failing on
 * Safari, while a Cache entry is a Response, which is what a file is.
 *
 * The name is deliberately not one the service worker manages. `src/sw.ts`
 * names its caches 'pages', 'assets', 'images' and 'pdfjs-assets-*', and
 * Serwist's outdated-cache cleanup only removes caches whose names contain
 * "-precache-" and the worker's scope — so a new deploy never takes these
 * with it. Nothing ever fetches the keys below from the network; they are
 * same-origin paths only because the Cache API keys entries by request URL:
 *
 *   /__kept/keeper.json                         whose files these are
 *   /__kept/<businessId>/manifest.json          what is kept, as KeptProduct[]
 *   /__kept/<businessId>/<productId>/pdf        the PDF
 *   /__kept/<businessId>/<productId>/photo      its photo, when there is one
 *
 * The manifest is written LAST when keeping and FIRST when forgetting, so a
 * product never appears kept with its file missing. Each stored file also
 * carries the URL it was fetched from (`SOURCE_HEADER`), so what
 * `readKeptPdf` reports is true of the bytes themselves even if a manifest
 * write was lost between the two. Reading never creates the cache: a phone
 * that has never kept anything has none, which is what lets rootState.ts tell
 * at a glance that there is nothing here to check.
 *
 * ── Whose they are ───────────────────────────────────────────────────────
 *
 * The person's who kept them, and nobody else's. The first keep records their
 * user id (`KEEPER_KEY`), and before anything here is read or written, the
 * person signed in now is checked against it (`claimKept`): someone else, and
 * every kept file goes first. rootState.ts runs the same check as soon as a
 * page load knows who is signed in, so a phone that changes hands is cleared
 * whether or not the next person ever opens a product.
 *
 * Not simply dropped at every sign-in and sign-out, which is what the page
 * cache gets (`forgetCachedPages`): a Better Auth session lapses after a week
 * unused, and the same technician signing back in would lose every file they
 * kept, silently, to find out in a roof void. Signing out leaves the files
 * where they are — unreachable while nobody is signed in, since the Products
 * page needs a session, and only ever listed per business, which a person has
 * to belong to to open — and they go the moment anyone else signs in.
 *
 * Who is signed in is read from the session's token (`signedInUserId`). A
 * token that cannot be read checks nothing and forgets nothing: the files
 * then outlast a change of person, still listed only in a business the next
 * person must belong to, rather than vanish from the person who kept them.
 *
 * ── How long they last ───────────────────────────────────────────────────
 *
 * Until forgotten, the product loses its PDF, someone else signs in, or the
 * browser evicts the origin's storage. The first keep asks for persistent
 * storage, which Chrome grants to an installed app and Safari to a
 * home-screen one; without it a browser short on space may clear everything
 * this origin stored at once. The page should treat a kept copy as likely,
 * never certain — and it can: `readKeptPdf` answers null and the network is
 * still there to try.
 *
 * Every Cache Storage call is guarded. `caches` does not exist on the server
 * or outside a secure context, Firefox's private windows refuse to open it,
 * and any write can fail on quota.
 */

export const KEPT_CACHE = 'pestm8-kept-products-v1'

const KEPT_ROOT = '/__kept'
const KEEPER_KEY = `${KEPT_ROOT}/keeper.json`
/** On each stored file: the URL its bytes were fetched from, URI-encoded. */
const SOURCE_HEADER = 'X-Kept-Source'

/**
 * How long a download may go with no bytes arriving before it is given up as
 * a network failure. Counted from the last bytes, so a big file on a slow link
 * that is still coming is never cut off — only one that has stopped.
 */
const STALL_MS = 30_000

export type KeptProduct = {
  productId: string
  businessId: string
  name: string
  description: string | null
  url: string | null
  fileName: string
  /** Bytes, as stored — not the size the server last reported. */
  size: number
  /** The URL the PDF was fetched from: the identity of the bytes kept. */
  pdfUrl: string
  /**
   * The URL of the photo stored alongside, or null for none. It changes only
   * together with the stored photo, so it always describes the bytes here.
   */
  photoUrl: string | null
  /** When this copy of the PDF was stored (re-set when it is refreshed). */
  keptAt: number
}

/**
 * What to keep. `keptAt` is stamped here, and `size` is measured from the
 * bytes stored, so a caller spreading a KeptProduct-shaped object in may pass
 * one and it is ignored.
 */
export type KeepRequest = Omit<KeptProduct, 'keptAt' | 'size'> & {
  size?: number | null
}

/** What a keep can fail on, for the page to say which. */
export type KeepFailure =
  /** No Cache Storage here: a private window, or an old or insecure page. */
  | 'unsupported'
  /** No signal, or it dropped (or stalled) mid-download. Worth a retry. */
  | 'network'
  /** The server would not send the file — usually because it is gone. */
  | 'http'
  /** The phone is out of room for this origin. */
  | 'quota'
  /** The cache refused for some other reason. */
  | 'storage'

export class KeepError extends Error {
  readonly reason: KeepFailure

  constructor(
    reason: KeepFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'KeepError'
    this.reason = reason
  }
}

const MESSAGES: Record<KeepFailure, string> = {
  unsupported:
    'This browser cannot keep files on the phone. A private window never can.',
  network: 'Could not download the PDF. Check your signal and try again.',
  http: 'The server could not send the PDF. It may have been replaced or removed.',
  quota:
    'This phone has no room left for offline files. Remove something you have kept, or free up space, then try again.',
  storage: 'This phone could not save the PDF. Try again.',
}

const SIGNED_OUT = 'Signed out before the PDF was kept.'
const SOMEONE_ELSE =
  'The files kept on this phone belong to someone else signed in here. Reload the app, then try again.'

function keepErrorFrom(error: unknown): unknown {
  if (error instanceof KeepError || isAbortError(error)) return error
  if (error instanceof FileTransferError) {
    return new KeepError(
      error.kind === 'network' ? 'network' : 'http',
      error.kind === 'http' && error.status === 404
        ? 'The PDF is no longer there. It may have been replaced or removed.'
        : MESSAGES[error.kind === 'network' ? 'network' : 'http'],
      { cause: error },
    )
  }
  const name = (error as { name?: unknown } | null)?.name
  const code = (error as { code?: unknown } | null)?.code
  if (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22
  ) {
    return new KeepError('quota', MESSAGES.quota, { cause: error })
  }
  if (name === 'SecurityError') {
    return new KeepError('unsupported', MESSAGES.unsupported, { cause: error })
  }
  return new KeepError('storage', MESSAGES.storage, { cause: error })
}

// ── Cache access ───────────────────────────────────────────────────────────

function cachesAvailable(): boolean {
  try {
    return typeof caches !== 'undefined'
  } catch {
    return false
  }
}

/** The cache — created if need be — or a KeepError saying why not. */
async function openKept(): Promise<Cache> {
  if (!cachesAvailable()) {
    throw new KeepError('unsupported', MESSAGES.unsupported)
  }
  await claimKept(signedInUserId())
  try {
    return await caches.open(KEPT_CACHE)
  } catch (error) {
    throw keepErrorFrom(error)
  }
}

/**
 * The cache if anything was ever kept, else null — for reading, which must
 * not create it (see the top of this file). Throws a KeepError when it cannot
 * be opened, as `openKept` does.
 */
async function existingKept(): Promise<Cache | null> {
  if (!cachesAvailable()) return null
  await claimKept(signedInUserId())
  try {
    return (await caches.has(KEPT_CACHE)) ? await caches.open(KEPT_CACHE) : null
  } catch (error) {
    throw keepErrorFrom(error)
  }
}

const part = (id: string) => encodeURIComponent(id)
const manifestKey = (businessId: string) =>
  `${KEPT_ROOT}/${part(businessId)}/manifest.json`
const pdfKey = (businessId: string, productId: string) =>
  `${KEPT_ROOT}/${part(businessId)}/${part(productId)}/pdf`
const photoKey = (businessId: string, productId: string) =>
  `${KEPT_ROOT}/${part(businessId)}/${part(productId)}/photo`

function isKeptProduct(value: unknown): value is KeptProduct {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const stringOrNull = (x: unknown) => x === null || typeof x === 'string'
  return (
    typeof v.productId === 'string' &&
    typeof v.businessId === 'string' &&
    typeof v.name === 'string' &&
    stringOrNull(v.description) &&
    stringOrNull(v.url) &&
    typeof v.fileName === 'string' &&
    typeof v.size === 'number' &&
    typeof v.pdfUrl === 'string' &&
    stringOrNull(v.photoUrl) &&
    typeof v.keptAt === 'number'
  )
}

function sameKept(a: KeptProduct, b: KeptProduct | undefined): boolean {
  return (
    b !== undefined &&
    a.productId === b.productId &&
    a.businessId === b.businessId &&
    a.name === b.name &&
    a.description === b.description &&
    a.url === b.url &&
    a.fileName === b.fileName &&
    a.size === b.size &&
    a.pdfUrl === b.pdfUrl &&
    a.photoUrl === b.photoUrl &&
    a.keptAt === b.keptAt
  )
}

/** One entry per product, A to Z — the order the products page lists them. */
function tidy(
  entries: ReadonlyArray<KeptProduct>,
  businessId: string,
): Array<KeptProduct> {
  const byId = new Map<string, KeptProduct>()
  for (const entry of entries) {
    if (entry.businessId === businessId) byId.set(entry.productId, entry)
  }
  return [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'en-AU', { sensitivity: 'base' }),
  )
}

/**
 * The manifest as stored. Throws when the cache cannot be read, because a
 * caller about to write the manifest back must not mistake "could not read
 * it" for "nothing kept" and wipe it; unreadable JSON, on the other hand, has
 * nothing in it worth saving and counts as empty.
 */
async function readManifest(
  cache: Cache,
  businessId: string,
): Promise<Array<KeptProduct>> {
  let res: Response | undefined
  try {
    res = await cache.match(manifestKey(businessId))
  } catch (error) {
    throw keepErrorFrom(error)
  }
  if (!res) return []
  try {
    const data: unknown = await res.json()
    return Array.isArray(data)
      ? tidy(data.filter(isKeptProduct), businessId)
      : []
  } catch {
    return []
  }
}

async function writeManifest(
  cache: Cache,
  businessId: string,
  entries: ReadonlyArray<KeptProduct>,
): Promise<Array<KeptProduct>> {
  const tidied = tidy(entries, businessId)
  try {
    await cache.put(
      manifestKey(businessId),
      new Response(JSON.stringify(tidied), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  } catch (error) {
    throw keepErrorFrom(error)
  }
  return tidied
}

/** Who kept what is here, or null when nobody was recorded. */
async function readKeeper(cache: Cache): Promise<string | null> {
  let res: Response | undefined
  try {
    res = await cache.match(KEEPER_KEY)
  } catch (error) {
    throw keepErrorFrom(error)
  }
  if (!res) return null
  try {
    const data = (await res.json()) as { userId?: unknown } | null
    return typeof data?.userId === 'string' ? data.userId : null
  } catch {
    return null
  }
}

async function writeKeeper(cache: Cache, userId: string): Promise<void> {
  try {
    await cache.put(
      KEEPER_KEY,
      new Response(JSON.stringify({ userId }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  } catch (error) {
    throw keepErrorFrom(error)
  }
}

/**
 * Stores one file with the URL it came from. The type is given rather than
 * taken from the Blob: a product's PDF slot only ever holds a PDF (checked on
 * upload), whatever type the server or a test double labelled it with, and
 * the share sheet decides which apps to offer by it.
 */
async function putFile(
  cache: Cache,
  key: string,
  blob: Blob,
  sourceUrl: string,
  type: string,
): Promise<void> {
  try {
    await cache.put(
      key,
      new Response(blob, {
        headers: {
          'Content-Type': type,
          'Content-Length': String(blob.size),
          [SOURCE_HEADER]: encodeURIComponent(sourceUrl),
        },
      }),
    )
  } catch (error) {
    throw keepErrorFrom(error)
  }
}

async function dropFiles(
  cache: Cache,
  businessId: string,
  productId: string,
): Promise<void> {
  // Best-effort: the manifest no longer names them, so a file left behind is
  // unreachable, and forgetAllKept sweeps it with everything else.
  await Promise.all([
    cache.delete(pdfKey(businessId, productId)).catch(() => false),
    cache.delete(photoKey(businessId, productId)).catch(() => false),
  ])
}

function sourceOf(res: Response): string | null {
  const raw = res.headers.get(SOURCE_HEADER)
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/**
 * A photo to keep alongside, or null. It is decoration; nothing fails on it.
 * Fetched like the PDF, stall limit and all, so a photo that stops arriving
 * cannot hold up the keep or the sync waiting on it.
 */
async function fetchPhoto(
  url: string,
  signal?: AbortSignal,
): Promise<Blob | null> {
  try {
    return await fetchWithProgress(url, () => {}, signal, {
      stallMs: STALL_MS,
    })
  } catch {
    return null
  }
}

/** `fetchWithProgress` calls a typeless file a PDF; a photo is an image. */
function photoTypeOf(photo: Blob): string {
  return photo.type.startsWith('image/') ? photo.type : 'image/jpeg'
}

/*
 * Photos this page load could not store — the phone had room for a PDF but
 * not for the picture. A sync does not fetch them again until the next page
 * load: each attempt would download the full-size photo over mobile data
 * only to throw it away. A keep the person asks for still tries.
 */
const unstorablePhotos = new Set<string>()

function isOffline(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false
  } catch {
    return false
  }
}

// ── Whose they are ────────────────────────────────────────────────────────

/** The person this page load has checked the kept files against. */
let confirmedFor: string | null = null
let claims: Promise<void> = Promise.resolve()

/**
 * Makes sure what is kept here belongs to `userId`, forgetting everything if
 * it belongs to someone else — or to nobody on record, which is only ever a
 * keep made while signed out, or an empty cache. Null (not known who is
 * signed in) checks nothing. Never rejects.
 *
 * Every read and write in this module calls it first with the person
 * rootState.ts says is signed in, and rootState.ts calls it as soon as a page
 * load knows who that is. Checked once per person per page load; the answer
 * is kept in memory after that.
 */
export function claimKept(userId: string | null): Promise<void> {
  if (!userId || !cachesAvailable()) return Promise.resolve()
  // One at a time, so two callers racing at page load read the keeper once.
  const next = claims.then(() => claimOnce(userId))
  claims = next
  return next
}

async function claimOnce(userId: string): Promise<void> {
  if (confirmedFor === userId) return
  try {
    if (await caches.has(KEPT_CACHE)) {
      const keeper = await readKeeper(await caches.open(KEPT_CACHE))
      // Downloads are left running: the only one there can be is a keep this
      // same person has just asked for, which waits on this check before it
      // starts. Anything older is stopped from writing by the generation.
      if (keeper !== userId) await forgetEverything(false)
    }
    confirmedFor = userId
  } catch {
    // Not readable just now. Asked again at the next read, which will likely
    // fail the same way and find nothing to show.
  }
}

// ── Serialising writes ────────────────────────────────────────────────────

/*
 * Every change to a business's manifest is read-modify-write, so two at once
 * would lose one: keep A and keep B both read [], and whichever writes second
 * wins. Writes for one business are therefore taken one at a time — across
 * tabs with the Web Locks API where there is one (Safari 15.4+, every current
 * Chrome and Firefox), and within this tab otherwise. Downloads happen
 * OUTSIDE the lock; only the cache writes are inside, so a slow PDF never
 * holds up forgetting another one. Nothing locked calls anything else that
 * locks: a Web Lock is not re-entrant, and that would deadlock. (`claimKept`
 * is called inside, and takes no lock.)
 */
const chains = new Map<string, Promise<unknown>>()

function withLock<T>(businessId: string, run: () => Promise<T>): Promise<T> {
  try {
    const locks =
      typeof navigator === 'undefined'
        ? undefined
        : (navigator as Partial<Navigator>).locks
    if (locks?.request) {
      return locks.request(`${KEPT_CACHE}:${businessId}`, run)
    }
  } catch {
    // Web Locks refused (an opaque origin, say): this tab's own queue below.
  }
  const previous = chains.get(businessId) ?? Promise.resolve()
  const next = previous.then(run, run)
  const settled = next.then(
    () => {},
    () => {},
  )
  chains.set(businessId, settled)
  void settled.then(() => {
    if (chains.get(businessId) === settled) chains.delete(businessId)
  })
  return next
}

/*
 * Bumped whenever everything kept is forgotten, here or in another tab. A
 * keep or refresh that started before checks it before writing, so a download
 * finishing after the cache was dropped does not put the old person's file
 * back.
 */
let generation = 0

// ── The operations ────────────────────────────────────────────────────────

let askedToPersist = false

/**
 * Asks the browser not to evict what this origin stores, once per page load,
 * after the first keep. Chrome and Safari answer without asking the person;
 * Firefox asks, which is why this waits for someone to have chosen to keep
 * something rather than asking on page load.
 */
async function askToPersist(): Promise<void> {
  if (askedToPersist) return
  askedToPersist = true
  try {
    const storage = (navigator as Partial<Navigator>).storage as
      Partial<StorageManager> | undefined
    if (!storage?.persist) return
    if (storage.persisted && (await storage.persisted())) return
    await storage.persist()
  } catch {
    // Best-effort: the copy is kept either way, just less durably.
  }
}

/**
 * Keeps a product's PDF (and its photo, best-effort) on this phone.
 *
 * Pass the PDF when it is already in memory — the viewer has just loaded it
 * — and it is stored without downloading it again; otherwise it is fetched
 * from `entry.pdfUrl`, reporting progress, and given up as a `network`
 * failure if it stops arriving for `STALL_MS`. Resolves with what was kept.
 * Rejects with a `KeepError` saying why not, or with the browser's
 * `AbortError` when `signal` fires during the download.
 *
 * Keeping a product that is already kept replaces its copy.
 */
export async function keepProduct(
  entry: KeepRequest,
  pdf?: Blob,
  onProgress?: (progress: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<KeptProduct> {
  if (!cachesAvailable()) {
    throw new KeepError('unsupported', MESSAGES.unsupported)
  }
  // Listening from the start, so a sign-out in another tab while this
  // downloads stops it here too.
  openChannel()
  const userId = signedInUserId()
  // Before `started`: forgetting someone else's files is not a reason to
  // fail this person's keep.
  await claimKept(userId)
  const started = generation
  const { businessId, productId } = entry

  const photo = entry.photoUrl
    ? fetchPhoto(entry.photoUrl, signal)
    : Promise.resolve(null)
  let blob: Blob
  try {
    blob =
      pdf ??
      (await fetchWithProgress(entry.pdfUrl, onProgress ?? (() => {}), signal, {
        stallMs: STALL_MS,
      }))
  } catch (error) {
    throw keepErrorFrom(error)
  }
  const photoBlob = await photo

  const kept: KeptProduct = {
    productId,
    businessId,
    name: entry.name,
    description: entry.description,
    url: entry.url,
    fileName: entry.fileName,
    size: blob.size,
    pdfUrl: entry.pdfUrl,
    photoUrl: photoBlob ? entry.photoUrl : null,
    keptAt: Date.now(),
  }

  await withLock(businessId, async () => {
    if (generation !== started) throw new KeepError('storage', SIGNED_OUT)
    // Cancelled while the photo arrived or the lock was held elsewhere:
    // nothing written yet, so nothing for the forget that follows to undo.
    if (signal?.aborted) {
      throw new DOMException('The keep was cancelled.', 'AbortError')
    }
    const cache = await openKept()
    const keeper = await readKeeper(cache)
    // Only when another tab signed someone else in since this page checked.
    // Writing now would put this person's file among theirs.
    if (userId && keeper !== null && keeper !== userId) {
      throw new KeepError('storage', SOMEONE_ELSE)
    }
    const entries = await readManifest(cache, businessId)
    const wasKept = entries.some((e) => e.productId === productId)
    try {
      // First, so the cache never holds a known person's file unlabelled.
      if (userId && keeper === null) await writeKeeper(cache, userId)
      await putFile(
        cache,
        pdfKey(businessId, productId),
        blob,
        kept.pdfUrl,
        PDF_TYPE,
      )
      if (photoBlob && kept.photoUrl) {
        // The photo is decoration: a phone with room for the PDF but not the
        // picture still gets the PDF.
        const photoUrl = kept.photoUrl
        await putFile(
          cache,
          photoKey(businessId, productId),
          photoBlob,
          photoUrl,
          photoTypeOf(photoBlob),
        ).catch(() => {
          unstorablePhotos.add(photoUrl)
          kept.photoUrl = null
        })
      }
      if (!kept.photoUrl) {
        await cache.delete(photoKey(businessId, productId)).catch(() => false)
      }
      // Once more before the write that makes it count: everything was
      // forgotten while the files went in, and the cache they went into may
      // already be a new, empty one.
      if (generation !== started) throw new KeepError('storage', SIGNED_OUT)
      const written = await writeManifest(cache, businessId, [
        ...entries.filter((e) => e.productId !== productId),
        kept,
      ])
      setEntries(businessId, written)
    } catch (error) {
      // Nothing half-kept is left taking up room. A product that WAS kept
      // keeps whatever its files now hold: the manifest still names it, and
      // each file carries the URL it came from.
      if (!wasKept) await dropFiles(cache, businessId, productId)
      throw error
    }
  })
  announce(businessId)
  void askToPersist()
  warmPdfjsAssets()
  return kept
}

/** Removes a product's kept copy. Rejects with a KeepError if it cannot. */
export async function forgetKeptProduct(
  businessId: string,
  productId: string,
): Promise<void> {
  if (!cachesAvailable()) return
  // A background refresh of this very file is pointless now.
  stopRefresh(businessId, productId)
  const changed = await withLock(businessId, async () => {
    const cache = await existingKept()
    if (!cache) return false
    const entries = await readManifest(cache, businessId)
    const listed = entries.some((e) => e.productId === productId)
    if (listed) {
      const written = await writeManifest(
        cache,
        businessId,
        entries.filter((e) => e.productId !== productId),
      )
      setEntries(businessId, written)
    }
    await dropFiles(cache, businessId, productId)
    return listed
  })
  if (changed) announce(businessId)
}

/** Everything kept for a business, A to Z. Empty where nothing can be. */
export async function listKept(
  businessId: string,
): Promise<Array<KeptProduct>> {
  try {
    const cache = await existingKept()
    return cache ? await readManifest(cache, businessId) : []
  } catch {
    return []
  }
}

export type KeptPdf = {
  blob: Blob
  /**
   * The URL these bytes were fetched from. Compare it with the product's
   * current PDF URL: equal, and this copy is current; different, and the file
   * has been replaced since — still worth showing with no signal, but the
   * network has the new one.
   */
  pdfUrl: string
}

/** The kept PDF, or null when there is none (or it cannot be read). */
export async function readKeptPdf(
  businessId: string,
  productId: string,
): Promise<KeptPdf | null> {
  try {
    const cache = await existingKept()
    if (!cache) return null
    const res = await cache.match(pdfKey(businessId, productId))
    if (!res) return null
    const source = sourceOf(res)
    const blob = await res.blob()
    const pdfUrl =
      source ??
      (await readManifest(cache, businessId)).find(
        (e) => e.productId === productId,
      )?.pdfUrl ??
      ''
    return { blob, pdfUrl }
  } catch {
    return null
  }
}

/** The kept photo, or null. */
export async function readKeptPhoto(
  businessId: string,
  productId: string,
): Promise<Blob | null> {
  try {
    const cache = await existingKept()
    if (!cache) return null
    const res = await cache.match(photoKey(businessId, productId))
    return res ? await res.blob() : null
  } catch {
    return null
  }
}

/**
 * Drops every kept file, for every business, stops every download under way,
 * and tells the app's other tabs to do the same. What `claimKept` does when
 * someone else signs in (bar stopping downloads — see there); nothing in the
 * app needs it otherwise. Never throws.
 */
export function forgetAllKept(): Promise<void> {
  return forgetEverything(true)
}

async function forgetEverything(stopDownloads: boolean): Promise<void> {
  letGoHere(stopDownloads)
  try {
    if (cachesAvailable()) await caches.delete(KEPT_CACHE)
  } catch {
    // A browser that refuses the cache has nothing kept in it.
  }
  announce(null)
}

/**
 * This tab's half of forgetting everything, and all of it when another tab
 * did the forgetting: nothing started before this may write afterwards (the
 * generation), downloads stop costing data, and every list reads empty.
 */
function letGoHere(stopDownloads: boolean): void {
  generation++
  if (stopDownloads) {
    for (const flight of inFlight.values()) flight.abort?.abort()
  }
  for (const businessId of snapshots.keys()) setEntries(businessId, [])
}

// ── pdf.js's own files, for offline ───────────────────────────────────────

/**
 * pdf.js fetches some of what a PDF needs only when a page asks for it: the
 * JPEG 2000 decoder for a page with a JPX picture, the colour-management
 * decoder and CMYK profile for print colours (a label's pictograms), the
 * Symbol and ZapfDingbats fonts for a page that names them without embedding
 * them. The service worker keeps each the first time it is fetched
 * (`src/sw.ts`), so whatever a PDF used online it can use offline. But a
 * product is often kept after reading page 1, or from the list without being
 * opened at all, and page 9 may need something nothing has fetched yet —
 * offline, its pictogram comes out blank.
 *
 * So after something is kept, and whenever kept products are on screen, the
 * set that such a page could need is fetched once for the worker to keep:
 * about 400 KB, once per pdf.js version per phone. `public/pdfjs/version.json`
 * lists it (scripts/copy-pdfjs-assets.mjs writes it and fails the build if a
 * file is missing). Character maps stay on demand: 1.6 MB, and only for CJK
 * text. A browser with WebAssembly switched off (iOS Lockdown Mode) gets the
 * JavaScript JPEG 2000 decoder instead, which is all pdf.js can use there.
 *
 * Only with a service worker in charge (nothing else would keep them), only
 * online, and never more than once at a time; what is already cached is
 * skipped, so after the first time this costs a handful of cache lookups. A
 * pdf.js upgrade drops the old version's cache (`src/sw.ts`), and the next
 * visit to kept products online fetches the new set.
 */
const PDFJS_ROOT = '/pdfjs/'
const PDFJS_LIST = `${PDFJS_ROOT}version.json`

type WarmList = {
  always: Array<string>
  wasm: Array<string>
  nowasm: Array<string>
}

let warming: Promise<void> | null = null

function warmPdfjsAssets(): void {
  if (warming) return
  warming = warmOnce().then(
    (finished) => {
      // Not now (offline, no service worker yet) or not all of it: the next
      // keep, or the next look at kept products, tries again.
      if (!finished) warming = null
    },
    () => {
      warming = null
    },
  )
}

/** Whether every file is now cached. */
async function warmOnce(): Promise<boolean> {
  if (!cachesAvailable() || typeof navigator === 'undefined') return false
  const nav = navigator as Partial<Navigator>
  if (nav.onLine === false || !nav.serviceWorker?.controller) return false

  const res = await fetch(PDFJS_LIST, { cache: 'no-cache' })
  if (!res.ok) return false
  const list = warmListOf(await res.json())
  if (!list) return false
  const files = [
    ...list.always,
    ...(typeof WebAssembly === 'undefined' ? list.nowasm : list.wasm),
  ]

  let finished = true
  for (const file of files) {
    const url = `${PDFJS_ROOT}${file}`
    try {
      if (await caches.match(url)) continue
      const asset = await fetch(url)
      // Read to the end: the worker keeps its copy as the body arrives.
      await asset.arrayBuffer()
      if (!asset.ok) finished = false
    } catch {
      finished = false
    }
  }
  return finished
}

/** The list, if it is one: relative paths within /pdfjs/, nothing else. */
function warmListOf(data: unknown): WarmList | null {
  const warm = (data as { warm?: unknown } | null)?.warm
  if (typeof warm !== 'object' || warm === null) return null
  const paths = (value: unknown): Array<string> | null =>
    Array.isArray(value) &&
    value.every(
      (path) => typeof path === 'string' && /^[\w-]+\/[\w.-]+$/.test(path),
    )
      ? (value as Array<string>)
      : null
  const { always, wasm, nowasm } = warm as Record<string, unknown>
  const list = {
    always: paths(always),
    wasm: paths(wasm),
    nowasm: paths(nowasm),
  }
  return list.always && list.wasm && list.nowasm
    ? { always: list.always, wasm: list.wasm, nowasm: list.nowasm }
    : null
}

// ── Keeping kept copies current ───────────────────────────────────────────

/** A product as the products query returns it — what a sync compares with. */
export type LiveProduct = {
  id: string
  name: string
  description: string | null
  url: string | null
  photoUrl: string | null
  pdf: {
    /** Null when the file is gone from storage. */
    url: string | null
    fileName: string
    size: number | null
  } | null
}

/**
 * What to hand `keep` for a product as the query returns it, or null when
 * there is nothing to keep — no PDF, or one whose file is gone from storage.
 * The business is left for the hook to fill in.
 */
export function keepRequestFor(
  product: LiveProduct,
): Omit<KeepRequest, 'businessId'> | null {
  if (!product.pdf?.url) return null
  return {
    productId: product.id,
    name: product.name,
    description: product.description,
    url: product.url,
    fileName: product.pdf.fileName,
    pdfUrl: product.pdf.url,
    photoUrl: product.photoUrl,
  }
}

export type KeptChange = {
  previous: KeptProduct
  /** The entry as it should end up. */
  next: KeptProduct
  /** The photo: unchanged, replaced (fetch `next.photoUrl`), or removed. */
  photo: 'same' | 'refetch' | 'drop'
}

export type KeptSyncPlan = {
  /** Products deleted, or left without a PDF: nothing to keep any more. */
  forget: Array<string>
  /** The PDF was replaced: fetch `next.pdfUrl`, then swap the copy. */
  redownload: Array<KeptChange>
  /** Same PDF; the name, words, link, photo or file name changed. */
  update: Array<KeptChange>
}

/**
 * Compares what is kept with the products as they are now. Pure.
 *
 * A PDF's URL is the identity of its bytes (`DocumentSource.key` says the
 * same): Convex hands out one stable URL per stored file, so a different URL
 * means a different file — the PDF was replaced — and the same URL means the
 * bytes kept are still the bytes. If storage URLs ever became signed and
 * expiring, every sync would re-download everything, and this is the
 * function to change.
 *
 * Products not kept are ignored: a sync never keeps anything new, since
 * what is kept is the person's choice, made on their data plan.
 *
 * A product whose PDF is still set but whose file is gone from storage
 * (`pdf.url` null) keeps its copy. The page cannot open that file from the
 * network, so the copy here may be the only one anyone has left.
 */
export function planKeptSync(
  kept: ReadonlyArray<KeptProduct>,
  live: ReadonlyArray<LiveProduct>,
): KeptSyncPlan {
  const products = new Map(live.map((product) => [product.id, product]))
  const plan: KeptSyncPlan = { forget: [], redownload: [], update: [] }

  for (const entry of kept) {
    const product = products.get(entry.productId)
    if (!product?.pdf) {
      plan.forget.push(entry.productId)
      continue
    }
    const fileUrl = product.pdf.url
    const replaced = fileUrl !== null && fileUrl !== entry.pdfUrl
    const next: KeptProduct = {
      ...entry,
      name: product.name,
      description: product.description,
      url: product.url,
      photoUrl: product.photoUrl,
      ...(fileUrl === null
        ? {}
        : {
            pdfUrl: fileUrl,
            fileName: product.pdf.fileName,
            size: replaced ? (product.pdf.size ?? entry.size) : entry.size,
          }),
    }
    const photo =
      product.photoUrl === entry.photoUrl
        ? 'same'
        : product.photoUrl
          ? 'refetch'
          : 'drop'

    if (replaced) {
      plan.redownload.push({ previous: entry, next, photo })
    } else if (
      next.name !== entry.name ||
      next.description !== entry.description ||
      next.url !== entry.url ||
      next.fileName !== entry.fileName ||
      photo !== 'same'
    ) {
      plan.update.push({ previous: entry, next, photo })
    }
  }
  return plan
}

/**
 * What, besides the list, the page's sync must run again on: which products
 * are kept, the file each came from, and when it was stored. Empty when
 * nothing is (or nothing has been read yet).
 *
 * A keep writes the PDF URL it was tapped on, after a download that can take
 * minutes — and a list that changed meanwhile (the PDF replaced, the product
 * deleted) was synced without it: the product was not kept yet, or the keep
 * had it in hand (`refreshPdf` leaves it alone). The keep landing changes
 * this, so the list is applied again, to it too. It settles: words leave it
 * alone, and a refreshed PDF or a forgotten product changes it once, after
 * which the same list has nothing left to do.
 */
export function keptSyncKey(
  entries: ReadonlyArray<KeptProduct> | null,
): string {
  if (!entries) return ''
  return entries.map((e) => `${e.productId} ${e.keptAt} ${e.pdfUrl}`).join('\n')
}

type SyncState = {
  /** The newest list handed in, and its number. */
  live: ReadonlyArray<LiveProduct>
  seq: number
  /** A newer list arrived during the pass: plan again when it ends. */
  again: boolean
}
const syncs = new Map<string, { state: SyncState; done: Promise<void> }>()
let syncSeq = 0
/** Per business: the newest list whose words are in the manifest. */
const wordsApplied = new Map<string, number>()

/**
 * Brings the kept copies in line with the products as they are now: forgets
 * what is gone, updates names and words, and — only with signal — fetches
 * replaced PDFs and photos. The old copy stays until the new one is stored,
 * so a download that fails halfway leaves the phone with the old file rather
 * than none, and the next sync tries again.
 *
 * Pass the products query's LOADED result — never a placeholder `[]` while
 * it loads, which would forget everything kept.
 *
 * One pass per business at a time. A call while one is running writes its
 * deletions and new words at once — they need no download, so they do not
 * wait behind one — and hands the pass its list, which runs once more with
 * the newest list before settling. A download the newer list makes pointless
 * (the product deleted, or replaced again) is stopped. Never rejects.
 *
 * The downloads are the app's, not the person's: they show in the hook's
 * `refreshing`, never in `busy`, so they never disable Keep or Remove, and
 * removing a product stops its refresh. Each is given up after `STALL_MS`
 * with no bytes, and tried again next sync.
 */
export function syncKept(
  businessId: string,
  live: ReadonlyArray<LiveProduct>,
): Promise<void> {
  if (!cachesAvailable()) return Promise.resolve()
  openChannel()
  const seq = ++syncSeq
  const running = syncs.get(businessId)
  if (running) {
    running.state.live = live
    running.state.seq = seq
    running.state.again = true
    void applyWords(businessId, live, seq, generation).catch(() => {})
    return running.done
  }

  const state: SyncState = { live, seq, again: true }
  const done = (async () => {
    try {
      while (state.again) {
        state.again = false
        await syncOnce(businessId, state, state.live, state.seq)
      }
    } catch {
      // Best-effort throughout; the next sync starts from what is stored.
    } finally {
      syncs.delete(businessId)
    }
  })()
  syncs.set(businessId, { state, done })
  return done
}

async function syncOnce(
  businessId: string,
  state: SyncState,
  live: ReadonlyArray<LiveProduct>,
  seq: number,
): Promise<void> {
  const started = generation
  const plan = await applyWords(businessId, live, seq, started)
  if (!plan || isOffline()) return
  // A newer list came in: the next pass plans from it rather than finish
  // this one's downloads.
  const superseded = () => state.again || generation !== started

  // Replaced PDFs, one at a time: gentle on a weak connection, and each swap
  // is its own small write once its bytes are in.
  for (const change of plan.redownload) {
    if (superseded()) return
    await refreshPdf(businessId, change, started)
  }

  // Replaced photos. The entry's photoUrl moves only with the bytes, so a
  // photo that fails to arrive is simply tried again next time.
  for (const change of [...plan.update, ...plan.redownload]) {
    if (superseded()) return
    await refreshPhoto(businessId, change, started)
  }
}

/**
 * Everything a list changes that needs no download, in one write: forget
 * what is gone, update the words, drop removed photos. A replaced PDF's entry
 * takes its new name here too, but keeps the old file's URL, name and size
 * until the new bytes are stored. Planned inside the lock, against the
 * manifest as it is, and written — and announced — only when something in
 * it changes. Resolves with the plan, for the downloads; null when there is
 * nothing kept, or a newer list's words are already in.
 */
async function applyWords(
  businessId: string,
  live: ReadonlyArray<LiveProduct>,
  seq: number,
  started: number,
): Promise<KeptSyncPlan | null> {
  const outcome = await withLock(businessId, async () => {
    if (generation !== started) return null
    // Lists reach this out of order — one handed in during a pass applies
    // at once, and the pass then applies its own older one — so the newest
    // list's words stand.
    if ((wordsApplied.get(businessId) ?? 0) > seq) return null
    wordsApplied.set(businessId, seq)

    const cache = await existingKept()
    if (!cache) return null
    const entries = await readManifest(cache, businessId)
    const plan = planKeptSync(entries, live)
    const forget = new Set(plan.forget)
    const changes = new Map(
      [...plan.update, ...plan.redownload].map((c) => [
        c.previous.productId,
        c,
      ]),
    )
    const before = new Map(entries.map((e) => [e.productId, e]))
    const next: Array<KeptProduct> = []
    for (const entry of entries) {
      if (forget.has(entry.productId)) continue
      const change = changes.get(entry.productId)
      if (!change) {
        next.push(entry)
        continue
      }
      const replaced = change.next.pdfUrl !== entry.pdfUrl
      next.push({
        ...entry,
        name: change.next.name,
        description: change.next.description,
        url: change.next.url,
        fileName: replaced ? entry.fileName : change.next.fileName,
        photoUrl: change.photo === 'drop' ? null : entry.photoUrl,
      })
      if (change.photo === 'drop') {
        await cache
          .delete(photoKey(businessId, entry.productId))
          .catch(() => false)
      }
    }

    // A photo that only needs fetching changes nothing here yet: its URL
    // moves with its bytes, in `refreshPhoto`.
    const changed =
      forget.size > 0 || next.some((e) => !sameKept(e, before.get(e.productId)))
    if (changed) {
      const written = await writeManifest(cache, businessId, next)
      setEntries(businessId, written)
    }
    for (const productId of forget) {
      await dropFiles(cache, businessId, productId)
    }
    stopStaleRefreshes(businessId, plan)
    return { plan, changed }
  })
  if (outcome?.changed) announce(businessId)
  return outcome?.plan ?? null
}

/** Fetches a replaced PDF and swaps it in, unless something moved on. */
async function refreshPdf(
  businessId: string,
  change: KeptChange,
  started: number,
): Promise<void> {
  const { productId } = change.previous
  const key = flightKey(businessId, productId)
  // The person is keeping or removing it right now: theirs to finish.
  if (inFlight.has(key)) return
  // Removed, or refreshed already, since the plan was made.
  const current = (await listKept(businessId)).find(
    (e) => e.productId === productId,
  )
  if (current?.pdfUrl !== change.previous.pdfUrl || inFlight.has(key)) return

  const abort = new AbortController()
  const target = change.next.pdfUrl
  const promise = (async () => {
    const blob = await fetchWithProgress(target, () => {}, abort.signal, {
      stallMs: STALL_MS,
    })
    const swapped = await withLock(businessId, async () => {
      if (generation !== started || abort.signal.aborted) return false
      const cache = await existingKept()
      if (!cache) return false
      const entries = await readManifest(cache, businessId)
      const now = entries.find((e) => e.productId === productId)
      if (!now || now.pdfUrl !== change.previous.pdfUrl) return false
      await putFile(
        cache,
        pdfKey(businessId, productId),
        blob,
        target,
        PDF_TYPE,
      )
      const written = await writeManifest(cache, businessId, [
        ...entries.filter((e) => e.productId !== productId),
        {
          ...now,
          pdfUrl: target,
          fileName: change.next.fileName,
          size: blob.size,
          keptAt: Date.now(),
        },
      ])
      setEntries(businessId, written)
      return true
    })
    if (swapped) announce(businessId)
  })().then((): KeepOutcome => ({ ok: true }), outcomeOf)

  inFlight.set(key, {
    kind: 'refresh',
    businessId,
    productId,
    target,
    promise,
    abort,
  })
  setRefreshing(businessId, productId, true)
  try {
    // Never rejects: a failure leaves the old copy, and the next sync tries.
    await promise
  } finally {
    setRefreshing(businessId, productId, false)
    if (inFlight.get(key)?.promise === promise) inFlight.delete(key)
  }
}

/** Fetches a replaced photo and swaps it in, unless something moved on. */
async function refreshPhoto(
  businessId: string,
  change: KeptChange,
  started: number,
): Promise<void> {
  const { productId } = change.previous
  const url = change.next.photoUrl
  if (change.photo !== 'refetch' || !url || unstorablePhotos.has(url)) return
  const photo = await fetchPhoto(url)
  if (!photo) return
  try {
    const swapped = await withLock(businessId, async () => {
      if (generation !== started) return false
      const cache = await existingKept()
      if (!cache) return false
      const entries = await readManifest(cache, businessId)
      const current = entries.find((e) => e.productId === productId)
      if (!current || current.photoUrl !== change.previous.photoUrl) {
        return false
      }
      try {
        await putFile(
          cache,
          photoKey(businessId, productId),
          photo,
          url,
          photoTypeOf(photo),
        )
      } catch (error) {
        unstorablePhotos.add(url)
        throw error
      }
      const written = await writeManifest(cache, businessId, [
        ...entries.filter((e) => e.productId !== productId),
        { ...current, photoUrl: url },
      ])
      setEntries(businessId, written)
      return true
    })
    if (swapped) announce(businessId)
  } catch {
    // Decoration; next time.
  }
}

/** Stops a background refresh of one product's PDF, if one is running. */
function stopRefresh(businessId: string, productId: string): void {
  const flight = inFlight.get(flightKey(businessId, productId))
  if (flight?.kind === 'refresh') flight.abort?.abort()
}

/** Stops refreshes the newest plan no longer asks for. */
function stopStaleRefreshes(businessId: string, plan: KeptSyncPlan): void {
  const wanted = new Map(
    plan.redownload.map((c) => [c.previous.productId, c.next.pdfUrl]),
  )
  for (const flight of inFlight.values()) {
    if (
      flight.kind === 'refresh' &&
      flight.businessId === businessId &&
      wanted.get(flight.productId) !== flight.target
    ) {
      flight.abort?.abort()
    }
  }
}

// ── The shared state the hook reads ───────────────────────────────────────

type Snapshot = {
  entries: Array<KeptProduct> | null
  kept: ReadonlySet<string>
  busy: ReadonlySet<string>
  refreshing: ReadonlySet<string>
}

const NOTHING: ReadonlySet<string> = new Set()
/** Also the server's answer, and the first client render's. */
const UNREAD: Snapshot = {
  entries: null,
  kept: NOTHING,
  busy: NOTHING,
  refreshing: NOTHING,
}

const snapshots = new Map<string, Snapshot>()
const listeners = new Map<string, Set<() => void>>()

function snapshotOf(businessId: string): Snapshot {
  return snapshots.get(businessId) ?? UNREAD
}

function publish(businessId: string, next: Snapshot): void {
  snapshots.set(businessId, next)
  for (const listener of listeners.get(businessId) ?? []) listener()
}

function setEntries(businessId: string, entries: Array<KeptProduct>): void {
  publish(businessId, {
    ...snapshotOf(businessId),
    entries,
    kept: new Set(entries.map((e) => e.productId)),
  })
}

/*
 * Counted, because more than one of the person's own actions can be busy
 * with a product at once — a forget still settling while they tap Keep
 * again — and the first to finish must not clear the spinner the other still
 * owns.
 */
const busyCounts = new Map<string, number>()

function setBusy(businessId: string, productId: string, on: boolean): void {
  const key = `${businessId}/${productId}`
  const count = Math.max(0, (busyCounts.get(key) ?? 0) + (on ? 1 : -1))
  if (count === 0) busyCounts.delete(key)
  else busyCounts.set(key, count)

  const current = snapshotOf(businessId)
  if (current.busy.has(productId) === count > 0) return
  const busy = new Set(current.busy)
  if (count > 0) busy.add(productId)
  else busy.delete(productId)
  publish(businessId, { ...current, busy })
}

/** Not counted: `refreshPdf` runs at most one refresh per product. */
function setRefreshing(
  businessId: string,
  productId: string,
  on: boolean,
): void {
  const current = snapshotOf(businessId)
  if (current.refreshing.has(productId) === on) return
  const refreshing = new Set(current.refreshing)
  if (on) refreshing.add(productId)
  else refreshing.delete(productId)
  publish(businessId, { ...current, refreshing })
}

/** Re-reads the manifest, in line with writes so it cannot land stale. */
function refresh(businessId: string): Promise<void> {
  if (!cachesAvailable()) {
    // Answered after the subscription that asked, not during it.
    return Promise.resolve().then(() => setEntries(businessId, []))
  }
  return withLock(businessId, async () => {
    const entries = await listKept(businessId)
    setEntries(businessId, entries)
    if (entries.length > 0) warmPdfjsAssets()
  }).catch(() => {})
}

/*
 * Other tabs and windows of the app hear about changes here, and re-read.
 * The message says only which business changed, never what — the cache is
 * the truth, and each tab reads it for itself — or that everything was
 * forgotten, which each tab acts on at once rather than reading a cache that
 * is gone.
 */
type Message = { businessId: string } | { forgotAll: true }

let channel: BroadcastChannel | null | undefined

function openChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel
  channel = null
  try {
    if (typeof BroadcastChannel === 'undefined') return null
    channel = new BroadcastChannel(KEPT_CACHE)
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as Partial<Record<string, unknown>> | null
      if (data?.forgotAll === true) {
        // Someone else signed in there. A keep still downloading here must
        // not write the previous person's file into the new person's cache.
        letGoHere(true)
        return
      }
      const businessId = data?.businessId
      if (typeof businessId === 'string' && snapshots.has(businessId)) {
        void refresh(businessId)
      }
    }
  } catch {
    channel = null
  }
  return channel
}

function announce(businessId: string | null): void {
  try {
    const message: Message =
      businessId === null ? { forgotAll: true } : { businessId }
    openChannel()?.postMessage(message)
  } catch {
    // Other tabs catch up when they next mount the hook.
  }
}

function subscribe(businessId: string, listener: () => void): () => void {
  let set = listeners.get(businessId)
  if (!set) {
    set = new Set()
    listeners.set(businessId, set)
  }
  const first = set.size === 0
  set.add(listener)
  openChannel()
  // Read afresh whenever something starts watching, even with an answer in
  // memory: one cache read, and it catches what changed while nobody was.
  if (first) void refresh(businessId)
  return () => {
    set.delete(listener)
  }
}

// ── The hook ──────────────────────────────────────────────────────────────

/** How a keep or forget from the hook went. It never rejects. */
export type KeepOutcome =
  | { ok: true }
  | { ok: false; reason: KeepFailure | 'cancelled'; message: string }

export type KeptProductsState = {
  /** Whether this browser can keep files at all. False on the server. */
  supported: boolean
  /**
   * What is kept for this business, A to Z. Null until it has been read in
   * the browser — on the server and on the first client render alike, so
   * hydration matches; render nothing kept-specific until it is an array.
   */
  entries: Array<KeptProduct> | null
  isKept: (productId: string) => boolean
  /**
   * Products the person is keeping or removing right now. Their Keep and
   * Remove controls wait on it.
   */
  busy: ReadonlySet<string>
  /**
   * Products whose replaced PDF a sync is fetching in the background. The
   * old copy is still there and still opens, so nothing need wait on this —
   * Remove stays available, and stops the refresh.
   */
  refreshing: ReadonlySet<string>
  /**
   * Keeps a product. The business is this hook's, whatever the entry says.
   * Pass the PDF if it is already in memory. A second call while one is
   * running for the same product joins it; a forget while it downloads
   * cancels the download and then forgets.
   */
  keep: (
    entry: Omit<KeepRequest, 'businessId'> & { businessId?: string },
    pdf?: Blob,
  ) => Promise<KeepOutcome>
  forget: (productId: string) => Promise<KeepOutcome>
  readPdf: (productId: string) => Promise<KeptPdf | null>
}

type InFlight = {
  kind: 'keep' | 'forget' | 'refresh'
  businessId: string
  productId: string
  promise: Promise<KeepOutcome>
  abort?: AbortController
  /** A refresh's: the URL it is fetching. */
  target?: string
}
const inFlight = new Map<string, InFlight>()
const flightKey = (businessId: string, productId: string) =>
  `${businessId}/${productId}`

function outcomeOf(error: unknown): KeepOutcome {
  if (isAbortError(error)) {
    return { ok: false, reason: 'cancelled', message: 'Cancelled.' }
  }
  const failure = keepErrorFrom(error)
  return failure instanceof KeepError
    ? { ok: false, reason: failure.reason, message: failure.message }
    : { ok: false, reason: 'storage', message: MESSAGES.storage }
}

function track(
  businessId: string,
  productId: string,
  flight: Pick<InFlight, 'kind' | 'abort'>,
  run: () => Promise<void>,
): Promise<KeepOutcome> {
  const key = flightKey(businessId, productId)
  setBusy(businessId, productId, true)
  const promise = run()
    .then((): KeepOutcome => ({ ok: true }), outcomeOf)
    .finally(() => {
      setBusy(businessId, productId, false)
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key)
    })
  inFlight.set(key, { ...flight, businessId, productId, promise })
  return promise
}

function keepFromHook(
  businessId: string,
  entry: Omit<KeepRequest, 'businessId'>,
  pdf?: Blob,
): Promise<KeepOutcome> {
  const running = inFlight.get(flightKey(businessId, entry.productId))
  if (running?.kind === 'keep') return running.promise
  // The person's keep fetches the current file itself; a refresh racing it
  // would only fetch it twice.
  if (running?.kind === 'refresh') running.abort?.abort()
  const abort = new AbortController()
  return track(
    businessId,
    entry.productId,
    { kind: 'keep', abort },
    async () => {
      // Whatever is still running settles first, so the two end in the
      // order asked.
      if (running) await running.promise
      await keepProduct({ ...entry, businessId }, pdf, undefined, abort.signal)
    },
  )
}

function forgetFromHook(
  businessId: string,
  productId: string,
): Promise<KeepOutcome> {
  const running = inFlight.get(flightKey(businessId, productId))
  if (running?.kind === 'forget') return running.promise
  running?.abort?.abort()
  return track(businessId, productId, { kind: 'forget' }, async () => {
    // Let a cancelled keep or refresh settle first: if its bytes were
    // already being written, the forget below then removes them.
    if (running) await running.promise
    await forgetKeptProduct(businessId, productId)
  })
}

const noSubscription = () => () => {}

/**
 * What is kept on this phone for one business, and the means to change it.
 * Every component using it for the same business sees the same state, and
 * other tabs of the app are told when it changes.
 */
export function useKeptProducts(businessId: string): KeptProductsState {
  const subscribeHere = useCallback(
    (listener: () => void) => subscribe(businessId, listener),
    [businessId],
  )
  const snapshot = useSyncExternalStore(
    subscribeHere,
    () => snapshotOf(businessId),
    () => UNREAD,
  )
  const supported = useSyncExternalStore(
    noSubscription,
    cachesAvailable,
    () => false,
  )

  const isKept = useCallback(
    (productId: string) => snapshot.kept.has(productId),
    [snapshot],
  )
  const keep = useCallback(
    (entry: Omit<KeepRequest, 'businessId'>, pdf?: Blob) =>
      keepFromHook(businessId, entry, pdf),
    [businessId],
  )
  const forget = useCallback(
    (productId: string) => forgetFromHook(businessId, productId),
    [businessId],
  )
  const readPdf = useCallback(
    (productId: string) => readKeptPdf(businessId, productId),
    [businessId],
  )

  return useMemo(
    () => ({
      supported,
      entries: snapshot.entries,
      isKept,
      busy: snapshot.busy,
      refreshing: snapshot.refreshing,
      keep,
      forget,
      readPdf,
    }),
    [supported, snapshot, isKept, keep, forget, readPdf],
  )
}
