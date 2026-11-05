import { addDaysToKey, dayKeyOf } from '../../convex/lib/dates'
import { addressNear, siteKey, streetKey } from '../../convex/lib/contactKeys'
import { splitJobTypes } from '../../convex/lib/jobTypes'
import { describeInterval, firstVisitAt } from '../../convex/lib/recurrence'
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
import type { MatchIndex, MatchSite } from '../../convex/lib/clientMatch'
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
 * sheet will send with the booking (the plan's M7); until then this is the
 * only check there is.
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
  /** `Not checked`: what the check couldn't read (`uncheckedRows`). */
  label: 'Already booked' | 'Already repeats' | 'Not checked'
  message: string
  fix?: SiteFix
  fix2?: SiteFix
  shows: Shows
  /** The site the row is about; null for what couldn't be checked. */
  propertyId: Id<'properties'> | null
}

/** At most this many rows, nearest first (§3.2). */
export const SITE_ROWS_MAX = 2

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
 * and nothing already seen.
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
  if (!nearToo) return out.slice(0, SITE_ROWS_MAX)
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
  return out.slice(0, SITE_ROWS_MAX)
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
 * else does: until the online sheet sends the check (the plan's M7) this is
 * the only check, and a booking it never made would otherwise go on one
 * press with no sign. Each has no fix; the second press books, as with any
 * row. (The plan's §3.2 leaves a date past the weeks held to the server's
 * check, §4.3, as no row at all: M7, which sends that check, is where to
 * drop the row for such a date, keeping it where the week either side
 * straddles an edge.)
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
    const there =
      propertyId === null
        ? []
        : found.filter((r) => r.propertyId === propertyId)
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
