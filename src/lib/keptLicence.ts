import { prepareUpload } from '#/lib/images/prepareUpload'
import { FileTransferError, fetchWithProgress } from '#/lib/pdfFiles'
import { signedInUserId } from '#/lib/rootState'

/**
 * The person's own licences, kept on their phone: the whole wallet, not only
 * what has been opened.
 *
 * A technician is asked for a licence on site — by a client, a builder, an
 * inspector — and on site is where there is no signal. So everything the
 * holder has is kept here as soon as the list of their licences answers with
 * signal (`syncKeptWallet`), in the background, one file at a time: the
 * names, numbers and expiry dates, and every file. Only the holder's own —
 * the owner opening a member's licences from Team never leaves a copy.
 *
 * The same approach as `keptProducts.ts`:
 *
 *  - Cache Storage, one cache (`KEPT_LICENCE_CACHE`) written only here, under
 *    same-origin keys nothing ever fetches:
 *
 *      /__kept-licence/keeper.json                       whose these are
 *      /__kept-licence/<business>/<membership>/index.json
 *          the licences, as the list last said, without the files' URLs
 *      /__kept-licence/<business>/<membership>/files/<fileId>/<uploadedAt>
 *          each file's bytes
 *      /__kept-licence/<business>/<membership>/thumbs/<fileId>/<uploadedAt>
 *          a photo's thumbnail, 240px on its long side
 *
 *  - A file is named by its id and its `uploadedAt`, never its URL: the list
 *    hands out URLs and never storage ids, and a file on a licence never
 *    changes once added (a new picture is a new file), so the two name these
 *    exact bytes wherever they are served from.
 *  - Thumbnails are their own small copies. The lists draw one per licence
 *    and the Show my licence sheet one per file, and twenty 2400px photos
 *    decoded at once to fill 48px tiles is what gets a web app killed on an
 *    iPhone.
 *  - Whose they are is written first (`keeper.json`) and checked against the
 *    person signed in (`signedInUserId`) before anything here is read or
 *    written. Someone else, and every kept licence goes. They also go at
 *    every sign-in and sign-out — `forgetCachedPages` (rootState.ts) drops
 *    this cache by name — because a licence card is personal information:
 *    losing the copies to a lapsed session costs one quiet re-download the
 *    next time the list answers with signal.
 *  - At most `KEEP_BUDGET_BYTES` of files, in the order the list gives them
 *    (oldest licence first, and its files oldest first). Past that, the rest
 *    open with signal only.
 *
 * Every call is guarded and never throws: `caches` is missing on the server,
 * outside a secure context and in Firefox's private windows, and any write
 * can fail on quota. A copy is a convenience; the network is still there.
 */

export const KEPT_LICENCE_CACHE = 'pestm8-kept-licence-v2'

/**
 * The Phase 8.1 cache, which held one document per person. Nothing reads it
 * any more; the wallet's first keep drops it, and so does every sign-in and
 * sign-out.
 */
export const OLD_KEPT_LICENCE_CACHE = 'pestm8-kept-licence-v1'

/** How much of the wallet's files one phone keeps: about sixty photos of
 * cards at the size they are uploaded, or three large scanned PDFs. */
export const KEEP_BUDGET_BYTES = 60 * 1024 * 1024

const ROOT = '/__kept-licence'
const KEEPER_KEY = `${ROOT}/keeper.json`
/** On each kept file and thumbnail: which file it is, as JSON. */
const META_HEADER = 'X-Kept-Licence'
/** A thumbnail's long side: a 72px tile at three device pixels a point. */
const THUMB_EDGE = 240
/** A background fetch nobody is watching gives up once it stops arriving. */
const FETCH_STALL_MS = 30_000

/** One file on a licence, as kept: what the viewer needs to open it. */
export type KeptLicenceFile = {
  _id: string
  kind: 'pdf' | 'image'
  contentType: string
  fileName: string
  size: number
  /** When it was added — with `_id`, the identity of these bytes. */
  uploadedAt: number
}

/** One licence, as kept. */
export type KeptLicence = {
  _id: string
  name: string
  number?: string
  /** `YYYY-MM-DD`, the last day it is good for. */
  expiresOn?: string
  files: Array<KeptLicenceFile>
}

