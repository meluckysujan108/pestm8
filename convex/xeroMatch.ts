import { ConvexError, v } from 'convex/values'
import {
  paginationOptsValidator,
  paginationResultValidator,
} from 'convex/server'
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import { requireActor, requireWriteActor } from './lib/actor'
import { forSelf, recordAudit } from './lib/audit'
import { isSwitched } from './lib/capabilities'
import { xeroConfigured, xeroPaused } from './lib/xeroConfig'
import { CONTACTS_PAGE_SIZE, XeroError, getContactsPage } from './lib/xeroHttp'
import {
  addCounts,
  inXeroBook,
  isLiveXero,
  linkCounts,
  moveMatchCounts,
  requireConnectionHolder,
} from './lib/xeroHooks'
import { matchClients } from './lib/xeroMatch'
import { DEMO_PLAN } from './demo/shared'
import { accessTokenFor } from './xeroTokens'
import {
  xeroCandidate,
  xeroCandidateReason,
  xeroLinkState,
  xeroMatchState,
} from './schema'
import type { Infer } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'
import type { XeroContactRow } from './lib/xeroHttp'
import type { MatchCountsDelta } from './lib/xeroHooks'
import type { ClientForMatch, Proposal } from './lib/xeroMatch'

/**
 * Match your clients (Release 2): which PestM8 client is which contact in a
 * connected Xero organisation, before Release 3 sends anything.
 *
 * READ-ONLY toward Xero. The only call is `GET /Contacts`, paged; nothing
 * here creates, changes or archives a contact. What it writes is PestM8's
 * own `xeroContactLinks` — a proposal per client — and the holder's word on
 * the ones it could not be sure of. Release 3 acts on those links: a linked
 * client updates its contact, everything else becomes a new one.
 *
 * ── A run (`run`) ─────────────────────────────────────────────────────────
 *
 *  1. Claims the TENANT lease (`claimTenant`): one run or drain per Xero
 *     organisation at a time, across every business, because Xero's limits
 *     (60 calls a minute, 5,000 a day) are the organisation's, not the
 *     connection's. Busy: tried again a minute later, ten times.
 *  2. Reads every contact, 1,000 a page, 1.1 s apart.
 *  3. Reads every client the organisation gets (`clientsForMatch`): the whole
 *     book, less the Recycle bin and legacy-archived clients. Leads are
 *     counted, not proposed — they wait until their first job is booked.
 *  4. Matches them (lib/xeroMatch.ts has the rules) and stores the
 *     proposals (`saveProposals`), never touching a decision.
 *  5. Finishes (`finishMatch`): drops the undecided proposals an earlier run
 *     left for clients this one no longer proposes, and says how many are
 *     linked, to check, new and waiting as leads.
 *
 * Whatever happens the lease is let go, and a failure is stored as a code the
 * page words (xeroCopy.ts `matchProblemCopy`): reconnect, busy,
 * too_many_contacts, rate_limited, xero_unavailable, paused, disconnected,
 * stopped, failed.
 *
 * A run that dies without getting that far — killed by a deploy, or past
 * the action time limit — can't say so itself, and leaves the match
 * reading. Settings is told when that reading is past believing
 * (`matchStaleAfter`: its lease lapsed, or it never took the organisation),
 * and from then shows it as stopped, with Check Xero again — which starts a
 * new run, since nothing holds the organisation any more.
 *
 * ── Who ───────────────────────────────────────────────────────────────────
 *
 * The connection's holder (`requireConnectionHolder`): the owner for the
 * business's organisation, the member for their own — and only while the
 * connection is live, since only one live connection per business can hold
 * an organisation. Same, Different, Unlink, Match again and Check again are
 * writes, refused while switched (SWITCHED, as `xero.disconnect` does).
 *
 * The answers belong to the organisation, not to whoever gave them: a link
 * is keyed by business and organisation, so whoever connects that
 * organisation here next finds them, and may change them.
 *
 * ── Errors the page words ─────────────────────────────────────────────────
 *
 * NOT_FOUND, NO_ACCESS, SWITCHED, CONTACT_TAKEN, XERO_NOT_CONFIGURED,
 * XERO_RECONNECT.
 */

// ───────────────────────────────────────────────────────────────── limits

/** How long a run holds the organisation without renewing. Renewed with
 * every page read and every batch saved, so only a run that died keeps it
 * from the next for longer than a page takes. */
const LEASE_MS = 5 * 60_000
/** Between pages: Xero allows an organisation 60 calls a minute. */
const PAGE_GAP_MS = 1100
/** 50,000 contacts. A book that size wants a different tool than a match
 * that holds it all in one action. */
const MAX_PAGES = 50
/** A page of Xero's that failed in a way worth another go (busy, a 5xx, a
 * minute's rate limit) is tried this many times, waiting at most a minute. */
const PAGE_TRIES = 3
const MAX_PAGE_WAIT_MS = 60_000
/** Xero says the minute's allowance is down to this: wait for the next. */
const MINUTE_RESERVE = 1
const MINUTE_MS = 60_000
const CLIENT_PAGE = 500
const SAVE_BATCH = 200
const STALE_BATCH = 500
/** Someone else holds the organisation: try again a minute later, this many
 * times in all. */
const BUSY_RETRY_MS = 60_000
const BUSY_TRIES = 10
/** How long an ask (`startMatch`) may wait for its run to take the
 * organisation — through every busy retry — before the page calls it
 * stopped. */
const CLAIM_GRACE_MS = BUSY_TRIES * BUSY_RETRY_MS + 5 * 60_000
/** How long past a lapsed lease before the page calls a read stopped: a run
 * renewing it just then, or a phone's clock a little ahead, is not. */
const STALE_MARGIN_MS = 2 * 60_000
/** Connecting again within this long of a finished match does not read
 * Xero again: Check Xero again is on the page for that. */
const MATCH_FRESH_MS = 7 * 24 * 60 * 60_000

/** Why a run stopped, as the page words it (xeroCopy.ts). */
export type MatchProblem =
  | 'reconnect'
  | 'busy'
  | 'too_many_contacts'
  | 'rate_limited'
  | 'xero_unavailable'
  | 'paused'
  | 'disconnected'
  | 'failed'

const ZERO_COUNTS = {
  contacts: 0,
  linked: 0,
  review: 0,
  fresh: 0,
  different: 0,
  leads: 0,
}

type Counts = typeof ZERO_COUNTS
type Match = NonNullable<Doc<'xeroSyncState'>['match']>

// ───────────────────────────────────────────────────────────────── shapes

const contactArg = v.object({
  contactId: v.string(),
  name: v.string(),
  email: v.optional(v.string()),
  accountNumber: v.optional(v.string()),
  status: v.union(
    v.literal('ACTIVE'),
    v.literal('ARCHIVED'),
    v.literal('GDPRREQUEST'),
  ),
  phone: v.optional(v.string()),
  place: v.optional(v.string()),
})

