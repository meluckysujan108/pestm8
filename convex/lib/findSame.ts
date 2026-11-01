import { ConvexError, v } from 'convex/values'
import { matchEvidence } from '../schema'
import {
  MATCH_ROWS_MAX,
  NO_OURS,
  autoRule,
  buildMatchIndex,
  matchNewClient,
  matchNewSite,
} from './clientMatch'
import { addressNear, areaCodeOf, siteKey } from './contactKeys'
import { oursOfCaller } from './ours'
import {
  inClientScope,
  matchBookComplete,
  visibleClientIds,
} from './clientScope'
import { isInScope } from './capabilities'
import { jobInScope } from './jobPeople'
import { isBinned } from './bin'
import { intervalOf } from './recurrence'
import {
  isOpenStatus,
  openNear,
  openWorkCovers,
  slotOf,
  slotShown,
} from './siteWork'
import { dayKeyOf, startOfDayInZone, startOfWeekKey } from './dates'
import type { Infer } from 'convex/values'
import type {
  Candidate,
  Evidence,
  MatchDirectory,
  MatchIndex,
  TypedAddress,
  TypedClient,
} from './clientMatch'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { ActorEnvelope } from './actor'

/**
 * The server's backstop when a booking or a new client saves: is the new
 * client someone already in the book, and is that address already booked?
 * The phone asks both first, from what it keeps (lib/clientMatch.ts,
 * lib/siteWork.ts); this asks them again with what is in the database now,
 * because the phone's copy can be behind (offline, a push not yet landed),
 * capped, or missing what its role isn't sent.
 *
 * Only when the call asks: `matchCheck` and `siteCheck` are optional, so a
 * screen that sends neither reads nothing more and is refused nothing new.
 * The one change it sees came with them: a site's postcode is stored
 * trimmed (properties.ts `storedPostcode`), since sites are found here by
 * it exactly. Called inside the create mutations, never as a
 * query of its own: a public "who has this number?" would be a way to read
 * the book one guess at a time.
 *
 * It decides, and writes nothing. A refusal is a ConvexError thrown before
 * anything is made, so no client, no client or job number, no Xero queue
 * entry, no audit row and no hint survive it. A booking that goes ahead gets
 * back the possible duplicates to note against the client it makes
 * (`clientMatchHints`), and the move a phone made onto a client, for the
 * audit row.
 *
 * ── Who is matched, by what ─────────────────────────────────────────────
 *
 * The same rows, fields and code as the caller's own phone (FW11):
 *  - clients by `by_business`, unbinned, the directory's limit;
 *  - business clients' contact people by `clientContacts.by_business`, and
 *    clients' emails, only when the caller's role is sent them and sees the
 *    whole book (`matchBookComplete`), as `clients.directory` sends them;
 *  - the numbers and emails to leave out, for this caller exactly as their
 *    phone leaves them out (`oursOfCaller`); and, for the possible
 *    duplicates noted for the office, which only those who see the team
 *    read, every member's, as those people's phones leave them out;
 *  - only the clients the caller may see (`inClientScope`). The index is
 *    built from those alone, so a client they can't see is never a
 *    candidate and never a second holder; and a typed address is checked
 *    for work only at the sites of those clients. So neither a refusal nor
 *    its absence says anything about the clients outside their book. (A
 *    site chosen by its id is checked whoever's it is: its id, and its
 *    work's dates for twenty weeks, are what `jobs.openWork` already sends
 *    every member; and someone else's work is named only within those
 *    twenty weeks: see `checkSiteWork`.)
 *  - sites only at the typed postcode (`by_business_and_postcode`), in both
 *    forms for one written with three digits or four (810 is 0810). Exact
 *    address keys include the postcode, so every site that can be the typed
 *    address is read; the suggestions the phone also makes from a client's
 *    other sites (a street in another suburb, an address only like one of
 *    theirs, a site contact elsewhere) never refuse a match and never make
 *    a hint, so they aren't read for. (An address only like one of theirs
 *    at the same postcode can hold a booking the outbox moved onto them, at
 *    the site check: `checkSiteWork`.)
 *
 * ── What refuses ────────────────────────────────────────────────────────
 *
 *  - `MATCHED_CLIENT`, with the sheet open (`by: 'sheet'`): a Same
 *    candidate the person was not shown and booked past (`dismissed`). With
 *    nobody there (`by: 'outbox'`, a booking sent later): only a candidate
 *    under the automatic rule (`autoRule`), so the phone may move the
 *    booking onto them. Likely and Shared never refuse: they were the
 *    phone's to show, and a phone that was behind must not be refused on
 *    weak evidence.
 *  - `SITE_BOOKED`: open work within a week of the booking at the site, or
 *    at any site that is the typed address, whoever's of the clients the
 *    caller may see, that the booking wasn't sent as seen: the caller's own
 *    at any date, anyone else's only within `jobs.openWork`'s twenty weeks
 *    from this week. For a booking the outbox moved onto a client at a new
 *    site for them, at their own sites only like it too.
 *  - `SITE_REPEATS`: a second Recurring Job at the site, when the one there
 *    wasn't seen.
 *
 * Each names at most MATCH_ROWS_MAX, and hands back every other one that
 * stops the booking (`more`) as `dismissed`, `seen` or `seenSeries` takes
 * it back, never with a name, so one Book anyway that sends them all back
 * gets through, not one refusal per three. (Unless a week turns between
 * the two in the business's zone: someone else's work in the week that
 * came within `jobs.openWork`'s twenty weeks was never named, and a visit
 * of theirs whose slot crossed an edge of them is told by its other slot,
 * so either refuses once more: see `checkSiteWork`.)
 *
 * In that order: a booking moved onto a client is sent again with its
 * `siteCheck`, so two techs who took the same caller end with one client
 * and one job, the second booking held for a look (FW1).
 *
 * A refusal names only clients the caller may see, by name and suburb,
 * never a stored number, email or street address; a job's id and number
 * only when the job is theirs to see. What `seen` sends back is a site and a
 * slot, and a job's id only for a job of their own, nothing their phone
 * wasn't sent (by `jobs.openWork`, or by the refusal), so a subcontractor's
 * Book anyway always gets through (RK1).
 *
 * ── Races ───────────────────────────────────────────────────────────────
 *
 * Mutations are serialisable. Two phones sending the same new client both
 * read the client range and both advance the business's client number, so
 * the second runs again and finds the first's client. Two bookings at one
 * exact address both read its jobs by `by_property`, so the second finds
 * the first's job. Weaker evidence within the same second (a misspelt name)
 * books twice; the second's hint names the first for the office.
 *
 * Reading the whole client range also means a client written meanwhile (an
 * import's batch, a merge) makes the booking run again; Convex retries it.
 * Watched in Convex's insights for `jobs:create`, `recurrences:create` and
 * `properties:create`: past a trigger, the matching keys move to their own
 * table (the plan's §5, "Server keys").
 */