/** What the phone has of the wallet: the list, as it last answered. */
export type KeptWallet = {
  /** When the list was kept. */
  keptAt: number
  licences: Array<KeptLicence>
}

/** A licence as the live list (`memberLicences.list`) hands it over. */
export type LiveLicence = Omit<KeptLicence, 'files'> & {
  files: Array<KeptLicenceFile & { url: string | null }>
}

/** The live list: whose it is, and what is in it. */
export type LiveWallet = { mine: boolean; licences: Array<LiveLicence> }

// ── Change notices ─────────────────────────────────────────────────────────

const listeners = new Set<() => void>()

/**
 * Called whenever something kept here changes — the list, a file arriving, a
 * file forgotten — so a page reads the kept copy again. Returns the way to
 * stop listening.
 */
export function onKeptLicencesChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function changed(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // One page's trouble is not another's.
    }
  }
}

// ── Cache access ───────────────────────────────────────────────────────────

function cachesAvailable(): boolean {
  try {
    return typeof caches !== 'undefined'
  } catch {
    return false
  }
}

const part = (id: string) => encodeURIComponent(id)
const walletRoot = (businessId: string, membershipId: string) =>
  `${ROOT}/${part(businessId)}/${part(membershipId)}`
const indexKey = (businessId: string, membershipId: string) =>
  `${walletRoot(businessId, membershipId)}/index.json`
const filesRoot = (businessId: string, membershipId: string) =>
  `${walletRoot(businessId, membershipId)}/files/`
const fileKey = (
  businessId: string,
  membershipId: string,
  fileId: string,
  uploadedAt: number,
) => `${filesRoot(businessId, membershipId)}${part(fileId)}/${uploadedAt}`
const thumbKey = (
  businessId: string,
  membershipId: string,
  fileId: string,
  uploadedAt: number,
) =>
  `${walletRoot(businessId, membershipId)}/thumbs/${part(fileId)}/${uploadedAt}`

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  })
}

async function keeperOf(cache: Cache): Promise<string | null> {
  try {
    const res = await cache.match(KEEPER_KEY)
    if (!res) return null
    const body = (await res.json()) as { userId?: unknown } | null
    return typeof body?.userId === 'string' ? body.userId : null
  } catch {
    return null
  }
}

/**
 * The cache, for reading, when it is the signed-in person's; null when
 * nothing is kept or nobody is known to be signed in. Kept by anyone else,
 * and it all goes. Reading never creates it.
 *
 * A cache with no keeper yet is one a write is still labelling (it is made
 * first and labelled a moment later): nothing in it is shown, and nothing is
 * taken from under that write either.
 */
async function openForRead(): Promise<Cache | null> {
  const userId = signedInUserId()
  if (!userId || !cachesAvailable()) return null
  if (!(await caches.has(KEPT_LICENCE_CACHE))) return null
  const cache = await caches.open(KEPT_LICENCE_CACHE)
  const keeper = await keeperOf(cache)
  if (keeper === userId) return cache
  if (keeper !== null) {
    await caches.delete(KEPT_LICENCE_CACHE)
    changed()
  }
  return null
}

/**
 * The cache, for writing, once it is provably `userId`'s: anyone else's goes
 * first, and one not yet labelled is labelled before anything is put in it.
 * (Everything kept goes at every sign-in and sign-out, so an unlabelled one
 * can only be this session's own, caught between its making and its label.)
 */
async function openForWrite(userId: string): Promise<Cache> {
  if (await caches.has(KEPT_LICENCE_CACHE)) {
    const cache = await caches.open(KEPT_LICENCE_CACHE)
    const keeper = await keeperOf(cache)
    if (keeper === userId) return cache
    if (keeper === null) {
      await cache.put(KEEPER_KEY, json({ userId }))
      return cache
    }
    await caches.delete(KEPT_LICENCE_CACHE)
  }
  const cache = await caches.open(KEPT_LICENCE_CACHE)
  await cache.put(KEEPER_KEY, json({ userId }))
  return cache
}