const proposalArg = v.union(
  v.object({
    clientId: v.id('clients'),
    outcome: v.literal('linked'),
    contact: contactArg,
  }),
  v.object({
    clientId: v.id('clients'),
    outcome: v.literal('review'),
    contact: contactArg,
    reason: xeroCandidateReason,
  }),
  v.object({ clientId: v.id('clients'), outcome: v.literal('new') }),
)

const countsArg = v.object({
  contacts: v.number(),
  linked: v.number(),
  review: v.number(),
  fresh: v.number(),
  different: v.number(),
  leads: v.number(),
})

/** What a batch of proposals, or a run, counts. */
type LinkCounts = Pick<Counts, 'linked' | 'review' | 'fresh' | 'different'>

/** One client of the match page (`reviewPage`). */
const reviewItem = v.object({
  clientId: v.id('clients'),
  clientName: v.string(),
  clientNumber: v.union(v.number(), v.null()),
  clientPhone: v.union(v.string(), v.null()),
  /** Its oldest live site's suburb: how two John Smiths are told apart. */
  clientSuburb: v.union(v.string(), v.null()),
  state: xeroLinkState,
  how: v.union(v.literal('matched'), v.literal('chosen'), v.null()),
  candidate: v.union(xeroCandidate, v.null()),
  xeroName: v.union(v.string(), v.null()),
  decidedAt: v.union(v.number(), v.null()),
  /** Whether the person looking gave the answer: an organisation's answers
   * pass to whoever holds it next. */
  decidedByYou: v.boolean(),
})

export type ReviewItem = Infer<typeof reviewItem>

/** The match page's lists, each one link state. */
const FILTER_STATE = {
  review: 'needs_review',
  matched: 'linked',
  new: 'new',
  separate: 'separate',
} as const satisfies Record<string, Doc<'xeroContactLinks'>['state']>

/** A client as a run sees it: what the matcher compares, and whether it is a
 * lead (counted, not proposed). */
export type MatchClient = ClientForMatch & { lead: boolean }

type MatchTarget = {
  grantId: Id<'xeroGrants'>
  tenantId: string
  businessId: Id<'businesses'>
}

// ──────────────────────────────────────────────────────────────── helpers

async function syncRowOf(
  ctx: QueryCtx | MutationCtx,
  connectionId: Id<'xeroConnections'>,
): Promise<Doc<'xeroSyncState'> | null> {
  return ctx.db
    .query('xeroSyncState')
    .withIndex('by_connection', (q) => q.eq('connectionId', connectionId))
    .first()
}

/** This connection's row, made on first use. */
async function ensureSyncRow(
  ctx: MutationCtx,
  connection: Doc<'xeroConnections'>,
): Promise<Doc<'xeroSyncState'>> {
  const existing = await syncRowOf(ctx, connection._id)
  if (existing) return existing
  const id = await ctx.db.insert('xeroSyncState', {
    connectionId: connection._id,
    businessId: connection.businessId,
    tenantId: connection.tenantId,
  })
  const row = await ctx.db.get('xeroSyncState', id)
  if (!row) throw new ConvexError('NOT_FOUND')
  return row
}

/** Someone other than `holder`, in any business, holds a live lease on this
 * organisation. A lease past its time belongs to a run that died, and is
 * anyone's. */
async function tenantBusy(
  ctx: QueryCtx | MutationCtx,
  tenantId: string,
  holder: string,
  now: number,
): Promise<boolean> {
  const rows = ctx.db
    .query('xeroSyncState')
    .withIndex('by_tenant', (q) => q.eq('tenantId', tenantId))
  for await (const row of rows) {
    if (row.lease && row.lease.until > now && row.lease.holder !== holder) {
      return true
    }
  }
  return false
}

/**
 * The connection's row, while `holder` still has the organisation — its own
 * lease, in time or run over with nobody else having taken the
 * organisation since — else LEASE_LOST. Renews the lease.
 */
async function holdLease(
  ctx: MutationCtx,
  connectionId: Id<'xeroConnections'>,
  holder: string,
  now: number,
): Promise<Doc<'xeroSyncState'>> {
  const sync = await syncRowOf(ctx, connectionId)
  const lease = sync?.lease
  if (
    !sync ||
    lease?.holder !== holder ||
    (lease.until <= now && (await tenantBusy(ctx, sync.tenantId, holder, now)))
  ) {
    throw new ConvexError('LEASE_LOST')
  }
  await ctx.db.patch('xeroSyncState', sync._id, {
    lease: { holder, until: now + LEASE_MS },
  })
  return sync
}

async function linkOf(
  ctx: QueryCtx | MutationCtx,
  businessId: Id<'businesses'>,
  tenantId: string,
  clientId: Id<'clients'>,
): Promise<Doc<'xeroContactLinks'> | null> {
  return ctx.db
    .query('xeroContactLinks')
    .withIndex('by_business_and_tenant_and_client', (q) =>
      q
        .eq('businessId', businessId)
        .eq('tenantId', tenantId)
        .eq('clientId', clientId),
    )
    .first()
}

/** The suburb of a client's oldest site not in the Recycle bin. */
async function oldestSiteSuburb(
  ctx: QueryCtx,
  clientId: Id<'clients'>,
): Promise<string | undefined> {
  const site = await ctx.db
    .query('properties')
    .withIndex('by_client', (q) => q.eq('clientId', clientId))
    .filter((q) => q.eq(q.field('deletedAt'), undefined))
    .first()
  return site?.suburb.trim() || undefined
}

/**
 * When a match still reading is past believing, as Settings is told it
 * (`xero.status`): the run that was reading it has died — killed by a
 * deploy, past the action time limit — without saying so. The page compares
 * it with its own clock (a query mustn't read one) and from then shows the
 * read as stopped, with Check Xero again, which `startMatch` then accepts:
 * the dead run's lease has lapsed.
 *
 * Its lease's end, while the run holds one (renewed with every page and
 * batch); for an ask no run has taken up yet, long enough for every busy
 * retry. Null when not reading.
 */
export function matchStaleAfter(sync: Doc<'xeroSyncState'>): number | null {
  const match = sync.match
  if (match?.state !== 'reading') return null
  if (match.runId === '') return match.at + CLAIM_GRACE_MS
  const lease = sync.lease
  const until =
    lease?.holder === match.runId ? lease.until : match.at + LEASE_MS
  return until + STALE_MARGIN_MS
}

/**
 * Asks for a match of this connection: shows it as reading straight away,
 * so the page says so before the run has even started, and schedules the
 * run. False — and nothing done — while a run of this connection holds its
 * lease: the one under way is the answer.
 *
 * The run id is cleared, which retires whatever an earlier run was still
 * doing for this connection (a clean-up still going, a run hung past its
 * lease): only the run whose id the match carries may finish or fail it.
 */
