import type { LoadProgress } from '#/components/pdf/types'

/**
 * Moving a PDF between the network, this phone and the other apps on it.
 *
 * Everything here runs in the browser, and every export is safe to import
 * from a route: nothing touches `window`, `navigator` or `document` until it
 * is called, and nothing here imports pdf.js — that library starts a worker
 * and reaches for `DOMMatrix` at module load, which is why the viewer that
 * uses it is only ever loaded lazily. These helpers are what the product page
 * needs BEFORE the viewer exists: to upload a file, to share one, to fetch one
 * to keep for later.
 *
 * Most of what is fiddly here is the iPhone. This app is mostly used as an
 * installed web app on technicians' phones, and on iOS three things behave
 * unlike anywhere else:
 *
 * - `navigator.share()` only runs inside the tap that asked for it. Safari
 *   ties the permission to the gesture, and an `await` between the tap and
 *   the call — for a download, say — spends it, so the share sheet silently
 *   never opens. Every share below calls `share()` before its first `await`,
 *   and a file to share has to be in hand before the tap.
 * - A download from an installed app has nowhere sensible to land. There is no
 *   Downloads bar in a standalone window; Safari either swaps the app's page
 *   for a bare preview with no way back or does nothing at all. The share
 *   sheet's "Save to Files" is the iPhone's own answer to "keep a copy of
 *   this", so that is what Save means there.
 * - iPadOS asks for desktop sites by default, so an iPad says it is a Mac.
 */

export const PDF_TYPE = 'application/pdf'

/** How the bytes failed to arrive: no connection, or a server that said no. */
export type TransferErrorKind = 'network' | 'http'

/**
 * A download or upload that did not complete, with enough shape for the
 * caller to say something useful: "no signal" and "the file is gone" call
 * for different words, and only one of them is worth a Retry.
 *
 * An abort is NOT one of these. When the caller's signal fires, the
 * browser's own `AbortError` comes through untouched, so `signal.aborted` —
 * or an error named `AbortError` — is how a caller tells that it gave up
 * rather than failed.
 */
export class FileTransferError extends Error {
  readonly kind: TransferErrorKind
  /** The HTTP status for `http`; null for `network`. */
  readonly status: number | null

  constructor(
    kind: TransferErrorKind,
    message: string,
    status: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'FileTransferError'
    this.kind = kind
    this.status = status
  }
}

/** The name every browser gives a dismissed share sheet or a fired signal. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

/** How patient `fetchWithProgress` is. */
export type FetchOptions = {
  /**
   * Give up after this many milliseconds in which no bytes arrived — no
   * answer to the request, or a body that stopped mid-file — with a `network`
   * FileTransferError. Omitted: wait as long as the connection does.
   *
   * For downloads nobody is watching. On one bar of signal a connection can
   * stall without ever failing: Chrome on Android has no read timeout on a
   * response body, so it is the TCP retransmit limit that ends it, often a
   * quarter of an hour later. A person watching a progress bar can give up
   * sooner; a background refresh cannot, and holds up whatever waits on it.
   * Counted from the last bytes, not from the start, so a big file on a slow
   * link that is still arriving is never cut off.
   */
  stallMs?: number
}

/**
 * Fetches a file, reporting progress as the bytes arrive.
 *
 * `fetch` has no progress events, so the body is read chunk by chunk and
 * counted. The total comes from Content-Length; when the server sends none,
 * `total` is null and the caller shows a spinner instead of a bar. A total
 * the body outgrows (a compressed response whose length is the compressed
 * size — Content-Encoding is not readable cross-origin, so this cannot be
 * known up front) turns into null too, rather than a bar stuck past full.
 *
 * `credentials: 'omit'`: the files live on Convex's storage domain, where
 * the URL itself is the capability and no cookie means anything — and a
 * request that carried credentials would need that domain to name this
 * origin in its CORS headers instead of allowing any.
 *
 * A server that names no type (or only `application/octet-stream`, which is
 * what a file picker that did not recognise the file uploads as) is taken to
 * have sent a PDF, because that is the only thing this is used to fetch — and
 * a `File` built from the Blob keeps the type, which the share sheet reads to
 * decide which apps to offer.
 */
