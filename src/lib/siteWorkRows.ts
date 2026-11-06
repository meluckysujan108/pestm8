import { addDaysToKey, dayKeyOf } from '../../convex/lib/dates'
import { addressNear, siteKey, streetKey } from '../../convex/lib/contactKeys'
import { splitJobTypes } from '../../convex/lib/jobTypes'
import {
  HORIZON_DAYS,
  describeInterval,
  firstVisitAt,
} from '../../convex/lib/recurrence'
import {
  isOpenStatus,
  openNear,
  openWorkCovers,
  openWorkDays,
  SITE_WINDOW_DAYS,
} from '../../convex/lib/siteWork'
import { formatJobDate, formatTime, formatUpdated } from './format'
import { possessive, tagSentence } from './clientMatchRows'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import type {
  MatchClient,
  MatchIndex,
  MatchSite,
} from '../../convex/lib/clientMatch'
import type { Interval } from '../../convex/lib/recurrence'
import type { MatchFix } from './clientMatchRows'

/**
 * Is this site already booked? New Job's check at Book (the matching plan's
 * M5, §3): what is booked at each site (`jobs.openWork`, kept on the phone),
 * read in every client mode, with signal or without, before the booking
 * goes. Pure, so the form and its tests decide the same.
 *
 * What counts is convex/lib/siteWork.ts's, the rule the server's own check
 * keeps (`openNear`: open work within a week either side, by the business's
 * calendar, nearest first). The booking's date is a one-off's, or a
 * series' first visit (`firstVisitAt`, as `recurrences.create` checks it),
 * never the anchor of one started weeks ago.
 *
 * What it says of work outside the person's own (C5) is a date and nothing
 * more: no job number, service, person, time or client, and nothing to
 * open; at an address typed, only Book at that site, which is one the
 * person may book at and names the address alone. In New site for, Book at
 * only ever books at the chosen client's own site (`bookFor`): another
 * client's at the address is said, but booking there would take the
 * booking off the client chosen. What it shows is
 * what Book anyway books past (`seenOf`, `seenSeriesOf`), which the online
 * sheet sends with the booking (`siteCheck`, the plan's M7), for the server
 * to check again with what is booked now; what it finds that the phone
 * didn't hold comes back as rows of their own (`refusedSiteRows`).
 *
 * The words keep the app's: names, never pronouns; curly apostrophes and
 * spaced em dashes.
 */

/** What `jobs.openWork` answers. */
export type OpenWork = FunctionReturnType<typeof api.jobs.openWork>
export type OpenWorkRow = OpenWork['rows'][number]
export type OpenWorkSeries = OpenWork['series'][number]

/** A job or visit the person may see, with its number, services and lead. */
export type TheirRow = Extract<OpenWorkRow, { jobId: Id<'jobs'> }>

/** Whether a row is the person's to see (C5): it comes with its id. */
export function inScope(row: OpenWorkRow): row is TheirRow {
  return 'jobId' in row
}

/** The Recurring Job a row is a visit of, if it is one. */
export function seriesOfRow(row: OpenWorkRow): Id<'recurrences'> | undefined {
  return inScope(row) ? row.recurrenceId : row.series
}

// ── Seen ─────────────────────────────────────────────────────────────────

/**
 * A job or visit the person was shown, as the server takes it back (§3.4):
 * the site and the slot as `openWork` sent it (`at`), and for one in their
 * scope its id too, so a one-off the office moves is still the one seen.
 */
export type SeenPair = {
  propertyId: Id<'properties'>
  at: number
  jobId?: Id<'jobs'>
}

/** Everything shown and booked past: jobs and visits, and Recurring Jobs. */
export type Seen = {
  pairs: ReadonlyArray<SeenPair>
  series: ReadonlyArray<Id<'recurrences'>>
}

export const NOTHING_SEEN: Seen = { pairs: [], series: [] }

/** What a row of the panel shows, for what is seen once it is booked past. */
export type Shows = {
  rows: ReadonlyArray<OpenWorkRow>
  series: ReadonlyArray<Id<'recurrences'>>
}

/** A row as `seen` holds it: its `at` as sent, and its id in scope only. */
export function pairOf(row: OpenWorkRow): SeenPair {
  return inScope(row)
    ? { propertyId: row.propertyId, at: row.at, jobId: row.jobId }
    : { propertyId: row.propertyId, at: row.at }
}

/** Whether a row has been seen: by its pair, by its id, or by its series. */
export function isSeen(row: OpenWorkRow, seen: Seen): boolean {
  const series = seriesOfRow(row)
  if (series !== undefined && seen.series.includes(series)) return true
  return seen.pairs.some(
    (pair) =>
      (pair.propertyId === row.propertyId && pair.at === row.at) ||
      (inScope(row) && pair.jobId === row.jobId),
  )
}

/** `seen` pairs for every job or visit `shown` names (§3.4). */
export function seenOf(
  shown: ReadonlyArray<{ shows: Shows }>,
): Array<SeenPair> {
  const out: Array<SeenPair> = []
  for (const { shows } of shown) {
    for (const row of shows.rows) {
      const pair = pairOf(row)
      if (
        !out.some(
          (p) =>
            p.propertyId === pair.propertyId &&
            p.at === pair.at &&
            p.jobId === pair.jobId,
        )
      ) {
        out.push(pair)
      }
    }
  }
  return out
}

/** `seenSeries` for every Recurring Job `shown` names, as a series or
 * through one of its visits (§3.4): any later visit of it is seen too. */
export function seenSeriesOf(
  shown: ReadonlyArray<{ shows: Shows }>,
): Array<Id<'recurrences'>> {
  const out = new Set<Id<'recurrences'>>()
  for (const { shows } of shown) {
    for (const id of shows.series) out.add(id)
    for (const row of shows.rows) {
      const series = seriesOfRow(row)
      if (series !== undefined) out.add(series)
    }
  }
  return [...out]
}

/** `seen` with what `shows` names added: what a fix that named it booked
 * past (FW13), so the press after it isn't asked about it again. */
export function withSeen(seen: Seen, shows: Shows): Seen {
  const one = [{ shows }]
  const pairs = [...seen.pairs]
  for (const pair of seenOf(one)) {
    if (
      !pairs.some(
        (p) =>
          p.propertyId === pair.propertyId &&
          p.at === pair.at &&
          p.jobId === pair.jobId,
      )
    ) {
      pairs.push(pair)
    }
  }
  const series = [...new Set([...seen.series, ...seenSeriesOf(one)])]
  return pairs.length === seen.pairs.length &&
    series.length === seen.series.length
    ? seen
    : { pairs, series }
}

// ── Which answer, and which date ───────────────────────────────────────────

/** An answer the phone holds, by the week it was asked for. */
export type HeldOpenWork = { startKey: string; work: OpenWork }

/** Whether the days of the answer asked for with `startKey` reach into the
 * week either side of `dayKey` (SITE_WINDOW_DAYS, inclusive). */
function reachesWeekOf(startKey: string, dayKey: string): boolean {
  const { firstKey, endKey } = openWorkDays(startKey)
  return (
    addDaysToKey(dayKey, -SITE_WINDOW_DAYS) < endKey &&
    addDaysToKey(dayKey, SITE_WINDOW_DAYS) >= firstKey
  )
}

/**
 * Which answer checks a booking on `dayKey`: the newest held whose days
 * cover it (`openWorkCovers`), so last week's still checks a Monday opened
 * with no signal; failing that, the newest whose days reach into the week
 * either side of it, so a date just past the twenty weeks still has the
 * work the phone holds near it checked (the server names in-window work
 * near a date outside it), and says what it can't check (`uncheckedRows`).
 * `none`: the phone holds none at all, which the panel says. `past`: none
 * reaches within a week of the date, so nothing near it can be checked
 * here, which the panel says too; a Recurring Job running at the site is
 * still checked, from the newest (`bookingWork`), as that is so whatever
 * the dates.
 */