export async function startMatch(
  ctx: MutationCtx,
  connection: Doc<'xeroConnections'>,
): Promise<boolean> {
  const now = Date.now()
  const sync = await ensureSyncRow(ctx, connection)
  if (
    sync.match?.state === 'reading' &&
    sync.lease !== undefined &&
    sync.lease.until > now
  ) {
    return false
  }
  const prior = sync.match
  await ctx.db.patch('xeroSyncState', sync._id, {
    match: {
      state: 'reading',
      at: now,
      runId: '',
      contacts: prior?.contacts ?? 0,
      linked: prior?.linked ?? 0,
      review: prior?.review ?? 0,
      fresh: prior?.fresh ?? 0,
      different: prior?.different ?? 0,
      leads: prior?.leads ?? 0,
    },
  })
  await ctx.scheduler.runAfter(0, internal.xeroMatch.run, {
    connectionId: connection._id,
  })
  return true
}

/**
 * After a connect or reconnect (convex/xero.ts `finish`): asks for a match
 * (`startMatch`), unless this connection finished one in the last week — a
 * reconnect after a lapsed sign-in finds its matches where it left them, and
 * Check Xero again is there if the books changed meanwhile.
 *
 * In the same write as the connect, so the page never shows a connection
 * that is connected with no match under way: one with no match at all
 * (connected before matching existed) is offered Check Xero again.
 */
export async function matchAfterConnect(
  ctx: MutationCtx,
  connection: Doc<'xeroConnections'>,
): Promise<void> {
  const sync = await syncRowOf(ctx, connection._id)
  const match = sync?.match
  if (match?.state === 'ready' && Date.now() - match.at < MATCH_FRESH_MS) {
    return
  }
  await startMatch(ctx, connection)
}

/** Moves this connection's finished match counts with one decision, so the
 * page is right without a run (lib/xeroHooks.ts `moveMatchCounts`). */
async function adjustCounts(
  ctx: MutationCtx,
  connectionId: Id<'xeroConnections'>,
  delta: MatchCountsDelta,
): Promise<void> {
  await moveMatchCounts(ctx, await syncRowOf(ctx, connectionId), delta)
}

/** The counts a link moves from one state to another. */
function movedCounts(
  from: Doc<'xeroContactLinks'>['state'],
  to: Doc<'xeroContactLinks'>['state'],
): MatchCountsDelta {
  return addCounts(linkCounts(from, -1), linkCounts(to, 1))
}

/**
 * The other clients' links to one Xero contact in this business and
 * organisation, sorted by whether they hold it:
 *
 * - `holding`: a client in the book linked to it. One Xero contact is one
 *   client, so nobody else may have it while this one does.
 * - `outOfBook`: linked, but its client is in the Recycle bin, archived or
 *   gone. It is on no list and is never sent, so it holds nothing — and if
 *   someone else takes the contact its link goes, and a restore is matched
 *   afresh.
 */
async function othersLinkedTo(
  ctx: MutationCtx,
  {
    businessId,
    tenantId,
    contactId,
    clientId,
  }: {
    businessId: Id<'businesses'>
    tenantId: string
    contactId: string
    clientId: Id<'clients'>
  },
): Promise<{
  holding: Array<Doc<'xeroContactLinks'>>
  outOfBook: Array<Doc<'xeroContactLinks'>>
}> {
  const rows = await ctx.db
    .query('xeroContactLinks')
    .withIndex('by_business_and_tenant_and_contact', (q) =>
      q
        .eq('businessId', businessId)
        .eq('tenantId', tenantId)
        .eq('xeroContactId', contactId),
    )
    .take(20)
  const holding: Array<Doc<'xeroContactLinks'>> = []
  const outOfBook: Array<Doc<'xeroContactLinks'>> = []
  for (const row of rows) {
    if (row.clientId === clientId || row.state !== 'linked') continue
    const client = await ctx.db.get('clients', row.clientId)
    if (client && client.businessId === businessId && inXeroBook(client)) {
      holding.push(row)
    } else {
      outOfBook.push(row)
    }
  }
  return { holding, outOfBook }
}

// ─────────────────────────────────────────────────────────────────── a run

/**
 * Why a connection can't be matched now, as the match should say it — or
 * `skip` when there is nothing to say to anyone (the connection is gone, or
 * belongs to the demo business), or null when it can be.
 */
async function unmatchable(
  ctx: QueryCtx | MutationCtx,
  connection: Doc<'xeroConnections'> | null,
): Promise<MatchProblem | 'skip' | null> {
  if (!connection) return 'skip'
  const business = await ctx.db.get('businesses', connection.businessId)
  if (!business || business.plan === DEMO_PLAN) return 'skip'
  switch (connection.status) {
    case 'connected':
      return null
    case 'needs_reconnect':
      return 'reconnect'
    case 'disconnected':
      return 'disconnected'
    default:
      return 'skip'
  }
}

/** What a run needs to reach this connection's organisation — or why there
 * is nothing to match: gone, not connected, the demo business. */
export const forMatch = internalQuery({
  args: { connectionId: v.id('xeroConnections') },
  handler: async (
    ctx,
    { connectionId },
  ): Promise<
    | { ok: true; target: MatchTarget }
    | { ok: false; problem: MatchProblem | null }
  > => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    const why = await unmatchable(ctx, connection)
    if (why !== null || !connection) {
      return { ok: false, problem: why === 'skip' ? null : why }
    }
    return {
      ok: true,
      target: {
        grantId: connection.grantId,
        tenantId: connection.tenantId,
        businessId: connection.businessId,
      },
    }
  },
})

/**
 * Takes the organisation for one run: refused while anyone, in any business,
 * holds a live lease on it — two runs, or a run and a drain, would share one
 * minute's 60 calls and leave each other rate-limited. Taken, the match
 * shows as reading, with this run's id and nothing counted yet.
 *
 * Checks again what `forMatch` checked, because the run waited on nothing
 * in between but time: the demo business can never claim one.
 */
export const claimTenant = internalMutation({
  args: { connectionId: v.id('xeroConnections'), holder: v.string() },
  handler: async (
    ctx,
    { connectionId, holder },
  ): Promise<
    | { claimed: true }
    | { claimed: false; reason: 'busy' }
    | { claimed: false; reason: 'gone'; problem: MatchProblem | null }
  > => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    const why = await unmatchable(ctx, connection)
    if (why !== null || !connection) {
      return {
        claimed: false,
        reason: 'gone',
        problem: why === 'skip' ? null : why,
      }
    }

    const now = Date.now()
    if (await tenantBusy(ctx, connection.tenantId, holder, now)) {
      return { claimed: false, reason: 'busy' }
    }
    const sync = await ensureSyncRow(ctx, connection)
    await ctx.db.patch('xeroSyncState', sync._id, {
      lease: { holder, until: now + LEASE_MS },
      match: { state: 'reading', at: now, runId: holder, ...ZERO_COUNTS },
    })
    return { claimed: true }
  },
})

