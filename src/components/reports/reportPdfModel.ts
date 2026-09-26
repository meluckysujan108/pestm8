import { FileTransferError } from '#/lib/pdfFiles'
import {
  MAX_COORDINATE,
  MAX_MARKUP_PAGE,
  MAX_POINTS_PER_STROKE,
  MIN_COORDINATE,
} from '../../../convex/lib/reportMarkup'
import type { MarkupPoint, MarkupStroke } from '#/components/pdf/types'
import { isOffline } from '#/lib/online'

/**
 * The thinking behind a report's PDF on screen, kept apart from React so it
 * can be tested on its own: which page a stored mark belongs to, one render
 * shared by everyone who asks for it at once, and what to say when something
 * fails.
 *
 * ── Pages: stored from 1, shown from 0 ────────────────────────────────────
 *
 * `reportPdfAnnotations.page` has always been 1-based — the old viewer drew
 * one page at a time and called the first one 1. The new viewer's page slots
 * count from 0. Every conversion between the two happens in this file and
 * nowhere else, because getting it wrong once moves every existing mark onto
 * the page after the one it was drawn on, and nothing would say so.
 */

/** One stroke as `reportAnnotations.listForReport` sends it. */
export type AnnotationRow = {
  id: string
  /** 1-based, as stored. */
  page: number
  points: ReadonlyArray<MarkupPoint>
  createdAt: number
  /** Drawn by the person asking — never by the account they are working in. */
  mine: boolean
  /** The author's member colour; null when they have left the team. */
  authorColour: string | null
}

/** The viewer's slot for a stored page. */
export const pageIndexOf = (page: number): number => page - 1
/** The stored page for a viewer slot. */
export const storedPageOf = (pageIndex: number): number => pageIndex + 1

/**
 * The marks by the viewer's 0-based page index, in the order they were drawn
 * (the server sends them that way, so a later stroke paints over an earlier
 * one). Your own marks carry no colour — the viewer draws them in its pen red
 * — and a teammate's carry their member colour when there is one.
 *
 * Each mark's `order` is its `createdAt`: Undo, with nothing of yours still
 * saving, takes the one of yours with the largest — your newest anywhere in
 * the report, not only on the page being read, which was the old per-page
 * canvas's rule only because it could see one page.
 *
 * A row with a page no slot could hold is left out rather than drawn on the
 * wrong page: only a bad write could have made it.
 */
export function strokesByPage(
  rows: ReadonlyArray<AnnotationRow>,
): Map<number, Array<MarkupStroke>> {
  const byPage = new Map<number, Array<MarkupStroke>>()
  for (const row of rows) {
    if (!Number.isInteger(row.page) || row.page < 1) continue
    const index = pageIndexOf(row.page)
    const stroke: MarkupStroke = {
      id: row.id,
      points: row.points,
      mine: row.mine,
      order: row.createdAt,
    }
    if (!row.mine && row.authorColour) stroke.color = row.authorColour
    const list = byPage.get(index)
    if (list) list.push(stroke)
    else byPage.set(index, [stroke])
  }
  return byPage
}

/**
 * A finished stroke, made fit to save: its stored page, and its points with
 * anything the server would refuse taken out or brought in, so a scribble is
 * saved rather than refused whole.
 *
 * - A point that is not a real number is dropped (the old canvas never sent
 *   one; a stray `NaN` would be somebody else's broken screen).
 * - A point that ran off the page — the pointer is captured, so a stroke
 *   keeps going past the edge — is brought back to the band the server
 *   accepts around the page, which leaves what shows on the page unchanged.
 * - A stroke longer than one may be is thinned evenly, first and last point
 *   kept, rather than cut short where the finger was still drawing.
 *
 * Null when nothing drawable is left, or the page is not one a report has.
 */
export function strokeToSave(
  pageIndex: number,
  points: ReadonlyArray<MarkupPoint>,
): { page: number; points: Array<MarkupPoint> } | null {
  const page = storedPageOf(pageIndex)
  if (!Number.isInteger(page) || page < 1 || page > MAX_MARKUP_PAGE) return null
  const clean: Array<MarkupPoint> = []
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    clean.push({ x: clampCoordinate(point.x), y: clampCoordinate(point.y) })
  }
  if (clean.length === 0) return null
  return { page, points: thinned(clean, MAX_POINTS_PER_STROKE) }
}