// ── Validation ─────────────────────────────────────────────────────────────

const optionalString = (value: unknown) =>
  value === undefined || typeof value === 'string'

function isKeptFile(value: unknown): value is KeptLicenceFile {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v._id === 'string' &&
    (v.kind === 'pdf' || v.kind === 'image') &&
    typeof v.contentType === 'string' &&
    typeof v.fileName === 'string' &&
    typeof v.size === 'number' &&
    typeof v.uploadedAt === 'number'
  )
}

function isKeptLicence(value: unknown): value is KeptLicence {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v._id === 'string' &&
    typeof v.name === 'string' &&
    optionalString(v.number) &&
    optionalString(v.expiresOn) &&
    Array.isArray(v.files) &&
    v.files.every(isKeptFile)
  )
}

/** A file's own fields, and nothing else — never its URL. */
function fileOf(file: KeptLicenceFile): KeptLicenceFile {
  return {
    _id: file._id,
    kind: file.kind,
    contentType: file.contentType,
    fileName: file.fileName,
    size: file.size,
    uploadedAt: file.uploadedAt,
  }
}

function licenceOf(licence: KeptLicence): KeptLicence {
  return {
    _id: licence._id,
    name: licence.name,
    ...(licence.number === undefined ? {} : { number: licence.number }),
    ...(licence.expiresOn === undefined
      ? {}
      : { expiresOn: licence.expiresOn }),
    files: licence.files.map(fileOf),
  }
}

function fileMetaOf(res: Response): KeptLicenceFile | null {
  const raw = res.headers.get(META_HEADER)
  if (!raw) return null
  try {
    const data: unknown = JSON.parse(decodeURIComponent(raw))
    return isKeptFile(data) ? data : null
  } catch {
    return null
  }
}

// ── The list ───────────────────────────────────────────────────────────────

/**
 * Keeps the list of this person's licences — names, numbers, expiry dates and
 * what each file is. Nothing while nobody is known to be signed in: a copy
 * nobody's name is on could not be checked before it was shown. Resolves true
 * when it was kept.
 */
export async function keepWalletIndex(
  businessId: string,
  membershipId: string,
  licences: ReadonlyArray<KeptLicence>,
): Promise<boolean> {
  const userId = signedInUserId()
  if (!userId || !cachesAvailable()) return false
  try {
    const cache = await openForWrite(userId)
    const wallet: KeptWallet = {
      keptAt: Date.now(),
      licences: licences.map(licenceOf),
    }
    await cache.put(indexKey(businessId, membershipId), json(wallet))
    changed()
    return true
  } catch {
    return false
  }
}

/** The kept list of this person's licences, or null — none kept, unreadable,
 * or kept by someone else (in which case everything kept goes). */
export async function readKeptWallet(
  businessId: string,
  membershipId: string,
): Promise<KeptWallet | null> {
  try {
    const cache = await openForRead()
    if (!cache) return null
    const res = await cache.match(indexKey(businessId, membershipId))
    if (!res) return null
    const body = (await res.json()) as Partial<KeptWallet> | null
    if (
      typeof body?.keptAt !== 'number' ||
      !Array.isArray(body.licences) ||
      !body.licences.every(isKeptLicence)
    ) {
      return null
    }
    return { keptAt: body.keptAt, licences: body.licences.map(licenceOf) }
  } catch {
    return null
  }
}

// ── Files ──────────────────────────────────────────────────────────────────

/**
 * A photo's thumbnail, for the lists: `THUMB_EDGE` on its long side. Null for
 * a picture this browser cannot draw, which then shows a plain tile.
 */
export async function makeLicenceThumbnail(blob: Blob): Promise<Blob | null> {
  try {
    const made = await prepareUpload(blob, {
      maxEdge: THUMB_EDGE,
      quality: 0.7,
    })
    return made.passthrough ? null : made.blob
  } catch {
    return null
  }
}

/**
 * Keeps one of this person's files, and a photo's thumbnail with it when
 * there is one. Resolves true when the file was kept.
 */