export async function fetchWithProgress(
  url: string,
  onProgress: (progress: LoadProgress) => void,
  signal?: AbortSignal,
  options: FetchOptions = {},
): Promise<Blob> {
  const watch =
    options.stallMs !== undefined && options.stallMs > 0
      ? watchForStall(options.stallMs, signal)
      : null
  try {
    return await download(url, onProgress, signal, watch)
  } catch (error) {
    // The caller's own abort wins over a stall that fired in the same moment.
    if (watch?.stalled && !signal?.aborted) {
      throw new FileTransferError(
        'network',
        'The download stopped arriving. Check your signal and try again.',
        null,
        { cause: error },
      )
    }
    throw error
  } finally {
    watch?.stop()
  }
}

async function download(
  url: string,
  onProgress: (progress: LoadProgress) => void,
  signal: AbortSignal | undefined,
  watch: StallWatch | null,
): Promise<Blob> {
  const guard = watch ? watch.guard : <T>(step: Promise<T>) => step
  let res: Response
  try {
    res = await guard(
      fetch(url, { credentials: 'omit', signal: watch?.signal ?? signal }),
    )
  } catch (error) {
    if (signal?.aborted || watch?.stalled || isAbortError(error)) throw error
    throw new FileTransferError(
      'network',
      'Could not reach the server. Check your signal and try again.',
      null,
      { cause: error },
    )
  }
  if (!res.ok) {
    // Drop the body unread; nothing in an error page is worth the data.
    void res.body?.cancel().catch(() => {})
    throw new FileTransferError(
      'http',
      res.status === 404
        ? 'The file is no longer there.'
        : `The server could not send the file (${res.status}).`,
      res.status,
    )
  }
  watch?.tick()

  const type = pdfTypeOf(res.headers.get('Content-Type'))
  let total = contentLengthOf(res.headers)
  onProgress({ loaded: 0, total })

  if (!res.body) {
    // No streaming body (very old engines): no progress to give, but the file
    // still arrives.
    const whole = await readWhole(guard(res.blob()), signal, watch)
    onProgress({ loaded: whole.size, total: whole.size })
    return whole.type === type ? whole : whole.slice(0, whole.size, type)
  }

  const reader = res.body.getReader()
  const chunks: Array<Uint8Array<ArrayBuffer>> = []
  let loaded = 0
  try {
    for (;;) {
      const { done, value } = await guard(reader.read())
      if (done) break
      watch?.tick()
      chunks.push(value)
      loaded += value.byteLength
      if (total !== null && loaded > total) total = null
      onProgress({ loaded, total })
    }
  } catch (error) {
    // Let the connection go rather than leave it reading into nothing.
    void reader.cancel().catch(() => {})
    if (signal?.aborted || watch?.stalled || isAbortError(error)) throw error
    // Signal dropped mid-file: the connection opened, then went away.
    throw new FileTransferError(
      'network',
      'The download was interrupted. Check your signal and try again.',
      null,
      { cause: error },
    )
  }
  return new Blob(chunks, { type })
}

async function readWhole(
  whole: Promise<Blob>,
  signal: AbortSignal | undefined,
  watch: StallWatch | null,
): Promise<Blob> {
  try {
    return await whole
  } catch (error) {
    if (signal?.aborted || watch?.stalled || isAbortError(error)) throw error
    throw new FileTransferError(
      'network',
      'The download was interrupted. Check your signal and try again.',
      null,
      { cause: error },
    )
  }
}

type StallWatch = {
  /** For `fetch`: fires when the caller's signal does, or on a stall. */
  signal: AbortSignal
  /** Whether it was the stall that fired. */
  readonly stalled: boolean
  /** Bytes arrived: start counting again. */
  tick: () => void
  /**
   * The step, or a rejection the moment the watch fires. `fetch` honours the
   * signal by itself, but a body stream is not bound to be wired to it, and a
   * read that never settles would hold the download open for good.
   */
  guard: <T>(step: Promise<T>) => Promise<T>
  stop: () => void
}