/**
 * At most this many clients, and contact people, are read for the check:
 * `clients.directory`'s DIRECTORY_LIMIT, so the server never judges a book
 * bigger than a phone can hold. Past it the check can't say who holds a
 * number alone (`complete` is false), so a typed new client is never Same
 * and never moved. New site for {client} reads only that client, and the
 * site checks only the sites at the address, so those still refuse.
 */
const BOOK_LIMIT = 8000

/** Sites read at one postcode form. A business has hundreds there at the
 * most; past it, the oldest are left out (`sitesAt`). */
const POSTCODE_SITES_LIMIT = 2000

/** Sites at the typed address whose work is checked: in practice one or
 * two, several clients' at a house that was sold or let, or units saved
 * without their unit numbers. Past it the newest are kept and the cut is
 * logged (`checkSiteWork`); a site left out is never checked, so a booking
 * there goes ahead. */
const TARGETS_MAX = 50

/** A site's jobs read for the double-booking check, newest made first: a
 * weekly service for years before it reaches this. */
const JOBS_PER_SITE = 500

/** And across all the sites at the address, so a crowded one reads no more
 * than ten sites in full would: past ten, each has an even share, and each
 * of fifty still has its newest hundred. */
const JOBS_READ_MAX = 10 * JOBS_PER_SITE

/** A site's Recurring Jobs read for the second-series check, and across
 * all the sites at the address, shared out as their jobs are. */
const SERIES_PER_SITE = 50
const SERIES_READ_MAX = 10 * SERIES_PER_SITE

/**
 * How many more a refusal hands back, past the MATCH_ROWS_MAX it names
 * (`more`): every other candidate, job or Recurring Job that stops the
 * booking, so one Book anyway (or one Send) that adds them all to
 * `dismissed`, `seen` or `seenSeries` gets through. Without it a site with a
 * fourth unseen job that week is refused again for the fourth. Past this
 * many a second refusal names the rest; each round clears this many more,
 * so it always ends.
 */
const MORE_MAX = 200

export type MatchEvidence = Infer<typeof matchEvidence>

/** The words of `matchEvidence`, in its order. */
const MATCH_EVIDENCE: ReadonlyArray<MatchEvidence> = matchEvidence.members.map(
  (member) => member.value,
)

/**
 * What the person was shown about matching clients, and booked past.
 * Optional on every mutation that takes it; never stored.
 */
export const matchCheckArg = v.optional(
  v.object({
    // Who is there to answer a refusal: the open sheet, or nobody (a
    // booking the phone kept and sends later).
    by: v.union(v.literal('sheet'), v.literal('outbox')),
    // Every candidate the phone's matcher returned and the person booked
    // past, shown or counted in "and 2 more".
    dismissed: v.array(v.id('clients')),
    // Only on the outbox's resend after MATCHED_CLIENT: the client the phone
    // moved the booking onto, and why (the candidate's evidence). Never
    // refused again for that client, and, for a new client moved onto
    // them (its evidence holds `name`), on the booking's audit row as that
    // move (`matchedOn`). Ignored with `by: 'sheet'`, where a person chose
    // where it goes.
    applied: v.optional(
      v.object({
        clientId: v.id('clients'),
        evidence: v.array(matchEvidence),
      }),
    ),
  }),
)

/**
 * The work at the site the person was shown, and booked past: each job or
 * visit by its site and the slot it was told by (`slotOf`, or `slotShown`
 * for someone else's), and each Recurring Job, whose visits are then all
 * seen. Optional; never stored.
 *
 * A one-off has no slot of its own: moved by the office, even on the same
 * day, it is at another. So a job in the person's own scope, whose id their
 * phone holds (`jobs.openWork`, and SITE_BOOKED's rows), is sent by its id
 * too, and is seen wherever it has been moved. One out of their scope is
 * known by its site and the slot it was told by (`slotShown`) alone, which
 * is all their phone was sent.
 */
export const siteCheckArg = v.optional(
  v.object({
    seen: v.array(
      v.object({
        propertyId: v.id('properties'),
        at: v.number(),
        jobId: v.optional(v.id('jobs')),
      }),
    ),
    seenSeries: v.array(v.id('recurrences')),
  }),
)

export type MatchCheck = NonNullable<Infer<typeof matchCheckArg>>
export type SiteCheck = NonNullable<Infer<typeof siteCheckArg>>

/** A client the booking may be, as MATCHED_CLIENT names it. */
export type MatchedCandidate = {
  clientId: Id<'clients'>
  name: string
  /** Of the site at the typed address, else of their first site. */
  suburb?: string
  status?: Doc<'clients'>['status']
  archived?: true
  /** Their site at the typed address, when it matched exactly. */
  propertyId?: Id<'properties'>
  evidence: Array<MatchEvidence>
  /** Under the automatic rule: a booking sent later may be moved onto them
   * without a tap. Only ever true for `by: 'outbox'`. */
  auto: boolean
}