export async function keepLicenceFile(
  businessId: string,
  membershipId: string,
  file: KeptLicenceFile,
  blob: Blob,
  thumbnail: Blob | null = null,
): Promise<boolean> {
  const userId = signedInUserId()
  if (!userId || !cachesAvailable()) return false
  const meta = encodeURIComponent(JSON.stringify(fileOf(file)))
  try {
    const cache = await openForWrite(userId)
    await cache.put(
      fileKey(businessId, membershipId, file._id, file.uploadedAt),
      new Response(blob, {
        headers: {
          'Content-Type': file.contentType,
          'Content-Length': String(blob.size),
          [META_HEADER]: meta,
        },
      }),
    )
    if (thumbnail) {
      await cache.put(
        thumbKey(businessId, membershipId, file._id, file.uploadedAt),
        new Response(thumbnail, {
          headers: {
            'Content-Type': thumbnail.type || 'image/jpeg',
            [META_HEADER]: meta,
          },
        }),
      )
    }
    changed()
    return true
  } catch {
    return false
  }
}

async function readEntry(key: string): Promise<Blob | null> {
  try {
    const cache = await openForRead()
    if (!cache) return null
    const res = await cache.match(key)
    if (!res || !fileMetaOf(res)) return null
    return await res.blob()
  } catch {
    return null
  }
}

/** This version of one of this person's files, if it is kept. */
export function readKeptLicenceFile(
  businessId: string,
  membershipId: string,
  fileId: string,
  uploadedAt: number,
): Promise<Blob | null> {
  return readEntry(fileKey(businessId, membershipId, fileId, uploadedAt))
}

/** A kept photo's thumbnail, if it has one. */
export function readKeptThumbnail(
  businessId: string,
  membershipId: string,
  fileId: string,
  uploadedAt: number,
): Promise<Blob | null> {
  return readEntry(thumbKey(businessId, membershipId, fileId, uploadedAt))
}

/** What is kept of this person's files: which, and how big. */
async function keptFilesOf(
  cache: Cache,
  businessId: string,
  membershipId: string,
): Promise<Array<KeptLicenceFile>> {
  const prefix = filesRoot(businessId, membershipId)
  const found: Array<KeptLicenceFile> = []
  for (const request of await cache.keys()) {
    // Keys come back as whole URLs; what was put was the path.
    const path = new URL(request.url, 'https://kept.invalid').pathname
    if (!path.startsWith(prefix)) continue
    const res = await cache.match(path)
    const meta = res ? fileMetaOf(res) : null
    if (meta) found.push(meta)
    else await cache.delete(path)
  }
  return found
}

async function forgetFile(
  cache: Cache,
  businessId: string,
  membershipId: string,
  file: { _id: string; uploadedAt: number },
): Promise<void> {
  await cache.delete(
    fileKey(businessId, membershipId, file._id, file.uploadedAt),
  )
  await cache.delete(
    thumbKey(businessId, membershipId, file._id, file.uploadedAt),
  )
}

/** Drops everything kept of every licence: both caches, the old one too. */
export async function forgetKeptLicences(): Promise<void> {
  try {
    if (cachesAvailable()) {
      await Promise.all([
        caches.delete(KEPT_LICENCE_CACHE),
        caches.delete(OLD_KEPT_LICENCE_CACHE),
      ])
    }
  } catch {
    // A browser that refuses the cache has nothing kept in it.
  }
  changed()
}

// ── Keeping the wallet up to date ──────────────────────────────────────────

export type SyncOptions = {
  /** Bytes this page already has for a file — just uploaded from this
   * phone, or opened a moment ago — so it is not downloaded again. */
  inHand?: (fileId: string, uploadedAt: number) => Blob | null
  /** How a file is fetched: the network, unless a test says otherwise. */
  fetchFile?: (url: string) => Promise<Blob>
  /** How a photo's thumbnail is made (`makeLicenceThumbnail`). */
  makeThumbnail?: (blob: Blob) => Promise<Blob | null>
  /** The most bytes of files to keep (`KEEP_BUDGET_BYTES`). */
  budget?: number
}

const fetchForKeeping = (url: string) =>
  fetchWithProgress(url, () => {}, undefined, { stallMs: FETCH_STALL_MS })