function watchForStall(ms: number, outer: AbortSignal | undefined): StallWatch {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stalled = false
  let fire: (reason: unknown) => void = () => {}
  const fired = new Promise<never>((_, reject) => {
    fire = reject
  })
  // Rejected for whichever step is waiting; unobserved if none is.
  fired.catch(() => {})

  const onOuterAbort = () => {
    clearTimeout(timer)
    controller.abort(outer?.reason)
    fire(outer?.reason ?? new DOMException('Aborted.', 'AbortError'))
  }
  if (outer?.aborted) onOuterAbort()
  else outer?.addEventListener('abort', onOuterAbort, { once: true })

  const tick = () => {
    if (controller.signal.aborted) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      const reason = new DOMException(
        'No bytes arrived in time.',
        'TimeoutError',
      )
      controller.abort(reason)
      fire(reason)
    }, ms)
  }
  tick()

  return {
    signal: controller.signal,
    get stalled() {
      return stalled
    },
    tick,
    guard: <T>(step: Promise<T>) => Promise.race([step, fired]),
    stop: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    },
  }
}

function pdfTypeOf(contentType: string | null): string {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  return type === '' || type === 'application/octet-stream' ? PDF_TYPE : type
}

function contentLengthOf(headers: Headers): number | null {
  const length = Number(headers.get('Content-Length'))
  return Number.isFinite(length) && length > 0 ? length : null
}

// `%PDF-`, the header every PDF opens with.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]

/**
 * Whether a file really is a PDF, checked on the phone before it is uploaded.
 *
 * The picker's `accept` is a hint, not a gate — Android's lets "All files"
 * through, and a Word document renamed `.pdf` has the right name and type and
 * is still not a PDF. Uploading it would cost the data, and the first person
 * to open it would get an error in the viewer instead of the one who chose it
 * getting one now.
 *
 * The spec lets the header sit anywhere in the first 1024 bytes (some
 * generators write a byte-order mark or junk first), so that is where it is
 * looked for, and nothing more is read.
 */
export async function looksLikePdf(blob: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await bytesOf(blob.slice(0, 1024)))
    return head.some((_, at) =>
      PDF_MAGIC.every((byte, i) => head[at + i] === byte),
    )
  } catch {
    return false
  }
}

function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  // `Blob.arrayBuffer` arrived in iOS 14; a Response reads a Blob everywhere.
  const loose = blob as Partial<Blob>
  return typeof loose.arrayBuffer === 'function'
    ? blob.arrayBuffer()
    : new Response(blob).arrayBuffer()
}

/** What the platform check reads, split out so it can be tested. */
export type DeviceHints = {
  userAgent: string
  platform: string
  maxTouchPoints: number
}

/**
 * An iPhone, iPod touch or iPad — including an iPad asking for desktop sites,
 * which it does by default from iPadOS 13 on and which then reports itself
 * as a Mac ("Macintosh" in the user agent, "MacIntel" as the platform). What
 * gives it away is the touch screen: no Mac has one, so a "Mac" with more
 * than one touch point is an iPad. Chrome and Firefox on iOS are WebKit
 * underneath and say "iPhone" or "iPad" like Safari does, so they are covered
 * too — and they share its rules about downloads and the share sheet.
 */
export function isAppleTouch(hints: DeviceHints): boolean {
  if (/\b(iPhone|iPad|iPod)\b/.test(hints.userAgent)) return true
  if (/^(iPhone|iPad|iPod)/.test(hints.platform)) return true
  const saysMac =
    /^Mac/.test(hints.platform) || /\bMacintosh\b/.test(hints.userAgent)
  return saysMac && hints.maxTouchPoints > 1
}