export type MatchedClient = {
  code: 'MATCHED_CLIENT'
  /** At most MATCH_ROWS_MAX. */
  candidates: Array<MatchedCandidate>
  /** Every other client that stops it ("and 2 more"), for `dismissed` with
   * the named ones. Only when there are any. */
  more?: Array<Id<'clients'>>
}

/** Open work at the site, as SITE_BOOKED names it. */
export type BookedRow = {
  propertyId: Id<'properties'>
  /** Its slot (`slotOf`), which `seen` sends back; for someone else's
   * whose slot is past the twenty weeks, when it is booked (`slotShown`). */
  at: number
  scheduledAt: number
  /** The Recurring Job a visit is of, which `seenSeries` sends back. */
  series?: Id<'recurrences'>
  /** The site's client, when the caller may see them and they aren't in
   * the Recycle bin. */
  clientName?: string
  /** Only for a job the caller may see. */
  jobId?: Id<'jobs'>
  jobNumber?: number
}

export type SiteBooked = {
  code: 'SITE_BOOKED'
  /** At most MATCH_ROWS_MAX, nearest first. */
  rows: Array<BookedRow>
  /** Every other job or visit that stops it, as `seen` takes it back with
   * the named ones: by site and slot, and by its id too for a job the
   * caller may see, as a named row gives it. Only when there are any. */
  more?: Array<SiteCheck['seen'][number]>
}

/** A Recurring Job already at the site, as SITE_REPEATS names it. */
export type RepeatsRow = {
  recurrenceId: Id<'recurrences'>
  propertyId: Id<'properties'>
  /** Its first open visit from today. */
  nextAt?: number
  /** How often, and what: only when it is the caller's to see. */
  intervalCount?: number
  intervalUnit?: Doc<'recurrences'>['intervalUnit']
  jobType?: string
}

export type SiteRepeats = {
  code: 'SITE_REPEATS'
  /** At most MATCH_ROWS_MAX. */
  series: Array<RepeatsRow>
  /** Every other Recurring Job that stops it, for `seenSeries` with the
   * named ones. Only when there are any. */
  more?: Array<Id<'recurrences'>>
}

/** Where a booking or a new client goes, as `resolvePropertyId` reads it. */
export type Proposed =
  | { mode: 'existing'; propertyId: Id<'properties'> }
  | { mode: 'site'; clientId: Id<'clients'>; address: TypedAddress }
  | { mode: 'new'; client: TypedClient & { site: TypedAddress } }

/**
 * `resolvePropertyId`'s input, in the same order of precedence: a site, a
 * new site for a client, or a new client. Null for none (it refuses that).
 */
export function proposedOf(input: {
  propertyId?: Id<'properties'>
  newProperty?: { clientId: Id<'clients'> } & TypedAddress
  newClient?: {
    clientName: string
    phone?: string
    email?: string
  } & TypedAddress
}): Proposed | null {
  if (input.propertyId !== undefined) {
    return { mode: 'existing', propertyId: input.propertyId }
  }
  if (input.newProperty) {
    return {
      mode: 'site',
      clientId: input.newProperty.clientId,
      address: addressOf(input.newProperty),
    }
  }
  if (input.newClient) {
    const { clientName, phone, email } = input.newClient
    return {
      mode: 'new',
      client: {
        name: clientName,
        ...(phone !== undefined ? { phone } : {}),
        ...(email !== undefined ? { email } : {}),
        site: addressOf(input.newClient),
      },
    }
  }
  return null
}

function addressOf(row: TypedAddress): TypedAddress {
  return {
    addressLine: row.addressLine,
    suburb: row.suburb,
    postcode: row.postcode,
  }
}

/** What the caller writes once its booking is made. */
export type Backstop = {
  /** Possible duplicates of the client a new-client booking makes. */
  hints: Array<{
    otherClientId: Id<'clients'>
    evidence: Array<MatchEvidence>
  }>
  /** The outbox's `matchCheck.applied`: recorded on the booking's audit row
   * once it lands on that client (`matchedOn`). Never the sheet's. */
  applied?: MatchCheck['applied']
}

/**
 * The checks the booking asks for, in order: MATCHED_CLIENT, then
 * SITE_REPEATS (a Recurring Job only), then SITE_BOOKED. Throws the first
 * refusal; returns what to note once the booking is made.
 *
 * `at` is when the booking is (a one-off's `scheduledAt`, a series' first
 * visit), `series` whether it is a Recurring Job, `now` the mutation's
 * clock. Called after the request id's lookup, the writer's own checks and
 * the target's (`checkPropertyTarget` in properties.ts: a client in the
 * Recycle bin, a number that can't be dialled), and before
 * `resolvePropertyId`. So whatever it lets through is made: nothing after
 * it refuses, and a check that found nothing can't be made to fail on
 * purpose to learn its answer for free.
 */
export async function backstop(
  ctx: QueryCtx,
  env: ActorEnvelope,
  businessId: Id<'businesses'>,
  proposed: Proposed | null,
  checks: {
    matchCheck?: MatchCheck
    siteCheck?: SiteCheck
    at?: number
    series?: boolean
    now: number
  },
): Promise<Backstop> {
  const { matchCheck, siteCheck } = checks
  // A move is the outbox's alone: with the sheet open a person chose where
  // the booking goes, and that is never recorded as the rule's move, nor
  // to be put back by "Book as a new client instead" (2c-J).
  const out: Backstop = {
    hints: [],
    ...(matchCheck?.by === 'outbox' && matchCheck.applied
      ? { applied: matchCheck.applied }
      : {}),
  }
  if (proposed === null || (!matchCheck && !siteCheck)) return out

  const visible = await visibleClientIds(ctx, env)
  const address = proposed.mode === 'existing' ? null : addressFor(proposed)
  const sites = address ? await sitesAt(ctx, businessId, address.postcode) : []

  // An existing site makes no client and no site: nothing to match.
  if (matchCheck && proposed.mode !== 'existing') {
    out.hints = await findSame(ctx, env, businessId, proposed, {
      check: matchCheck,
      visible,
      sites,
    })
  }
  if (siteCheck && checks.at !== undefined) {
    // The business row is read only by what needs it: here its time zone,
    // and a new client's match its numbers (`findSame`). Every booking,
    // Recurring Job visit and numbered report patches it, so a save that
    // reads it runs again whenever one of those lands meanwhile. The
    // bookings write it anyway; Add property (`createForClient`) doesn't.
    // The writer's own check has already proved it is there.
    const business = await ctx.db.get('businesses', businessId)
    if (business) {
      await checkSiteWork(ctx, env, business, proposed, {
        check: siteCheck,
        visible,
        sites,
        at: checks.at,
        series: checks.series === true,
        now: checks.now,
        movedOnto: out.applied?.clientId,
      })
    }
  }
  return out
}