async function syncOnce(
  businessId: string,
  membershipId: string,
  wallet: LiveWallet,
  options: SyncOptions,
): Promise<void> {
  const userId = signedInUserId()
  if (!wallet.mine || !userId || !cachesAvailable()) return
  const stillThem = () => signedInUserId() === userId
  const budget = options.budget ?? KEEP_BUDGET_BYTES
  const fetchFile = options.fetchFile ?? fetchForKeeping
  const makeThumbnail = options.makeThumbnail ?? makeLicenceThumbnail

  // The Phase 8.1 copy: the wallet has it now, if it is still held.
  try {
    await caches.delete(OLD_KEPT_LICENCE_CACHE)
  } catch {
    // Only space is lost.
  }

  if (!(await keepWalletIndex(businessId, membershipId, wallet.licences))) {
    return
  }

  const wanted = new Map<string, KeptLicenceFile & { url: string | null }>()
  for (const licence of wallet.licences) {
    for (const file of licence.files) {
      wanted.set(`${file._id}:${file.uploadedAt}`, file)
    }
  }

  // What is kept already, and what is kept but no longer on any licence —
  // taken off, or its licence deleted, here or on another phone.
  const have = new Set<string>()
  let total = 0
  try {
    const cache = await openForWrite(userId)
    let forgot = false
    for (const kept of await keptFilesOf(cache, businessId, membershipId)) {
      const key = `${kept._id}:${kept.uploadedAt}`
      if (wanted.has(key)) {
        have.add(key)
        total += kept.size
      } else {
        await forgetFile(cache, businessId, membershipId, kept)
        forgot = true
      }
    }
    if (forgot) changed()
  } catch {
    return
  }

  // What is not: one at a time, in the list's order, until the budget.
  for (const [key, file] of wanted) {
    if (have.has(key)) continue
    if (total + file.size > budget) return
    if (!stillThem()) return
    let blob = options.inHand?.(file._id, file.uploadedAt) ?? null
    if (!blob) {
      if (file.url === null) continue
      try {
        blob = await fetchFile(file.url)
      } catch (error) {
        // One file gone from storage need not stop the rest; no signal does.
        if (error instanceof FileTransferError && error.kind === 'http') {
          continue
        }
        return
      }
    }
    const thumbnail =
      file.kind === 'image' ? await makeThumbnail(blob).catch(() => null) : null
    if (!stillThem()) return
    if (
      !(await keepLicenceFile(businessId, membershipId, file, blob, thumbnail))
    ) {
      // Out of room, most likely: the next file would not fit either.
      return
    }
    total += file.size
  }
}

type Pending = { wallet: LiveWallet; options: SyncOptions }
const syncing = new Map<string, { next: Pending | null; done: Promise<void> }>()

/**
 * Brings what is kept on this phone into line with the holder's own list, as
 * it has just answered: the list itself, then any file not yet kept — in the
 * background, one at a time, until `KEEP_BUDGET_BYTES` — and forgets kept
 * files no longer on it. Does nothing for anyone else's list (`mine` false).
 *
 * One at a time per person: called again while it runs (the list answered
 * again, or another page asked), it runs once more when done, with the
 * latest list. Never rejects.
 */
export function syncKeptWallet(
  businessId: string,
  membershipId: string,
  wallet: LiveWallet,
  options: SyncOptions = {},
): Promise<void> {
  if (!wallet.mine) return Promise.resolve()
  const who = `${businessId}/${membershipId}`
  const running = syncing.get(who)
  if (running) {
    running.next = { wallet, options }
    return running.done
  }
  const entry: { next: Pending | null; done: Promise<void> } = {
    next: { wallet, options },
    done: Promise.resolve(),
  }
  syncing.set(who, entry)
  entry.done = (async () => {
    try {
      while (entry.next) {
        const latest = entry.next
        entry.next = null
        try {
          await syncOnce(
            businessId,
            membershipId,
            latest.wallet,
            latest.options,
          )
        } catch {
          // Never thrown on purpose; a copy is a convenience.
        }
      }
    } finally {
      syncing.delete(who)
    }
  })()
  return entry.done
}