/** `isAppleTouch` for this browser. False on the server. */
export function isAppleTouchDevice(): boolean {
  try {
    if (typeof navigator === 'undefined') return false
    const nav = navigator as Partial<Navigator>
    return isAppleTouch({
      userAgent: nav.userAgent ?? '',
      platform: nav.platform ?? '',
      maxTouchPoints: nav.maxTouchPoints ?? 0,
    })
  } catch {
    return false
  }
}

/**
 * The browser's `navigator`, typed as what it might be missing. lib.dom
 * declares `share`, `canShare` and `clipboard` as always present; they are
 * not (Firefox on a desktop has no `share`, an insecure context has no
 * `clipboard`), and a check against the honest type is one the linter lets
 * stand.
 */
function looseNavigator(): Partial<Navigator> | null {
  return typeof navigator === 'undefined' ? null : navigator
}

/**
 * Whether the share sheet takes files here. Asked with a PDF-shaped probe
 * because browsers answer per type: Chrome on Android shares PDFs, but not
 * every type it could be handed.
 *
 * True on iOS 15+, Android Chrome, Safari on a Mac and Chrome/Edge on
 * Windows; false on Firefox and on most desktop Linux. Never throws.
 */
export function canShareFiles(): boolean {
  try {
    const nav = looseNavigator()
    if (!nav?.share || !nav.canShare || typeof File === 'undefined') {
      return false
    }
    return nav.canShare({
      files: [new File(['%PDF-'], 'probe.pdf', { type: PDF_TYPE })],
    })
  } catch {
    return false
  }
}

/** Whether there is a share sheet for text and links at all. */
export function canShareText(): boolean {
  try {
    return typeof looseNavigator()?.share === 'function'
  } catch {
    return false
  }
}

/**
 * Wraps bytes as a named PDF, which is what the share sheet and a download
 * both need: the name is what lands in Files, Mail or Downloads, and the type
 * decides which apps the sheet offers. The name is made to end in `.pdf` —
 * Android's Files app will not open a PDF saved without it.
 */
export function asPdfFile(blob: Blob, fileName: string): File {
  const name = /\.pdf$/i.test(fileName.trim())
    ? fileName.trim()
    : `${fileName.trim() || 'document'}.pdf`
  return new File([blob], name, { type: PDF_TYPE })
}

/**
 * Hands a PDF to the system share sheet — Mail, Messages, AirDrop, WhatsApp,
 * Save to Files.
 *
 * `share()` is called before anything is awaited: Safari only honours it
 * inside the tap that asked (see the top of this file), so the caller must
 * already hold the File and must not await anything between the tap and this
 * call either.
 *
 * Resolves `'cancelled'` when the person closes the sheet without choosing
 * anything — that is a choice, not a failure, but nothing went either, and a
 * caller that says "Sent" afterwards must be able to tell — and `'shared'`
 * once it has gone. Rejects on anything else, including a browser with no
 * share sheet at all.
 */
export async function sharePdf(
  file: File,
  opts: { title?: string; text?: string } = {},
): Promise<'shared' | 'cancelled'> {
  const nav = looseNavigator()
  if (!nav?.share) throw new Error('This browser cannot share files.')
  const data: ShareData = { files: [file] }
  if (opts.title) data.title = opts.title
  if (opts.text) data.text = opts.text
  try {
    await nav.share(data)
    return 'shared'
  } catch (error) {
    if (isAbortError(error)) return 'cancelled'
    throw error
  }
}

// Long enough for the browser to have read the object URL into its download
// manager (revoking it at once can cancel the download before it starts, and
// Firefox reads it lazily), short enough that the bytes are not held for the
// life of the page.
const REVOKE_AFTER_MS = 60_000

/**
 * Saves a copy of the PDF outside the app.
 *
 * On an iPhone or iPad that can share files, this is the share sheet, whose
 * "Save to Files" is where a copy belongs (see the top of this file) — so,
 * as for `sharePdf`, nothing may be awaited between the tap and this call.
 * Everywhere else it is an ordinary download: a link to the bytes with a
 * `download` name, clicked. The link joins the document for the click
 * because older Firefox ignores a click on a detached one.
 *
 * Resolves as `sharePdf` does where it is the share sheet — `'cancelled'`
 * when that is closed without choosing — and `'saved'` once a download has
 * been handed to the browser.
 */
