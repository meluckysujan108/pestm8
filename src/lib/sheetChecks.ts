import { convexCode } from '#/components/forms/describeError'
import type { FunctionArgs } from 'convex/server'
import type { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import type {
  MatchedClient,
  SiteBooked,
  SiteRepeats,
} from '../../convex/lib/findSame'
import { MATCH_MORE_ID } from './clientMatchRows'
import { SITE_MORE_ID, SITE_MORE_SERIES_ID } from './siteWorkRows'
import type { BookingSite } from './outbox/outboxItem'
import type { Access } from './access'
import type { Seen, SeenPair } from './siteWorkRows'

/**
 * The online sheet sends its checks (the matching plan's M7, §4.5): what a
 * sheet open with signal tells the server it showed and saved past, and
 * what it does when the server, whose book is current, finds more.
 *
 * New Job, Clients → New client and Add property check on the phone first,
 * from what it keeps (lib/clientMatchRows.ts, lib/siteWorkRows.ts). Then the
 * save goes with what that check returned: every client the matcher found
 * (`matchCheck.dismissed`, shown or counted in "And 2 more", FW17d), and
 * every job, visit and Recurring Job shown and booked past (`siteCheck`),
 * so the server refuses only what the phone never showed: its copy was
 * behind, capped, or held less (C4). A refusal is rare, and comes back as
 * rows of the panel, with the phone's own words and the note "PestM8 found
 * this when saving." (`FOUND_WHEN_SAVING`); Book anyway sends them back as
 * seen, under the same request id, and books once.
 *
 * Pure, but for the wait for what a fix needs (`createHoldWait`), so the
 * forms and their tests decide the same.
 */

/** The refusals a sheet shows as rows of its panel (§4.3). */
export const SHEET_CHECK_CODES = [
  'MATCHED_CLIENT',
  'SITE_BOOKED',
  'SITE_REPEATS',
] as const

export type SheetCheckCode = (typeof SHEET_CHECK_CODES)[number]

/** A refusal's details, as the server sends them (convex/lib/findSame.ts). */
export type SheetRefusal = MatchedClient | SiteBooked | SiteRepeats

/** The note at the end of the panel while rows a refusal added show. */
export const FOUND_WHEN_SAVING = 'PestM8 found this when saving.'

/** How long a refusal's fix waits for the live client list to hold what it
 * books at (§4.5): the picker needs the option. */
export const HOLD_WAIT_MS = 3000

function isCode(code: string | null): code is SheetCheckCode {
  return (SHEET_CHECK_CODES as ReadonlyArray<string>).includes(code ?? '')
}

type Loose = Record<string, unknown>

function isObject(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** Only the entries in the shape they are sent in: one in any other was
 * never the server's, and is left out rather than shown. */
function listOf<T>(value: unknown, ok: (entry: unknown) => boolean): Array<T> {
  return Array.isArray(value) ? (value.filter(ok) as Array<T>) : []
}

/**
 * The refusal's details, read from the server's own answer: a ConvexError
 * whose data is `{ code, … }` for one of the three, each entry in the shape
 * it is sent in. Null for anything else, a refusal by its code alone among
 * them (no rows to show: FormAlert says it), or a message that only names
 * one (RK16).
 */
export function sheetRefusalOf(error: unknown): SheetRefusal | null {
  const code = convexCode(error)
  if (!isCode(code)) return null
  const data = (error as { data?: unknown }).data
  if (!isObject(data)) return null
  const ids = (value: unknown) => listOf<string>(value, isString)
  if (code === 'MATCHED_CLIENT') {
    const candidates = listOf<MatchedClient['candidates'][number]>(
      data.candidates,
      (c) => isObject(c) && isString(c.clientId) && isString(c.name),
    ).map((c) => ({ ...c, evidence: ids(c.evidence) }))
    if (candidates.length === 0) return null
    const more = ids(data.more)
    return {
      code,
      candidates: candidates as MatchedClient['candidates'],
      ...(more.length > 0 ? { more: more as Array<Id<'clients'>> } : {}),
    }
  }
  if (code === 'SITE_BOOKED') {
    const pair = (r: unknown) =>
      isObject(r) &&
      isString(r.propertyId) &&
      isNumber(r.at) &&
      (r.jobId === undefined || isString(r.jobId))
    const rows = listOf<SiteBooked['rows'][number]>(
      data.rows,
      (r) => pair(r) && isNumber((r as Loose).scheduledAt),
    )
    if (rows.length === 0) return null
    const more = listOf<NonNullable<SiteBooked['more']>[number]>(
      data.more,
      pair,
    )
    return { code, rows, ...(more.length > 0 ? { more } : {}) }
  }
  const series = listOf<SiteRepeats['series'][number]>(
    data.series,
    (r) => isObject(r) && isString(r.recurrenceId) && isString(r.propertyId),
  )
  if (series.length === 0) return null
  const more = ids(data.more)
  return {
    code,
    series,
    ...(more.length > 0 ? { more: more as Array<Id<'recurrences'>> } : {}),
  }
}

// ── What a save sends back ────────────────────────────────────────────────

/** What a refusal's rows, once booked past, send back with the next save:
 * its clients as dismissed, its jobs and visits as seen, its Recurring Jobs
 * as seen series. Every one it named, and every one in `more`. */
export type SheetSends = {
  dismissed: ReadonlyArray<Id<'clients'>>
  seen: ReadonlyArray<SeenPair>
  seenSeries: ReadonlyArray<Id<'recurrences'>>
}

export const NOTHING_SENT: SheetSends = {
  dismissed: [],
  seen: [],
  seenSeries: [],
}

/** A pair as `siteCheck` takes it: the site and the slot told, and the
 * job's id only where the server sent one (the person's own, C5). */
function pairOf(row: {
  propertyId: Id<'properties'>
  at: number
  jobId?: Id<'jobs'>
}): SeenPair {
  return row.jobId !== undefined
    ? { propertyId: row.propertyId, at: row.at, jobId: row.jobId }
    : { propertyId: row.propertyId, at: row.at }
}

/** Everything a refusal names, named or in `more`, as the save after it
 * sends it back ("Found while building M6"). */
export function sendsOf(refusal: SheetRefusal): SheetSends {
  switch (refusal.code) {
    case 'MATCHED_CLIENT':
      return {
        ...NOTHING_SENT,
        dismissed: [
          ...refusal.candidates.map((c) => c.clientId),
          ...(refusal.more ?? []),
        ],
      }
    case 'SITE_BOOKED':
      return {
        ...NOTHING_SENT,
        seen: [...refusal.rows, ...(refusal.more ?? [])].map(pairOf),
        // A visit's series, as the phone's own rows send it (`seenSeriesOf`).
        seenSeries: refusal.rows.flatMap((r) =>
          r.series !== undefined ? [r.series] : [],
        ),
      }
    case 'SITE_REPEATS':
      return {
        ...NOTHING_SENT,
        seenSeries: [
          ...refusal.series.map((s) => s.recurrenceId),
          ...(refusal.more ?? []),
        ],
      }
  }
}

const pairKey = (p: SeenPair) => `${p.propertyId}|${p.at}|${p.jobId ?? ''}`

/** Each once. */
export function joinSends(...all: ReadonlyArray<SheetSends>): SheetSends {
  const pairs = new Map<string, SeenPair>()
  for (const sends of all) {
    for (const pair of sends.seen) pairs.set(pairKey(pair), pair)
  }
  return {
    dismissed: [...new Set(all.flatMap((s) => s.dismissed))],
    seen: [...pairs.values()],
    seenSeries: [...new Set(all.flatMap((s) => s.seenSeries))],
  }
}

/** Where a refusal's row, on the panel, keeps what it sends back: by the
 * check it is of and its id, as `SaveWarningsController.injected` has it. */
export function rowKey(row: { source: string; id: string }): string {
  return `${row.source}\n${row.id}`
}

/**
 * What the rows refusals put on the panel send back, those still standing
 * and those carried (`SaveWarningsController.refusedNow()`: a row the
 * phone found again in other words took one's place, so it shows, but what
 * the refusal's named was shown), each once: of one check alone
 * (`source`), or of every one. A row edited away, or taken by a fix, sends
 * nothing more.
 */
export function standingSends(
  byRow: ReadonlyMap<string, SheetSends>,
  injected: ReadonlyArray<{ source: string; id: string }>,
  source?: string,
): SheetSends {
  return joinSends(
    ...injected.flatMap((row) => {
      if (source !== undefined && row.source !== source) return []
      const sends = byRow.get(rowKey(row))
      return sends ? [sends] : []
    }),
  )
}

/**
 * What each row a refusal puts on the panel sends back with the next press:
 * the refusal's own (`sends`), and, for a row taking the place of one of
 * the same id still standing or carried (`injected`, as
 * `SaveWarningsController.refusedNow()` has them before the refusal's are
 * put on), what that one sent too. So a count of the rest ("And 2 more")
 * put back by a second refusal still books past the first's. A key no row
 * stands for any more is left out.
 */
export function sendsByRow(
  before: ReadonlyMap<string, SheetSends>,
  injected: ReadonlyArray<{ source: string; id: string }>,
  source: string,
  rows: ReadonlyArray<{ id: string }>,
  sends: SheetSends,
): Map<string, SheetSends> {
  const next = new Map<string, SheetSends>()
  for (const row of injected) {
    const key = rowKey(row)
    const kept = before.get(key)
    if (kept) next.set(key, kept)
  }
  for (const row of rows) {
    const key = rowKey({ source, id: row.id })
    const kept = next.get(key)
    next.set(key, kept ? joinSends(kept, sends) : sends)
  }
  return next
}

/**
 * The work match rows named at their sites (FW13) that the panel says in
 * the phone's own words: what `seen` sends back for them. Not a row a
 * refusal put in a match row's place (`injected`, of `source`): its words
 * are the server's (`refusedMatchRows`), and say nothing of that work, so
 * the work isn't seen, and the server names it.
 */
export function namedOnPanel<T>(
  named: ReadonlyMap<string, ReadonlyArray<T>>,
  injected: ReadonlyArray<{ source: string; id: string }>,
  source: string,
): Array<T> {
  return [...namedRowsOnPanel(named, injected, source).values()].flat()
}

/** `namedOnPanel`, by the match row that names it: what a Book at at one
 * site books past of it (`bookAtSees`). */
export function namedRowsOnPanel<T>(
  named: ReadonlyMap<string, ReadonlyArray<T>>,
  injected: ReadonlyArray<{ source: string; id: string }>,
  source: string,
): Map<string, ReadonlyArray<T>> {
  const theirs = new Set(
    injected.filter((row) => row.source === source).map((row) => row.id),
  )
  return new Map([...named].filter(([id]) => !theirs.has(id)))
}

/** `matchCheck` and `siteCheck`, as `jobs.create`, `recurrences.create`,
 * `properties.create` and `createForClient` take them (§4.2). */
export type MatchCheckArg = NonNullable<
  FunctionArgs<typeof api.jobs.create>['matchCheck']
>
export type SiteCheckArg = NonNullable<
  FunctionArgs<typeof api.jobs.create>['siteCheck']
>
export type SheetChecks = {
  matchCheck?: MatchCheckArg
  siteCheck?: SiteCheckArg
}

/** `matchCheck` from the sheet: someone is there to answer a refusal. */
export function matchCheckFor(
  dismissed: Iterable<Id<'clients'>>,
): MatchCheckArg {
  return { by: 'sheet', dismissed: [...new Set(dismissed)] }
}

/** `siteCheck`: what the phone's rows showed and fixes booked past
 * (`seen`), and what refusals named (`sends`), each once, each pair in the
 * validator's shape exactly. */
export function siteCheckFor(seen: Seen, sends: SheetSends): SiteCheckArg {
  const pairs = new Map<string, SeenPair>()
  for (const pair of [...seen.pairs, ...sends.seen]) {
    pairs.set(pairKey(pair), pairOf(pair))
  }
  return {
    seen: [...pairs.values()],
    seenSeries: [...new Set([...seen.series, ...sends.seenSeries])],
  }
}

/**
 * What a send again carries (`sendChecked`): what the send refused carried
 * (`carried`), with what the refusals since named (`extra`), each once, in
 * the validator's shape. Never the form read again: a client or job the
 * phone took in while the booking was out, or the form edited meanwhile,
 * would go back as booked past though it was never shown.
 */
export function resentChecks(
  carried: SheetChecks,
  extra: SheetSends,
): SheetChecks {
  return {
    ...(carried.matchCheck
      ? {
          matchCheck: matchCheckFor([
            ...carried.matchCheck.dismissed,
            ...extra.dismissed,
          ]),
        }
      : {}),
    ...(carried.siteCheck
      ? {
          siteCheck: siteCheckFor(
            {
              pairs: carried.siteCheck.seen,
              series: carried.siteCheck.seenSeries,
            },
            extra,
          ),
        }
      : {}),
  }
}

/**
 * The checks each send of one press carries, for `sendChecked`'s `send`:
 * the first's read as it goes (`read`: what the press's own checks found,
 * `createPressReads`, given what earlier refusals of the press named:
 * nothing, for the first); a send again, what the first carried and what
 * the refusals since named (`resentChecks`).
 */
export function pressChecks<TChecks extends SheetChecks>(
  read: (extra: SheetSends) => TChecks,
): (extra: SheetSends, again: boolean) => SheetChecks {
  let first: TChecks | null = null
  return (extra, again) => {
    if (again && first !== null) return resentChecks(first, extra)
    first = read(extra)
    return first
  }
}

/**
 * What each press's checks found, kept with the press, for the save it
 * leads to: the clients the phone's matcher returned, the work its rows
 * showed. A save sends what its press's checks found as they answered,
 * never the form read again as it goes: the save waits for the slowest
 * check (an email's domain, a street, up to 3 s), and a client or job the
 * phone took in meanwhile was never shown, so it is the server's to name.
 *
 * Every check of one press is given the same `signal` (`runSaveChecks`): a
 * check calls `begin(signal)` as it is asked, which starts the press's
 * record where it is the first of it, and gives back the `note` it puts
 * what it found in as it answers. A note goes nowhere once a later press
 * has begun, or where the check ran out of time (`signal.aborted`): it
 * found nothing, as the guard counts it. `last()` is the newest press's.
 *
 * `sending()` is the newest press's as its save goes, and `sent()` gives
 * it back after: the record of the newest press whose save went (null
 * before one has), for a refused row's fix to read what the press refused
 * showed. Every row a press whose save went found was on the panel, shown
 * and booked past, before its save could go (`createSaveGuard`); a later
 * press still checking ("Checking…") has begun its own record, whose rows
 * aren't drawn yet, so `last()` would say what the panel never showed.
 */
export function createPressReads<T extends object>() {
  let press: { signal: AbortSignal | null; read: Partial<T> } = {
    signal: null,
    read: {},
  }
  let sent: Partial<T> | null = null
  return {
    begin(signal: AbortSignal) {
      if (press.signal !== signal) press = { signal, read: {} }
      // This press's own record: once a later press has begun, nothing
      // reads it.
      const { read } = press
      return <TKey extends keyof T>(key: TKey, value: T[TKey]): void => {
        if (!signal.aborted) read[key] = value
      }
    },
    last(): Partial<T> {
      return press.read
    },
    sending(): Partial<T> {
      sent = press.read
      return sent
    },
    sent(): Partial<T> | null {
      return sent
    },
  }
}

export type PressReads<T extends object> = ReturnType<
  typeof createPressReads<T>
>

/** A press's `note` (`createPressReads`). */
export type PressNote<T extends object> = ReturnType<PressReads<T>['begin']>

/** `seen` with what `sends` names added: what a refused row's Book at
 * books past, as the phone's own rows' fixes do (`withSeenAll`). */
export function withSent(seen: Seen, sends: SheetSends): Seen {
  if (sends.seen.length === 0 && sends.seenSeries.length === 0) return seen
  const check = siteCheckFor(seen, sends)
  return { pairs: check.seen, series: check.seenSeries }
}

/**
 * What New Job sends with a booking (§4.5): `matchCheck` with a new client
 * or a new site, and `siteCheck` in every mode. `dismissed` is every client
 * the phone's matcher returned at this press (`bookingDismissed`), `seen`
 * what the phone's rows showed and fixes booked past, and `sends` what
 * refusals named that the person has since seen.
 */
export function bookingSheetChecks(at: {
  property: BookingSite
  dismissed: ReadonlyArray<Id<'clients'>>
  seen: Seen
  sends: SheetSends
}): Required<Pick<SheetChecks, 'siteCheck'>> & SheetChecks {
  const makes = 'newClient' in at.property || 'newProperty' in at.property
  return {
    ...(makes
      ? { matchCheck: matchCheckFor([...at.dismissed, ...at.sends.dismissed]) }
      : {}),
    siteCheck: siteCheckFor(at.seen, at.sends),
  }
}

/**
 * Whether every job is the person's to be told of, as the server's site
 * check reads it (`jobScope` in convex/lib/capabilities.ts, a scope of the
 * whole business): an owner in their own account, or anyone who "can see
 * everyone's schedule", that grant as a switch intersects it. Working in
 * someone else's account, it is that account's scope, which the phone
 * knows only through the grant: so an owner in a technician's account sees
 * no more than the technician, and someone in the owner's account is taken
 * to see no more than their own grant does (the safe side: the "Not
 * checked" rows stay).
 */
export function seesWholeSchedule(
  access: Pick<Access, 'role' | 'caps' | 'actingAs'>,
): boolean {
  return (
    access.caps['schedules.seeOthers'] ||
    (access.role === 'owner' && access.actingAs === null)
  )
}

// ── A press of Save with its checks ───────────────────────────────────────

/**
 * A count of the rest a refusal names ("And 2 more": `match:more`,
 * `site:more`, `site:more:series`): its words can't tell one set of the
 * rest from another, so it is already listed only by what it counts
 * (`counts`, `alreadyListed`), never by its words.
 */
export function countsTheRest(id: string): boolean {
  return (
    id === MATCH_MORE_ID || id === SITE_MORE_ID || id === SITE_MORE_SERIES_ID
  )
}

/** A refusal's rows, as the form shows them, and the check they are of. */
export type RefusedRows<TRow extends { id: string }> = {
  source: string
  rows: ReadonlyArray<TRow>
}

/** A row as `sendChecked` compares it with what is listed: a count of the
 * rest with the ids of the rows it counts (`counts`). */
type Listed = {
  id: string
  message: string
  source?: string
  counts?: ReadonlyArray<string>
}

/**
 * Whether a refusal's row says only what the panel already listed: a row
 * of the same check (`source`) and id, in the same words, as
 * `warningsSignature` compares them. Not by its id alone: the phone's
 * "12 Watle St looks like Jane Nguyen’s 12 Wattle St" and the server's
 * "Jane Nguyen already has 12 Watle St" are one row's id (`match:<id>`,
 * `match:own-site`), and the second is news. A count of the rest ("And 2
 * more", `countsTheRest`) is already said only where every row it counts
 * (`counts`: `site:job:…`, `site:day:…`, `site:series:…`) was listed by the
 * same check, as a row of that id or counted by a count listed: the same
 * work told again (by its other slot after the week turned) is no news,
 * and one row more than was counted is. One that doesn't say what it
 * counts is always new.
 */
export function alreadyListed(
  row: Omit<Listed, 'source'>,
  source: string,
  listed: ReadonlyArray<Listed>,
): boolean {
  const ours = listed.filter(
    (l) => l.source === undefined || l.source === source,
  )
  if (countsTheRest(row.id)) {
    const said = new Set(ours.flatMap((l) => [l.id, ...(l.counts ?? [])]))
    const counts = row.counts ?? []
    return counts.length > 0 && counts.every((id) => said.has(id))
  }
  return ours.some((l) => l.id === row.id && l.message === row.message)
}

/**
 * What a refusal's rows come to (`sendChecked`): those of them the panel
 * shows (`shows`), and whether the refusal is sent again by itself
 * instead (`again`). Only what is new is shown, never a row already listed
 * in the same words, nor a count of the rest counting only what was
 * listed (`alreadyListed`); but a count of the rest ("And 2 more") that is
 * new is never shown alone: "And 2 more" is the rest of rows the panel
 * then shows with it, every one the refusal named.
 */
function refusedShows<TRow extends Omit<Listed, 'source'>>(
  refusal: SheetRefusal,
  { source, rows }: RefusedRows<TRow>,
  listed: ReadonlyArray<Listed>,
  mayAgain: boolean,
): { source: string; shows: ReadonlyArray<TRow>; again: boolean } {
  const fresh = rows.filter((row) => !alreadyListed(row, source, listed))
  return {
    source,
    shows: fresh.some((row) => !countsTheRest(row.id)) ? fresh : rows,
    again:
      refusal.code !== 'MATCHED_CLIENT' &&
      fresh.length === 0 &&
      rows.length > 0 &&
      mayAgain,
  }
}

/**
 * One press of Book (or Save) with the sheet's checks, and what it does with
 * the server's refusal of them (§4.5):
 *
 * - **The rows.** A refusal of the three is shown as rows of the panel
 *   (`inject`), with what it names sent back as seen by the press after it
 *   (`sends`, kept with the rows), and what an earlier refusal of this
 *   press sent again by itself named, where that was of the same check:
 *   kept with rows of another check, it would go back with them after an
 *   edit of the day or the repeat had taken that check's own rows off, as
 *   seen at a date it was never shown for. Only what is new: a row already
 *   listed in the same words (shown and booked past by this press, the
 *   phone's or a refusal's), or a count of the rest ("And 2 more",
 *   `countsTheRest`) counting only rows listed, is not said again
 *   (`alreadyListed`); a count that is new is never said alone: with
 *   nothing else new, the rows it is the rest of are said again with it.
 *   And the error is thrown, so the press ends as a refusal does: nothing
 *   was made.
 * - **Nothing new.** A refusal of the site's work naming only what the
 *   person has already booked past, in the words they were shown (a visit
 *   of someone else's told by its other slot after the week turned, "For
 *   M5, M7 and 2c-J from M6b"; or moved by the office on the same day,
 *   shown again by its `at` alone, "Found while building M6") is sent
 *   again at once, with it, under the same request id (New Job's, straight,
 *   and not once the sheet is discarded: `BookingSession.book`), with what
 *   the send refused carried and nothing read afresh (`pressChecks`): never
 *   a loop of the same rows. Once, and only while the form is as it was at
 *   the press (`asPressed`): refused a second time with nothing new, or the
 *   form edited meanwhile, the rows are shown after all (or FormAlert says
 *   it, for a check edited), for the person to decide.
 *   Never MATCHED_CLIENT: the server names only clients not in
 *   `dismissed`, so a client it names is never one booked past, whatever
 *   its row says (the phone's row was of a site only like theirs; the
 *   server's is of the same address exactly), and is always shown.
 * - **Anything else** is thrown as it came.
 *
 * `send` is one call of the save, given what earlier refusals of this press
 * named (`extra`), and whether it is that send again (`again`: New Job's
 * goes straight, as the one refused did); `rowsOf` the rows for a refusal,
 * as the form reads them now; `hold` the wait for what their fixes need
 * (`createHoldWait`, up to 3 s), asked only where rows will be shown: a
 * refusal sent again by itself shows nothing, nor do rows the panel would
 * turn down (none read for the form as it is now, or `mayShow` false), so
 * those wait for nothing, and FormAlert says it at once; and given
 * `turnedDown`, whether the panel would turn them down now, for the wait
 * to end on as soon as it does (the check edited while it runs: the rows
 * are for nothing then, so the button needn't say a save is going on for
 * the rest of the 3 s); the rows are read again once it answers; `listed`
 * the rows shown and confirmed now
 * (`SaveWarningsController.listedNow`); `mayShow` whether the panel would
 * take rows of a check now (`SaveWarningsController.mayInject`; omitted,
 * it always would); `asPressed` whether the form is as it was at the press
 * (`SaveWarningsController.asPressed`; omitted, it always is).
 */
export async function sendChecked<T, TRow extends Omit<Listed, 'source'>>(at: {
  send: (extra: SheetSends, again: boolean) => Promise<T>
  rowsOf: (
    refusal: SheetRefusal,
  ) => RefusedRows<TRow> | Promise<RefusedRows<TRow>>
  hold?: (refusal: SheetRefusal, turnedDown: () => boolean) => Promise<unknown>
  listed: () => ReadonlyArray<Listed>
  inject: (
    source: string,
    rows: ReadonlyArray<TRow>,
    sends: SheetSends,
    error: unknown,
  ) => void
  mayShow?: (source: string) => boolean
  asPressed?: () => boolean
}): Promise<T> {
  let extra = NOTHING_SENT
  // The check whose rows the refusal sent again by itself was of: what it
  // named is kept with rows of that check alone.
  let extraOf: string | null = null
  let sentAgain = false
  for (;;) {
    try {
      return await at.send(extra, sentAgain)
    } catch (error) {
      const refusal = sheetRefusalOf(error)
      if (!refusal) throw error
      const read = async () =>
        refusedShows(
          refusal,
          await at.rowsOf(refusal),
          at.listed(),
          !sentAgain && (at.asPressed?.() ?? true),
        )
      let rows = await read()
      // Only for rows the panel will take: with none, or rows it turns
      // down, FormAlert says it at once; and only while it would.
      const source = rows.source
      const takes = () => at.mayShow?.(source) ?? true
      if (!rows.again && at.hold && rows.shows.length > 0 && takes()) {
        await at.hold(refusal, () => !takes())
        rows = await read()
      }
      const own = sendsOf(refusal)
      if (rows.again) {
        sentAgain = true
        extra = joinSends(extra, own)
        extraOf = rows.source
        continue
      }
      at.inject(
        rows.source,
        rows.shows,
        extraOf === rows.source ? joinSends(extra, own) : joinSends(own),
        error,
      )
      throw error
    }
  }
}

/**
 * A wait for the live client list (or a client's sites) to hold what a
 * refusal's fix books at (or for the panel to turn its rows down, which
 * the forms ask too: `sendChecked`'s `turnedDown`): `until(holds)` answers
 * true as soon as it does, asked again each time `poke` says what it reads
 * may have changed (the forms poke on every commit: an answer pushed, an
 * edit), or what it holds after `ms`.
 */
export function createHoldWait() {
  const waiting = new Set<() => void>()
  return {
    until(holds: () => boolean, ms: number = HOLD_WAIT_MS): Promise<boolean> {
      if (holds()) return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        const done = (held: boolean) => {
          clearTimeout(timer)
          waiting.delete(check)
          resolve(held)
        }
        const check = () => {
          if (holds()) done(true)
        }
        const timer = setTimeout(() => done(holds()), ms)
        waiting.add(check)
      })
    },
    poke(): void {
      for (const check of [...waiting]) check()
    },
  }
}

export type HoldWait = ReturnType<typeof createHoldWait>