function clampCoordinate(value: number): number {
  return Math.min(MAX_COORDINATE, Math.max(MIN_COORDINATE, value))
}

function thinned<T>(points: Array<T>, max: number): Array<T> {
  if (points.length <= max) return points
  const step = (points.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)])
}

/**
 * One run of `start` per key while it is under way: a second caller asking
 * for the same key gets the promise the first one started, and the next
 * caller after it settles starts afresh.
 *
 * For `reportPdf.generate`. Opening the PDF tab asks for the report's PDF,
 * and so does opening the viewer — often a second apart, when a link lands
 * straight on the viewer or someone taps View PDF while the tab is still
 * preparing. Two calls would each claim the render, the second would sit
 * waiting on the first, and a technician on one bar of signal would pay for
 * the round trip twice.
 */
export function createInFlight<T>(): (
  key: string,
  start: () => Promise<T>,
) => Promise<T> {
  const running = new Map<string, Promise<T>>()
  return (key, start) => {
    const existing = running.get(key)
    if (existing) return existing
    let begun: Promise<T>
    try {
      begun = start()
    } catch (error) {
      begun = Promise.reject(error)
    }
    const shared = begun.finally(() => {
      if (running.get(key) === shared) running.delete(key)
    })
    running.set(key, shared)
    return shared
  }
}

/** "Replaced by version 2" — the badge a superseded report's PDF carries. */
export function replacedBadge(version: number | undefined): string {
  // A correction is always issued at the next version of the same number
  // (`reports.amend`), and a report is only ever replaced by its correction.
  return `Replaced by version ${(version ?? 1) + 1}`
}

// ---- Plain words -----------------------------------------------------------

/** What a failed fetch, or a dropped socket, says in the browsers we meet. */
const NETWORK =
  /failed to fetch|networkerror|network request failed|load failed|connection (?:lost|closed)|offline|timed? ?out/i

/** A refusal this file has words for, raised here rather than by the server. */
export class PdfProblem extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'PdfProblem'
    this.code = code
  }
}

/**
 * The code behind an error, or null: a ConvexError's `data` (a string, or
 * `{ code }`), one of ours, or a code named in a plain error's message.
 */