/** Keeps the organisation while the contacts are read: a page at a time, so
 * a large book can't outlast the lease. LEASE_LOST if it went. */
export const renewLease = internalMutation({
  args: { connectionId: v.id('xeroConnections'), holder: v.string() },
  handler: async (ctx, { connectionId, holder }): Promise<null> => {
    await holdLease(ctx, connectionId, holder, Date.now())
    return null
  },
})

/** Lets the organisation go, if this run still has it. */
export const releaseTenant = internalMutation({
  args: { connectionId: v.id('xeroConnections'), holder: v.string() },
  handler: async (ctx, { connectionId, holder }): Promise<null> => {
    const sync = await syncRowOf(ctx, connectionId)
    if (sync?.lease?.holder === holder) {
      await ctx.db.patch('xeroSyncState', sync._id, { lease: undefined })
    }
    return null
  },
})

/**
 * Sets how the match stands — in practice, that it failed, and why.
 *
 * With `runId`, only while the match is still that run's: one overtaken by a
 * newer run (Check Xero again, a reconnect) must not overwrite it. Without —
 * a run that never got the organisation — only while no run of this
 * connection holds its lease, since that one will say how it went. Counts are
 * kept as they were.
 */
export const setMatchState = internalMutation({
  args: {
    connectionId: v.id('xeroConnections'),
    state: xeroMatchState,
    problem: v.optional(v.string()),
    runId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { connectionId, state, problem, runId },
  ): Promise<{ written: boolean }> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection) return { written: false }
    const now = Date.now()
    const sync = await ensureSyncRow(ctx, connection)
    if (runId !== undefined) {
      if (sync.match?.runId !== runId) return { written: false }
    } else if (sync.lease && sync.lease.until > now) {
      return { written: false }
    }
    const prior = sync.match
    const match: Match = {
      state,
      at: now,
      runId: runId ?? prior?.runId ?? '',
      contacts: prior?.contacts ?? 0,
      linked: prior?.linked ?? 0,
      review: prior?.review ?? 0,
      fresh: prior?.fresh ?? 0,
      different: prior?.different ?? 0,
      leads: prior?.leads ?? 0,
      ...(problem ? { problem } : {}),
    }
    await ctx.db.patch('xeroSyncState', sync._id, { match })
    return { written: true }
  },
})

/**
 * One page of the clients a connected organisation gets: the whole book,
 * less the Recycle bin and clients archived the legacy way (`archivedAt`),
 * which are never sent. Leads come back marked, to be counted and not
 * proposed. A page may come back short (or empty) when it held binned or
 * archived clients; `isDone` says when there are no more.
 *
 * Each with the emails the matcher compares — the client's own and, for a
 * business, its contact person's (lib/contactPerson.ts: the primary
 * `clientContacts` row, not in the bin) — and the holder's decision about
 * it in this organisation, if they made one.
 */
export const clientsForMatch = internalQuery({
  args: {
    businessId: v.id('businesses'),
    tenantId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (
    ctx,
    { businessId, tenantId, cursor },
  ): Promise<{
    page: Array<MatchClient>
    isDone: boolean
    continueCursor: string
  }> => {
    const result = await ctx.db
      .query('clients')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .paginate({ numItems: CLIENT_PAGE, cursor })

    const page: Array<MatchClient> = []
    for (const client of result.page) {
      if (!inXeroBook(client)) continue

      const emails = new Set<string>()
      const addEmail = (raw: string | undefined) => {
        const email = raw?.trim().toLowerCase()
        if (email) emails.add(email)
      }
      addEmail(client.email)
      if (client.kind === 'business') {
        const primary = await ctx.db
          .query('clientContacts')
          .withIndex('by_client', (q) => q.eq('clientId', client._id))
          .filter((q) =>
            q.and(
              q.eq(q.field('deletedAt'), undefined),
              q.eq(q.field('isPrimary'), true),
            ),
          )
          .first()
        addEmail(primary?.email)
      }

      const link = await linkOf(ctx, businessId, tenantId, client._id)
      const decided =
        link?.decidedAt !== undefined &&
        (link.state === 'linked' || link.state === 'separate')
          ? {
              state: link.state,
              ...(link.state === 'linked' && link.xeroContactId
                ? { xeroContactId: link.xeroContactId }
                : {}),
            }
          : undefined

      const phone = client.phone?.trim()
      const suburb = await oldestSiteSuburb(ctx, client._id)
      page.push({
        clientId: client._id,
        name: client.name,
        emails: [...emails],
        lead: client.status === 'lead',
        ...(client.clientNumber === undefined
          ? {}
          : { clientNumber: client.clientNumber }),
        ...(phone ? { phone } : {}),
        ...(suburb ? { suburb } : {}),
        ...(decided ? { decided } : {}),
      })
    }
    return {
      page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    }
  },
})

/** A link's fields for one proposal. Every field a proposal does not set is
 * cleared, so a client that was linked last run and is a question now says
 * only the question. */
function proposedFields(
  proposal: Infer<typeof proposalArg>,
  contestedByDecision: boolean,
): Pick<
  Doc<'xeroContactLinks'>,
  'state' | 'xeroContactId' | 'how' | 'candidate' | 'xeroName'
> {
  const cleared = {
    xeroContactId: undefined,
    how: undefined,
    candidate: undefined,
    xeroName: undefined,
  }
  if (proposal.outcome === 'new') return { ...cleared, state: 'new' }
  const { contact } = proposal
  if (proposal.outcome === 'linked' && !contestedByDecision) {
    return {
      ...cleared,
      state: 'linked',
      how: 'matched',
      xeroContactId: contact.contactId,
      xeroName: contact.name,
    }
  }
  return {
    ...cleared,
    state: 'needs_review',
    candidate: {
      contactId: contact.contactId,
      name: contact.name,
      reason:
        proposal.outcome === 'review' && !contestedByDecision
          ? proposal.reason
          : 'contested',
      ...(contact.email ? { email: contact.email } : {}),
      ...(contact.phone ? { phone: contact.phone } : {}),
      ...(contact.place ? { place: contact.place } : {}),
      ...(contact.accountNumber
        ? { accountNumber: contact.accountNumber }
        : {}),
    },
  }
}

/**
 * Stores one batch of a run's proposals, while the run still has the
 * organisation (LEASE_LOST otherwise) and the connection is still live.
 *
 * - A decided row (Same, Different, Unlink) is never touched: the holder's
 *   word stands over any run's.
 * - One Xero contact is one client per organisation, after every batch and
 *   not only once the run is done. A link the run proposes to a contact
 *   another client in the book is linked to by the holder's word is put to
 *   the holder as contested instead. One an EARLIER run linked to another
 *   client is stale — this run's matcher, which sees every client at once,
 *   gave the contact to this one — so that row goes now rather than when its
 *   own client's batch is saved: a run stopped in between must not leave two
 *   clients linked to one contact. A client out of the book (binned,
 *   archived) holds nothing (`othersLinkedTo`); its link goes too.
 * - A client binned, archived or wiped since the run read it is skipped; the
 *   run's finish drops what an earlier run left for it.
 *
 * Returns how many of the batch are linked, to check, new and different
 * now, each decided row skipped counted as it stands — the run's counts are
 * these.
 */
export const saveProposals = internalMutation({
  args: {
    connectionId: v.id('xeroConnections'),
    holder: v.string(),
    runId: v.string(),
    proposals: v.array(proposalArg),
  },
  handler: async (
    ctx,
    { connectionId, holder, runId, proposals },
  ): Promise<LinkCounts> => {
    await holdLease(ctx, connectionId, holder, Date.now())
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection || !isLiveXero(connection)) {
      throw new ConvexError('XERO_DISCONNECTED')
    }
    const { businessId, tenantId } = connection

    const counts: LinkCounts = { linked: 0, review: 0, fresh: 0, different: 0 }
    const tally = (state: Doc<'xeroContactLinks'>['state']) => {
      const delta = linkCounts(state, 1)
      counts.linked += delta.linked ?? 0
      counts.review += delta.review ?? 0
      counts.fresh += delta.fresh ?? 0
      counts.different += delta.different ?? 0
    }

    for (const proposal of proposals) {
      const client = await ctx.db.get('clients', proposal.clientId)
      if (!client || client.businessId !== businessId || !inXeroBook(client)) {
        continue
      }
      const link = await linkOf(ctx, businessId, tenantId, proposal.clientId)
      if (link?.decidedAt !== undefined) {
        tally(link.state)
        continue
      }

      let contestedByDecision = false
      let released: Array<Doc<'xeroContactLinks'>> = []
      if (proposal.outcome === 'linked') {
        const { holding, outOfBook } = await othersLinkedTo(ctx, {
          businessId,
          tenantId,
          contactId: proposal.contact.contactId,
          clientId: proposal.clientId,
        })
        // An undecided link this very run made can't be here (the matcher
        // never proposes one contact for two clients), but if it were, it
        // would be as good as this one: the holder is asked.
        const stale = holding.filter(
          (row) => row.decidedAt === undefined && row.runId !== runId,
        )
        contestedByDecision = holding.length > stale.length
        released = [...stale, ...outOfBook]
      }

      const fields = proposedFields(proposal, contestedByDecision)
      if (fields.state === 'linked') {
        for (const row of released) {
          await ctx.db.delete('xeroContactLinks', row._id)
        }
      }
      if (link) {
        await ctx.db.patch('xeroContactLinks', link._id, { ...fields, runId })
      } else {
        await ctx.db.insert('xeroContactLinks', {
          businessId,
          tenantId,
          clientId: proposal.clientId,
          ...fields,
          runId,
        })
      }
      tally(fields.state)
    }
    return counts
  },
})