export async function savePdf(
  file: File,
): Promise<'shared' | 'saved' | 'cancelled'> {
  if (isAppleTouchDevice() && canShareFiles()) return sharePdf(file)
  // No page to click a link in (rendering on the server): nothing went, and
  // nothing is to be said about it.
  if (typeof document === 'undefined') return 'cancelled'

  const href = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = href
  link.download = file.name
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(href), REVOKE_AFTER_MS)
  }
  return 'saved'
}

/**
 * What `savePdf` will do, in the words the platform uses for it. Matches
 * `savePdf`'s own test, so an old iPhone that cannot share files — where Save
 * falls back to a download — is told "Download". "Download" on the server;
 * read it in the browser.
 */
export function saveLabel(): 'Save to Files' | 'Download' {
  return isAppleTouchDevice() && canShareFiles() ? 'Save to Files' : 'Download'
}

/** How a share went, for the page to say so: "Copied" needs saying. */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed'

export type ShareableProduct = {
  name: string
  description?: string | null
  url?: string | null
}

/**
 * The words that go with a shared product: its name, its description and its
 * link, a blank line between each, leaving out whichever is empty.
 *
 * The link goes in the text and NOT in the share's `url` as well. Given both,
 * every target shows it twice — Messages and Mail on iOS add the `url` as its
 * own item after the text, and Android joins them into one message ("…text
 * https://…") — while some targets take only one of the two (iOS's Copy keeps
 * just the `url`, many Android apps read just the text). One text carrying
 * everything reaches every app whole, with the link in it exactly once, and
 * Messages and Mail still turn it into a tappable link.
 */
export function productShareText(product: ShareableProduct): string {
  return [product.name, product.description, product.url]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join('\n\n')
}

/**
 * Shares a product: its PDF, with its name, description and link as the
 * message, where the share sheet takes files; just the words where it takes
 * only text; and copied to the clipboard where there is no share sheet at all
 * (Firefox on a desktop), which the page should say out loud — "Copied".
 *
 * `title` is the product's name. Most targets ignore it; Android's Mail and
 * Gmail use it as the subject, which is where a name belongs.
 *
 * The File has to be in hand already (see `sharePdf`). A caller that has not
 * downloaded the PDF yet shares the words now rather than making the person
 * wait for bytes and then tap again.
 */
export async function shareProduct(
  product: ShareableProduct & { file?: File | null },
): Promise<ShareOutcome> {
  const text = productShareText(product)
  const title = product.name.trim()
  const nav = looseNavigator()

  let data: ShareData | null = null
  if (product.file && canShareFiles()) {
    data = { title, text, files: [product.file] }
  } else if (nav?.share) {
    data = { title, text }
  }
  if (!data || !nav?.share) return (await copyText(text)) ? 'copied' : 'failed'

  try {
    await nav.share(data)
    return 'shared'
  } catch (error) {
    return isAbortError(error) ? 'cancelled' : 'failed'
  }
}

/**
 * Shares a bare link — the product's web page. Here the link IS the `url`,
 * not text: on its own it is what Messages turns into a preview card and what
 * iOS's Copy copies. With no share sheet, it is copied instead.
 */
export async function shareLink(link: {
  title?: string
  url: string
}): Promise<ShareOutcome> {
  const nav = looseNavigator()
  if (!nav?.share) return (await copyText(link.url)) ? 'copied' : 'failed'

  const data: ShareData = { url: link.url }
  if (link.title) data.title = link.title
  try {
    await nav.share(data)
    return 'shared'
  } catch (error) {
    return isAbortError(error) ? 'cancelled' : 'failed'
  }
}