/**
 * A booking the outbox moved onto an existing client after the server's
 * MATCHED_CLIENT, as its audit row records it (`meta.matched`), and what
 * the move did, for "Book as a new client instead" (2c-J) to put back.
 *
 * It is the phone's account of the move (`matchCheck.applied`, sent `by:
 * 'outbox'` only), checked against where the booking landed: the server
 * doesn't keep its refusals, so it can't prove one came first. Whatever is
 * built on it must be bounded by that: an undo may only ever hand over a
 * site that bookings moved this way made, and only while the job is still
 * where the booking put it.
 */
export type MatchedMove = {
  clientId: Id<'clients'>
  evidence: Array<MatchEvidence>
  /** The site the booking was made at, which is the client's: one of
   * theirs, or one it made on them (`madeSite`). */
  propertyId: Id<'properties'>
  /** The booking made that site (a new site for {client}), which isn't
   * theirs when the move was wrong. */
  madeSite?: true
  /** They were a lead, made active by this booking. */
  wasLead?: true
}

/**
 * The `applied` move as the audit row records it, when the booking did
 * land on that client; otherwise nothing. A phone can't have its own say
 * recorded as a match the booking didn't make.
 *
 * Only a move from one client to another: a new client the automatic rule
 * moved onto someone, which it never does without the exact name, so its
 * evidence always holds `name`. New site for {client} moved onto that
 * client's own site at the address (`['site']`) is still the client the
 * person chose, and is no move. The evidence is recorded once each, in
 * `matchEvidence`'s order, whatever the phone repeated.
 *
 * Read before the booking makes a lead active (`activateLeadAt`), so the
 * record says whether it did. `madeSite` is whether the booking made the
 * site it is at (`newProperty`), rather than choosing one of theirs.
 */
export async function matchedOn(
  ctx: QueryCtx,
  applied: MatchCheck['applied'],
  propertyId: Id<'properties'>,
  booked: { madeSite: boolean },
): Promise<MatchedMove | null> {
  if (!applied) return null
  const evidence = MATCH_EVIDENCE.filter((e) => applied.evidence.includes(e))
  if (!evidence.includes('name')) return null
  const site = await ctx.db.get('properties', propertyId)
  if (site?.clientId !== applied.clientId) return null
  const client = await ctx.db.get('clients', applied.clientId)
  return {
    clientId: applied.clientId,
    evidence,
    propertyId,
    ...(booked.madeSite ? { madeSite: true as const } : {}),
    ...(client?.status === 'lead' ? { wasLead: true as const } : {}),
  }
}

/**
 * The move the outbox made when this job was booked, from its `job.create`
 * audit row, which is written whenever one was made (and only then for
 * someone working as themselves). Null when the job was booked where it
 * was sent. What "Book as a new client instead" (2c-J) is built on.
 */
export async function automaticMoveOf(
  ctx: QueryCtx,
  jobId: Id<'jobs'>,
): Promise<MatchedMove | null> {
  const made = await ctx.db
    .query('auditLog')
    .withIndex('by_entity', (q) =>
      q.eq('entityType', 'jobs').eq('entityId', jobId),
    )
    .filter((q) => q.eq(q.field('action'), 'job.create'))
    .first()
  return matchedMoveIn(ctx, made?.meta)
}

/**
 * The move the outbox made when this Recurring Job was booked, from its
 * `recurrence.create` audit row (`meta.matched`), written whenever one was
 * made, as `automaticMoveOf` reads a job's. Its visits carry no move of
 * their own. A series is never to be put back (2c-J offers "Open the
 * Recurring Job" instead), so a one-off moved onto the same client at its
 * site mustn't be put back alone either. Null when it was booked where it
 * was sent.
 */
export async function automaticSeriesMoveOf(
  ctx: QueryCtx,
  recurrenceId: Id<'recurrences'>,
): Promise<MatchedMove | null> {
  const made = await ctx.db
    .query('auditLog')
    .withIndex('by_entity', (q) =>
      q.eq('entityType', 'recurrences').eq('entityId', recurrenceId),
    )
    .filter((q) => q.eq(q.field('action'), 'recurrence.create'))
    .first()
  return matchedMoveIn(ctx, made?.meta)
}

/** The move under an audit row's `meta.matched`, as `matchedOn` wrote it. */
function matchedMoveIn(ctx: QueryCtx, meta: unknown): MatchedMove | null {
  const matched = fieldOf(meta, 'matched')
  if (matched === null) return null
  const clientId = idOf(ctx, 'clients', matched.clientId)
  const propertyId = idOf(ctx, 'properties', matched.propertyId)
  if (clientId === null || propertyId === null) return null
  return {
    clientId,
    evidence: Array.isArray(matched.evidence)
      ? (matched.evidence as Array<MatchEvidence>)
      : [],
    propertyId,
    ...(matched.madeSite === true ? { madeSite: true as const } : {}),
    ...(matched.wasLead === true ? { wasLead: true as const } : {}),
  }
}