/**
 * The end of a run: drops the undecided links an earlier run left — for
 * clients this one no longer proposes (binned, archived, become leads) —
 * then marks the match ready with the run's counts and lets the
 * organisation go.
 *
 * 500 links a call; with more, it carries on in a call of its own. Only
 * while the match is still this run's: a newer one, started meanwhile, owns
 * the links now and cleans up after itself.
 */
export const finishMatch = internalMutation({
  args: {
    connectionId: v.id('xeroConnections'),
    holder: v.string(),
    runId: v.string(),
    counts: countsArg,
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<{ done: boolean }> => {
    const { connectionId, holder, runId, counts } = args
    const sync = await syncRowOf(ctx, connectionId)
    if (!sync || sync.match?.runId !== runId) return { done: true }

    const result = await ctx.db
      .query('xeroContactLinks')
      .withIndex('by_business_and_tenant_and_client', (q) =>
        q.eq('businessId', sync.businessId).eq('tenantId', sync.tenantId),
      )
      .paginate({ numItems: STALE_BATCH, cursor: args.cursor ?? null })
    for (const link of result.page) {
      if (link.decidedAt === undefined && link.runId !== runId) {
        await ctx.db.delete('xeroContactLinks', link._id)
      }
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.xeroMatch.finishMatch, {
        connectionId,
        holder,
        runId,
        counts,
        cursor: result.continueCursor,
      })
      return { done: false }
    }

    await ctx.db.patch('xeroSyncState', sync._id, {
      match: { state: 'ready', at: Date.now(), runId, ...counts },
      ...(sync.lease?.holder === holder ? { lease: undefined } : {}),
    })
    return { done: true }
  },
})

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Reads one connection's organisation and proposes a Xero contact for every
 * client it gets. Scheduled by a connect (`xero.finish`) and by Check Xero
 * again (`rematch`); for whoever looks after the deployment,
 * `npx convex run xeroMatch:run '{"connectionId": "…"}'`.
 *
 * Does nothing on a deployment not set up for Xero, or for a connection that
 * is not connected (the page already says why). With the kill switch on it
 * reads nothing, and says so.
 */
export const run = internalAction({
  args: {
    connectionId: v.id('xeroConnections'),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { connectionId, attempt = 0 }): Promise<null> => {
    if (!xeroConfigured()) return null
    const found:
      | { ok: true; target: MatchTarget }
      | { ok: false; problem: MatchProblem | null } = await ctx.runQuery(
      internal.xeroMatch.forMatch,
      { connectionId },
    )
    if (!found.ok) {
      // Asked for while it was connected, and no longer is: say why rather
      // than leave the page reading.
      if (found.problem) {
        await ctx.runMutation(internal.xeroMatch.setMatchState, {
          connectionId,
          state: 'failed',
          problem: found.problem,
        })
      }
      return null
    }
    const target = found.target
    if (xeroPaused()) {
      await ctx.runMutation(internal.xeroMatch.setMatchState, {
        connectionId,
        state: 'failed',
        problem: 'paused' satisfies MatchProblem,
      })
      return null
    }

    const holder = crypto.randomUUID()
    const claim:
      | { claimed: true }
      | { claimed: false; reason: 'busy' }
      | { claimed: false; reason: 'gone'; problem: MatchProblem | null } =
      await ctx.runMutation(internal.xeroMatch.claimTenant, {
        connectionId,
        holder,
      })
    if (!claim.claimed) {
      if (claim.reason === 'gone') {
        if (claim.problem) {
          await ctx.runMutation(internal.xeroMatch.setMatchState, {
            connectionId,
            state: 'failed',
            problem: claim.problem,
          })
        }
        return null
      }
      if (attempt + 1 < BUSY_TRIES) {
        await ctx.scheduler.runAfter(BUSY_RETRY_MS, internal.xeroMatch.run, {
          connectionId,
          attempt: attempt + 1,
        })
      } else {
        await ctx.runMutation(internal.xeroMatch.setMatchState, {
          connectionId,
          state: 'failed',
          problem: 'busy' satisfies MatchProblem,
        })
      }
      return null
    }

    try {
      await matchUnderLease(ctx, connectionId, target, holder)
    } catch (error) {
      const problem = problemOf(error)
      console.error(
        `[xero] match for connection ${connectionId} stopped: ${problem} (${describe(error)})`,
      )
      if (error instanceof XeroError && error.classified.kind === 'reconnect') {
        // Xero refuses this organisation to a sign-in it otherwise accepts:
        // the connection needs reconnecting, as R1's organisation read
        // decides it. A dead sign-in (XERO_RECONNECT) is already marked.
        await ctx.runMutation(internal.xero.orgGone, { connectionId })
      }
      await ctx.runMutation(internal.xeroMatch.setMatchState, {
        connectionId,
        state: 'failed',
        problem,
        runId: holder,
      })
    } finally {
      await ctx.runMutation(internal.xeroMatch.releaseTenant, {
        connectionId,
        holder,
      })
    }
    return null
  },
})

