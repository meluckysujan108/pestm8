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
 *
 * Matching the caller notes counts too, only when they change
 * (`logConnectionChange`): `match-shown {same, likely, maybe, shared, live}`
 * for a press of Book or Save that found someone the caller may be, and
 * whether the client list it was found in was live. And how long things
 * took, only when slower than any this page has noted (`logConnectionSlower`,
 * `ms` as its band: 16 for 16 to 31 ms): `match-index {rows, ms}` as a match
 * index is built (lib/useMatchIndex.ts), and `picker-filter {rows, ms}` for
 * a picker's list that took longer than a frame to work out
 * (lib/usePickerList.ts). So a big book on a slow phone, typed into all
 * morning with no signal, says how slow it is in a handful of notes, not one
 * a key, and the socket's and sign-in's notes before it are still there to
 * send.
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

const lastOfEvent = new Map<string, string>()

/**
 * `logConnection`, only when `details` differ from the last note of `event`
 * this page made: counts said each time something is found would push the
 * connection's own notes out of the 300 kept.
 */
export function logConnectionChange(
  event: string,
  details: ConnectionNote,
): void {
  const said = JSON.stringify(details)
  if (lastOfEvent.get(event) === said) return
  lastOfEvent.set(event, said)
  logConnection(event, details)
}

/** The slowest band of each timed event noted by this page. */
const slowestOfEvent = new Map<string, number>()

/** The longest band a time is said in: 4,096 ms and over. */
const MS_BAND_TOP = 4_096

/**
 * How long something took, in the band a note says it in: the power of two
 * at or under it, so 16 for 16 to 31 ms, 32 for 32 to 63, up to 4,096 for
 * anything longer; 0 under a millisecond.
 */
export function msBand(ms: number): number {
  if (!(ms >= 1)) return 0
  return Math.min(2 ** Math.floor(Math.log2(ms)), MS_BAND_TOP)
}

/**
 * `logConnection` for how long something took (`details.ms`), said as its
 * band (`msBand`), and only when that is slower than any note of `event`
 * this page has made: a time is a little different every time, so noted
 * each time it would push the connection's own notes out of the 300 kept.
 */
export function logConnectionSlower(
  event: string,
  details: ConnectionNote & { ms: number },
): void {
  const band = msBand(details.ms)
  const slowest = slowestOfEvent.get(event)
  if (slowest !== undefined && band <= slowest) return
  slowestOfEvent.set(event, band)
  logConnection(event, { ...details, ms: band })
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
  lastOfEvent.clear()
  slowestOfEvent.clear()
  log = null
  device = null
  listening = false
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
}
