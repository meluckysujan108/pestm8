/**
 * What this phone's connection to PestM8 has been doing, kept on the phone and
 * sent to the server now and then (components/shell/ConnectionDiagnostics.tsx,
 * convex/diagnostics.ts), so the next "it just hangs" comes with evidence.
 *
 * On 25 Oct 2026 the server's logs could say only that it had answered
 * everything it was asked in under half a second. Whether a phone's socket had
 * died unnoticed, was waiting for a sign-in token, or was opened from a saved
 * copy of the page, only the phone knew, and it kept no record. Now it notes
 * the moments that decide that: coming back on screen, a socket opening,
 * closing or being given up, a token and how long it took, the notice shown
 * and why, Try again and Reload.
 *
 * Kept in this browser's storage, the last 300 notes, so the ones from before
 * a Reload — the person giving up — are still there to send afterwards. Times
 * and states only: nothing anyone typed, no names, no addresses. Every read
 * and write is best-effort: storage can be missing, full or refused, and none
 * of that may cost the page anything.
 */

/** A note's details: short words and numbers. */
export type ConnectionNote = Record<string, string | number | boolean>

/** One note, as sent: when (epoch ms), what, and its details. */
export type ConnectionEntry = { t: number; e: string; d?: ConnectionNote }

type Kept = ConnectionEntry & { s: number }

type Log = {
  /** The number the next note gets. */
  next: number
  /** The highest number the server has. */
  sent: number
  entries: Array<Kept>
  /** Who the notes are sent as, once known (`adoptConnectionLog`). */
  owner?: string
}

const STORAGE_KEY = 'pestm8.connectionLog'
const DEVICE_KEY = 'pestm8.deviceId'
/** How many notes are kept, sent or not. */
export const KEPT_NOTES = 300

let log: Log | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let listening = false
let device: string | null = null

/** A page in a browser: not the server render, nor a test without one. */
function inBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function load(): Log {
  if (log) return log
  log = { next: 1, sent: 0, entries: [] }
  try {
    const kept: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? 'null')
    if (
      typeof kept === 'object' &&
      kept !== null &&
      'next' in kept &&
      'sent' in kept &&
      'entries' in kept &&
      typeof kept.next === 'number' &&
      typeof kept.sent === 'number' &&
      Array.isArray(kept.entries)
    ) {
      log = {
        next: kept.next,
        sent: kept.sent,
        entries: (kept.entries as Array<Kept>).slice(-KEPT_NOTES),
        ...('owner' in kept && typeof kept.owner === 'string'
          ? { owner: kept.owner }
          : {}),
      }
    }
  } catch {
    // Unreadable: start a new log.
  }
  if (!listening && inBrowser()) {
    // Written on a timer, and at once when the page may be about to go.
    listening = true
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') save()
    })
  }
  return log
}

function save(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!log) return
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(log))
  } catch {
    // Full or refused: the notes stay in memory for this page.
  }
}

/** Notes something about the connection. Does nothing on the server. */
export function logConnection(event: string, details?: ConnectionNote): void {
  if (!inBrowser()) return
  const current = load()
  current.entries.push({
    s: current.next++,
    t: Date.now(),
    e: event,
    ...(details ? { d: details } : {}),
  })
  if (current.entries.length > KEPT_NOTES) {
    current.entries.splice(0, current.entries.length - KEPT_NOTES)
  }
  saveTimer ??= setTimeout(save, 1_000)
}

/** The oldest notes the server does not have yet, up to `max`, or null. */
export function unsentConnectionLog(
  max: number,
): { through: number; entries: Array<ConnectionEntry> } | null {
  if (!inBrowser()) return null
  const current = load()
  const unsent = current.entries
    .filter((entry) => entry.s > current.sent)
    .slice(0, max)
  const last = unsent.at(-1)
  if (!last) return null
  return {
    through: last.s,
    entries: unsent.map(({ s: _s, ...entry }) => entry),
  }
}

/**
 * Says who the notes are about to be sent as (a user id). The notes are this
 * browser's, not one person's: notes left unsent by another person's sign-in
 * here are dropped rather than sent as this person's, and notes from before
 * anyone was known are kept.
 */
export function adoptConnectionLog(owner: string): void {
  if (!inBrowser()) return
  const current = load()
  if (current.owner === owner) return
  if (current.owner !== undefined) current.sent = current.next - 1
  current.owner = owner
  saveTimer ??= setTimeout(save, 1_000)
}

/** Records that the server has every note up to `through`. */
export function markConnectionLogSent(through: number): void {
  const current = load()
  if (through <= current.sent) return
  current.sent = through
  saveTimer ??= setTimeout(save, 1_000)
}

/**
 * A random name for this browser, kept with its notes, so one phone's notes
 * can be told from the same person's laptop. Nothing about the device itself.
 */
export function deviceId(): string {
  if (device) return device
  const kept = storage()
  try {
    device = kept?.getItem(DEVICE_KEY) ?? null
  } catch {
    // Unreadable: a new name below.
  }
  if (device) return device
  device =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  try {
    kept?.setItem(DEVICE_KEY, device)
  } catch {
    // Not kept: this page load still uses one name throughout.
  }
  return device
}

/** For tests: forgets the log in memory, as a new page load would. */
export function forgetConnectionLogForTests(): void {
  log = null
  device = null
  listening = false
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
}