function codeOf(error: unknown, known: ReadonlyArray<string>): string | null {
  if (error instanceof PdfProblem) return error.code
  if (typeof error !== 'object' || error === null) return null
  const data = (error as { data?: unknown }).data
  if (typeof data === 'string') return data
  if (typeof data === 'object' && data !== null) {
    const code = (data as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  const message = messageOf(error)
  return known.find((code) => new RegExp(`\\b${code}\\b`).test(message)) ?? null
}

function messageOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
}

const SIGNED_OUT = 'You’ve been signed out. Sign in again, then try again.'
const NO_SIGNAL = 'No signal. Try again when you have some.'

/**
 * Words for anything the network or the server says, given the words for
 * this job's own codes. A download that failed says why itself
 * (`FileTransferError`'s words are written for this screen already).
 */
function wordsFor(
  error: unknown,
  offline: boolean,
  own: Readonly<Record<string, string>>,
  fallback: string,
): string {
  const code = codeOf(error, Object.keys(own))
  if (code !== null && code in own) return own[code]
  if (code === 'UNAUTHENTICATED') return SIGNED_OUT
  if (error instanceof FileTransferError) return error.message
  if (offline || NETWORK.test(messageOf(error))) return NO_SIGNAL
  return fallback
}

const REPORT_PDF_WORDS: Readonly<Record<string, string>> = {
  // The render did not finish: it failed, or another one holding the claim
  // (the pipeline started at finalise, usually) outlasted the wait for it.
  PDF_UNAVAILABLE: 'The PDF didn’t finish drawing. Try again in a moment.',
  NO_URL: 'The PDF didn’t finish drawing. Try again in a moment.',
  NOT_FOUND: 'This report has been deleted, so there’s no PDF to show.',
  NO_ACCESS: 'Your access doesn’t cover this report. Ask the business owner.',
  REPORT_NOT_FINALISED: 'This report isn’t locked yet, so it has no PDF.',
}

/** Why a finalised report's PDF could not be prepared or opened. */
export function reportPdfProblem(error: unknown, offline: boolean): string {
  return wordsFor(
    error,
    offline,
    REPORT_PDF_WORDS,
    'Could not prepare the PDF. Try again.',
  )
}

const PREVIEW_WORDS: Readonly<Record<string, string>> = {
  // Our own: the answers on screen did not reach the server, so a preview
  // drawn now would show the document without them. Not a matter of signal —
  // a Convex save waits out a lost connection rather than failing — but a
  // refusal (someone else changed the same answer, most often), which the
  // report behind the sheet already explains.
  SAVE_FAILED:
    'Your latest answers haven’t saved, so the preview can’t show them. Close this to see why.',
  NO_URL: 'The preview didn’t finish drawing. Try again.',
  REPORT_FINALISED:
    'This report has just been locked. Close this and open the finished document.',
  NOT_FOUND: 'This report has been deleted.',
  NO_ACCESS: 'Your access doesn’t cover this report. Ask the business owner.',
}

/** Why a draft's preview could not be drawn or opened. */
export function previewProblem(error: unknown, offline: boolean): string {
  return wordsFor(
    error,
    offline,
    PREVIEW_WORDS,
    'Could not draw the preview. Try again.',
  )
}

/**
 * Whether a failed load is one the viewer's own error screen tells truly —
 * "It didn't download. Check your signal and try again." — and whose Try
 * again might mend: no connection, or a download that stopped arriving.
 *
 * Anything else it would misreport as signal, with a Try again that fails the
 * same way every time: a refusal the server gave a reason for (a report
 * locked or deleted meanwhile, access that does not cover it), answers that
 * would not save, a file the server says is gone. The viewer says nothing
 * but that one line whatever it is handed, so those are for the caller to say
 * somewhere that can.
 */
export function isSignalProblem(error: unknown, offline: boolean): boolean {
  if (error instanceof FileTransferError) return error.kind === 'network'
  // A code, or a function that threw on the server, is the server answering
  // — which it could not have done without a connection.
  const known = [
    'UNAUTHENTICATED',
    ...Object.keys(REPORT_PDF_WORDS),
    ...Object.keys(PREVIEW_WORDS),
  ]
  if (codeOf(error, known) !== null) return false
  const message = messageOf(error)
  if (/\bServer Error\b/.test(message)) return false
  return offline || NETWORK.test(message)
}

const MARKUP_WORDS: Readonly<Record<string, string>> = {
  // Your own share of the report's marks (`MAX_STROKES_PER_AUTHOR`): only you
  // can take marks of yours away, so only you can make room in it — and you
  // can.
  TOO_MANY_STROKES:
    'You’ve made as many marks as one person can on this report. Clear some of yours to add more.',
  // The whole report's, filled by several people's shares. "Clear some of
  // yours" would be advice the person may not be able to follow — they may
  // have no marks here at all, and nobody clears a colleague's — so this
  // says whose marks they are and who can make room.
  REPORT_FULL_OF_MARKS:
    'This report is full of the team’s marks. Whoever made them can clear some to make room.',
  INVALID_STROKE: 'That mark couldn’t be saved. Try drawing it again.',
  NO_ACCESS: 'Your access doesn’t let you mark this report.',
  NOT_FOUND: 'This report has been deleted.',
}

const MARKUP_FALLBACK = {
  add: 'Your mark didn’t save. Try again.',
  undo: 'Could not undo your last mark. Try again.',
  clear: 'Could not clear your marks. Try again.',
} as const

/** Why a mark could not be saved, undone or cleared. */
export function markupProblem(
  error: unknown,
  offline: boolean,
  action: keyof typeof MARKUP_FALLBACK,
): string {
  return wordsFor(error, offline, MARKUP_WORDS, MARKUP_FALLBACK[action])
}

/** What the phone says about its connection: only "offline" is worth trusting. */
export function phoneIsOffline(): boolean {
  return isOffline()
}
