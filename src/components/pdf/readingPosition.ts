/**
 * "Reopen where I left off": the page, how far down it, and the zoom, kept on
 * this phone per PDF.
 *
 * A technician checks section 8 of a safety data sheet, closes it to answer
 * the client, and opens it again a minute later; landing back on page 1 and
 * scrolling for section 8 again is the kind of friction that makes someone
 * stop opening the sheet at all.
 *
 * Kept in localStorage, one key per PDF (by `source.key`, the file's URL, so
 * a replaced file starts from the top), and trimmed to the most recent 50 so
 * years of opened sheets do not accumulate. Every access is guarded: storage
 * is missing on the server and throws in some private modes, and a place in
 * a PDF is never worth an error.
 *
 * The parsing and trimming are pure and take the storage as an argument, so
 * they can be tested without a browser.
 */

import { MAX_ZOOM, MIN_ZOOM } from './layout'

export const POSITION_PREFIX = 'pestm8:pdf-position:'
export const MAX_POSITIONS = 50

export type ReadingPosition = {
  /** 1-based. */
  page: number
  /** How far down that page the top of the screen was, 0–1. */
  fraction: number
  zoom: number
}

type Stored = ReadingPosition & { savedAt: number }

/** The subset of `Storage` used here, so a test can pass a Map-backed fake. */
export type StorageLike = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>

export function positionKey(sourceKey: string): string {
  return POSITION_PREFIX + sourceKey
}

export function serialisePosition(
  position: ReadingPosition,
  savedAt: number,
): string {
  // Short keys: this is written every half-second while someone scrolls.
  return JSON.stringify({
    p: position.page,
    f: Math.round(position.fraction * 10_000) / 10_000,
    z: Math.round(position.zoom * 1000) / 1000,
    t: savedAt,
  })
}

/**
 * Reads a stored position back, or null for anything that is not one — a
 * value from an older version, one edited by hand, a truncated write.
 * Values are clamped rather than rejected where the intent is clear.
 */
export function parsePosition(raw: string | null): Stored | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { p, f, z, t } = value as Record<string, unknown>
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1) return null
  if (typeof f !== 'number' || !Number.isFinite(f)) return null
  if (typeof z !== 'number' || !Number.isFinite(z)) return null
  return {
    page: p,
    fraction: Math.min(1, Math.max(0, f)),
    zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)),
    savedAt: typeof t === 'number' && Number.isFinite(t) ? t : 0,
  }
}

/**
 * The keys to remove so at most `max` positions remain: the least recently
 * saved first, and anything unreadable before those.
 */
export function positionsToDrop(
  entries: Array<{ key: string; savedAt: number }>,
  max: number = MAX_POSITIONS,
): string[] {
  if (entries.length <= max) return []
  return [...entries]
    .sort((a, b) => a.savedAt - b.savedAt)
    .slice(0, entries.length - max)
    .map((entry) => entry.key)
}

/** This browser's localStorage, or null where there is none to use. */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

export function loadPosition(
  storage: StorageLike | null,
  sourceKey: string,
): ReadingPosition | null {
  if (!storage) return null
  try {
    const stored = parsePosition(storage.getItem(positionKey(sourceKey)))
    if (!stored) return null
    return { page: stored.page, fraction: stored.fraction, zoom: stored.zoom }
  } catch {
    return null
  }
}

export function savePosition(
  storage: StorageLike | null,
  sourceKey: string,
  position: ReadingPosition,
  now: number,
): void {
  if (!storage) return
  try {
    const key = positionKey(sourceKey)
    const isNew = storage.getItem(key) === null
    storage.setItem(key, serialisePosition(position, now))
    // Only a new PDF can take the count over the limit, so only then is it
    // worth walking every key in storage.
    if (isNew) trimPositions(storage)
  } catch {
    // Full, or blocked. Forgetting a place is harmless.
  }
}

function trimPositions(storage: StorageLike): void {
  const entries: Array<{ key: string; savedAt: number }> = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key?.startsWith(POSITION_PREFIX)) continue
    entries.push({
      key,
      savedAt: parsePosition(storage.getItem(key))?.savedAt ?? 0,
    })
  }
  for (const key of positionsToDrop(entries)) storage.removeItem(key)
}