/** An object under `key` of an audit row's `meta`, or null. */
function fieldOf(meta: unknown, key: string): Record<string, unknown> | null {
  if (typeof meta !== 'object' || meta === null || !(key in meta)) return null
  const value: unknown = (meta as Record<string, unknown>)[key]
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function idOf<T extends 'clients' | 'properties'>(
  ctx: QueryCtx,
  table: T,
  value: unknown,
): Id<T> | null {
  return typeof value === 'string' ? ctx.db.normalizeId(table, value) : null
}

function addressFor(
  proposed: Exclude<Proposed, { mode: 'existing' }>,
): TypedAddress | null {
  const address =
    proposed.mode === 'site' ? proposed.address : proposed.client.site
  return address.addressLine.trim() === '' ? null : address
}

/** A postcode as it may be stored: four digits, or the three an NT or ACT
 * site was saved with before the app asked for four (`siteKey` pads them). */
function postcodeForms(raw: string): Array<string> {
  const code = raw.trim()
  if (code === '') return []
  if (/^0\d{3}$/.test(code)) return [code, code.slice(1)]
  if (/^\d{3}$/.test(code)) return [code, `0${code}`]
  return [code]
}

/**
 * Every unbinned site of the business at the postcode, in either form:
 * newest first, as the clients are read, so in a postcode past the limit
 * the sites left out are the oldest, not the ones most likely to be booked
 * again. A site left out only takes evidence away (no match, no hold), so
 * the check then lets through what it can't see; it says so in the log.
 */
async function sitesAt(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  postcode: string,
): Promise<Array<Doc<'properties'>>> {
  const reads = await Promise.all(
    postcodeForms(postcode).map((form) =>
      ctx.db
        .query('properties')
        .withIndex('by_business_and_postcode', (q) =>
          q.eq('businessId', businessId).eq('postcode', form),
        )
        .order('desc')
        .filter((q) => q.eq(q.field('deletedAt'), undefined))
        .take(POSTCODE_SITES_LIMIT + 1),
    ),
  )
  if (reads.some((read) => read.length > POSTCODE_SITES_LIMIT)) {
    // Counts only: never the postcode or an address.
    console.warn('findSame sites cut', { limit: POSTCODE_SITES_LIMIT })
  }
  return reads.flatMap((read) => read.slice(0, POSTCODE_SITES_LIMIT))
}

const PERSON_EVIDENCE: ReadonlySet<Evidence> = new Set([
  'mobile',
  'email',
  'landline',
])

const KEPT_EVIDENCE: ReadonlySet<Evidence> = new Set<Evidence>(MATCH_EVIDENCE)

/** The evidence that says who or where, as `matchEvidence` holds it. */
function keptEvidence(evidence: ReadonlyArray<Evidence>): Array<MatchEvidence> {
  return evidence.filter((e): e is MatchEvidence => KEPT_EVIDENCE.has(e))
}

/**
 * MATCHED_CLIENT, or the hints a new client goes ahead with.
 *
 * A hint for each candidate (at most three) whose evidence says who they
 * are (`hintsOf`): their name with their address, or their own mobile,
 * email or landline, under their name or another. Not an address under
 * another name (a sold house, an agency's site), a shared number, or a name
 * alone. And worked out with the team's numbers left out, whoever booked:
 * only those who see the team read them.
 */
async function findSame(
  ctx: QueryCtx,
  env: ActorEnvelope,
  businessId: Id<'businesses'>,
  proposed: Exclude<Proposed, { mode: 'existing' }>,
  read: {
    check: MatchCheck
    visible: Set<Id<'clients'>> | 'all'
    sites: ReadonlyArray<Doc<'properties'>>
  },
): Promise<Backstop['hints']> {
  const { check, visible, sites } = read
  let complete = matchBookComplete(env, visible)
  let index: MatchIndex
  let typed: TypedClient
  let candidates: Array<Candidate>
  // A new client's possible duplicates, once it isn't refused.
  let hints = async (): Promise<Backstop['hints']> => []

  if (proposed.mode === 'site') {
    // New site for {client}: only whether the chosen client already has
    // it. Another client holding the address is not a match here (a sold
    // house, a managing agency); it is the site check's.
    const client = await ctx.db.get('clients', proposed.clientId)
    if (
      !client ||
      isBinned(client) ||
      client.businessId !== businessId ||
      !inClientScope(visible, client._id)
    ) {
      return []
    }
    index = buildMatchIndex(
      {
        clients: [client],
        sites: sites.filter((site) => site.clientId === client._id),
        contacts: [],
        complete,
      },
      // Only their sites are matched (`matchNewSite`), never a number, so
      // no area code is needed, nor the business row it comes from.
      { areaCode: '', ours: NO_OURS },
    )
    typed = { site: proposed.address }
    candidates = matchNewSite(index, client._id, proposed.address).candidates
  } else {
    // The writer's own check has already proved it is there.
    const business = await ctx.db.get('businesses', businessId)
    if (!business) return []
    const areaCode = areaCodeOf(business.state)
    const [clients, contacts, ours] = await Promise.all([
      ctx.db
        .query('clients')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .order('desc')
        .filter((q) => q.eq(q.field('deletedAt'), undefined))
        .take(BOOK_LIMIT + 1),
      complete
        ? ctx.db
            .query('clientContacts')
            .withIndex('by_business', (q) => q.eq('businessId', businessId))
            .order('desc')
            .filter((q) => q.eq(q.field('deletedAt'), undefined))
            .take(BOOK_LIMIT + 1)
        : [],
      oursOfCaller(ctx, env, business),
    ])
    // Past the limit the book is cut, and who else holds a number can't be
    // said: then nothing is Same, and nothing is moved.
    if (clients.length > BOOK_LIMIT || contacts.length > BOOK_LIMIT) {
      complete = false
    }
    const book: MatchDirectory = {
      clients: clients
        .slice(0, BOOK_LIMIT)
        .filter((client) => inClientScope(visible, client._id)),
      sites,
      contacts: contacts.slice(0, BOOK_LIMIT),
      complete,
    }
    index = buildMatchIndex(book, { areaCode, ours })
    const client = proposed.client
    typed = client
    const found = matchNewClient(index, client)
    candidates = found.candidates
    hints = async () => {
      const own = hintsOf(found.candidates)
      if (env.caps['team.manage']) return own
      // Hints are read only by those who see the team (clientMatchHints.ts
      // `forClient`), so they are worked out as such a person's own
      // booking would make them: a team member's number or email on a
      // client is the team's, and never says the new client is that
      // client. What this booker was told, refused or not, came from their
      // own `ours` above, as their phone would have it, so nothing they see
      // turns on the team's numbers.
      //
      // Leaving the team's out only takes holders away. It can take a hint
      // away, or turn a number two clients hold into one client's (a field
      // holding a team member's number is left out whole), and never gives
      // a number to a client who held none of it. So the roster is read
      // only when this booker's own check found a possible duplicate, or a
      // number or email others hold too.
      if (own.length === 0 && found.shared.length === 0) return own
      const team = await oursOfCaller(ctx, env, business, true)
      return hintsOf(
        matchNewClient(buildMatchIndex(book, { areaCode, ours: team }), client)
          .candidates,
      )
    }
  }

  const dismissed = new Set(check.dismissed)
  const outbox = check.by === 'outbox'
  const applied = outbox ? check.applied?.clientId : undefined
  const stopping = candidates.filter((candidate) =>
    outbox
      ? autoRule(index, candidate, typed, {
          mode: proposed.mode,
          dismissed: check.dismissed,
          applied,
        })
      : candidate.tier === 'same' &&
        !dismissed.has(candidate.clientId) &&
        candidate.clientId !== applied,
  )

  if (candidates.length > 0) {
    // Counts and tiers only: never a name, number, email or address.
    console.log('findSame', {
      by: check.by,
      mode: proposed.mode,
      candidates: candidates.length,
      tier: candidates[0].tier,
      refused: stopping.length > 0,
    })
  }

  if (stopping.length > 0) {
    const byId = new Map(sites.map((site) => [site._id, site]))
    const more = stopping
      .slice(MATCH_ROWS_MAX, MATCH_ROWS_MAX + MORE_MAX)
      .map((candidate) => candidate.clientId)
    const data: MatchedClient = {
      code: 'MATCHED_CLIENT',
      candidates: await Promise.all(
        stopping
          .slice(0, MATCH_ROWS_MAX)
          .map((candidate) =>
            matchedCandidate(ctx, index, candidate, byId, outbox),
          ),
      ),
      ...(more.length > 0 ? { more } : {}),
    }
    throw new ConvexError(data)
  }

  return hints()
}

/**
 * The possible duplicates among a new client's candidates, at most
 * MATCH_ROWS_MAX: those whose evidence says who they are. Their own mobile,
 * email or landline, under their name or another; or their name with their
 * address, which is Same on a whole book and Likely on one the check can't
 * see whole (past BOOK_LIMIT, or narrowed), where it is still the strongest
 * sign there is that the new client is them. Read from the evidence, not
 * the tier, so how much of the book was seen never decides it.
 */
function hintsOf(candidates: ReadonlyArray<Candidate>): Backstop['hints'] {
  return candidates
    .filter(
      ({ evidence }) =>
        evidence.some((e) => PERSON_EVIDENCE.has(e)) ||
        (evidence.includes('site') &&
          (evidence.includes('name') || evidence.includes('nameNear'))),
    )
    .slice(0, MATCH_ROWS_MAX)
    .map((candidate) => ({
      otherClientId: candidate.clientId,
      evidence: keptEvidence(candidate.evidence),
    }))
}

/** A candidate as the refusal names it: no stored number, email or street. */
async function matchedCandidate(
  ctx: QueryCtx,
  index: MatchIndex,
  candidate: Candidate,
  sitesById: ReadonlyMap<Id<'properties'>, Doc<'properties'>>,
  auto: boolean,
): Promise<MatchedCandidate> {
  const client = index.clients.get(candidate.clientId)
  // Their oldest site at the typed address, the one a booking moves onto.
  const site: Doc<'properties'> | undefined = candidate.siteIds
    .map((id) => sitesById.get(id))
    .filter((row): row is Doc<'properties'> => row !== undefined)
    .sort((a, b) => a._creationTime - b._creationTime)
    .at(0)
  const suburb =
    site?.suburb ??
    (
      await ctx.db
        .query('properties')
        .withIndex('by_client', (q) => q.eq('clientId', candidate.clientId))
        .filter((q) => q.eq(q.field('deletedAt'), undefined))
        .first()
    )?.suburb
  return {
    clientId: candidate.clientId,
    name: client?.name ?? '',
    ...(suburb ? { suburb } : {}),
    ...(client?.status ? { status: client.status } : {}),
    ...(client?.archivedAt !== undefined ? { archived: true as const } : {}),
    ...(site ? { propertyId: site._id } : {}),
    evidence: keptEvidence(candidate.evidence),
    auto,
  }
}

/**
 * SITE_REPEATS, then SITE_BOOKED, for the site the booking goes to: an
 * existing one, or every site that is the typed address, whoever's among
 * the clients the caller may see (exact keys only; FW1, FW2). Jobs are
 * read `by_property` per site, and Recurring Jobs `recurrences.by_property`,
 * the open ones and the window by `lib/siteWork.ts`, the phone's own rule.
 *
 * One more for a booking the outbox moved onto a client (`movedOnto`) at a
 * new site for them, as typed: that client's own sites at the postcode that
 * are only like the typed address (`addressNear`: "30 Watle St" for their
 * 30 Wattle St). The move came from their name and their own mobile or
 * email, so a second phone's booking of the same caller, typed a little
 * differently, waits for a look at the first's job instead of booking a
 * second job at a second, misspelt site (FW1). Only ever a hold for a tap,
 * never a move: nobody is moved by an address that is only like theirs.
 *
 * By the booking's own date, however far off, for the caller's own work
 * (`jobInScope`, theirs to see anyway): an annual inspection booked a year
 * ahead, or a job left open months ago, is what the phone may not hold.
 * Anyone else's is named only when it falls within `jobs.openWork`'s
 * twenty weeks from this week (`openWorkCovers` from this week's Monday),
 * which `openWork` sends every member this week: the owner's answer to C5
 * (1 Nov 2026), "dates only" and no further. Its row's slot too: past them,
 * someone else's visit is told by when it is booked (`slotShown`), as
 * `openWork` tells it, and `seen` takes it back by that. So a refusal never tells someone of another
 * member's work beyond what `openWork` sends them now, and a booking beside
 * work past those weeks goes ahead, for the office to see. A Recurring
 * Job's next visit, for SITE_REPEATS, is judged visit by visit the same
 * way, so one the office moved onto someone else past them isn't named,
 * whoever's the series is. Someone who sees the whole schedule has every
 * job in scope, so for them nothing is cut.
 *
 * The weeks go by the mutation's clock, so a Book anyway sent back after a
 * week has turned in the business's zone can be refused once more: work
 * of someone else's in the week that came within them wasn't named the
 * first time, and a visit of someone else's whose slot crossed an edge of
 * them at the turn is told by its other slot now (`slotShown`: its slot
 * one side, when it is booked the other; most often a visit overdue from
 * four weeks back and moved forward), so the pair sent back no longer
 * holds it. Once each, so the next Book anyway gets through; an outbox
 * booking held for a look and sent days later can meet it too. M7's and
 * 2c-J's copy says so as more to look at, never as a loop, and not as new
 * work: a visit told by its other slot is one already named, at the same
 * site and booked time.
 *
 * So can a Book anyway after the office moves someone else's visit whose
 * slot is past the twenty weeks: it was told by when it was booked, since
 * its slot is a date past them, so once moved it is shown again, as a
 * one-off is. A visit told as someone else's that has become the caller's
 * since is still seen by what it was told while its slot stays past them
 * (once within them, it is told and seen by its slot, as their own is).
 *
 * A date tried that finds nothing books a job there, which the office
 * sees: the target's own refusals come first (`backstop`), so a booking
 * can't be made to fail after the check instead.
 *
 * Every site at the address up to TARGETS_MAX, past it the newest, and the
 * cut logged; their jobs read newest made first, JOBS_PER_SITE each up to
 * ten sites and an even share of JOBS_READ_MAX past that.
 */
async function checkSiteWork(
  ctx: QueryCtx,
  env: ActorEnvelope,
  business: Doc<'businesses'>,
  proposed: Proposed,
  read: {
    check: SiteCheck
    visible: Set<Id<'clients'>> | 'all'
    sites: ReadonlyArray<Doc<'properties'>>
    at: number
    series: boolean
    now: number
    movedOnto?: Id<'clients'>
  },
): Promise<void> {
  const { check, visible, sites } = read
  let targets: Array<Doc<'properties'>>
  if (proposed.mode === 'existing') {
    const site = await ctx.db.get('properties', proposed.propertyId)
    // Anything else is `resolvePropertyId`'s to refuse.
    targets =
      site && !isBinned(site) && site.businessId === business._id ? [site] : []
  } else {
    const address = addressFor(proposed)
    const key = address ? siteKey(address) : null
    const exact = sites.filter((site) => key !== null && siteKey(site) === key)
    const like =
      proposed.mode === 'site' &&
      address !== null &&
      read.movedOnto === proposed.clientId
        ? sites.filter(
            (site) =>
              site.clientId === proposed.clientId &&
              siteKey(site) !== key &&
              addressNear(address, site),
          )
        : []
    // The exact address's sites, newest first whichever postcode form they
    // were saved with, then those only like it: past TARGETS_MAX, the
    // oldest are the ones left out.
    const newestFirst = (x: Doc<'properties'>, y: Doc<'properties'>) =>
      y._creationTime - x._creationTime
    const theirs = [...exact.sort(newestFirst), ...like.sort(newestFirst)]
      // Only the sites of clients the caller may see. On a narrowed book
      // their phone holds no other client's address, so it couldn't have
      // shown this work, and a refusal would tell them, one typed address
      // at a time, that someone outside their book is there and when.
      .filter((site) => inClientScope(visible, site.clientId))
    if (theirs.length > TARGETS_MAX) {
      // Counts only: never the postcode or an address.
      console.warn('findSame targets cut', { limit: TARGETS_MAX })
    }
    targets = theirs.slice(0, TARGETS_MAX)
  }
  if (targets.length === 0) return
  const jobsEach = Math.min(
    JOBS_PER_SITE,
    Math.floor(JOBS_READ_MAX / targets.length),
  )
  const seriesEach = Math.min(
    SERIES_PER_SITE,
    Math.floor(SERIES_READ_MAX / targets.length),
  )

  const seenSeries = new Set<string>(check.seenSeries)
  const jobs = (
    await Promise.all(
      targets.map((site) =>
        ctx.db
          .query('jobs')
          .withIndex('by_property', (q) => q.eq('propertyId', site._id))
          .order('desc')
          .take(jobsEach),
      ),
    )
  )
    .flat()
    .filter((job) => !isBinned(job) && job.businessId === business._id)

  // Whether a job is the caller's to see, asked once a job: it decides
  // whether someone else's work is past what may be named, and what a
  // named row carries.
  const scoped = new Map<Id<'jobs'>, boolean>()
  const theirs = async (job: Doc<'jobs'>) => {
    let answer = scoped.get(job._id)
    if (answer === undefined) {
      answer = await jobInScope(ctx, env.scope, job)
      scoped.set(job._id, answer)
    }
    return answer
  }
  // Someone else's work is named only within `jobs.openWork`'s twenty
  // weeks from this week, as `openWork` sends every member this week (by
  // the mutation's clock, in the business's zone); the caller's own at any
  // date.
  const monday = startOfWeekKey(dayKeyOf(read.now, business.timezone))
  const nameable = async (job: Doc<'jobs'>) =>
    openWorkCovers(monday, dayKeyOf(job.scheduledAt, business.timezone)) ||
    (await theirs(job))
  // The slot a named job is told by and taken back by: its own, but for
  // someone else's whose slot is past the twenty weeks, when it is booked,
  // as `openWork` tells it (`slotShown`).
  const slotTold = async (job: Doc<'jobs'>) => {
    const shown = slotShown(job, monday, business.timezone)
    return shown === slotOf(job) || !(await theirs(job)) ? shown : slotOf(job)
  }

  if (read.series) {
    const running = (
      await Promise.all(
        targets.map((site) =>
          ctx.db
            .query('recurrences')
            .withIndex('by_property', (q) => q.eq('propertyId', site._id))
            // Running and unbinned before the cut, so however many were
            // stopped there over the years, none pushes a running one out.
            .filter((q) =>
              q.and(
                q.eq(q.field('active'), true),
                q.eq(q.field('deletedAt'), undefined),
              ),
            )
            .take(seriesEach),
        ),
      )
    )
      .flat()
      .filter(
        (row) => row.businessId === business._id && !seenSeries.has(row._id),
      )
      .sort((a, b) => a._creationTime - b._creationTime)
    if (running.length > 0) {
      const more = running
        .slice(MATCH_ROWS_MAX, MATCH_ROWS_MAX + MORE_MAX)
        .map((row) => row._id)
      const today = startOfDayInZone(
        dayKeyOf(read.now, business.timezone),
        business.timezone,
      )
      const data: SiteRepeats = {
        code: 'SITE_REPEATS',
        series: await Promise.all(
          running.slice(0, MATCH_ROWS_MAX).map(async (row) => {
            // Its next visit, judged visit by visit as SITE_BOOKED judges a
            // job: one moved onto someone else past the twenty weeks is
            // theirs alone to know, whoever's the series is.
            let nextAt: number | undefined
            for (const visit of jobs
              .filter(
                (job) =>
                  job.recurrenceId === row._id &&
                  isOpenStatus(job.status) &&
                  job.scheduledAt >= today,
              )
              .sort((a, b) => a.scheduledAt - b.scheduledAt)) {
              if (await nameable(visit)) {
                nextAt = visit.scheduledAt
                break
              }
            }
            const interval = isInScope(env.scope, row) ? intervalOf(row) : null
            return {
              recurrenceId: row._id,
              propertyId: row.propertyId,
              ...(nextAt !== undefined ? { nextAt } : {}),
              ...(interval
                ? {
                    intervalCount: interval.count,
                    intervalUnit: interval.unit,
                    jobType: row.jobType,
                  }
                : {}),
            }
          }),
        ),
        ...(more.length > 0 ? { more } : {}),
      }
      throw new ConvexError(data)
    }
  }

  const seen = new Set(
    check.seen.map((pair) => `${pair.propertyId}|${pair.at}`),
  )
  const seenJobs = new Set<string>(
    check.seen.flatMap((pair) =>
      pair.jobId !== undefined ? [pair.jobId] : [],
    ),
  )
  const unseen = openNear(
    jobs.filter(
      (job) =>
        !seenJobs.has(job._id) &&
        !(job.recurrenceId !== undefined && seenSeries.has(job.recurrenceId)),
    ),
    read.at,
    business.timezone,
  )
  const near: Array<{ job: Doc<'jobs'>; at: number }> = []
  for (const job of unseen) {
    if (!(await nameable(job))) continue
    const at = await slotTold(job)
    if (seen.has(`${job.propertyId}|${at}`)) continue
    // The caller's own, told as someone else's before it became theirs.
    const shown = slotShown(job, monday, business.timezone)
    if (shown !== at && seen.has(`${job.propertyId}|${shown}`)) continue
    near.push({ job, at })
  }
  if (near.length === 0) return

  const shown = near.slice(0, MATCH_ROWS_MAX)
  // The rest as the named rows are sent back: a job the caller may see by
  // its id too, so one the office moves before the resend is still seen;
  // anyone else's by site and slot alone, once each (two in one slot are
  // one pair to send back).
  const pairOf = ({ job, at }: (typeof near)[number]) =>
    `${job.propertyId}|${at}`
  const pairs = new Set(shown.map(pairOf))
  const more: NonNullable<SiteBooked['more']> = []
  for (const told of near.slice(MATCH_ROWS_MAX)) {
    if (more.length >= MORE_MAX) break
    const { job, at } = told
    const pair = { propertyId: job.propertyId, at }
    if (await theirs(job)) {
      more.push({ ...pair, jobId: job._id })
    } else if (!pairs.has(pairOf(told))) {
      more.push(pair)
    }
    pairs.add(pairOf(told))
  }
  const siteOf = new Map(targets.map((site) => [site._id, site]))
  const names = new Map<Id<'clients'>, string | null>()
  const clientNameOf = async (propertyId: Id<'properties'>) => {
    const clientId = siteOf.get(propertyId)?.clientId
    if (clientId === undefined || !inClientScope(visible, clientId)) {
      return null
    }
    if (!names.has(clientId)) {
      const client = await ctx.db.get('clients', clientId)
      names.set(clientId, client && !isBinned(client) ? client.name : null)
    }
    return names.get(clientId) ?? null
  }
  const data: SiteBooked = {
    code: 'SITE_BOOKED',
    rows: await Promise.all(
      shown.map(async ({ job, at }) => {
        const clientName = await clientNameOf(job.propertyId)
        const own = await theirs(job)
        return {
          propertyId: job.propertyId,
          at,
          scheduledAt: job.scheduledAt,
          ...(job.recurrenceId !== undefined
            ? { series: job.recurrenceId }
            : {}),
          ...(clientName !== null ? { clientName } : {}),
          ...(own
            ? {
                jobId: job._id,
                ...(job.jobNumber !== undefined
                  ? { jobNumber: job.jobNumber }
                  : {}),
              }
            : {}),
        }
      }),
    ),
    ...(more.length > 0 ? { more } : {}),
  }
  throw new ConvexError(data)
}