/** Steps 2–5 of a run, with the organisation held. Throws on anything that
 * stops it; `run` words it. */
async function matchUnderLease(
  ctx: ActionCtx,
  connectionId: Id<'xeroConnections'>,
  target: MatchTarget,
  holder: string,
): Promise<void> {
  const runId = holder

  // Every contact, archived ones included (the matcher leaves them out).
  const token = { current: await accessTokenFor(ctx, target.grantId) }
  const contacts: Array<XeroContactRow> = []
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new ConvexError('XERO_TOO_MANY_CONTACTS')
    if (page > 1) await sleep(PAGE_GAP_MS)
    const { contacts: rows, rate } = await readContactsPage(
      ctx,
      target,
      page,
      token,
    )
    contacts.push(...rows)
    if (rows.length < CONTACTS_PAGE_SIZE) break
    await ctx.runMutation(internal.xeroMatch.renewLease, {
      connectionId,
      holder,
    })
    if (
      rate.minRemaining !== undefined &&
      rate.minRemaining <= MINUTE_RESERVE
    ) {
      await sleep(MINUTE_MS)
    }
  }

  // Every client the organisation gets.
  const clients: Array<MatchClient> = []
  let cursor: string | null = null
  for (;;) {
    const page: {
      page: Array<MatchClient>
      isDone: boolean
      continueCursor: string
    } = await ctx.runQuery(internal.xeroMatch.clientsForMatch, {
      businessId: target.businessId,
      tenantId: target.tenantId,
      cursor,
    })
    clients.push(...page.page)
    if (page.isDone) break
    cursor = page.continueCursor
  }

  // A lead waits for its first job and is only counted — unless the holder
  // already linked it (a client turned back into a lead keeps its link),
  // when it still reserves its contact.
  const leads = clients.filter((c) => c.lead && !c.decided).length
  const proposals = matchClients(
    clients.filter((c) => !c.lead || c.decided),
    contacts,
  )

  const totals: LinkCounts = { linked: 0, review: 0, fresh: 0, different: 0 }
  for (let i = 0; i < proposals.length; i += SAVE_BATCH) {
    const saved: LinkCounts = await ctx.runMutation(
      internal.xeroMatch.saveProposals,
      {
        connectionId,
        holder,
        runId,
        proposals: proposals.slice(i, i + SAVE_BATCH).map(toArg),
      },
    )
    totals.linked += saved.linked
    totals.review += saved.review
    totals.fresh += saved.fresh
    totals.different += saved.different
  }
  for (const client of clients) {
    if (client.decided?.state === 'linked') totals.linked += 1
    else if (client.decided?.state === 'separate') {
      totals.fresh += 1
      totals.different += 1
    }
  }

  await ctx.runMutation(internal.xeroMatch.finishMatch, {
    connectionId,
    holder,
    runId,
    counts: {
      contacts: contacts.filter((c) => c.status === 'ACTIVE').length,
      ...totals,
      leads,
    },
    cursor: null,
  })
}

/** A proposal as `saveProposals` takes it: the contact's matching fields
 * only (not Xero's first and last names, which the validator would refuse). */
function toArg(proposal: Proposal): Infer<typeof proposalArg> {
  if (proposal.outcome === 'new') {
    return { clientId: proposal.clientId, outcome: 'new' }
  }
  const c = proposal.contact
  const contact = {
    contactId: c.contactId,
    name: c.name,
    status: c.status,
    ...(c.email ? { email: c.email } : {}),
    ...(c.accountNumber ? { accountNumber: c.accountNumber } : {}),
    ...(c.phone ? { phone: c.phone } : {}),
    ...(c.place ? { place: c.place } : {}),
  }
  return proposal.outcome === 'linked'
    ? { clientId: proposal.clientId, outcome: 'linked', contact }
    : {
        clientId: proposal.clientId,
        outcome: 'review',
        contact,
        reason: proposal.reason,
      }
}

/**
 * One page of contacts. A lapsed access token (401) is refreshed once; Xero
 * busy, down or over its minute is waited out up to PAGE_TRIES times, a
 * minute at most each. Anything else — or a wait longer than that, such as
 * the day's allowance — stops the run.
 */
async function readContactsPage(
  ctx: ActionCtx,
  target: MatchTarget,
  page: number,
  token: { current: string },
): ReturnType<typeof getContactsPage> {
  let refreshed = false
  for (let tries = 1; ; tries++) {
    try {
      return await getContactsPage(token.current, target.tenantId, page)
    } catch (error) {
      if (!(error instanceof XeroError)) throw error
      const classified = error.classified
      if (classified.kind === 'refresh') {
        if (refreshed) throw error
        refreshed = true
        token.current = await accessTokenFor(ctx, target.grantId, {
          forceRefresh: true,
        })
        continue
      }
      const wait =
        classified.kind === 'retry'
          ? classified.afterMs
          : classified.kind === 'pause'
            ? classified.until - Date.now()
            : null
      if (wait === null || wait > MAX_PAGE_WAIT_MS || tries >= PAGE_TRIES) {
        throw error
      }
      await sleep(Math.max(wait, PAGE_GAP_MS))
    }
  }
}