export function pickOpenWork<T extends HeldOpenWork>(
  held: ReadonlyArray<T>,
  dayKey: string,
): { kind: 'none' } | { kind: 'past' } | { kind: 'answer'; answer: T } {
  if (held.length === 0) return { kind: 'none' }
  const newest = [...held].sort((a, b) => (a.startKey < b.startKey ? 1 : -1))
  const answer =
    newest.find((h) => openWorkCovers(h.startKey, dayKey)) ??
    newest.find((h) => reachesWeekOf(h.startKey, dayKey))
  return answer ? { kind: 'answer', answer } : { kind: 'past' }
}

/**
 * When the booking is, for the check: a one-off when it is booked; a series
 * at its first visit, its anchor or, for one started more than a day ago,
 * the first visit the engine projects (`firstVisitAt`), as the server
 * checks it.
 */
export function bookingAt(
  booking: { scheduledAt: number; repeat: Interval | null },
  timezone: string,
  now: number,
): number {
  return booking.repeat
    ? firstVisitAt(
        { anchorDate: booking.scheduledAt, ...booking.repeat },
        timezone,
        now,
      )
    : booking.scheduledAt
}

// ── Where ─────────────────────────────────────────────────────────────────

/** A site to check, and how the booking came to it. */
export type SiteTarget = {
  site: Pick<
    MatchSite,
    '_id' | 'clientId' | 'addressLine' | 'suburb' | 'postcode'
  >
  /**
   * `chosen`: the site the booking is at (existing mode). `address`: any
   * client's site at the address typed. `street`: the same street in the
   * same postcode, another suburb. `near`: one like it ("12 Watle St"), of
   * a client the booking is for or the caller may be.
   */
  how: 'chosen' | 'address' | 'street' | 'near'
}

/** An address as typed in New client or New site for. */
export type TypedSite = {
  addressLine: string
  suburb: string
  postcode: string
}

/**
 * The sites a booking is checked at (§3.2, FW2). Existing mode: the site
 * chosen. New client and New site for: every site at the typed address,
 * whoever's it is; then, worded as such, those on the same street in the
 * same postcode, and those only like it of `clients` (the client a new
 * site is for, or the clients the caller may be).
 */
export function siteTargets(
  index: MatchIndex,
  at:
    | { mode: 'existing'; site: SiteTarget['site'] | null }
    | {
        mode: 'new' | 'site'
        typed: TypedSite
        clients: ReadonlyArray<Id<'clients'>>
      },
): Array<SiteTarget> {
  if (at.mode === 'existing') {
    return at.site ? [{ site: at.site, how: 'chosen' }] : []
  }
  if (at.typed.addressLine.trim() === '') return []
  const key = siteKey(at.typed)
  const out: Array<SiteTarget> = []
  const add = (site: SiteTarget['site'], how: SiteTarget['how']) => {
    if (!out.some((t) => t.site._id === site._id)) out.push({ site, how })
  }
  for (const site of index.sites.get(key) ?? []) add(site, 'address')
  for (const site of index.streets.get(streetKey(at.typed)) ?? []) {
    if (index.siteKeys.get(site._id) !== key) add(site, 'street')
  }
  for (const clientId of at.clients) {
    for (const site of index.sitesOf.get(clientId) ?? []) {
      if (index.siteKeys.get(site._id) === key) continue
      if (addressNear(at.typed, site)) add(site, 'near')
    }
  }
  return out
}

// ── The rows ──────────────────────────────────────────────────────────────

/** What a row's fix does: opens a job's sheet, or books at a site. */
export type SiteFix =
  | { kind: 'openJob'; label: string; jobId: Id<'jobs'>; dayKey: string }
  | Extract<MatchFix, { kind: 'bookAt' }>

/** One row of the panel at Book, of the panel's last kind (`site`). */
export type SiteRow = {
  /**
   * Stable for the same work, so a second press with the same rows books,
   * and one row's own: a job of the person's by its id; someone else's by
   * its slot, which the server takes back as one (`seen`); a Recurring Job
   * by its id; what couldn't be checked by which part.
   */
  id: string
  /** `Not checked`: what the check couldn't read (`uncheckedRows`).
   * `And 2 more`: the rest past SITE_ROWS_MAX, counted (`restRow`). */
  label: 'Already booked' | 'Already repeats' | 'Not checked' | AndMore
  message: string
  fix?: SiteFix
  fix2?: SiteFix
  shows: Shows
  /** The site the row is about; null for what couldn't be checked. */
  propertyId: Id<'properties'> | null
  /** `And 2 more`: the ids of the rows it counts, so a refusal telling
   * only those again says nothing new (`SaveWarning['counts']`). */
  counts?: ReadonlyArray<string>
  /** `And 3 more` about several sites (`propertyId` null): what it counts
   * at each, so a match row's fix books past what it counts at the site
   * it books at (`showsAt`). */
  bySite?: ReadonlyArray<{ propertyId: Id<'properties'>; shows: Shows }>
}

/** At most this many rows, nearest first (§3.2), then the rest counted in
 * one row of its own ("And 2 more", `restRow`). */
export const SITE_ROWS_MAX = 2

/** "And 2 more". */
export type AndMore = `And ${number} more`

/** The ids of the rows counting the rest, the phone's and a refusal's
 * alike: of jobs and visits (`SITE_MORE_ID`, with any Recurring Jobs past
 * the rows), and of a refusal's Recurring Jobs alone. */
export const SITE_MORE_ID = 'site:more'
export const SITE_MORE_SERIES_ID = 'site:more:series'

/**
 * What a row counting the rest says (`restRow`, `refusedSiteRows`): how many
 * more jobs or visits within the week, and Recurring Jobs, at the site (or
 * sites) checked, or at the one site named (`site`, "12 Wattle St,
 * Maylands"). Someone else's several on one day count as one, as their row
 * would have been (C5): their number is no more the person's here than in
 * a row of its own.
 */
export function restMessage(at: {
  near: number
  series: number
  sites: number
  site?: string
}): string {
  const here = at.site ?? (at.sites > 1 ? 'these sites' : 'this site')
  const near =
    at.near === 1 ? 'another job or visit' : `${at.near} other jobs or visits`
  const series =
    at.series === 1
      ? 'another Recurring Job'
      : `${at.series} other Recurring Jobs`
  if (at.series === 0) {
    return `${near.charAt(0).toUpperCase()}${near.slice(1)} ${
      at.near === 1 ? 'is' : 'are'
    } booked at ${here} within a week of this one.`
  }
  if (at.near === 0) {
    return `${series.charAt(0).toUpperCase()}${series.slice(1)} ${
      at.series === 1 ? 'runs' : 'run'
    } at ${here}.`
  }
  const has =
    at.site !== undefined
      ? `${at.site} also has`
      : at.sites > 1
        ? 'These sites also have'
        : 'This site also has'
  return `${has} ${series} and ${near} within a week of this one.`
}

/**
 * The rows past SITE_ROWS_MAX, as one row that counts them: "And 2 more —
 * 2 other jobs or visits are booked at this site within a week of this
 * one." With no fix; it shows every one of them, so Book anyway and Book
 * at book past them all, as the server takes them back (`siteCheck`'s
 * `seen`), the way "And 2 more" of the clients the caller may be is
 * dismissed with them (FW17d), and a match row's fix those at the site it
 * books at (`bySite`, where they are at several). Without it, the server
 * would name them as found when saving, though the phone held them all
 * along.
 *
 * "This site" only where every row, those above (`above`) and those it
 * counts, is about one site: read under rows about the address typed, it
 * would mean that one. Those counted all at another, its address
 * (`siteText`: "12 Wattle St, Maylands", the same street in the same
 * postcode); at several, "these sites".
 */