/**
 * Puts text on the clipboard. True when it got there.
 *
 * The Clipboard API first; it is missing outside a secure context and on iOS
 * before 13.4, and Safari refuses it outside a tap. So, failing that, the old
 * way: select the text in a hidden field and `execCommand('copy')`. Should be
 * called straight from the tap, for the same reason as `sharePdf`.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = looseNavigator()?.clipboard as
      Partial<Clipboard> | undefined
    if (clipboard?.writeText) {
      await clipboard.writeText(text)
      return true
    }
  } catch {
    // Refused or unavailable; try the selection below.
  }
  return copyBySelection(text)
}

function copyBySelection(text: string): boolean {
  if (typeof document === 'undefined') return false
  const previous = document.activeElement
  const field = document.createElement('textarea')
  field.value = text
  // Read-only, so iOS does not raise the keyboard for a field nobody sees.
  field.setAttribute('readonly', '')
  field.setAttribute('aria-hidden', 'true')
  // 16px because iOS zooms the page into any focused field smaller than
  // that; fixed and off to the side so selecting it does not scroll.
  field.style.cssText =
    'position:fixed;top:0;left:-9999px;font-size:16px;opacity:0;'
  document.body.append(field)
  try {
    field.focus({ preventScroll: true })
    field.select()
    // iOS ignores `select()` on a textarea; a range it honours.
    field.setSelectionRange(0, text.length)
    // Deprecated, and still the only copy there is without the Clipboard API.
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true })
  }
}

const SIZE_UNITS = ['KB', 'MB', 'GB'] as const

/**
 * A file size as a person reads one: "842 KB", "1.2 MB", "12 MB".
 *
 * Decimal — a kilobyte is 1000 bytes — because that is what the phone itself
 * says. iOS's Files app and Android's both count in thousands, so the size
 * shown here matches the one Files shows after "Save to Files" instead of
 * disagreeing by a few percent. Kilobytes are whole; megabytes and up carry
 * one decimal place when it is not zero. Rounded before the unit is chosen,
 * so 999,999 bytes is "1 MB", never "1,000 KB".
 */
export function formatBytes(bytes: number): string {
  const n = Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0
  if (n < 1000) return n === 1 ? '1 byte' : `${n} bytes`

  let value = n / 1000
  let unit = 0
  while (unit < SIZE_UNITS.length - 1 && roundTo(value, unit) >= 1000) {
    value /= 1000
    unit++
  }
  const digits = unit === 0 ? 0 : 1
  const shown = new Intl.NumberFormat('en-AU', {
    maximumFractionDigits: digits,
  }).format(roundTo(value, unit))
  return `${shown} ${SIZE_UNITS[unit]}`
}

function roundTo(value: number, unit: number): number {
  return unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
}

/**
 * Uploads a file to a Convex upload URL (from a `generateUploadUrl`
 * mutation) and returns the storage id it was stored under — as a plain
 * string; the caller casts it to `Id<'_storage'>` for the mutation that
 * claims it, which is where the id's type is checked for real.
 *
 * `fetch` cannot report upload progress, so there is none; a PDF is a few
 * megabytes, and the button's own pending state covers it.
 */
export async function uploadToStorage(
  uploadUrl: string,
  blob: Blob,
  contentType: string,
  signal?: AbortSignal,
): Promise<string> {
  let res: Response
  try {
    res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: blob,
      credentials: 'omit',
      signal,
    })
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error
    throw new FileTransferError(
      'network',
      'The upload did not get through. Check your signal and try again.',
      null,
      { cause: error },
    )
  }
  if (!res.ok) {
    throw new FileTransferError(
      'http',
      `The upload was refused (${res.status}).`,
      res.status,
    )
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // Reported below as a missing id.
  }
  const storageId =
    typeof body === 'object' && body !== null
      ? (body as { storageId?: unknown }).storageId
      : undefined
  if (typeof storageId !== 'string' || storageId === '') {
    throw new FileTransferError(
      'http',
      'The upload finished without a storage id.',
      res.status,
    )
  }
  return storageId
}