/** Why a run stopped, as a code the page words. */
function problemOf(error: unknown): MatchProblem {
  if (error instanceof XeroError) {
    const classified = error.classified
    switch (classified.kind) {
      case 'refresh':
      case 'reconnect':
        return 'reconnect'
      case 'pause':
        return classified.why === 'server' ? 'xero_unavailable' : 'rate_limited'
      case 'retry':
        return 'xero_unavailable'
      default:
        return 'failed'
    }
  }
  if (error instanceof ConvexError) {
    switch (error.data) {
      case 'XERO_RECONNECT':
        return 'reconnect'
      case 'XERO_BUSY':
      case 'LEASE_LOST':
        return 'busy'
      case 'XERO_RETRY':
        return 'xero_unavailable'
      case 'XERO_TOO_MANY_CONTACTS':
        return 'too_many_contacts'
      case 'XERO_DISCONNECTED':
        return 'disconnected'
      default:
        return 'failed'
    }
  }
  return 'failed'
}

/** An error as a log line may carry it: never a token (no helper puts one
 * in a message). */
function describe(error: unknown): string {
  if (error instanceof XeroError) {
    return `${error.message} ${JSON.stringify(error.classified)}`
  }
  if (error instanceof ConvexError) return String(error.data)
  return error instanceof Error ? error.message : String(error)
}

// ───────────────────────────────────────────────────────────── the page

/**
 * The match page: one of its lists, 100 or so at a time. The holder only —
 * the owner for the business's organisation, the member for their own — and
 * only through a live connection: the links are the organisation's, so a
 * connection disconnected since (whose holder may have no say in that
 * organisation any more) reads nothing, and only the one live connection
 * that holds it now does.
 *
 * `review` is To check, `matched` the clients that are a Xero contact,
 * `new` the ones nothing matched, `separate` the ones the holder said were
 * different (or unlinked). A link whose client has since gone to the Recycle
 * bin, or was archived, is left out: it is not sent while it is there.
 */