function restRow(
  cut: ReadonlyArray<SiteRow>,
  above: ReadonlyArray<SiteRow>,
  siteText: (propertyId: Id<'properties'>) => string | undefined,
): SiteRow {
  const series = cut.filter((row) => row.label === 'Already repeats').length
  const near = cut.length - series
  const sites = [...new Set(cut.map((row) => row.propertyId))]
  const one = sites.length === 1 ? sites[0] : null
  const alone = one !== null && above.every((row) => row.propertyId === one)
  const site = one !== null && !alone ? siteText(one) : undefined
  return {
    id: SITE_MORE_ID,
    label: `And ${cut.length} more`,
    message: restMessage({
      near,
      series,
      sites: alone ? 1 : Math.max(sites.length, 2),
      ...(site !== undefined ? { site } : {}),
    }),
    shows: {
      rows: cut.flatMap((row) => row.shows.rows),
      series: cut.flatMap((row) => row.shows.series),
    },
    propertyId: one,
    counts: cut.map((row) => row.id),
    ...(one === null
      ? {
          bySite: cut.flatMap(({ propertyId, shows }) =>
            propertyId === null ? [] : [{ propertyId, shows }],
          ),
        }
      : {}),
  }
}

/**
 * What `rows` show at one site: each row's own where it is about that
 * site, and of an "And 3 more" about several (`bySite`), what it counts
 * there. What a match row's fix books past at the site it books at
 * (`bookingWork`'s `fixSees`, `refusedMatchSees`), the counted rest with
 * the rows above; work at another site stays to be told of.
 */
function showsAt(
  rows: ReadonlyArray<Pick<SiteRow, 'propertyId' | 'shows' | 'bySite'>>,
  propertyId: Id<'properties'>,
): Array<{ shows: Shows }> {
  return rows
    .flatMap((row): ReadonlyArray<Pick<SiteRow, 'propertyId' | 'shows'>> =>
      row.propertyId === null ? (row.bySite ?? []) : [row],
    )
    .filter((row) => row.propertyId === propertyId)
}

/** At most SITE_ROWS_MAX rows, and the rest counted in one more. */
function capped(
  rows: ReadonlyArray<SiteRow>,
  check: Pick<SiteCheck, 'targets'>,
): Array<SiteRow> {
  if (rows.length <= SITE_ROWS_MAX) return [...rows]
  const siteText = (propertyId: Id<'properties'>) => {
    const target = check.targets.find((t) => t.site._id === propertyId)
    return target && `${target.site.addressLine}, ${target.site.suburb}`
  }
  const above = rows.slice(0, SITE_ROWS_MAX)
  return [...above, restRow(rows.slice(SITE_ROWS_MAX), above, siteText)]
}

/** What the check reads. */
export type SiteCheck = {
  work: OpenWork
  timezone: string
  /** Today in the business's zone: whether a date needs its year. */
  today: string
  /** The booking's date (`bookingAt`). */
  at: number
  /** The booking is a Recurring Job: a running one at the site is a row. */
  repeats: boolean
  targets: ReadonlyArray<SiteTarget>
  /** Shown already, and booked past or named by a match row. */
  seen: Seen
  /** Whose each site is, for a row in the person's scope. */
  index: Pick<MatchIndex, 'clients'>
  /** Who each job is for, by membership, as New Job names them. */
  people: ReadonlyMap<string, string>
  /** The address as typed, for a site only like it. */
  typedAddress: string
  /**
   * New site for: the client the booking is for, whose own sites alone a
   * row books at (null while none is chosen). Another client's site at the
   * address is said, with its date and Open #123 for the person's own
   * work, but never offered as Book at: that would take the booking off
   * the client chosen, and its label names only the address (in New site
   * for, another client holding the address is no match row either).
   * Undefined in New client and at a site chosen.
   */
  bookFor?: Id<'clients'> | null
}

function dateOf(at: number, check: Pick<SiteCheck, 'timezone' | 'today'>) {
  return formatJobDate(dayKeyOf(at, check.timezone), check.today)
}

/** "a and b", "a, b and c". */
function joinAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** What a sentence about a target's work starts with, before its verb. */
function subjectOf(target: SiteTarget, mine: boolean, check: SiteCheck) {
  const { site } = target
  const client = check.index.clients.get(site.clientId)
  const text = `${site.addressLine}, ${site.suburb}`
  switch (target.how) {
    case 'chosen':
      return site.addressLine
    case 'address':
      return mine ? `${text} (${possessive(client)})` : text
    case 'street':
      return `${mine ? possessive(client, site.addressLine) : site.addressLine} in ${site.suburb}, the same postcode,`
    case 'near':
      return `${check.typedAddress} looks like ${mine ? possessive(client, text) : text}, which`
  }
}

/**
 * " Amy Lo is inactive.", after a row that names an archived or inactive
 * client only by a possessive (`subjectOf`, the person's own work at an
 * address typed): as the match rows say it (`tagSentence`), so one tap
 * never books onto such a client's site with no sign of it. '' where no
 * client is named.
 */
function tagOf(target: SiteTarget, mine: boolean, check: SiteCheck): string {
  if (!mine || target.how === 'chosen') return ''
  return tagSentence(check.index.clients.get(target.site.clientId))
}

/** Whether a row about `target` may book at its site (`bookFor`). */
function bookable(target: SiteTarget, check: SiteCheck): boolean {
  return (
    target.how !== 'chosen' &&
    (check.bookFor === undefined || check.bookFor === target.site.clientId)
  )
}

/** The fix that opens a row's job, in the person's scope. */
function openFix(
  row: TheirRow,
  timezone: string,
): Extract<SiteFix, { kind: 'openJob' }> {
  return {
    kind: 'openJob',
    label:
      row.recurrenceId !== undefined
        ? 'Open the visit'
        : row.jobNumber !== undefined
          ? `Open #${row.jobNumber}`
          : 'Open the job',
    jobId: row.jobId,
    dayKey: dayKeyOf(row.scheduledAt, timezone),
  }
}

/**
 * Book at the target's site. On the same street in the same postcode, it is
 * another suburb's, known by no name (a suggestion only): its label names
 * the suburb, as the match rows' does ("Book at 12 Wattle St, Maylands"),
 * so it never reads as the address typed.
 */
function bookAtFix(target: SiteTarget): SiteFix {
  const { site } = target
  return {
    kind: 'bookAt',
    label:
      target.how === 'street'
        ? `Book at ${site.addressLine}, ${site.suburb}`
        : `Book at ${site.addressLine}`,
    clientId: target.site.clientId,
    propertyId: target.site._id,
  }
}

/** A job's services, as a sentence says them: "General Pest Control and
 * Termite Inspection" (stored joined by commas, convex/lib/jobTypes.ts). */
function servicesOf(jobType: string | undefined): string {
  return joinAnd(splitJobTypes(jobType))
}

/**
 * "Already booked" for one job or visit (§3.2's table); or for someone
 * else's several on one day at a site, one row: its words are the date
 * alone, so two would read the same, and their number is no more the
 * person's than the rest (C5). It books past every one (`seen` takes each
 * slot back). At an address typed, Book at the site there, whoever's work
 * it is: the site is one the person may book at, and its label names only
 * the address; Open only for work of the person's own. In New site for,
 * Book at only at the chosen client's own site (`bookFor`).
 */