export const reviewPage = query({
  args: {
    businessId: v.id('businesses'),
    connectionId: v.id('xeroConnections'),
    filter: v.union(
      v.literal('review'),
      v.literal('matched'),
      v.literal('new'),
      v.literal('separate'),
    ),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(reviewItem),
  handler: async (
    ctx,
    { businessId, connectionId, filter, paginationOpts },
  ) => {
    const env = await requireActor(ctx, businessId)
    const connection = await requireConnectionHolder(
      ctx,
      env,
      await ctx.db.get('xeroConnections', connectionId),
      businessId,
    )
    if (!isLiveXero(connection)) throw new ConvexError('NOT_FOUND')
    const result = await ctx.db
      .query('xeroContactLinks')
      .withIndex('by_business_and_tenant_and_state', (q) =>
        q
          .eq('businessId', businessId)
          .eq('tenantId', connection.tenantId)
          .eq('state', FILTER_STATE[filter]),
      )
      .paginate(paginationOpts)

    const page: Array<ReviewItem> = []
    for (const link of result.page) {
      const client = await ctx.db.get('clients', link.clientId)
      if (!client || client.businessId !== businessId || !inXeroBook(client)) {
        continue
      }
      page.push({
        clientId: client._id,
        clientName: client.name,
        clientNumber: client.clientNumber ?? null,
        clientPhone: client.phone?.trim() || null,
        clientSuburb: (await oldestSiteSuburb(ctx, client._id)) ?? null,
        state: link.state,
        how: link.how ?? null,
        candidate: link.candidate ?? null,
        xeroName: link.xeroName ?? null,
        decidedAt: link.decidedAt ?? null,
        decidedByYou:
          link.decidedByMembershipId !== undefined &&
          link.decidedByMembershipId === env.actor.real._id,
      })
    }
    return { ...result, page }
  },
})

/** The connection, its client and the client's link, for a decision by the
 * holder — or why not. */
async function forDecision(
  ctx: MutationCtx,
  {
    businessId,
    connectionId,
    clientId,
  }: {
    businessId: Id<'businesses'>
    connectionId: Id<'xeroConnections'>
    clientId: Id<'clients'>
  },
) {
  const env = await requireWriteActor(ctx, businessId)
  // Named, ahead of the holder check, so a switched owner is told to switch
  // back rather than that they may not (as `xero.disconnect` does).
  if (isSwitched(env.actor)) throw new ConvexError('SWITCHED')
  const connection = await requireConnectionHolder(
    ctx,
    env,
    await ctx.db.get('xeroConnections', connectionId),
    businessId,
  )
  if (!isLiveXero(connection)) throw new ConvexError('NOT_FOUND')
  const client = await ctx.db.get('clients', clientId)
  // Not one on no list: in the Recycle bin, or archived.
  if (!client || client.businessId !== businessId || !inXeroBook(client)) {
    throw new ConvexError('NOT_FOUND')
  }
  const link = await linkOf(ctx, businessId, connection.tenantId, clientId)
  if (!link) throw new ConvexError('NOT_FOUND')
  return { env, connection, link, now: Date.now() }
}

/**
 * Unlinks a linked client: it becomes `separate`, decided, so Release 3 adds
 * it to Xero as a new contact and no later match links it again. The
 * contact it was linked to is kept as its candidate (`unlinked`), so the
 * Different list can say which contact it isn't, and Match again can ask
 * about that contact once more.
 */
async function unlinkLink(
  ctx: MutationCtx,
  {
    connection,
    link,
    by,
    now,
  }: {
    connection: Doc<'xeroConnections'>
    link: Doc<'xeroContactLinks'>
    by: Id<'memberships'>
    now: number
  },
): Promise<void> {
  await ctx.db.patch('xeroContactLinks', link._id, {
    state: 'separate',
    xeroContactId: undefined,
    how: undefined,
    xeroName: undefined,
    candidate: link.xeroContactId
      ? {
          contactId: link.xeroContactId,
          name: link.xeroName ?? '',
          reason: 'unlinked',
        }
      : undefined,
    runId: undefined,
    decidedAt: now,
    decidedByMembershipId: by,
  })
  await adjustCounts(ctx, connection._id, movedCounts('linked', 'separate'))
  await recordAudit(ctx, forSelf(by), {
    businessId: connection.businessId,
    action: 'xero.unlink',
    entityType: 'clients',
    entityId: link.clientId,
    meta: {
      tenantName: connection.tenantName,
      ...(link.xeroContactId ? { xeroContactId: link.xeroContactId } : {}),
    },
    at: now,
  })
}

/**
 * Same client / Different client on a To check card.
 *
 * - `same`: this client IS the candidate. Refused with CONTACT_TAKEN when
 *   another client in the book is already linked to that contact — one Xero
 *   contact is one client per organisation, and that client is on Matched,
 *   to be unlinked there. A client in the Recycle bin, or archived, holds
 *   nothing (`othersLinkedTo`): its link goes, and if it is restored it is
 *   matched afresh.
 * - `different`: it is not; Release 3 adds it as a new contact. The candidate
 *   is kept on the row, for reference and for Match again. On a linked
 *   client it is Unlink.
 *
 * Either is the holder's word: no later match changes it; only Match again
 * (`reopen`) puts it back. Anything not to check (or, for Different, linked)
 * is NOT_FOUND — the page is behind.
 */
export const decide = mutation({
  args: {
    businessId: v.id('businesses'),
    connectionId: v.id('xeroConnections'),
    clientId: v.id('clients'),
    choice: v.union(v.literal('same'), v.literal('different')),
  },
  returns: v.null(),
  handler: async (ctx, { businessId, connectionId, clientId, choice }) => {
    const { env, connection, link, now } = await forDecision(ctx, {
      businessId,
      connectionId,
      clientId,
    })
    const by = env.actor.real._id

    if (choice === 'same') {
      const candidate = link.candidate
      if (link.state !== 'needs_review' || !candidate) {
        throw new ConvexError('NOT_FOUND')
      }
      const { holding, outOfBook } = await othersLinkedTo(ctx, {
        businessId,
        tenantId: connection.tenantId,
        contactId: candidate.contactId,
        clientId,
      })
      if (holding.length > 0) throw new ConvexError('CONTACT_TAKEN')
      for (const row of outOfBook) {
        await ctx.db.delete('xeroContactLinks', row._id)
      }
      await ctx.db.patch('xeroContactLinks', link._id, {
        state: 'linked',
        how: 'chosen',
        xeroContactId: candidate.contactId,
        xeroName: candidate.name,
        candidate: undefined,
        runId: undefined,
        decidedAt: now,
        decidedByMembershipId: by,
      })
      await adjustCounts(
        ctx,
        connection._id,
        movedCounts('needs_review', 'linked'),
      )
      await recordAudit(ctx, forSelf(by), {
        businessId,
        action: 'xero.link',
        entityType: 'clients',
        entityId: clientId,
        meta: {
          tenantName: connection.tenantName,
          xeroContactId: candidate.contactId,
        },
        at: now,
      })
      return null
    }

    if (link.state === 'linked') {
      await unlinkLink(ctx, { connection, link, by, now })
      return null
    }
    if (link.state !== 'needs_review') throw new ConvexError('NOT_FOUND')
    await ctx.db.patch('xeroContactLinks', link._id, {
      state: 'separate',
      runId: undefined,
      decidedAt: now,
      decidedByMembershipId: by,
    })
    await adjustCounts(
      ctx,
      connection._id,
      movedCounts('needs_review', 'separate'),
    )
    await recordAudit(ctx, forSelf(by), {
      businessId,
      action: 'xero.separate',
      entityType: 'clients',
      entityId: clientId,
      meta: {
        tenantName: connection.tenantName,
        ...(link.candidate ? { xeroContactId: link.candidate.contactId } : {}),
      },
      at: now,
    })
    return null
  },
})

/**
 * Unlink on a Matched client: PestM8 will add it to Xero as a new contact
 * instead, and no later match links it again. Anything not linked is
 * NOT_FOUND — the page is behind.
 */
export const unlink = mutation({
  args: {
    businessId: v.id('businesses'),
    connectionId: v.id('xeroConnections'),
    clientId: v.id('clients'),
  },
  returns: v.null(),
  handler: async (ctx, { businessId, connectionId, clientId }) => {
    const { env, connection, link, now } = await forDecision(ctx, {
      businessId,
      connectionId,
      clientId,
    })
    if (link.state !== 'linked') throw new ConvexError('NOT_FOUND')
    await unlinkLink(ctx, { connection, link, by: env.actor.real._id, now })
    return null
  },
})

/**
 * Match again, on the Different list: takes back a Different (or an Unlink)
 * and puts the client back to the holder, To check against the same contact
 * — what makes Different, which saves on one tap, safe to offer. Like the
 * answer it undoes it is the holder's, audited (`xero.reopen`), and moves
 * the counts.
 *
 * Undecided again, it is the latest run's: tagged with that run, so a run
 * finishing meanwhile keeps it, and the next Check Xero again proposes it
 * afresh. A Different row with no contact to ask about (none can be made
 * now; defensive) goes back to New to Xero instead. Anything not Different
 * is NOT_FOUND — the page is behind.
 */
export const reopen = mutation({
  args: {
    businessId: v.id('businesses'),
    connectionId: v.id('xeroConnections'),
    clientId: v.id('clients'),
  },
  returns: v.union(v.literal('needs_review'), v.literal('new')),
  handler: async (ctx, { businessId, connectionId, clientId }) => {
    const { env, connection, link, now } = await forDecision(ctx, {
      businessId,
      connectionId,
      clientId,
    })
    if (link.state !== 'separate' || link.decidedAt === undefined) {
      throw new ConvexError('NOT_FOUND')
    }
    const sync = await syncRowOf(ctx, connection._id)
    const state = link.candidate ? 'needs_review' : 'new'
    await ctx.db.patch('xeroContactLinks', link._id, {
      state,
      decidedAt: undefined,
      decidedByMembershipId: undefined,
      runId: sync?.match?.runId ?? '',
    })
    await adjustCounts(ctx, connection._id, movedCounts('separate', state))
    await recordAudit(ctx, forSelf(env.actor.real._id), {
      businessId,
      action: 'xero.reopen',
      entityType: 'clients',
      entityId: clientId,
      meta: {
        tenantName: connection.tenantName,
        ...(link.candidate ? { xeroContactId: link.candidate.contactId } : {}),
      },
      at: now,
    })
    return state
  },
})

/**
 * Check Xero again: reads the organisation's contacts afresh. Decisions are
 * kept; undecided proposals are replaced by the new run's. A run already
 * under way for this connection is the answer, so pressing it twice reads
 * Xero once.
 *
 * Release 2 allows it at any time; Release 3 refuses it once Start syncing
 * has been pressed (`syncStartedAt`), when the links are what is being sent.
 */
export const rematch = mutation({
  args: {
    businessId: v.id('businesses'),
    connectionId: v.id('xeroConnections'),
  },
  returns: v.null(),
  handler: async (ctx, { businessId, connectionId }) => {
    const env = await requireWriteActor(ctx, businessId)
    if (isSwitched(env.actor)) throw new ConvexError('SWITCHED')
    const connection = await requireConnectionHolder(
      ctx,
      env,
      await ctx.db.get('xeroConnections', connectionId),
      businessId,
    )
    if (!xeroConfigured()) throw new ConvexError('XERO_NOT_CONFIGURED')
    if (connection.status === 'needs_reconnect') {
      throw new ConvexError('XERO_RECONNECT')
    }
    if (connection.status !== 'connected') throw new ConvexError('NOT_FOUND')
    // Already reading, under a live lease: that read is the answer.
    if (!(await startMatch(ctx, connection))) {
      throw new ConvexError('XERO_MATCH_RUNNING')
    }
    return null
  },
})