function bookedRow(
  target: SiteTarget,
  rows: ReadonlyArray<OpenWorkRow>,
  check: SiteCheck,
): SiteRow {
  const row = rows[0]
  const date = dateOf(row.scheduledAt, check)
  const mine = inScope(row)
  const subject = subjectOf(target, mine, check)
  const shows: Shows = { rows, series: [] }
  const propertyId = target.site._id
  const id = mine
    ? `site:job:${row.jobId}`
    : `site:day:${row.propertyId}:${dayKeyOf(row.scheduledAt, check.timezone)}`
  const bookHere = bookable(target, check)
  if (!mine) {
    return {
      id,
      label: 'Already booked',
      message: `${subject} has another job booked on ${date}.`,
      ...(bookHere ? { fix: bookAtFix(target) } : {}),
      shows,
      propertyId,
    }
  }
  const visit = row.recurrenceId !== undefined
  const person = check.people.get(row.assignedMembershipId)
  let message: string
  if (target.how !== 'chosen') {
    message = `${subject} has ${visit ? 'a Recurring Job visit' : 'a job'} on ${date}.${tagOf(target, mine, check)}`
  } else if (visit) {
    message = `${subject} has a Recurring Job visit on ${date}${person ? ` — ${person}` : ''}.`
  } else {
    // The services as one, then who: the person is never read as one more
    // service.
    const details = [servicesOf(row.jobType), person ?? ''].filter(
      (s) => s !== '',
    )
    const number = row.jobNumber !== undefined ? ` (#${row.jobNumber})` : ''
    const tail =
      details.length > 0 ? ` — ${details.join(', ')}${number}` : number
    message = `${subject} has a job on ${date} at ${formatTime(row.scheduledAt, check.timezone)}${tail}.`
  }
  const open = openFix(row, check.timezone)
  return !bookHere
    ? { id, label: 'Already booked', message, fix: open, shows, propertyId }
    : {
        id,
        label: 'Already booked',
        message,
        fix: bookAtFix(target),
        fix2: open,
        shows,
        propertyId,
      }
}

/** The next visit of `series` still open from today, as the phone holds it. */
function nextVisit(
  series: OpenWorkSeries,
  check: SiteCheck,
): OpenWorkRow | undefined {
  return check.work.rows
    .filter(
      (row) =>
        seriesOfRow(row) === series._id &&
        (!inScope(row) || isOpenStatus(row.status)) &&
        dayKeyOf(row.scheduledAt, check.timezone) >= check.today,
    )
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .at(0)
}

/** "Already repeats" for a running Recurring Job (§3.3). */
function repeatsRow(
  target: SiteTarget,
  series: OpenWorkSeries,
  check: SiteCheck,
): SiteRow {
  const next = nextVisit(series, check)
  const mine =
    series.intervalCount !== undefined && series.intervalUnit !== undefined
  const subject = subjectOf(target, mine, check)
  const nextText = next ? `, next ${dateOf(next.scheduledAt, check)}` : ''
  const shows: Shows = { rows: [], series: [series._id] }
  const id = `site:series:${series._id}`
  const propertyId = target.site._id
  if (series.intervalCount === undefined || series.intervalUnit === undefined) {
    return {
      id,
      label: 'Already repeats',
      message: `${subject} already has a Recurring Job${nextText}.`,
      shows,
      propertyId,
    }
  }
  const every = describeInterval({
    count: series.intervalCount,
    unit: series.intervalUnit,
  }).toLowerCase()
  const what = [servicesOf(series.jobType), every]
    .filter((s) => s !== '')
    .join(' ')
  const visit = next && inScope(next) ? next : undefined
  return {
    id,
    label: 'Already repeats',
    message: `${subject} already has a Recurring Job: ${what}${nextText}.${tagOf(target, mine, check)}`,
    ...(visit
      ? {
          fix: {
            ...openFix(visit, check.timezone),
            label: 'Open the Recurring Job',
          },
        }
      : {}),
    shows,
    propertyId,
  }
}

/**
 * The rows at Book (§3.2, §3.3): for a Recurring Job being booked, every
 * one already running at a site checked, at any distance in time; then
 * open work within a week either side of the booking's date, nearest
 * first, less a visit of a series already shown. At most SITE_ROWS_MAX,
 * then the rest counted ("And 2 more", `restRow`), and nothing already
 * seen.
 *
 * `near: false`: the Recurring Jobs alone, for a date no answer reaches
 * within a week of (`bookingWork`): what runs at a site is so whatever
 * the dates, while the work near the date isn't on the phone.
 */
export function siteWorkRows(
  check: SiteCheck,
  { near: nearToo = true }: { near?: boolean } = {},
): Array<SiteRow> {
  const out: Array<SiteRow> = []
  const shownSeries = new Set<Id<'recurrences'>>()
  if (check.repeats) {
    for (const target of check.targets) {
      for (const series of check.work.series) {
        if (series.propertyId !== target.site._id) continue
        if (check.seen.series.includes(series._id)) continue
        if (shownSeries.has(series._id)) continue
        shownSeries.add(series._id)
        out.push(repeatsRow(target, series, check))
      }
    }
  }
  if (!nearToo) return capped(out, check)
  const near: Array<{ target: SiteTarget; row: OpenWorkRow }> = []
  for (const target of check.targets) {
    const here = check.work.rows.filter(
      (row) => row.propertyId === target.site._id,
    )
    for (const row of openNear(here, check.at, check.timezone)) {
      if (isSeen(row, check.seen)) continue
      const series = seriesOfRow(row)
      if (series !== undefined && shownSeries.has(series)) continue
      near.push({ target, row })
    }
  }
  near.sort(
    (a, b) =>
      Math.abs(a.row.scheduledAt - check.at) -
        Math.abs(b.row.scheduledAt - check.at) ||
      a.row.scheduledAt - b.row.scheduledAt,
  )
  // Someone else's on one day at a site, one row: its words are the date
  // alone (`bookedRow`).
  const dayOf = (row: OpenWorkRow) => dayKeyOf(row.scheduledAt, check.timezone)
  const groups: Array<{ target: SiteTarget; rows: Array<OpenWorkRow> }> = []
  for (const { target, row } of near) {
    const day = inScope(row)
      ? undefined
      : groups.find(
          (g) =>
            !inScope(g.rows[0]) &&
            g.rows[0].propertyId === row.propertyId &&
            dayOf(g.rows[0]) === dayOf(row),
        )
    if (day) day.rows.push(row)
    else groups.push({ target, rows: [row] })
  }
  for (const { target, rows } of groups) {
    out.push(bookedRow(target, rows, check))
  }
  return capped(out, check)
}

/**
 * The foot of the panel when every row is one of these, naming the fix
 * each row offers first: book at the site there (at an address typed,
 * where booking there beats a second site at it), or open what is booked;
 * or book this one too. With only what couldn't be checked, book it.
 */
export function siteFooter(
  rows: ReadonlyArray<{
    label?: SiteRow['label']
    fix?: SiteFix
    fix2?: SiteFix
  }>,
  anyway: string,
): string {
  const rest = `press ${anyway} to book this one as well.`
  if (rows.some((row) => row.fix?.kind === 'bookAt')) {
    return `Book there, or ${rest}`
  }
  const opening = rows.filter((row) => row.fix?.kind === 'openJob')
  if (opening.length > 0) {
    return `Open ${opening.length === 1 ? 'it' : 'one'}, or ${rest}`
  }
  if (rows.length > 0 && rows.every((row) => row.label === NOT_CHECKED)) {
    return `Press ${anyway} to book it.`
  }
  return `Press ${anyway} to book this one as well.`
}

// ── A match row naming its site's work (FW13) ──────────────────────────────

/** The site a match row names, where its fix would book. */
export function namedSiteOf(row: {
  fix?: MatchFix
  fix2?: MatchFix
}): Id<'properties'> | null {
  for (const fix of [row.fix, row.fix2]) {
    if (fix?.kind === 'bookAt') return fix.propertyId
  }
  return null
}

/** The clients match rows name, whose sites only like the address typed
 * are checked too (`siteTargets`). */
export function matchClientsOf(
  rows: ReadonlyArray<{ fix?: MatchFix; fix2?: MatchFix }>,
): Array<Id<'clients'>> {
  const out = new Set<Id<'clients'>>()
  for (const row of rows) {
    for (const fix of [row.fix, row.fix2]) {
      if (fix && 'clientId' in fix) out.add(fix.clientId)
    }
  }
  return [...out]
}

/** "It has a job on Thu 30 Oct (#123).": what a match row adds about the
 * work at the site it names, each thing said once (someone else's two on
 * one day are one date). */
export function workClause(
  rows: ReadonlyArray<OpenWorkRow>,
  at: Pick<SiteCheck, 'timezone' | 'today'>,
): string {
  const phrases = rows.map((row) => {
    const date = dateOf(row.scheduledAt, at)
    if (!inScope(row)) return `another job booked on ${date}`
    if (row.recurrenceId !== undefined) {
      return `a Recurring Job visit on ${date}`
    }
    return `a job on ${date}${row.jobNumber !== undefined ? ` (#${row.jobNumber})` : ''}`
  })
  return `It has ${joinAnd([...new Set(phrases)])}.`
}

/**
 * The match rows (lib/clientMatchRows.ts) with what is booked at the site
 * each names (FW13), within a week of the booking and not seen yet, at most
 * SITE_ROWS_MAX: "12 Wattle St, Bayswater is Jane Nguyen’s. Same name and
 * address. It has a job on Thu 30 Oct (#123)." With what each named, by
 * row id: those are not rows of their own, and its fix marks them seen.
 */
export function matchRowsWithWork<
  T extends { id: string; message: string; fix?: MatchFix; fix2?: MatchFix },
>(
  rows: ReadonlyArray<T>,
  at: Pick<SiteCheck, 'work' | 'timezone' | 'today' | 'at' | 'seen'>,
): { rows: Array<T>; named: ReadonlyMap<string, ReadonlyArray<OpenWorkRow>> } {
  const named = new Map<string, ReadonlyArray<OpenWorkRow>>()
  const out = rows.map((row) => {
    const propertyId = namedSiteOf(row)
    if (propertyId === null) return row
    const here = at.work.rows.filter((r) => r.propertyId === propertyId)
    const near = openNear(here, at.at, at.timezone)
      .filter((r) => !isSeen(r, at.seen))
      .slice(0, SITE_ROWS_MAX)
    if (near.length === 0) return row
    named.set(row.id, near)
    return { ...row, message: `${row.message} ${workClause(near, at)}` }
  })
  return { rows: out, named }
}

// ── What the server found when saving (M7, §4.5) ──────────────────────────

/** What SITE_BOOKED or SITE_REPEATS names (convex/lib/findSame.ts). */
export type RefusedWork =
  | {
      code: 'SITE_BOOKED'
      rows: ReadonlyArray<{
        propertyId: Id<'properties'>
        at: number
        scheduledAt: number
        series?: Id<'recurrences'>
        clientName?: string
        jobId?: Id<'jobs'>
        jobNumber?: number
      }>
      /** By site and slot, and by its id too for the person's own. */
      more?: ReadonlyArray<{
        propertyId: Id<'properties'>
        at: number
        jobId?: Id<'jobs'>
      }>
    }
  | {
      code: 'SITE_REPEATS'
      series: ReadonlyArray<{
        recurrenceId: Id<'recurrences'>
        propertyId: Id<'properties'>
        nextAt?: number
        intervalCount?: number
        intervalUnit?: Interval['unit']
        jobType?: string
      }>
      more?: ReadonlyArray<Id<'recurrences'>>
    }

/** A row of the panel from a refusal: as a site row reads, with no work of
 * the phone's behind it (what it sends back is the refusal's). */
export type RefusedSiteRow = {
  id: string
  label: 'Already booked' | 'Already repeats' | AndMore
  message: string
  fix?: SiteFix
  fix2?: SiteFix
  /** `And 2 more`: the ids of the rows it counts, as a site row's are
   * (`SiteRow['counts']`). */
  counts?: ReadonlyArray<string>
}

/** What the rows are read with. */
export type RefusedSiteContext = {
  timezone: string
  /** Today in the business's zone: whether a date needs its year. */
  today: string
  /** Where the booking is: the site chosen, or the address typed (the
   * server's target is every site at it, exactly). */
  at:
    | { mode: 'existing'; site: { addressLine: string } }
    | {
        mode: 'new' | 'site'
        typed: TypedSite
        /** New site for: the client chosen, the only one Book at books for
         * (`SiteCheck['bookFor']`). */
        bookFor?: Id<'clients'> | null
      }
  /** A site on the live client list, by id: for its address, and for Book
   * at, which the picker needs it to hold. */
  siteOf: (propertyId: Id<'properties'>) => SiteTarget['site'] | undefined
  /** A client on it, by id: whether one named is archived or inactive
   * (`tagSentence`), as the phone's rows say. */
  clientOf?: (clientId: Id<'clients'>) => MatchClient | undefined
}

/**
 * What a refused row is about, before its verb, as the phone's rows say it
 * (`subjectOf`): the site chosen by its street; at an address typed, the
 * site there, from the client list where it holds it, else the address as
 * typed (the server matched it exactly). Whose it is only for the person's
 * own work (`mine`), and only where the server said (`clientName`, a client
 * the person may see) or the list holds them: someone else's is said by its
 * date alone, as the phone's row says it (C5).
 */
function refusedSubject(
  propertyId: Id<'properties'>,
  clientName: string | undefined,
  mine: boolean,
  ctx: RefusedSiteContext,
): string {
  if (ctx.at.mode === 'existing') return ctx.at.site.addressLine
  const site = ctx.siteOf(propertyId)
  const text = site ? `${site.addressLine}, ${site.suburb}` : typedText(ctx.at)
  if (!mine) return text
  const name =
    clientName ?? (site ? ctx.clientOf?.(site.clientId)?.name : undefined)
  return name ? `${text} (${name}’s)` : text
}

/** "12 Wattle St, Bayswater": the address as typed. */
function typedText(at: { typed: TypedSite }): string {
  return [at.typed.addressLine.trim(), at.typed.suburb.trim()]
    .filter((part) => part !== '')
    .join(', ')
}

/**
 * Where a refusal's "And 2 more" says the rest is (`restMessage`), as
 * `restRow` says it: "this site" only where every row above (`above`) and
 * every one it counts (`counted`) is about one site, as they always are at
 * the site chosen (the server checks it alone). At an address typed, the
 * server checks every site at it, exactly, whoever's: those counted all at
 * one site, its address ("12 Wattle St, Bayswater", the same address as
 * the rows above, which may be another client's site there); at several,
 * or where the refusal doesn't say where they are (`counted` null:
 * SITE_REPEATS' `more` is Recurring Jobs by id alone), the address typed,
 * which every one of them is at. Never "this site" for work that may be at
 * another site than the rows above it.
 */
function refusedRestPlace(
  above: ReadonlyArray<Id<'properties'>>,
  counted: ReadonlyArray<Id<'properties'>> | null,
  ctx: RefusedSiteContext,
): { sites: number; site?: string } {
  if (ctx.at.mode === 'existing') return { sites: 1 }
  if (counted !== null && new Set([...above, ...counted]).size <= 1) {
    return { sites: 1 }
  }
  const sites = new Set(counted ?? above)
  const site =
    sites.size === 1
      ? refusedSubject([...sites][0], undefined, false, ctx)
      : typedText(ctx.at)
  return site !== '' ? { sites: sites.size, site } : { sites: 2 }
}

/** " Amy Lo is inactive.", after a refused row of the person's own that
 * names an archived or inactive client by a possessive at an address typed
 * (`tagOf`), so its Book at never books onto such a client's site with no
 * sign of it. '' where no client is named, or the list doesn't hold them. */
function refusedTag(
  propertyId: Id<'properties'>,
  mine: boolean,
  ctx: RefusedSiteContext,
): string {
  if (!mine || ctx.at.mode === 'existing') return ''
  const site = ctx.siteOf(propertyId)
  return site ? tagSentence(ctx.clientOf?.(site.clientId)) : ''
}

/** Book at the site a refused row is about: at an address typed, where the
 * client list holds the site, and only the chosen client's in New site for. */
function refusedBookAt(
  propertyId: Id<'properties'>,
  ctx: RefusedSiteContext,
): SiteFix | undefined {
  if (ctx.at.mode === 'existing') return undefined
  const site = ctx.siteOf(propertyId)
  if (!site) return undefined
  if (ctx.at.bookFor !== undefined && ctx.at.bookFor !== site.clientId) {
    return undefined
  }
  return {
    kind: 'bookAt',
    label: `Book at ${site.addressLine}`,
    clientId: site.clientId,
    propertyId: site._id,
  }
}

/**
 * The rows for SITE_BOOKED and SITE_REPEATS (§4.5), with the phone's own
 * words, from what the server sent: someone else's work by its date alone
 * (C5), one row a day at a site; the person's own with Open #123 (the job's
 * sheet opens by its id); Book at the site at an address typed, where the
 * client list holds it. Then "And 2 more" for the rest the server named
 * (`more`), which Book anyway books past too: each of the person's own is
 * one, and someone else's by the day, as their rows would be, none for a
 * day a row above already says (C5: how many of someone else's there are
 * is no more the person's in a count than in a row). Someone else's entry
 * in `more` is sent by its site and slot alone (`at`), not the time it is
 * booked, so its day is its slot's: for a visit the office moved to
 * another day, the count can be one more or one less than its rows would
 * have been, or fold it into a row above for another day. Only the server
 * sending `scheduledAt` in `more` would make it exact (a backend change);
 * whatever the count says, every entry goes back as seen. "This site" in it
 * only where all of it, and every row above, is about one site; else the
 * address (`refusedRestPlace`). Each row's id is the check's own
 * (`site:job:…`, `site:day:…`, `site:series:…`), so a row the person has
 * already booked past is known as such; and "And 2 more" carries the ids
 * of what it counts (`counts`), so a count of only those is known too.
 */
export function refusedSiteRows(
  refusal: RefusedWork,
  ctx: RefusedSiteContext,
): Array<RefusedSiteRow> {
  const date = (at: number) => dateOf(at, ctx)
  const out: Array<RefusedSiteRow> = []
  const more = refusal.more?.length ?? 0
  if (refusal.code === 'SITE_REPEATS') {
    for (const series of refusal.series) {
      // How often and what only for the person's own, as their row says.
      const mine =
        series.intervalCount !== undefined && series.intervalUnit !== undefined
      const subject = refusedSubject(series.propertyId, undefined, mine, ctx)
      const tag = refusedTag(series.propertyId, mine, ctx)
      const next =
        series.nextAt !== undefined ? `, next ${date(series.nextAt)}` : ''
      const what =
        series.intervalCount !== undefined && series.intervalUnit !== undefined
          ? [
              servicesOf(series.jobType),
              describeInterval({
                count: series.intervalCount,
                unit: series.intervalUnit,
              }).toLowerCase(),
            ]
              .filter((part) => part !== '')
              .join(' ')
          : null
      // No fix: the server names no visit of it to open, and the phone's
      // own row offers no Book at either.
      out.push({
        id: `site:series:${series.recurrenceId}`,
        label: 'Already repeats',
        message:
          what === null
            ? `${subject} already has a Recurring Job${next}.`
            : `${subject} already has a Recurring Job: ${what}${next}.${tag}`,
      })
    }
    if (more > 0) {
      out.push({
        id: SITE_MORE_SERIES_ID,
        label: `And ${more} more`,
        message: restMessage({
          near: 0,
          series: more,
          ...refusedRestPlace(
            refusal.series.map((series) => series.propertyId),
            null,
            ctx,
          ),
        }),
        counts: (refusal.more ?? []).map((id) => `site:series:${id}`),
      })
    }
    return out
  }
  for (const row of refusal.rows) {
    const day = dayKeyOf(row.scheduledAt, ctx.timezone)
    const bookAt = refusedBookAt(row.propertyId, ctx)
    if (row.jobId === undefined) {
      // Someone else's: its date alone, once a day at a site.
      const id = `site:day:${row.propertyId}:${day}`
      if (out.some((r) => r.id === id)) continue
      out.push({
        id,
        label: 'Already booked',
        message: `${refusedSubject(row.propertyId, row.clientName, false, ctx)} has another job booked on ${date(row.scheduledAt)}.`,
        ...(bookAt ? { fix: bookAt } : {}),
      })
      continue
    }
    const subject = refusedSubject(row.propertyId, row.clientName, true, ctx)
    const visit = row.series !== undefined
    const open: SiteFix = {
      kind: 'openJob',
      label: visit
        ? 'Open the visit'
        : row.jobNumber !== undefined
          ? `Open #${row.jobNumber}`
          : 'Open the job',
      jobId: row.jobId,
      dayKey: day,
    }
    const number = row.jobNumber !== undefined ? ` (#${row.jobNumber})` : ''
    // At an address typed, as the phone's row says it: the date, and whose
    // the site is where it is said by a possessive (Open #123 names the
    // job).
    const message =
      ctx.at.mode !== 'existing'
        ? `${subject} has ${visit ? 'a Recurring Job visit' : 'a job'} on ${date(row.scheduledAt)}.${refusedTag(row.propertyId, true, ctx)}`
        : visit
          ? `${subject} has a Recurring Job visit on ${date(row.scheduledAt)}.`
          : `${subject} has a job on ${date(row.scheduledAt)} at ${formatTime(row.scheduledAt, ctx.timezone)}${number}.`
    out.push({
      id: `site:job:${row.jobId}`,
      label: 'Already booked',
      message,
      ...(bookAt ? { fix: bookAt, fix2: open } : { fix: open }),
    })
  }
  // The rest: each of the person's own one, someone else's one a day at a
  // site, and none for a day a row above already says: by its slot's day,
  // as `more` sends nothing else of it (above).
  const said = new Set(out.map((row) => row.id))
  const rest = new Set<string>()
  const sites: Array<Id<'properties'>> = []
  for (const entry of refusal.more ?? []) {
    const key =
      entry.jobId !== undefined
        ? `site:job:${entry.jobId}`
        : `site:day:${entry.propertyId}:${dayKeyOf(entry.at, ctx.timezone)}`
    if (said.has(key) || rest.has(key)) continue
    rest.add(key)
    sites.push(entry.propertyId)
  }
  if (rest.size > 0) {
    out.push({
      id: SITE_MORE_ID,
      label: `And ${rest.size} more`,
      message: restMessage({
        near: rest.size,
        series: 0,
        ...refusedRestPlace(
          refusal.rows.map((row) => row.propertyId),
          sites,
          ctx,
        ),
      }),
      counts: [...rest],
    })
  }
  return out
}

// ── What can't be checked ─────────────────────────────────────────────────

/** "Other bookings at this site can’t be checked on this phone." */
export const SITE_UNCHECKED =
  'Other bookings at this site can’t be checked on this phone.'

/** The label of a row about what the check couldn't read. */
export const NOT_CHECKED = 'Not checked' as const

/**
 * What the check couldn't read, as rows of the panel (§3.2, §1.3): with no
 * answer on the phone at all, or one cut short before the week after the
 * date (or, for a Recurring Job, at all); and where the week either side of
 * the date runs past the days the answer holds, the day it stops, however
 * far past: a date months out is said the same as one a day past the edge,
 * so how far off a booking is never decides whether a press says so. Rows,
 * not a line at the end, so the first press says so even where nothing
 * else does. Each has no fix; the second press books, as with any row.
 *
 * But for a date whose week either side lies wholly past the days held
 * (`serverChecks`, the plan's M7, "Found while building M5"): where the
 * booking goes with the server's own check (`siteCheck`, sent straight,
 * not kept on the phone), the person sees the whole schedule, and every
 * site checked is one the server checks too (the site chosen, or one at
 * the address typed exactly, `bookingWork`), the server names the work on
 * its books near that date there, whoever's, so there is nothing the
 * phone must say it couldn't (§3.2). On its books: a one-off at any date,
 * but a Recurring Job's visits only once made, HORIZON_DAYS ahead (by a
 * daily run, so two days less here, to be sure). So for a one-off whose
 * week after runs past them, kept where a Recurring Job runs at a site
 * checked (`seriesThere`): its visit that week is on nobody's books yet,
 * and only the phone could say so. With none running there, every booking
 * near the date is a one-off, which the server names, so it goes too. Not
 * for a Recurring Job being booked: the server names every one already
 * running there, whatever the dates (SITE_REPEATS), and the one-offs near
 * it.
 * Kept too where the week either side straddles an edge (the phone holds
 * part of it), where no usable answer is held, where a site checked is in
 * the same street or only like the address typed (the server checks exact
 * addresses alone), and for anyone whose book is narrowed (a
 * subcontractor, a contractor's team): someone else's work past the weeks
 * held is named neither by the phone nor by the server (C5), so it is
 * still a date nothing checked.
 *
 * Only where there is a site to check (`targets`): with none (no site
 * chosen, no address typed, or an address no client has), nothing the
 * phone could hold is booked there, and there is nothing to say.
 */
export function uncheckedRows(at: {
  /** `pickOpenWork`'s answer. */
  pick: 'none' | 'past' | 'answer'
  /** The week of the answer read: the one picked, or for `past` the
   * newest held (`bookingWork`). */
  startKey?: string
  /** Its rows were cut short (`capped`). */
  capped?: boolean
  /** When its last row is booked, for a cut answer. */
  lastAt?: number
  /** The booking's day, in the business's zone. */
  dayKey: string
  repeats: boolean
  /** How many sites the booking is checked at (`siteTargets`). */
  targets: number
  timezone: string
  today: string
  /** The server checks every job on its books near a date past the days
   * held: the booking goes with `siteCheck`, and the person sees the whole
   * schedule. */
  serverChecks?: boolean
  /**
   * A Recurring Job runs at a site checked, as the answer read has them
   * (every one running in the business, whoever's: `jobs.openWork`), or it
   * can't be told (the answer cut short). Unsaid, taken to: the safe side.
   */
  seriesThere?: boolean
}): Array<SiteRow> {
  if (at.targets === 0) return []
  const row = (id: string, message: string): SiteRow => ({
    id,
    label: NOT_CHECKED,
    message,
    shows: { rows: [], series: [] },
    propertyId: null,
  })
  if (at.pick === 'none') return [row('site:unchecked', SITE_UNCHECKED)]
  if (at.startKey === undefined) return []
  const from = addDaysToKey(at.dayKey, -SITE_WINDOW_DAYS)
  const to = addDaysToKey(at.dayKey, SITE_WINDOW_DAYS)
  const cutBefore =
    at.capped &&
    (at.repeats ||
      at.lastAt === undefined ||
      dayKeyOf(at.lastAt, at.timezone) <= to)
  if (cutBefore) return [row('site:unchecked', SITE_UNCHECKED)]
  const out: Array<SiteRow> = []
  const { firstKey, endKey } = openWorkDays(at.startKey)
  // Wholly past the days held, either way: the server's to name, but for
  // a one-off's week past the visits made so far (above).
  const madeUntil = addDaysToKey(at.today, HORIZON_DAYS - 2)
  const onBooks =
    at.repeats || to <= madeUntil || (at.seriesThere === false && !at.capped)
  if (at.serverChecks && ((from >= endKey && onBooks) || to < firstKey)) {
    return []
  }
  if (to >= endKey) {
    out.push(
      row(
        'site:unchecked:after',
        `Bookings at this site after ${formatJobDate(addDaysToKey(endKey, -1), at.today)} can’t be checked on this phone.`,
      ),
    )
  }
  if (from < firstKey) {
    out.push(
      row(
        'site:unchecked:before',
        `Bookings at this site before ${formatJobDate(firstKey, at.today)} can’t be checked on this phone.`,
      ),
    )
  }
  return out
}

/**
 * The line at the end of the panel, where what the rows (or a match row's
 * words about its site's work) were read from may be behind: how old it
 * is. A copy that may be behind never claims there is nothing booked. Null
 * where nothing was said of the work, or it is current.
 */
export function siteBehindNote(at: {
  /** Rows or match rows' lines came from it. */
  said: boolean
  /** It may be missing something newer (`mayBeBehind`). */
  behind: boolean
  asOf: number | null
  timezone: string
  today: string
}): string | null {
  if (!at.said || !at.behind) return null
  return at.asOf === null
    ? 'From the jobs on this phone.'
    : `From the jobs on this phone, updated ${formatUpdated(at.asOf, at.timezone, at.today)}.`
}

/** The latest row's time, for a cut answer (`uncheckedRows`). */
export function lastRowAt(work: OpenWork): number | undefined {
  let last: number | undefined
  for (const row of work.rows) {
    if (last === undefined || row.scheduledAt > last) last = row.scheduledAt
  }
  return last
}

// ── Both checks at Book, from one reading ──────────────────────────────────

/** A match row, as far as its site's work goes (lib/clientMatchRows.ts). */
type MatchRowLike = {
  id: string
  message: string
  fix?: MatchFix
  fix2?: MatchFix
}

/** What New Job reads at Book, from what the phone holds. */
export type BookingWork<TMatch, THeld> = {
  pick: 'none' | 'past' | 'answer'
  /** The answer read: the one picked; for a date no answer reaches within
   * a week of, the newest, for the Recurring Jobs running; none held, null. */
  read: THeld | null
  /** The match rows, each naming the work at the site it names (FW13). */
  matchRows: Array<TMatch>
  /** That work, by match row id: not rows of their own. */
  named: ReadonlyMap<string, ReadonlyArray<OpenWorkRow>>
  /**
   * What a match row's fix books past, by row id: the work it named, and
   * every row about the site it books at (an "Already repeats" there, say),
   * which the person read beside it. The press after the fix isn't asked
   * about any of it again.
   */
  fixSees: ReadonlyMap<string, Shows>
  /** The work found at the sites checked (`siteWorkRows`). */
  found: Array<SiteRow>
  /** What couldn't be checked (`uncheckedRows`). */
  unchecked: Array<SiteRow>
}

/**
 * Both checks at Book from one reading of what the phone holds
 * (`useOpenWork`'s answers, `pickOpenWork`): the match rows naming the work
 * at the site each names (FW13), and the site's own rows, less that work,
 * then what couldn't be checked. For a date no answer reaches within a
 * week of, the work near it isn't on the phone and is said not to be; a
 * Recurring Job running at the site still is, from the newest answer, as
 * it runs whatever the dates (§3.3).
 */
export function bookingWork<
  TMatch extends MatchRowLike,
  THeld extends HeldOpenWork,
>(at: {
  held: ReadonlyArray<THeld>
  /** The booking's day in the business's zone (`bookingAt`'s). */
  dayKey: string
  matchRows: ReadonlyArray<TMatch>
  check: Omit<SiteCheck, 'work'>
  /**
   * The "Not checked" rows a fix was taken beside, for this day and repeat,
   * at the sites they were said for (`uncheckedKeysOf`): read already, so
   * the press after the fix books, as it does past the work the fix marked
   * seen. Asked again once the date or repeat moves, as any row is, and
   * wherever the booking is checked at a site they weren't said for:
   * another site picked by hand, another address typed.
   */
  uncheckedSeen?: ReadonlySet<string>
  /** The server checks a date past the days held (`uncheckedRows`): for
   * every site checked here only where each is one it checks too, the site
   * chosen or one at the address typed exactly. Never a site in the same
   * street or only like the address (`street`, `near`): the server's check
   * is of exact addresses (§4.3), so nothing else would check that work. */
  serverChecks?: boolean
}): BookingWork<TMatch, THeld> {
  const { check } = at
  const pick = pickOpenWork(at.held, at.dayKey)
  const read =
    pick.kind === 'answer'
      ? pick.answer
      : ([...at.held]
          .sort((a, b) => (a.startKey < b.startKey ? 1 : -1))
          .at(0) ?? null)
  const unchecked = uncheckedRows({
    pick: pick.kind,
    startKey: read?.startKey,
    capped: read?.work.capped ?? false,
    lastAt: read ? lastRowAt(read.work) : undefined,
    dayKey: at.dayKey,
    repeats: check.repeats,
    targets: check.targets.length,
    timezone: check.timezone,
    today: check.today,
    serverChecks:
      at.serverChecks === true &&
      check.targets.every((t) => t.how === 'chosen' || t.how === 'address'),
    seriesThere:
      read === null ||
      read.work.series.some((series) =>
        check.targets.some((t) => t.site._id === series.propertyId),
      ),
  }).filter((row) => !readAtEvery(at.uncheckedSeen, row, check.targets))
  if (!read) {
    return {
      pick: pick.kind,
      read: null,
      matchRows: [...at.matchRows],
      named: new Map(),
      fixSees: new Map(),
      found: [],
      unchecked,
    }
  }
  const withWork =
    pick.kind === 'answer'
      ? matchRowsWithWork(at.matchRows, {
          work: read.work,
          timezone: check.timezone,
          today: check.today,
          at: check.at,
          seen: check.seen,
        })
      : {
          rows: [...at.matchRows],
          named: new Map<string, ReadonlyArray<OpenWorkRow>>(),
        }
  const found = siteWorkRows(
    {
      ...check,
      work: read.work,
      // What a match row has just said is not a row of its own.
      seen: {
        pairs: [
          ...check.seen.pairs,
          ...[...withWork.named.values()].flat().map(pairOf),
        ],
        series: check.seen.series,
      },
    },
    { near: pick.kind === 'answer' },
  )
  const fixSees = new Map<string, Shows>()
  for (const row of withWork.rows) {
    const propertyId = namedSiteOf(row)
    const named = withWork.named.get(row.id) ?? []
    const there = propertyId === null ? [] : showsAt(found, propertyId)
    if (named.length === 0 && there.length === 0) continue
    fixSees.set(row.id, {
      rows: [...named, ...there.flatMap((r) => r.shows.rows)],
      series: there.flatMap((r) => r.shows.series),
    })
  }
  return {
    pick: pick.kind,
    read,
    matchRows: withWork.rows,
    named: withWork.named,
    fixSees,
    found,
    unchecked,
  }
}

/** `seen` with what every row in `rows` shows added (`withSeen`). */
export function withSeenAll(
  seen: Seen,
  rows: ReadonlyArray<{ shows: Shows }>,
): Seen {
  return rows.reduce((s, row) => withSeen(s, row.shows), seen)
}

/**
 * What a site row's Book at books past (`withSeenAll`): every row of the
 * site's work the panel showed, and the work a match row beside them named
 * at the site it books at (FW13, `bookingWork`'s `named`), which that row
 * says in place of rows of its own. So the press after it isn't asked about
 * any of it again, as after the match row's own fix (`fixSees`). Work a
 * match row named at another site stays to be told of, should the booking
 * go there.
 */
export function bookAtSees(
  propertyId: Id<'properties'>,
  rows: ReadonlyArray<{ shows: Shows }>,
  named: ReadonlyMap<string, ReadonlyArray<OpenWorkRow>>,
): Array<{ shows: Shows }> {
  const there = [...named.values()]
    .flat()
    .filter((row) => row.propertyId === propertyId)
  return there.length === 0
    ? [...rows]
    : [...rows, { shows: { rows: there, series: [] } }]
}

/**
 * What a refused match row's fixes book past (`refusedMatchRows`), as the
 * phone's own match row's do (`bookingWork`'s `fixSees`): at the site the
 * row books at (`namedSiteOf`), every row of that site's work the press
 * refused showed (`shown`; of an "And 3 more" about several sites, what it
 * counts there: `showsAt`), and the work a match row beside them named
 * there in the phone's own words (`named`, `bookAtSees`). The row's own
 * words are the server's and name none of it, but the person was shown it
 * and booked past it at the press refused, so the press after the fix
 * isn't asked about it again ("Book on Jane Nguyen" books, as "Book on Bob
 * Smith" at the same site would have). Work at another site stays to be
 * told of; nothing where the row books at no site.
 */
export function refusedMatchSees(
  row: { fix?: MatchFix; fix2?: MatchFix },
  shown: ReadonlyArray<Pick<SiteRow, 'propertyId' | 'shows' | 'bySite'>>,
  named: ReadonlyMap<string, ReadonlyArray<OpenWorkRow>>,
): Shows | undefined {
  const propertyId = namedSiteOf(row)
  if (propertyId === null) return undefined
  const there = bookAtSees(propertyId, showsAt(shown, propertyId), named)
  if (there.length === 0) return undefined
  return {
    rows: there.flatMap((r) => r.shows.rows),
    series: there.flatMap((r) => r.shows.series),
  }
}

/**
 * A "Not checked" row as `uncheckedSeen` holds it: by what it said, and a
 * site it was said for. Its words are the same at every site ("Other
 * bookings at this site…"), so read for one site it says nothing of
 * another's.
 */
export function uncheckedKey(
  row: Pick<SiteRow, 'id' | 'message'>,
  siteId: string,
): string {
  return `${siteId}\n${row.id}\n${row.message}`
}

/**
 * The "Not checked" rows among `rows`, by `uncheckedKey`, at each of the
 * sites they were said for (`targets`, the booking's then): those a fix was
 * taken beside, which the press after it doesn't say again while the
 * booking is checked only at those sites (`bookingWork`'s `uncheckedSeen`).
 */
export function uncheckedKeysOf(
  rows: ReadonlyArray<Pick<SiteRow, 'id' | 'message' | 'label'>>,
  targets: ReadonlyArray<SiteTarget>,
): Array<string> {
  return rows
    .filter((row) => row.label === NOT_CHECKED)
    .flatMap((row) => targets.map((t) => uncheckedKey(row, t.site._id)))
}

/** Whether a "Not checked" row was read at every site the booking is
 * checked at now (`uncheckedKeysOf`). */
function readAtEvery(
  read: ReadonlySet<string> | undefined,
  row: Pick<SiteRow, 'id' | 'message'>,
  targets: ReadonlyArray<SiteTarget>,
): boolean {
  return (
    read !== undefined &&
    targets.length > 0 &&
    targets.every((t) => read.has(uncheckedKey(row, t.site._id)))
  )
}

/**
 * The day and repeat the work near a booking is read for (the site check's
 * dependency, and what its rows were `readFor`): a one-off's day, a
 * series' first visit's (`bookingAt`). That is the day the rows are about,
 * not the form's: the time of day alone can move a series' first visit by
 * a whole interval (anchored a little over a day ago it is booked from its
 * next visit on, `isBackfill`), and its rows must go with it.
 */
export function workDayOf(dayKey: string, repeat: Interval | null): string {
  return `${dayKey}|${repeat?.count ?? ''}|${repeat?.unit ?? ''}`
}

/**
 * What the match check's rows that name the work at their site hang on
 * beyond what was typed (FW13): where a row shown names it, the booking's
 * day and repeat (`workDay`) once they differ from those the rows were
 * read for, so moved, those rows go, as the site's own do (New Job takes
 * them, and only them, off the list: `SaveWarningsController.drop`);
 * otherwise nothing. A row naming no work stays as the date moves under
 * it, as it always did (M3). Never different at the press that shows the
 * rows (they are read for the day as it is), so the rows just shown stay.
 */
export function namedWorkMoved(at: {
  /** A match row shown names the work at its site. */
  naming: boolean
  workDay: string
  /** The `workDay` the rows shown were read for. */
  readFor: string | null
}): string | null {
  return at.naming && at.workDay !== at.readFor ? at.workDay : null
}
