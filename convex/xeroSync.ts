import { ConvexError, v } from 'convex/values'
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import { hasCapability, requireActor, requireWriteActor } from './lib/actor'
import type { ActorEnvelope } from './lib/actor'
import { forSelf, recordAudit } from './lib/audit'
import { isBinned } from './lib/bin'
import { isSwitched } from './lib/capabilities'
import { inClientScope, visibleClientIds } from './lib/clientScope'
import {
  CONTACT_PERSONS_ON_MATCHED,
  XERO_CLEARS_WITH_EMPTY,
  diff,
  eligibility,
  fieldHash,
  fieldProblems,
  fieldsFromXero,
  isBlank,
  nextHashes,
  ownedFields,
  payloadProblems,
  suffixNames,
  toXeroCreate,
  toXeroUpdate,
  buildUpdateBatch,
} from './lib/xeroContact'
import { xeroConfigured, xeroPaused } from './lib/xeroConfig'
import {
  CONTACTS_PAGE_SIZE,
  CONTACT_IDS_PER_READ,
  XeroError,
  getContactByName,
  getContactsByIds,
  getContactsPage,
  isNameClash,
  newIdempotencyKey,
  postContacts,
  putContacts,
} from './lib/xeroHttp'
import {
  addCounts,
  addSyncCounts,
  inXeroBook,
  isLiveXero,
  isSoftXeroProblem,
  linkCounts,
  moveMatchCounts,
  moveSharesOf,
  moveSyncCounts,
  queueClientForXero,
  releaseSharesOf,
  requireConnectionHolder,
  syncCounts,
} from './lib/xeroHooks'
import { accountNumberKey, matchClients } from './lib/xeroMatch'
import { DEMO_PLAN } from './demo/shared'
import { accessTokenFor } from './xeroTokens'
import {
  LEASE_MS,
  ensureSyncRow,
  holdLease,
  linkOf,
  othersLinkedTo,
  syncRowOf,
  tenantBusy,
} from './xeroMatch'
import {
  xeroCandidate,
  xeroFieldHashes,
  xeroLinkHow,
  xeroPauseReason,
} from './schema'
import type { Infer } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'
import type {
  ContactInput,
  Eligibility,
  FieldHashes,
  FieldKey,
  Fields,
  LinkHashes,
  LinkHow,
} from './lib/xeroContact'
import type {
  ItemResult,
  XeroContactFull,
  XeroContactRow,
  XeroRate,
} from './lib/xeroHttp'
import type { MatchCountsDelta, SyncCountsDelta } from './lib/xeroHooks'
import type { ClientForMatch } from './lib/xeroMatch'

/**
 * Sending the client book to Xero (Release 3): every connected organisation
 * that pressed Start syncing gets every client — less leads not yet booked,
 * the Recycle bin and legacy-archived clients — and every later change.
 * One-way, PestM8 → Xero, and never a delete or an archive there.
 *
 * ── Where the work comes from ─────────────────────────────────────────────
 *
 * - Live edits: every write to a client, its contacts or its sites queues
 *   the client for each sending organisation (lib/xeroHooks.ts, one
 *   `xeroOutbox` row per connection and client) and asks for a drain.
 * - The walk of the book: after Start syncing, the drain pages through the
 *   business's clients (`backfillCursor`) adding or filling in each one.
 *   Live edits always go first.
 *
 * ── A drain (`drain`, one organisation at a time) ─────────────────────────
 *
 *  1. Nothing on a deployment not set up for Xero, or with the kill switch
 *     on (`XERO_SYNC_PAUSED=on`): changes wait in the outbox.
 *  2. Takes the TENANT lease — Release 2's, on `xeroSyncState`: one drain or
 *     match per Xero organisation across every business, because Xero's
 *     limits (60 calls a minute, 5,000 a day, 5 at once) are the
 *     organisation's. Refused for the demo business, a connection not
 *     connected or not started, or while Xero said to wait (`pausedUntil`).
 *  3. Up to ten pages of fifty (`nextWork`): due outbox rows first, then the
 *     walk. Each client is judged as it is NOW (lib/xeroContact.ts
 *     `eligibility`): gone, binned, archived, stopped, sharing another
 *     client's contact, to check, an unbooked lead — nothing sent;
 *     otherwise created or updated.
 *     - Creates: ten or more at once read the organisation's contacts first
 *       and match them as Release 2 does (a contact made in Xero since the
 *       match is linked, not duplicated). The rest are one `PUT`, with a
 *       fresh Idempotency-Key per request, reused only for its own retries.
 *     - Updates: an unchanged client costs nothing. The rest are read by id
 *       (one GET per fifty): merged in Xero → linked to the survivor;
 *       archived → stopped; erased (GDPR) → stopped for good; otherwise
 *       compared field by field (`diff`: only what PestM8 changed and Xero
 *       did not) and one `POST` with every element's ContactID.
 *     - A name another contact has (`resolveCreateClash`): one free here
 *       with the client's number, and not the contact the holder said it
 *       isn't, is linked as a match (most likely our own create whose answer
 *       was lost); a contact nobody here holds is put to the holder (To
 *       check); otherwise the suburb, then the number, after the name.
 *     - Before every write, and once a minute otherwise (`checkpoint`): the
 *       lease renewed, and the kill switch and the connection read afresh —
 *       a long page never outlives the lease, and a switch or a Disconnect
 *       stops the drain at its next write.
 *  4. Records each page (`recordResults`) while it still holds the lease:
 *     links, compare-before-set hashes, counts, recent problems, the walk's
 *     cursor, Xero's day allowance. An outbox row goes only if no change
 *     came in while it was being sent (`rev`).
 *  5. Lets the organisation go, and asks for the next drain when there is
 *     more: the earliest due row, the walk, or when a pause ends.
 *
 * Xero saying no: a 401 is refreshed once; busy or down is tried three
 * more times (2, 5, 15 s), then the page backs off; a rate limit pauses the
 * organisation until Xero says; a refused sign-in or organisation marks the
 * connection for reconnecting, the outbox kept. At least 1.1 s between calls.
 * Raw Xero text goes only to `console.error`, client names taken out; rows
 * hold codes the screen words (src/components/xero/xeroCopy.ts).
 *
 * ── Errors the page words ─────────────────────────────────────────────────
 *
 * NOT_FOUND, NO_ACCESS, SWITCHED, XERO_NOT_CONFIGURED, XERO_DEMO,
 * XERO_RECONNECT, MATCH_STALE. (LEASE_LOST and XERO_HALTED stay inside a
 * drain.)
 */

// ───────────────────────────────────────────────────────────────── limits

/** Clients per page of work, and per request: Xero's own guidance for
 * batched contact writes, and what one GET by ids reads. */
const BATCH = CONTACT_IDS_PER_READ
/** A drain's pages, and its time: past either it lets the organisation go
 * and asks for another, so a long walk never holds it for one action's
 * whole life. */
const MAX_PAGES_PER_DRAIN = 10
const DRAIN_BUDGET_MS = 120_000
/** Between any two calls to one organisation (60 a minute is Xero's). */
const CALL_GAP_MS = 1100
/** Xero says the minute's allowance is down to this: wait for the next. */
const MINUTE_RESERVE = 1
const MINUTE_MS = 60_000
/** Busy or down: tried again this long after each failure, then given up. */
const RETRY_WAITS_MS = [2000, 5000, 15_000] as const
/** Fewer of the day's calls than this left: the walk waits an hour, so what
 * is left goes to live edits. */
const DAY_RESERVE = 200
const BACKFILL_HOLD_MS = 60 * 60_000
/** This many creates at once read the organisation's contacts first. */
const PREMATCH_MIN = 10
/** Pages of 1,000 read for that, at most. */
const MAX_CONTACT_PAGES = 50
/** A page that failed for a reason worth trying again waits this long, by
 * the number of times it has; past the last, it is given up as failed. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const
const MAX_ATTEMPTS = 8
/** Xero failing a whole request: the organisation is left alone this long. */
const SERVER_PAUSE_MS = 60_000
/** Someone else holds the organisation: tried again this often, so many
 * times; the reconciler catches anything after. */
const BUSY_RETRY_MS = 30_000
const BUSY_TRIES = 5
/** A drain that made no headway waits at least this before the next. */
const STALLED_WAIT_MS = 60_000
/** Rows overdue by this much mean the drain that was to send them died. */
const OVERDUE_MS = 60_000
/** A drain renews its lease, and checks it may go on, at least this often —
 * a fifth of the lease — and before every write (`checkpoint`). */
const CHECK_EVERY_MS = 60_000
/** Recent problems kept, and shown. */
const RECENT_MAX = 20
/** Recent problems Settings lists (xero.ts `status`). */
export const RECENT_SHOWN = 5
/** Start syncing needs a match this fresh: the links are what is sent. */
const MATCH_FRESH_MS = 7 * 24 * 60 * 60_000
/** Batches for the clean-ups that page. */
const DROP_BATCH = 500
const RECOUNT_BATCH = 300
const CLEAR_BATCH = 200
/** "Waiting to send" is shown as 99+ past this (xero.ts `status` counts to
 * it too). */
export const WAITING_CAP = 100
/** An import's clients counted for its undo dialog, at most. */
const IMPORT_NOTE_MAX = 2000

/**
 * A field's `seen` hash set by "Send PestM8's details" (`overwrite`): the
 * next send takes Xero's value as it then is for this field's baseline, so
 * PestM8's goes over it. Never a real hash (those are base-36 digits).
 */
const OVERWRITE_MARK = 'overwrite'

/**
 * A key of `seen` (never a `FieldKey`) set when a link moves to the contact
 * Xero merged its old one into: the next send fills that contact's blanks
 * from PestM8, as a new link's first send does, on top of carrying over what
 * the old contact had been sent. Gone after that send.
 */
const RELINKED_KEY = 'relinked'

/**
 * `seen.accountNumber` once Xero is known to give this client's number to
 * another ACTIVE contact (Release 2's rule): the number is left out until it
 * changes, rather than re-checked on every send.
 */
function heldNumberMark(accountNumber: unknown): string {
  return `held:${typeof accountNumber === 'string' ? accountNumber : ''}`
}

// ───────────────────────────────────────────────────────────────── shapes

const outcomeArg = v.union(
  /** Nothing to send (unchanged, or not eligible): its row goes. */
  v.object({
    kind: v.literal('skip'),
    clientId: v.id('clients'),
    rev: v.union(v.number(), v.null()),
  }),
  /** Linked to this contact, written or not. */
  v.object({
    kind: v.literal('linked'),
    clientId: v.id('clients'),
    rev: v.union(v.number(), v.null()),
    /** The contact the link named when the page was read (null: none). A
     * link moved since, by the holder, is theirs: this is not applied. */
    expect: v.union(v.string(), v.null()),
    xeroContactId: v.string(),
    xeroName: v.string(),
    how: v.optional(xeroLinkHow),
    sent: xeroFieldHashes,
    seen: xeroFieldHashes,
    different: v.array(v.string()),
    wrote: v.boolean(),
    problem: v.optional(v.string()),
  }),
  /** A contact the holder must decide about; nothing written. */
  v.object({
    kind: v.literal('review'),
    clientId: v.id('clients'),
    rev: v.union(v.number(), v.null()),
    /** The contact the link named when read (null: none), as `linked`'s. */
    expect: v.union(v.string(), v.null()),
    candidate: xeroCandidate,
  }),
  /** Archived or erased in Xero: no longer sent. */
  v.object({
    kind: v.literal('stopped'),
    clientId: v.id('clients'),
    rev: v.union(v.number(), v.null()),
    state: v.union(v.literal('archived_in_xero'), v.literal('gdpr')),
    xeroContactId: v.string(),
  }),
  /** Xero merged its contact into another: linked to that one (keeping
   * what was sent and seen), and sent to it next. */
  v.object({
    kind: v.literal('relink'),
    clientId: v.id('clients'),
    rev: v.union(v.number(), v.null()),
    from: v.string(),
    xeroContactId: v.string(),
    xeroName: v.string(),
  }),
  /** Xero refused this client (a code the page words). */
  v.object({
    kind: v.literal('failed'),
    clientId: v.id('clients'),
    rev: v.union(v.number(), v.null()),
    code: v.string(),
    creating: v.boolean(),
  }),
  /** Not sent for a reason worth trying again: backs off. */
  v.object({
    kind: v.literal('retry'),
    clientId: v.id('clients'),
    rev: v.union(v.number(), v.null()),
    code: v.string(),
  }),
)

type Outcome = Infer<typeof outcomeArg>
type Candidate = Infer<typeof xeroCandidate>
type PauseReason = Infer<typeof xeroPauseReason>

/** One client of a page of work, as `nextWork` reads it. */
type WorkItem = {
  clientId: Id<'clients'>
  /** Its outbox row's rev, or null for the walk of the book. */
  rev: number | null
  /** Null: the client is gone. */
  input: ContactInput | null
  link: Doc<'xeroContactLinks'> | null
}

type Work = {
  items: Array<WorkItem>
  /** Where the walk is after this page, when the page read some of it. */
  backfill: { cursor: string; done: boolean } | null
}

type SyncTarget = {
  grantId: Id<'xeroGrants'>
  tenantId: string
  businessId: Id<'businesses'>
}

type Claim =
  | { claimed: true; target: SyncTarget }
  | { claimed: false; reason: 'busy' | 'gone' }
  | { claimed: false; reason: 'paused'; until: number }

/** Why a page stopped short. `halt`: the kill switch went on, or the
 * connection was disconnected or stopped being connected, mid-drain. */
type Stop =
  | { kind: 'pause'; until: number; why: PauseReason }
  | { kind: 'reconnect'; markOrg: boolean }
  | { kind: 'failed'; code: string }
  | { kind: 'lease' }
  | { kind: 'halt' }

// ──────────────────────────────────────────────────────────────── reading

/** Whether the import that brought this client in is being undone (or has
 * been, and has yet to clear the client's mark — it keeps it, then). */
async function undoingImport(
  ctx: QueryCtx,
  client: Doc<'clients'>,
): Promise<boolean> {
  if (client.importId === undefined) return false
  const run = await ctx.db.get('clientImports', client.importId)
  return run?.undoneAt !== undefined
}

/** A client as its contact is made from (lib/xeroContact.ts
 * `ContactInput`). Its contacts are a handful; its oldest live site one
 * indexed read. */
async function contactInputOf(
  ctx: QueryCtx,
  client: Doc<'clients'>,
  businessState: string | undefined,
): Promise<ContactInput> {
  let primary: ContactInput['primary'] = null
  const others: ContactInput['others'] = []
  // A person switched from a business keeps its contacts hidden, not sent
  // (lib/contactPerson.ts).
  if (client.kind === 'business') {
    const rows = (
      await ctx.db
        .query('clientContacts')
        .withIndex('by_client', (q) => q.eq('clientId', client._id))
        .take(100)
    ).filter((row) => !isBinned(row))
    const star = rows.find(
      (row) => row.isPrimary === true && row.name.trim() !== '',
    )
    const withEmail = (row: Doc<'clientContacts'>) => {
      const email = row.email?.trim()
      return { name: row.name.trim(), ...(email ? { email } : {}) }
    }
    if (star) primary = withEmail(star)
    for (const row of [...rows].sort((a, b) => a.createdAt - b.createdAt)) {
      if (row === star || row.name.trim() === '') continue
      others.push(withEmail(row))
    }
  }
  const site = await ctx.db
    .query('properties')
    .withIndex('by_client', (q) => q.eq('clientId', client._id))
    .filter((q) => q.eq(q.field('deletedAt'), undefined))
    .first()
  return {
    client,
    primary,
    others,
    oldestSite: site
      ? {
          addressLine: site.addressLine,
          suburb: site.suburb,
          state: site.state,
          postcode: site.postcode,
        }
      : null,
    ...(businessState ? { businessState } : {}),
    ...((await undoingImport(ctx, client)) ? { undoing: true } : {}),
  }
}

async function workItemOf(
  ctx: QueryCtx,
  connection: Doc<'xeroConnections'>,
  businessState: string | undefined,
  clientId: Id<'clients'>,
  rev: number | null,
): Promise<WorkItem> {
  const client = await ctx.db.get('clients', clientId)
  if (!client || client.businessId !== connection.businessId) {
    return { clientId, rev, input: null, link: null }
  }
  return {
    clientId,
    rev,
    input: await contactInputOf(ctx, client, businessState),
    link: await linkOf(
      ctx,
      connection.businessId,
      connection.tenantId,
      clientId,
    ),
  }
}

/**
 * The next page of one connection's work, at most fifty clients: its due
 * outbox rows first, oldest due first; then, while there is room and the
 * walk is neither done nor held for the day's allowance, the next clients of
 * the book that need adding or filling in and are not already queued. Each
 * with what its contact is made from and its link, read now.
 *
 * `now` from the caller: a query never reads the clock.
 */
export const nextWork = internalQuery({
  args: {
    connectionId: v.id('xeroConnections'),
    now: v.number(),
    allowBackfill: v.boolean(),
  },
  handler: async (
    ctx,
    { connectionId, now, allowBackfill },
  ): Promise<Work | null> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    // Read afresh for every page: the kill switch, a Disconnect or a
    // reconnect needed stop a drain here, not just at its next claim.
    if (
      !connection ||
      connection.status !== 'connected' ||
      connection.syncStartedAt === undefined ||
      xeroPaused()
    ) {
      return null
    }
    const business = await ctx.db.get('businesses', connection.businessId)
    const businessState = business?.state
    const sync = await syncRowOf(ctx, connectionId)

    const items: Array<WorkItem> = []
    const due = await ctx.db
      .query('xeroOutbox')
      .withIndex('by_connection_and_dueAt', (q) =>
        q.eq('connectionId', connectionId).lte('dueAt', now),
      )
      .take(BATCH)
    for (const row of due) {
      items.push(
        await workItemOf(ctx, connection, businessState, row.clientId, row.rev),
      )
    }

    const walking =
      allowBackfill &&
      sync !== null &&
      sync.backfillDoneAt === undefined &&
      !(sync.backfillHeldUntil !== undefined && sync.backfillHeldUntil > now)
    if (!walking || items.length >= BATCH) return { items, backfill: null }

    const page = await ctx.db
      .query('clients')
      .withIndex('by_business', (q) =>
        q.eq('businessId', connection.businessId),
      )
      .paginate({
        numItems: BATCH - items.length,
        cursor: sync.backfillCursor ?? null,
      })
    const taken = new Set(items.map((item) => item.clientId))
    for (const client of page.page) {
      if (taken.has(client._id)) continue
      // Queued already: the live row sends it.
      const queued = await ctx.db
        .query('xeroOutbox')
        .withIndex('by_connection_and_client', (q) =>
          q.eq('connectionId', connectionId).eq('clientId', client._id),
        )
        .first()
      if (queued) continue
      const link = await linkOf(
        ctx,
        connection.businessId,
        connection.tenantId,
        client._id,
      )
      // Judged on the client and its link alone first — all eligibility
      // reads — so a lead or a binned client costs no reads of its contacts
      // and sites.
      const judged = eligibility(
        {
          client,
          primary: null,
          others: [],
          oldestSite: null,
          undoing: await undoingImport(ctx, client),
        },
        link,
      )
      if (judged !== 'create' && judged !== 'update') continue
      items.push({
        clientId: client._id,
        rev: null,
        input: await contactInputOf(ctx, client, businessState),
        link,
      })
    }
    return {
      items,
      backfill: { cursor: page.continueCursor, done: page.isDone },
    }
  },
})

/** When this connection's next drain is wanted, or null for never (nothing
 * waiting, or it is not sending — the kill switch included: the reconciler
 * picks it up once it is off). Never before a pause ends. */
export const nextDrainAt = internalQuery({
  args: { connectionId: v.id('xeroConnections'), now: v.number() },
  handler: async (ctx, { connectionId, now }): Promise<number | null> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (
      !connection ||
      connection.status !== 'connected' ||
      connection.syncStartedAt === undefined ||
      xeroPaused()
    ) {
      return null
    }
    const sync = await syncRowOf(ctx, connectionId)
    const first = await ctx.db
      .query('xeroOutbox')
      .withIndex('by_connection_and_dueAt', (q) =>
        q.eq('connectionId', connectionId),
      )
      .first()
    let next: number | null = first ? first.dueAt : null
    if (sync && sync.backfillDoneAt === undefined) {
      const walkAt =
        sync.backfillHeldUntil !== undefined && sync.backfillHeldUntil > now
          ? sync.backfillHeldUntil
          : now
      next = next === null ? walkAt : Math.min(next, walkAt)
    }
    if (
      next !== null &&
      sync?.pausedUntil !== undefined &&
      sync.pausedUntil > next
    ) {
      next = sync.pausedUntil
    }
    return next
  },
})

/**
 * Of these Xero contacts, the ones a client in the book here other than
 * `exceptClientId` is linked to in this organisation — one Xero contact is
 * one client. A client in the Recycle bin or archived holds nothing (as
 * `xeroMatch.othersLinkedTo` has it); nor does one using another client's
 * contact (`shared`): that client holds it, and is what makes it held.
 */
export const contactsHeld = internalQuery({
  args: {
    connectionId: v.id('xeroConnections'),
    contactIds: v.array(v.string()),
    exceptClientId: v.optional(v.id('clients')),
  },
  handler: async (
    ctx,
    { connectionId, contactIds, exceptClientId },
  ): Promise<Array<string>> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection) return []
    const held: Array<string> = []
    for (const contactId of new Set(contactIds)) {
      const rows = await ctx.db
        .query('xeroContactLinks')
        .withIndex('by_business_and_tenant_and_contact', (q) =>
          q
            .eq('businessId', connection.businessId)
            .eq('tenantId', connection.tenantId)
            .eq('xeroContactId', contactId),
        )
        .take(20)
      for (const row of rows) {
        if (row.clientId === exceptClientId || row.state !== 'linked') continue
        const client = await ctx.db.get('clients', row.clientId)
        if (client && inXeroBook(client)) {
          held.push(contactId)
          break
        }
      }
    }
    return held
  },
})

// ─────────────────────────────────────────────────────────── the lease

/**
 * Takes the organisation for one drain (or a dry run's read of its
 * contacts), on Release 2's tenant lease: refused while anyone, in any
 * business, holds a live lease on it — a match, or another business's
 * drain to the same organisation.
 *
 * A drain is refused, too, for what it must never write to: a deployment
 * not set up for Xero, the kill switch, the demo business, a connection not
 * connected or not started, and an organisation Xero told to wait. A dry
 * run, which writes nothing, needs only a connected connection.
 */
export const claimTenant = internalMutation({
  args: {
    connectionId: v.id('xeroConnections'),
    holder: v.string(),
    purpose: v.union(v.literal('drain'), v.literal('dryRun')),
  },
  handler: async (ctx, { connectionId, holder, purpose }): Promise<Claim> => {
    if (!xeroConfigured()) return { claimed: false, reason: 'gone' }
    const draining = purpose === 'drain'
    if (draining && xeroPaused()) return { claimed: false, reason: 'gone' }
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection || connection.status !== 'connected') {
      return { claimed: false, reason: 'gone' }
    }
    if (draining && connection.syncStartedAt === undefined) {
      return { claimed: false, reason: 'gone' }
    }
    const business = await ctx.db.get('businesses', connection.businessId)
    if (!business || business.plan === DEMO_PLAN) {
      return { claimed: false, reason: 'gone' }
    }

    const now = Date.now()
    const sync = await ensureSyncRow(ctx, connection)
    if (sync.pausedUntil !== undefined && sync.pausedUntil > now) {
      return { claimed: false, reason: 'paused', until: sync.pausedUntil }
    }
    if (await tenantBusy(ctx, connection.tenantId, holder, now)) {
      return { claimed: false, reason: 'busy' }
    }
    await ctx.db.patch('xeroSyncState', sync._id, {
      lease: { holder, until: now + LEASE_MS },
      // A pause that has run out says nothing any more.
      ...(sync.pausedUntil !== undefined
        ? { pausedUntil: undefined, pauseReason: undefined }
        : {}),
    })
    return {
      claimed: true,
      target: {
        grantId: connection.grantId,
        tenantId: connection.tenantId,
        businessId: connection.businessId,
      },
    }
  },
})

/**
 * A drain's `checkpoint`: renews its lease (LEASE_LOST if the organisation
 * is someone else's now), and says whether it may go on writing —
 * XERO_HALTED once the kill switch is on, or the connection is no longer
 * connected and started (a Disconnect, a member who left, a reconnect
 * needed). A dry run, which writes nothing, needs only the lease and a
 * connected connection.
 */
export const keepGoing = internalMutation({
  args: {
    connectionId: v.id('xeroConnections'),
    holder: v.string(),
    purpose: v.union(v.literal('drain'), v.literal('dryRun')),
  },
  handler: async (ctx, { connectionId, holder, purpose }): Promise<null> => {
    await holdLease(ctx, connectionId, holder, Date.now())
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection || connection.status !== 'connected') {
      throw new ConvexError('XERO_HALTED')
    }
    if (
      purpose === 'drain' &&
      (xeroPaused() || connection.syncStartedAt === undefined)
    ) {
      throw new ConvexError('XERO_HALTED')
    }
    return null
  },
})

/** Xero said to wait (or kept failing): nothing is sent to this
 * organisation until `until`. Kept if a later pause is already set. */
export const holdOff = internalMutation({
  args: {
    connectionId: v.id('xeroConnections'),
    until: v.number(),
    why: xeroPauseReason,
  },
  handler: async (ctx, { connectionId, until, why }): Promise<null> => {
    const sync = await syncRowOf(ctx, connectionId)
    if (!sync) return null
    if (sync.pausedUntil !== undefined && sync.pausedUntil >= until) return null
    await ctx.db.patch('xeroSyncState', sync._id, {
      pausedUntil: until,
      pauseReason: why,
    })
    await ctx.scheduler.runAt(until, internal.xeroSync.clearLapsed, {
      connectionId,
    })
    return null
  },
})

// ─────────────────────────────────────────────────────────── recording

/** How long a page that failed waits before its next try. */
function backoff(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[0]
}

type Tally = {
  sync: SyncCountsDelta
  match: MatchCountsDelta
}

/**
 * What one page of a drain did, stored — only while the drain still holds
 * the organisation (LEASE_LOST otherwise: whatever took it over reads the
 * same rows afresh, and a contact this drain made is found again by its
 * name and number).
 *
 * Per client: its link (one Xero contact is one client per organisation),
 * the hashes compare-before-set reads next time, and its outbox row —
 * deleted only if no change came in while this page was out (`rev`). Then
 * the organisation's counts, recent problems, when it was last written, the
 * walk's cursor (`backfill`, only for a page wholly handled), Xero's day
 * allowance — the walk held for an hour when it runs low — and any pause.
 */
export const recordResults = internalMutation({
  args: {
    connectionId: v.id('xeroConnections'),
    holder: v.string(),
    outcomes: v.array(outcomeArg),
    backfill: v.union(
      v.null(),
      v.object({ cursor: v.string(), done: v.boolean() }),
    ),
    dayRemaining: v.optional(v.number()),
    pause: v.optional(v.object({ until: v.number(), why: xeroPauseReason })),
  },
  handler: async (
    ctx,
    { connectionId, holder, outcomes, backfill, dayRemaining, pause },
  ): Promise<null> => {
    const now = Date.now()
    const held = await holdLease(ctx, connectionId, holder, now)
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection) throw new ConvexError('NOT_FOUND')

    const tally: Tally = { sync: {}, match: {} }
    const recent = [...(held.recent ?? [])]
    let listed = false
    let wrote = false
    for (const outcome of outcomes) {
      const result = await applyOutcome(ctx, connection, outcome, now, tally)
      if (result.problem) {
        recent.unshift({
          clientId: outcome.clientId,
          code: result.problem,
          at: now,
        })
        listed = true
      }
      if (result.wrote) wrote = true
    }

    // Re-read: holdLease and the links' writes have moved on from `held`.
    const sync = await ctx.db.get('xeroSyncState', held._id)
    if (!sync) throw new ConvexError('NOT_FOUND')
    await moveMatchCounts(ctx, sync, tally.match)

    const waiting = (
      await ctx.db
        .query('xeroOutbox')
        .withIndex('by_connection_and_dueAt', (q) =>
          q.eq('connectionId', connectionId),
        )
        .take(WAITING_CAP)
    ).length
    const counts = sync.counts
      ? {
          inXero: Math.max(0, sync.counts.inXero + (tally.sync.inXero ?? 0)),
          review: Math.max(0, sync.counts.review + (tally.sync.review ?? 0)),
          different: Math.max(
            0,
            sync.counts.different + (tally.sync.different ?? 0),
          ),
          failed: Math.max(0, sync.counts.failed + (tally.sync.failed ?? 0)),
          stopped: Math.max(0, sync.counts.stopped + (tally.sync.stopped ?? 0)),
          waiting,
        }
      : undefined

    await ctx.db.patch('xeroSyncState', sync._id, {
      ...(counts ? { counts } : {}),
      ...(listed ? { recent: recent.slice(0, RECENT_MAX) } : {}),
      ...(wrote ? { lastSentAt: now } : {}),
      ...(backfill
        ? {
            backfillCursor: backfill.cursor,
            ...(backfill.done ? { backfillDoneAt: now } : {}),
          }
        : {}),
      ...(dayRemaining !== undefined
        ? {
            dayRemaining,
            dayRemainingAt: now,
            ...(dayRemaining < DAY_RESERVE
              ? { backfillHeldUntil: now + BACKFILL_HOLD_MS }
              : {}),
          }
        : {}),
      ...(pause ? { pausedUntil: pause.until, pauseReason: pause.why } : {}),
    })
    // The walk is done: the tallies, moved one link at a time since Start
    // syncing, are counted afresh once.
    if (backfill?.done) {
      await ctx.scheduler.runAfter(0, internal.xeroSync.recount, {
        connectionId,
      })
    }
    // A pause or a hold says nothing once over: cleared then, so the page
    // never draws a line about one that has run out.
    for (const until of [
      pause?.until,
      dayRemaining !== undefined && dayRemaining < DAY_RESERVE
        ? now + BACKFILL_HOLD_MS
        : undefined,
    ]) {
      if (until !== undefined) {
        await ctx.scheduler.runAt(until, internal.xeroSync.clearLapsed, {
          connectionId,
        })
      }
    }
    // Disconnected while this page was out: what it did is recorded, and
    // anything it queued goes, as Disconnect's own drop did.
    if (!isLiveXero(connection)) {
      await ctx.scheduler.runAfter(0, internal.xeroSync.dropOutbox, {
        connectionId,
      })
    }
    return null
  },
})

/**
 * A pause, or the walk's hold for the day's allowance, that has run out:
 * cleared, so nothing on the page speaks of it (scheduled for the moment it
 * ends, by whatever set it). One set later since is left for its own.
 */
export const clearLapsed = internalMutation({
  args: { connectionId: v.id('xeroConnections') },
  handler: async (ctx, { connectionId }): Promise<null> => {
    const sync = await syncRowOf(ctx, connectionId)
    if (!sync) return null
    const now = Date.now()
    const pauseOver = sync.pausedUntil !== undefined && sync.pausedUntil <= now
    const holdOver =
      sync.backfillHeldUntil !== undefined && sync.backfillHeldUntil <= now
    if (pauseOver || holdOver) {
      await ctx.db.patch('xeroSyncState', sync._id, {
        ...(pauseOver
          ? { pausedUntil: undefined, pauseReason: undefined }
          : {}),
        ...(holdOver ? { backfillHeldUntil: undefined } : {}),
      })
    }
    return null
  },
})

/** Adds the move of one link, from how it was to how it is, to the page's
 * counts — for a client in the book; one out of it is in none. */
function tallyLink(
  tally: Tally,
  counted: boolean,
  before: Doc<'xeroContactLinks'> | null,
  after: Pick<
    Doc<'xeroContactLinks'>,
    'state' | 'different' | 'problem' | 'xeroContactId'
  >,
): void {
  if (!counted) return
  tally.sync = addSyncCounts(
    tally.sync,
    addSyncCounts(syncCounts(before, -1), syncCounts(after, 1)),
  )
  tally.match = addCounts(
    tally.match,
    addCounts(
      before ? linkCounts(before.state, -1) : {},
      linkCounts(after.state, 1),
    ),
  )
}

/** One client's outcome, stored. Says whether Xero was written, and the
 * problem to list under Recent problems when it is a new one. */
async function applyOutcome(
  ctx: MutationCtx,
  connection: Doc<'xeroConnections'>,
  outcome: Outcome,
  now: number,
  tally: Tally,
): Promise<{ wrote: boolean; problem: string | null }> {
  const none = { wrote: false, problem: null }
  const { businessId, tenantId } = connection
  const row = await ctx.db
    .query('xeroOutbox')
    .withIndex('by_connection_and_client', (q) =>
      q.eq('connectionId', connection._id).eq('clientId', outcome.clientId),
    )
    .first()
  // A change came in while this was out (or, for the walk, the client was
  // queued meanwhile): the row stays, and the next page sends that.
  const changedSince =
    row !== null && (outcome.rev === null || row.rev !== outcome.rev)
  const clear = async () => {
    if (row && !changedSince) await ctx.db.delete('xeroOutbox', row._id)
  }

  const client = await ctx.db.get('clients', outcome.clientId)
  if (!client || client.businessId !== businessId) {
    // Gone: there is nothing left to send, now or later.
    if (row) await ctx.db.delete('xeroOutbox', row._id)
    return none
  }
  const counted = inXeroBook(client)
  const link = await linkOf(ctx, businessId, tenantId, outcome.clientId)
  const upsert = async (
    fields: Partial<Omit<Doc<'xeroContactLinks'>, '_id' | '_creationTime'>> &
      Pick<Doc<'xeroContactLinks'>, 'state'>,
  ) => {
    if (link) {
      await ctx.db.patch('xeroContactLinks', link._id, fields)
    } else {
      await ctx.db.insert('xeroContactLinks', {
        businessId,
        tenantId,
        clientId: outcome.clientId,
        ...fields,
      })
    }
  }
  const newProblem = (code: string) =>
    link?.problem?.code === code ? null : code

  // Keep both, chosen while this page was out: the holder's word, and a
  // shared client is never sent — nothing the page found for it applies.
  if (link?.state === 'shared') {
    await clear()
    return none
  }

  switch (outcome.kind) {
    case 'skip':
      await clear()
      return none

    case 'linked': {
      const current = link?.xeroContactId ?? null
      // The holder moved the link while this was out (Same, Unlink): theirs
      // stands, and the row stays for a send to whatever it is now.
      if (current !== outcome.expect && current !== outcome.xeroContactId) {
        return { wrote: outcome.wrote, problem: null }
      }
      if (current !== outcome.xeroContactId) {
        // A contact new to this link: one Xero contact is one client per
        // organisation, checked again here in the write. The drain looked
        // before writing; a client linked to it since is put to the holder
        // rather than given a second client. One out of the book holds
        // nothing, and its link goes.
        const { holding, outOfBook } = await othersLinkedTo(ctx, {
          businessId,
          tenantId,
          contactId: outcome.xeroContactId,
          clientId: outcome.clientId,
        })
        if (holding.length > 0) {
          return await applyOutcome(
            ctx,
            connection,
            {
              kind: 'review',
              clientId: outcome.clientId,
              rev: outcome.rev,
              expect: current,
              candidate: {
                contactId: outcome.xeroContactId,
                name: outcome.xeroName,
                reason: 'contested',
              },
            },
            now,
            tally,
          ).then((result) => ({ ...result, wrote: outcome.wrote }))
        }
        for (const other of outOfBook) {
          await ctx.db.delete('xeroContactLinks', other._id)
          await releaseSharesOf(ctx, other.clientId, { tenantId })
        }
      }
      const seen: FieldHashes = { ...outcome.seen }
      let different = outcome.different
      // "Send PestM8's details" pressed while this was out: kept for the
      // next send, which the change it queued asks for.
      if (changedSince && current === outcome.xeroContactId) {
        for (const [field, hash] of Object.entries(link?.seen ?? {})) {
          if (hash !== OVERWRITE_MARK) continue
          seen[field] = OVERWRITE_MARK
          different = different.filter((key) => key !== field)
        }
      }
      const after = {
        state: 'linked' as const,
        xeroContactId: outcome.xeroContactId,
        xeroName: outcome.xeroName,
        how: outcome.how ?? link?.how ?? 'matched',
        candidate: undefined,
        sharedWithClientId: undefined,
        sent: outcome.sent,
        seen,
        different: different.length > 0 ? different : undefined,
        problem: outcome.problem
          ? { code: outcome.problem, at: now }
          : undefined,
        ...(outcome.wrote ? { lastSentAt: now } : {}),
      }
      if (link?.state === 'linked' && link.xeroContactId !== undefined) {
        if (link.xeroContactId !== after.xeroContactId) {
          // Another contact than the one the clients sharing it chose to use
          // (never, today): theirs to decide again.
          await releaseSharesOf(ctx, outcome.clientId, { tenantId })
        } else if (link.xeroName !== after.xeroName) {
          // Renamed in Xero, or by this send: what they show follows.
          await moveSharesOf(ctx, outcome.clientId, tenantId, {
            xeroContactId: after.xeroContactId,
            xeroName: after.xeroName,
          })
        }
      }
      await upsert(after)
      tallyLink(tally, counted, link, after)
      await clear()
      return {
        wrote: outcome.wrote,
        problem: outcome.problem ? newProblem(outcome.problem) : null,
      }
    }

    case 'review': {
      // The link moved meanwhile, or — for a client with no contact — the
      // holder ruled on it: theirs stands. (A linked client's contact merged
      // away is asked about whatever was decided: that contact is gone.)
      const current = link?.xeroContactId ?? null
      if (
        current !== outcome.expect ||
        (current === null && link?.decidedAt !== undefined)
      ) {
        await clear()
        return none
      }
      const after = {
        state: 'needs_review' as const,
        candidate: outcome.candidate,
        sharedWithClientId: undefined,
        xeroContactId: undefined,
        how: undefined,
        xeroName: undefined,
        runId: undefined,
        sent: undefined,
        seen: undefined,
        different: undefined,
        problem: undefined,
      }
      // Its contact merged into one another client has: it holds nothing
      // now, so whoever shared it goes back To check too.
      if (link?.state === 'linked') {
        await releaseSharesOf(ctx, outcome.clientId, { tenantId })
      }
      await upsert(after)
      tallyLink(tally, counted, link, after)
      await clear()
      return none
    }

    case 'stopped': {
      if (!link || link.xeroContactId !== outcome.xeroContactId) return none
      const after = {
        state: outcome.state,
        xeroContactId: outcome.xeroContactId,
        different: undefined,
        problem: undefined,
      }
      // Archived or erased in Xero, it is held no more (only a linked
      // client holds a contact): the clients sharing it go back To check,
      // where the holder says whether they get a contact of their own.
      if (link.state === 'linked') {
        await releaseSharesOf(ctx, outcome.clientId, { tenantId })
      }
      await upsert(after)
      tallyLink(tally, counted, link, after)
      await clear()
      // Counted under stopped, not listed: nothing failed.
      return none
    }

    case 'relink': {
      if (!link || link.xeroContactId !== outcome.from) return none
      // One Xero contact is one client, checked again here in the write, as
      // for `linked`: a survivor another client here holds — linked since,
      // or by an earlier outcome of this very page — is the holder's to
      // sort out. One out of the book holds nothing, and its link goes.
      const { holding, outOfBook } = await othersLinkedTo(ctx, {
        businessId,
        tenantId,
        contactId: outcome.xeroContactId,
        clientId: outcome.clientId,
      })
      if (holding.length > 0) {
        return await applyOutcome(
          ctx,
          connection,
          {
            kind: 'review',
            clientId: outcome.clientId,
            rev: outcome.rev,
            expect: outcome.from,
            candidate: {
              contactId: outcome.xeroContactId,
              name: outcome.xeroName,
              reason: 'contested',
            },
          },
          now,
          tally,
        )
      }
      for (const other of outOfBook) {
        await ctx.db.delete('xeroContactLinks', other._id)
        await releaseSharesOf(ctx, other.clientId, { tenantId })
      }
      // What was sent and seen carries over: the survivor is the same
      // person's contact, so the change that found the merge goes to it
      // where it holds what the old one did, and is left alone (different)
      // where the bookkeeper kept something else.
      const after = {
        state: 'linked' as const,
        how: 'relinked' as const,
        xeroContactId: outcome.xeroContactId,
        xeroName: outcome.xeroName,
        seen: { ...link.seen, [RELINKED_KEY]: '1' },
        different: undefined,
        problem: undefined,
      }
      // The clients sharing its contact are the same customer, whose
      // contact Xero merged into this one: they follow it, still shared,
      // rather than being asked about a contact that is gone.
      if (link.state === 'linked') {
        await moveSharesOf(ctx, outcome.clientId, tenantId, {
          xeroContactId: outcome.xeroContactId,
          xeroName: outcome.xeroName,
        })
      }
      await upsert(after)
      tallyLink(tally, counted, link, after)
      // Sent to the survivor next.
      if (row) {
        await ctx.db.patch('xeroOutbox', row._id, { dueAt: now })
      } else {
        await ctx.db.insert('xeroOutbox', {
          businessId,
          connectionId: connection._id,
          clientId: outcome.clientId,
          rev: 1,
          dueAt: now,
          firstQueuedAt: now,
          attempts: 0,
        })
      }
      return none
    }

    case 'failed': {
      const problem = { code: outcome.code, at: now }
      if (outcome.creating) {
        // Linked meanwhile (Same, or another page): nothing failed for it.
        if (link?.xeroContactId) {
          await clear()
          return none
        }
        const after = {
          state: 'failed' as const,
          problem,
          candidate: link?.candidate,
        }
        await upsert(after)
        tallyLink(tally, counted, link, after)
      } else if (link?.xeroContactId) {
        const after = {
          state: link.state,
          xeroContactId: link.xeroContactId,
          different: link.different,
          problem,
        }
        await ctx.db.patch('xeroContactLinks', link._id, { problem })
        tallyLink(tally, counted, link, after)
      }
      await clear()
      return { wrote: false, problem: newProblem(outcome.code) }
    }

    case 'retry': {
      const attempts = (row?.attempts ?? 0) + 1
      if (attempts >= MAX_ATTEMPTS) {
        // Tried for most of a day: given up as failed, so it shows. The
        // next change to the client tries again.
        return await applyOutcome(
          ctx,
          connection,
          {
            kind: 'failed',
            clientId: outcome.clientId,
            rev: row?.rev ?? outcome.rev,
            code: outcome.code,
            creating: !link?.xeroContactId,
          },
          now,
          tally,
        )
      }
      const lastError = { code: outcome.code, at: now }
      if (row) {
        await ctx.db.patch('xeroOutbox', row._id, {
          attempts,
          dueAt: now + backoff(attempts),
          lastError,
        })
      } else {
        await ctx.db.insert('xeroOutbox', {
          businessId,
          connectionId: connection._id,
          clientId: outcome.clientId,
          rev: 1,
          dueAt: now + backoff(attempts),
          firstQueuedAt: now,
          attempts,
          lastError,
        })
      }
      return none
    }
  }
}

// ──────────────────────────────────────────────────────────── the drain

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))

/** One drain's hold on an organisation, and what it has learnt of it. */
type Session = {
  ctx: ActionCtx
  connectionId: Id<'xeroConnections'>
  holder: string
  /** A drain writes; a dry run only reads, and needs no Start syncing. */
  purpose: 'drain' | 'dryRun'
  target: SyncTarget
  token: string
  /** A 401 has been answered with a fresh token once already. */
  refreshed: boolean
  lastCallAt: number
  /** When the lease was last renewed, and the drain told it may go on
   * (`checkpoint`). */
  checkedAt: number
  dayRemaining?: number
  minRemaining?: number
  /** Every contact of the organisation, once read this drain (pre-match,
   * and Release 2's AccountNumber rule). */
  contacts: Array<XeroContactRow> | null
  /** Contacts this drain has made, not yet recorded as linked: another
   * client's, for a clash with one of them. */
  created: Set<string>
  deadline: number
}

/** Waits out the gap between calls, and the minute when Xero says it is
 * nearly spent. */
async function spaceCalls(s: Session): Promise<void> {
  const now = Date.now()
  let wait = s.lastCallAt + CALL_GAP_MS - now
  if (s.minRemaining !== undefined && s.minRemaining <= MINUTE_RESERVE) {
    wait = Math.max(wait, s.lastCallAt + MINUTE_MS - now)
    s.minRemaining = undefined
  }
  if (wait > 0) await sleep(wait)
}

function noteRate(s: Session, rate: XeroRate | undefined): void {
  if (rate?.dayRemaining !== undefined) s.dayRemaining = rate.dayRemaining
  if (rate?.minRemaining !== undefined) s.minRemaining = rate.minRemaining
}

/**
 * Before a call: the organisation is still this drain's (the lease renewed),
 * and still to be written to — the kill switch off, the connection connected
 * and started (`keepGoing`). Asked before every write, and at least once a
 * minute otherwise, so a page that runs long — clashes, refusals, Xero slow
 * to answer — never outlives the lease, and the kill switch or a Disconnect
 * stops a drain at its next write, not its next page. Throws LEASE_LOST or
 * XERO_HALTED, which stop the page (`stopOf`).
 */
async function checkpoint(s: Session, write: boolean): Promise<void> {
  if (!write && Date.now() - s.checkedAt < CHECK_EVERY_MS) return
  await s.ctx.runMutation(internal.xeroSync.keepGoing, {
    connectionId: s.connectionId,
    holder: s.holder,
    purpose: s.purpose,
  })
  s.checkedAt = Date.now()
}

/**
 * One call to Xero, spaced from the last, each try after a `checkpoint`. A
 * 401 is answered with a fresh token once per drain (a second is a sign-in
 * Xero no longer takes); busy or down is tried again three times, 2, 5 and
 * 15 s apart, through the SAME closure — so a write's Idempotency-Key, minted
 * before, is reused and a create whose answer was lost is not made twice.
 * Anything else is thrown for the page to decide.
 */
async function xeroCall<T>(
  s: Session,
  run: (token: string) => Promise<T>,
  rateOf: (result: T) => XeroRate | undefined = () => undefined,
  { write = false }: { write?: boolean } = {},
): Promise<T> {
  for (let retries = 0; ;) {
    await spaceCalls(s)
    await checkpoint(s, write)
    try {
      const result = await run(s.token)
      s.lastCallAt = Date.now()
      noteRate(s, rateOf(result))
      return result
    } catch (error) {
      s.lastCallAt = Date.now()
      if (!(error instanceof XeroError)) throw error
      const classified = error.classified
      if (classified.kind === 'refresh') {
        if (s.refreshed) {
          throw new XeroError(
            { kind: 'reconnect', code: 'unauthorised' },
            'Xero refused a fresh access token',
          )
        }
        s.refreshed = true
        s.token = await accessTokenFor(s.ctx, s.target.grantId, {
          forceRefresh: true,
        })
        continue
      }
      if (classified.kind === 'retry' && retries < RETRY_WAITS_MS.length) {
        await sleep(Math.max(classified.afterMs, RETRY_WAITS_MS[retries]))
        retries += 1
        continue
      }
      throw error
    }
  }
}

/** Why a page stopped, from what was thrown. */
function stopOf(error: unknown): Stop {
  if (error instanceof XeroError) {
    const classified = error.classified
    switch (classified.kind) {
      case 'pause':
        return { kind: 'pause', until: classified.until, why: classified.why }
      case 'refresh':
      case 'reconnect':
        return { kind: 'reconnect', markOrg: true }
      case 'retry':
        return { kind: 'failed', code: 'xero_unavailable' }
      case 'stop':
        return { kind: 'failed', code: classified.code }
      case 'ok':
        return { kind: 'failed', code: 'unknown' }
    }
  }
  if (error instanceof ConvexError) {
    switch (error.data) {
      // The sign-in is dead: every connection on it is marked already.
      case 'XERO_RECONNECT':
        return { kind: 'reconnect', markOrg: false }
      case 'LEASE_LOST':
        return { kind: 'lease' }
      case 'XERO_HALTED':
        return { kind: 'halt' }
      case 'XERO_BUSY':
      case 'XERO_RETRY':
        return { kind: 'failed', code: 'xero_unavailable' }
      default:
        return { kind: 'failed', code: 'unknown' }
    }
  }
  return { kind: 'failed', code: 'unknown' }
}

/** An error as a log line may carry it: never a token, never a contact. */
function describe(error: unknown): string {
  if (error instanceof XeroError) {
    return `${error.message} ${JSON.stringify(error.classified)}`
  }
  if (error instanceof ConvexError) return String(error.data)
  return error instanceof Error ? error.name : 'unknown'
}

/** A name as Xero's uniqueness compares it, near enough. */
function nameFold(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Xero's refusal of one element, as a code the page words. The words
 * themselves go only to the log, with the client's name and any email taken
 * out — Xero's messages quote them.
 */
function refusalCode(errors: ReadonlyArray<string>): string {
  const text = errors.join(' ').toLowerCase()
  if (/e-?mail/.test(text)) return 'email_invalid'
  if (/website|url/.test(text)) return 'website_invalid'
  if (/contact ?persons?/.test(text)) return 'persons_full'
  if (/\bname\b/.test(text)) return 'name_invalid'
  return 'unknown'
}

/** Xero refusing the AccountNumber itself: another contact has it. */
function refusesAccountNumber(errors: ReadonlyArray<string>): boolean {
  return errors.some((message) => /account\s*number/i.test(message))
}

function logRefusal(
  s: Session,
  clientId: Id<'clients'>,
  code: string,
  errors: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
): void {
  let text = errors.join(' · ').slice(0, 300)
  for (const name of names) {
    if (name.trim() !== '') text = text.split(name).join('…')
  }
  text = text.replace(/\S+@\S+/g, '…@…')
  console.error(
    `[xero] connection ${s.connectionId}: client ${clientId} refused (${code}): ${text}`,
  )
}

/** Every contact of the organisation, once a drain: for matching a batch of
 * creates against it, and for Release 2's AccountNumber rule. Archived ones
 * included (the matcher leaves them out). */
async function loadContacts(s: Session): Promise<Array<XeroContactRow>> {
  if (s.contacts) return s.contacts
  const contacts: Array<XeroContactRow> = []
  for (let page = 1; page <= MAX_CONTACT_PAGES; page++) {
    const { contacts: rows } = await xeroCall(
      s,
      (token) => getContactsPage(token, s.target.tenantId, page),
      (result) => result.rate,
    )
    contacts.push(...rows)
    if (rows.length < CONTACTS_PAGE_SIZE) break
    await s.ctx.runMutation(internal.xeroMatch.renewLease, {
      connectionId: s.connectionId,
      holder: s.holder,
    })
  }
  s.contacts = contacts
  return contacts
}

/** Whether another ACTIVE contact than `contactId` holds this AccountNumber
 * (Xero refuses it on a second): only answerable with the contacts read. */
function numberHeldElsewhere(
  contacts: ReadonlyArray<XeroContactRow>,
  accountNumber: unknown,
  contactId: string | null,
): boolean {
  const wanted =
    typeof accountNumber === 'string' ? accountNumberKey(accountNumber) : null
  if (wanted === null) return false
  return contacts.some(
    (contact) =>
      contact.status === 'ACTIVE' &&
      contact.contactId !== contactId &&
      accountNumberKey(contact.accountNumber) === wanted,
  )
}

/** One element written on its own, with its own Idempotency-Key. */
async function writeOne(
  s: Session,
  method: 'PUT' | 'POST',
  body: object,
): Promise<ItemResult> {
  const results = await writeMany(s, method, [body])
  return results[0] ?? { errors: ['Xero sent no result for this contact'] }
}

/** One request of up to fifty, its Idempotency-Key minted here and reused
 * only by `xeroCall`'s retries of this very request. */
async function writeMany(
  s: Session,
  method: 'PUT' | 'POST',
  bodies: Array<object>,
): Promise<Array<ItemResult>> {
  const key = newIdempotencyKey()
  const contacts =
    method === 'POST' ? buildUpdateBatch(bodies).Contacts : bodies
  const { results } = await xeroCall(
    s,
    (token) =>
      method === 'PUT'
        ? putContacts(token, s.target.tenantId, contacts, key)
        : postContacts(token, s.target.tenantId, contacts, key),
    (answer) => answer.rate,
    { write: true },
  )
  return results
}

/** A Xero contact as a To check card shows it (`xeroCandidate`). */
function candidateOf(
  contact: XeroContactFull,
  reason: Candidate['reason'],
): Candidate {
  const fields = fieldsFromXero(contact)
  const phone = [fields.phoneDefault, fields.phoneMobile].find(
    (value) => !isBlank(value),
  ) as { areaCode: string; number: string } | undefined
  const street = [fields.street, fields.pobox].find(
    (value) => !isBlank(value),
  ) as { city: string } | undefined
  const text = (value: string | undefined) => value?.trim() || undefined
  const email = text(contact.EmailAddress)
  const accountNumber = text(contact.AccountNumber)
  const phoneText = phone
    ? text(`${phone.areaCode} ${phone.number}`)
    : undefined
  const place = text(street?.city)
  return {
    contactId: contact.ContactID,
    name: contact.Name,
    reason,
    ...(email ? { email } : {}),
    ...(phoneText ? { phone: phoneText } : {}),
    ...(place ? { place } : {}),
    ...(accountNumber ? { accountNumber } : {}),
  }
}

/** A client as the matcher compares it (lib/xeroMatch.ts). */
function clientForMatch(input: ContactInput): ClientForMatch {
  const { client } = input
  const emails = new Set<string>()
  for (const raw of [client.email, input.primary?.email]) {
    const email = raw?.trim().toLowerCase()
    if (email) emails.add(email)
  }
  const phone = client.phone?.trim()
  const suburb = input.oldestSite?.suburb.trim()
  return {
    clientId: client._id,
    name: client.name,
    emails: [...emails],
    ...(client.clientNumber === undefined
      ? {}
      : { clientNumber: client.clientNumber }),
    ...(phone ? { phone } : {}),
    ...(suburb ? { suburb } : {}),
  }
}

/** An update to send: the client, the contact it is (or is about to be)
 * linked to, and how. */
type UpdateJob = {
  item: WorkItem
  contactId: string
  /** Set for a link this page makes (a create matched to an existing
   * contact): its record starts afresh. */
  how?: LinkHow
  /** The contact the link named when read. */
  expect: string | null
}

/** A create to send. */
type CreateJob = {
  item: WorkItem
  ours: Fields
  send: Fields
  name: string
  /** The number was left out: another contact has it. */
  numberHeld: boolean
  soft: string | null
}

/** One contact read, compared and (maybe) written: what to send, and what
 * to store after. */
type UpdatePlan = {
  job: UpdateJob
  contact: XeroContactFull
  ours: Fields
  hashes: LinkHashes
  send: Fields
  different: Array<FieldKey>
  numberHeld: boolean
  soft: string | null
}

function linkedOutcome(
  item: WorkItem,
  contact: XeroContactFull,
  {
    how,
    expect,
    hashes,
    wrote,
    problem,
    different = [],
  }: {
    how?: LinkHow
    expect: string | null
    hashes: { sent: FieldHashes; seen: FieldHashes }
    wrote: boolean
    problem: string | null
    different?: ReadonlyArray<FieldKey>
  },
): Outcome {
  return {
    kind: 'linked',
    clientId: item.clientId,
    rev: item.rev,
    expect,
    xeroContactId: contact.ContactID,
    xeroName: contact.Name,
    ...(how ? { how } : {}),
    sent: hashes.sent,
    seen: hashes.seen,
    different: [...different],
    wrote,
    ...(problem ? { problem } : {}),
  }
}

/** The hashes of a contact just made: PestM8's values as sent, Xero's as
 * answered — and the held-number mark when the number was left out. */
function createdHashes(
  job: CreateJob,
  contact: XeroContactFull,
): { sent: FieldHashes; seen: FieldHashes } {
  const hashes = nextHashes(
    job.ours,
    null,
    { send: job.send, different: [] },
    fieldsFromXero(contact),
  )
  if (job.numberHeld) {
    const ours = ownedFields(job.item.input as ContactInput, {
      creating: true,
      xeroPoboxBlank: true,
    })
    hashes.seen.accountNumber = heldNumberMark(ours.accountNumber)
  }
  return hashes
}

/** Whether nothing PestM8 sends for this client has changed since it was
 * last sent: no call at all. A link with nothing on record (just matched,
 * relinked, forced by `resyncAll`) or an overwrite asked for is never
 * unchanged. */
function unchangedSinceSent(item: WorkItem): boolean {
  const link = item.link
  if (!link?.sent || !item.input) return false
  const seen = link.seen ?? {}
  if (Object.values(seen).includes(OVERWRITE_MARK)) return false
  if (RELINKED_KEY in seen) return false
  const ours = ownedFields(item.input, {
    creating: false,
    xeroPoboxBlank: !('pobox' in seen) || seen.pobox === fieldHash(''),
  })
  if (
    'accountNumber' in ours &&
    seen.accountNumber === heldNumberMark(ours.accountNumber)
  ) {
    delete ours.accountNumber
  }
  return Object.entries(ours).every(
    ([field, value]) =>
      // The number fills a blank only, and people go only to a contact
      // PestM8 made (lib/xeroContact.ts `diff`): neither alone is a change
      // worth reading Xero for.
      field === 'accountNumber' ||
      (field === 'persons' &&
        !CONTACT_PERSONS_ON_MATCHED &&
        link.how !== 'created') ||
      link.sent?.[field] === fieldHash(value),
  )
}

/**
 * One page of work, sent. Every client gets an outcome unless Xero said
 * stop part-way (`stop`): those left have none, their rows stay, and the
 * walk's cursor does not move past them. A page that failed outright backs
 * off every client it had not settled.
 */
async function sendPage(
  s: Session,
  items: ReadonlyArray<WorkItem>,
): Promise<{ outcomes: Array<Outcome>; stop: Stop | null }> {
  const outcomes: Array<Outcome> = []
  const creates: Array<WorkItem> = []
  const updates: Array<UpdateJob> = []
  for (const item of items) {
    const judged: Eligibility = eligibility(item.input, item.link)
    if (judged === 'create') {
      creates.push(item)
    } else if (judged === 'update' && !unchangedSinceSent(item)) {
      const contactId = item.link?.xeroContactId as string
      updates.push({ item, contactId, expect: contactId })
    } else {
      outcomes.push({ kind: 'skip', clientId: item.clientId, rev: item.rev })
    }
  }

  try {
    const fresh = await preMatch(s, creates, updates, outcomes)
    await sendCreates(s, fresh, updates, outcomes)
    await sendUpdates(s, updates, outcomes)
    return { outcomes, stop: null }
  } catch (error) {
    const stop = stopOf(error)
    console.error(
      `[xero] connection ${s.connectionId}: page stopped (${stop.kind}): ${describe(error)}`,
    )
    if (stop.kind === 'failed') {
      const settled = new Set(outcomes.map((outcome) => outcome.clientId))
      for (const item of items) {
        if (settled.has(item.clientId)) continue
        outcomes.push({
          kind: 'retry',
          clientId: item.clientId,
          rev: item.rev,
          code: stop.code,
        })
      }
    }
    return { outcomes, stop }
  }
}

/**
 * Ten or more creates at once: read the organisation's contacts (once a
 * drain) and match the creates against them by Release 2's rules, so a
 * contact made in Xero since the match — an import after go-live, a
 * bookkeeper ahead of PestM8 — is linked rather than made again. A sure
 * match becomes an update of that contact (its blanks filled); a doubtful
 * one goes To check, with nothing written. With the contacts read already,
 * any number of creates is matched.
 *
 * Only creates the holder has not ruled on: a Different client is added as
 * its own contact, whatever Xero holds. Returns the creates left.
 */
async function preMatch(
  s: Session,
  creates: Array<WorkItem>,
  updates: Array<UpdateJob>,
  outcomes: Array<Outcome>,
): Promise<Array<WorkItem>> {
  const open = creates.filter(
    (item) =>
      item.input !== null &&
      (item.link === null ||
        ((item.link.state === 'new' || item.link.state === 'failed') &&
          item.link.decidedAt === undefined)),
  )
  if (open.length === 0) return creates
  if (open.length >= PREMATCH_MIN) await loadContacts(s)
  const contacts = s.contacts
  if (!contacts) return creates

  // A contact another client here already has — one PestM8 made for them,
  // most often, during this very backfill — is only worth asking about when
  // the likeness is strong: same name AND same email or number, two PestM8
  // records of one customer most likely, which the holder should see before
  // a second contact is made. A weak likeness to it (an agency's shared
  // office email, a namesake) is no question at all: offered, eight clients
  // sat To check on prod (15 Oct 2026) and Same could only refuse. Those are
  // matched again against the contacts nobody holds, and added if nothing
  // there is like them, a clashing name taking its suburb.
  const forMatch = open.map((item) =>
    clientForMatch(item.input as ContactInput),
  )
  const firstPass = matchClients(forMatch, contacts)
  const proposed = firstPass.flatMap((proposal) =>
    proposal.outcome === 'new' ? [] : [proposal.contact.contactId],
  )
  const held = new Set<string>(
    proposed.length > 0
      ? await s.ctx.runQuery(internal.xeroSync.contactsHeld, {
          connectionId: s.connectionId,
          contactIds: proposed,
        })
      : [],
  )
  // Strong matches to a held contact: To check, "contested", as before.
  const strongHeld = new Set<Id<'clients'>>(
    firstPass.flatMap((proposal) =>
      proposal.outcome === 'linked' && held.has(proposal.contact.contactId)
        ? [proposal.clientId]
        : [],
    ),
  )
  const proposals =
    held.size === 0
      ? firstPass
      : [
          ...firstPass.filter((proposal) => strongHeld.has(proposal.clientId)),
          ...matchClients(
            forMatch.filter((client) => !strongHeld.has(client.clientId)),
            contacts.filter((contact) => !held.has(contact.contactId)),
          ),
        ]

  const byId = new Map(open.map((item) => [item.clientId, item]))
  const settled = new Set<Id<'clients'>>()
  for (const proposal of proposals) {
    const item = byId.get(proposal.clientId)
    if (!item || proposal.outcome === 'new') continue
    settled.add(item.clientId)
    const contact = proposal.contact
    if (proposal.outcome === 'linked' && !held.has(contact.contactId)) {
      updates.push({
        item,
        contactId: contact.contactId,
        how: 'matched',
        expect: item.link?.xeroContactId ?? null,
      })
      continue
    }
    const reason = proposal.outcome === 'review' ? proposal.reason : 'contested'
    outcomes.push({
      kind: 'review',
      clientId: item.clientId,
      rev: item.rev,
      expect: item.link?.xeroContactId ?? null,
      candidate: {
        contactId: contact.contactId,
        name: contact.name,
        reason,
        ...(contact.email ? { email: contact.email } : {}),
        ...(contact.phone ? { phone: contact.phone } : {}),
        ...(contact.place ? { place: contact.place } : {}),
        ...(contact.accountNumber
          ? { accountNumber: contact.accountNumber }
          : {}),
      },
    })
  }
  return creates.filter((item) => !settled.has(item.clientId))
}

/** Creates, fifty to a `PUT`; then, one by one, those whose number Xero
 * refused (again without it) and those whose name was taken — one of which
 * may turn out to be in Xero already, and joins `updates`. */
async function sendCreates(
  s: Session,
  creates: Array<WorkItem>,
  updates: Array<UpdateJob>,
  outcomes: Array<Outcome>,
): Promise<void> {
  const jobs: Array<CreateJob> = []
  for (const item of creates) {
    const input = item.input as ContactInput
    const problems = fieldProblems(input)
    if (problems.includes('name_invalid')) {
      // Nothing of the name is left to send: Xero would refuse it.
      outcomes.push({
        kind: 'failed',
        clientId: item.clientId,
        rev: item.rev,
        code: 'name_invalid',
        creating: true,
      })
      continue
    }
    const ours = ownedFields(input, { creating: true, xeroPoboxBlank: true })
    let numberHeld = false
    if (
      'accountNumber' in ours &&
      s.contacts &&
      numberHeldElsewhere(s.contacts, ours.accountNumber, null)
    ) {
      delete ours.accountNumber
      numberHeld = true
    }
    const { send } = diff(ours, null, null)
    const soft =
      [...problems, ...payloadProblems(send, null)].find(
        (problem) =>
          problem === 'email_not_ascii' || problem === 'persons_full',
      ) ?? null
    jobs.push({
      item,
      ours,
      send,
      name: typeof ours.name === 'string' ? ours.name : '',
      numberHeld,
      soft,
    })
  }

  const clashes: Array<CreateJob> = []
  const numberRefused: Array<CreateJob> = []
  for (let i = 0; i < jobs.length; i += BATCH) {
    const chunk = jobs.slice(i, i + BATCH)
    const results = await writeMany(
      s,
      'PUT',
      chunk.map((job) => toXeroCreate(job.name, job.send)),
    )
    chunk.forEach((job, at) =>
      settleCreate(s, job, results[at], outcomes, { clashes, numberRefused }),
    )
  }

  for (const job of numberRefused) {
    dropNumber(job)
    try {
      const result = await writeOne(s, 'PUT', toXeroCreate(job.name, job.send))
      settleCreate(s, job, result, outcomes, { clashes, numberRefused: null })
    } catch (error) {
      outcomes.push(itemRefused(error, job.item, true))
    }
  }
  for (const job of clashes) {
    try {
      const outcome = await resolveCreateClash(s, job, updates)
      if (outcome) outcomes.push(outcome)
    } catch (error) {
      outcomes.push(itemRefused(error, job.item, true))
    }
  }
}

/** A create sent again without its number: Xero gives it to another
 * contact. */
function dropNumber(job: CreateJob): void {
  delete job.ours.accountNumber
  job.send = diff(job.ours, null, null).send
  job.numberHeld = true
}

/**
 * A call made for one client alone — a clash looked up, a create or rename
 * tried again — that Xero refused outright (a 4xx for the request, or an
 * answer that can't be read): that client fails, and the rest of the page
 * goes on. Anything that says to stop sending to the organisation at all (a
 * pause, a reconnect, Xero down past its retries, the lease, the kill
 * switch) is thrown on, for the page.
 */
function itemRefused(
  error: unknown,
  item: WorkItem,
  creating: boolean,
): Outcome {
  if (error instanceof XeroError && error.classified.kind === 'stop') {
    console.error(
      `[xero] client ${item.clientId}: one call refused (${error.classified.code}): ${describe(error)}`,
    )
    return {
      kind: 'failed',
      clientId: item.clientId,
      rev: item.rev,
      code: error.classified.code,
      creating,
    }
  }
  throw error
}

/** One element of a create's answer: linked, or set aside for a clash or a
 * refused number, or failed. */
function settleCreate(
  s: Session,
  job: CreateJob,
  result: ItemResult | undefined,
  outcomes: Array<Outcome>,
  later: {
    clashes: Array<CreateJob>
    numberRefused: Array<CreateJob> | null
  },
): void {
  const { item } = job
  const contact = result?.contact
  const errors = result?.errors ?? ['Xero sent no result for this contact']
  if (contact && errors.length === 0) {
    // Matched back by position; Xero answering for another name means the
    // answer cannot be trusted to be this client's. The next try finds it
    // by its name and number if it was made after all.
    if (nameFold(contact.Name) !== nameFold(job.name)) {
      outcomes.push({
        kind: 'retry',
        clientId: item.clientId,
        rev: item.rev,
        code: 'response_mismatch',
      })
      return
    }
    s.created.add(contact.ContactID)
    outcomes.push(
      linkedOutcome(item, contact, {
        how: 'created',
        expect: item.link?.xeroContactId ?? null,
        hashes: createdHashes(job, contact),
        wrote: true,
        problem: job.soft,
      }),
    )
    return
  }
  if (errors.some(isNameClash)) {
    later.clashes.push(job)
    return
  }
  if (
    later.numberRefused &&
    'accountNumber' in job.ours &&
    refusesAccountNumber(errors)
  ) {
    later.numberRefused.push(job)
    return
  }
  const code = refusalCode(errors)
  logRefusal(s, item.clientId, code, errors, [
    job.name,
    job.item.input?.client.name ?? '',
  ])
  outcomes.push({
    kind: 'failed',
    clientId: item.clientId,
    rev: item.rev,
    code,
    creating: true,
  })
}

/**
 * A create refused because another contact has the name (decision 4).
 *
 *  1. Who has it (`GET where=Name==`). Nobody that can be found: tried again
 *     later (`name_unread`) — never a suffix on a guess, which could be a
 *     second contact for a client already there.
 *  2. Free here (no client in the book linked to it, not made by this drain
 *     for another), ACTIVE, carrying this client's number, and not the
 *     contact the holder said this client isn't (`ownLostCreate`): most
 *     likely this very create, made by an earlier try whose answer was lost
 *     — or one the bookkeeper made for this client. Linked as a match is
 *     (`matched`: its blanks filled, nothing of Xero's overwritten, its
 *     people left as they are), through `updates`.
 *  3. Free, and the holder has not said this client is a different one: it
 *     may be this client, already in Xero — To check (`name_clash`),
 *     nothing written. Same links it; Different adds the client with a
 *     suffix.
 *  4. Otherwise "{name} ({suburb})", then "{name} #{number}", each its own
 *     create — a number Xero gives another contact left out — and each
 *     clash looked up as in 1 and 2, so a suffixed create whose answer was
 *     lost is found too. All taken is `name_taken`.
 *
 * Returns null when the client joined `updates`.
 */
async function resolveCreateClash(
  s: Session,
  job: CreateJob,
  updates: Array<UpdateJob>,
): Promise<Outcome | null> {
  const { item } = job
  const input = item.input as ContactInput
  const client = input.client
  const retry = (): Outcome => ({
    kind: 'retry',
    clientId: item.clientId,
    rev: item.rev,
    code: 'name_unread',
  })
  const asMatch = (contact: XeroContactFull): null => {
    updates.push({
      item,
      contactId: contact.ContactID,
      how: 'matched',
      expect: item.link?.xeroContactId ?? null,
    })
    return null
  }

  const holderContact = await xeroCall(s, (token) =>
    getContactByName(token, s.target.tenantId, job.name),
  )
  if (!holderContact) return retry()
  const free = await isFree(s, client._id, holderContact)
  if (free && ownLostCreate(item, holderContact)) return asMatch(holderContact)
  const ruledDifferent =
    item.link?.state === 'separate' || item.link?.decidedAt !== undefined
  if (free && !ruledDifferent) {
    return {
      kind: 'review',
      clientId: item.clientId,
      rev: item.rev,
      expect: item.link?.xeroContactId ?? null,
      candidate: candidateOf(holderContact, 'name_clash'),
    }
  }

  for (const name of suffixNames(
    client.name,
    input.oldestSite?.suburb,
    client.clientNumber,
  )) {
    let result = await writeOne(s, 'PUT', toXeroCreate(name, job.send))
    if (
      !result.contact &&
      !result.errors.some(isNameClash) &&
      'accountNumber' in job.send &&
      refusesAccountNumber(result.errors)
    ) {
      // The contact this client's number is on — most often the one it
      // isn't, which the holder unlinked — keeps it.
      dropNumber(job)
      result = await writeOne(s, 'PUT', toXeroCreate(name, job.send))
    }
    if (result.contact && result.errors.length === 0) {
      s.created.add(result.contact.ContactID)
      return linkedOutcome(item, result.contact, {
        how: 'created',
        expect: item.link?.xeroContactId ?? null,
        hashes: createdHashes(job, result.contact),
        wrote: true,
        problem: job.soft,
      })
    }
    if (result.errors.some(isNameClash)) {
      const taker = await xeroCall(s, (token) =>
        getContactByName(token, s.target.tenantId, name),
      )
      if (!taker) return retry()
      if (ownLostCreate(item, taker) && (await isFree(s, client._id, taker))) {
        return asMatch(taker)
      }
      continue
    }
    const code = refusalCode(result.errors)
    logRefusal(s, item.clientId, code, result.errors, [name, client.name])
    return {
      kind: 'failed',
      clientId: item.clientId,
      rev: item.rev,
      code,
      creating: true,
    }
  }
  return {
    kind: 'failed',
    clientId: item.clientId,
    rev: item.rev,
    code: 'name_taken',
    creating: true,
  }
}

/** A contact no client in the book here is linked to, other than
 * `clientId`; not one this drain made for another client and has yet to
 * record; and ACTIVE. */
async function isFree(
  s: Session,
  clientId: Id<'clients'>,
  contact: XeroContactFull,
): Promise<boolean> {
  if (contact.ContactStatus !== 'ACTIVE' || s.created.has(contact.ContactID)) {
    return false
  }
  const held: Array<string> = await s.ctx.runQuery(
    internal.xeroSync.contactsHeld,
    {
      connectionId: s.connectionId,
      contactIds: [contact.ContactID],
      exceptClientId: clientId,
    },
  )
  return held.length === 0
}

/**
 * Whether a free contact holding a name this client was refused is the
 * client's own: it carries the client's number — which PestM8 sends with
 * every create — and it is not the contact the holder said this client
 * isn't (Unlink, or Different on a card: kept as the link's `candidate`,
 * and often carrying the number already, from the match or a first send).
 */
function ownLostCreate(item: WorkItem, contact: XeroContactFull): boolean {
  const number = item.input?.client.clientNumber
  return (
    number !== undefined &&
    accountNumberKey(contact.AccountNumber) === number &&
    item.link?.candidate?.contactId !== contact.ContactID
  )
}

/**
 * The contact as compared: PestM8's fields, the link's record of what was
 * sent and seen (an overwrite's mark taken as Xero's value now; a number
 * Xero gives another contact left out), and from those what to send and
 * what Xero holds differently.
 */
function planUpdate(job: UpdateJob, contact: XeroContactFull): UpdatePlan {
  const input = job.item.input as ContactInput
  const link = job.item.link
  const xero = fieldsFromXero(contact)
  const fresh = job.how !== undefined
  const seen: FieldHashes = fresh ? {} : { ...link?.seen }
  for (const [field, hash] of Object.entries(seen)) {
    if (hash === OVERWRITE_MARK) {
      seen[field] = fieldHash(xero[field as FieldKey])
    }
  }
  const hashes: LinkHashes = fresh
    ? { how: job.how }
    : {
        ...(link?.sent ? { sent: { ...link.sent } } : {}),
        seen,
        ...(link?.how ? { how: link.how } : {}),
      }
  const ours = ownedFields(input, {
    creating: false,
    xeroPoboxBlank: isBlank(xero.pobox),
  })
  if (!fresh && RELINKED_KEY in seen) {
    // The first send to a contact Xero merged the old one into: its blanks
    // are filled, as a new link's are (`diff` fills where nothing is on
    // record as sent).
    delete seen[RELINKED_KEY]
    for (const field of Object.keys(ours) as Array<FieldKey>) {
      if (isBlank(xero[field]) && !isBlank(ours[field])) {
        delete hashes.sent?.[field]
      }
    }
  }
  let numberHeld = false
  if (
    'accountNumber' in ours &&
    seen.accountNumber === heldNumberMark(ours.accountNumber)
  ) {
    delete ours.accountNumber
    numberHeld = true
  }
  const { send, different } = diff(ours, hashes, xero)
  const soft =
    [...fieldProblems(input), ...payloadProblems(send, contact)].find(
      (problem) => problem === 'email_not_ascii' || problem === 'persons_full',
    ) ?? null
  return { job, contact, ours, hashes, send, different, numberHeld, soft }
}

/** The hashes to store after a pass over a contact, written or not. */
function updatedHashes(
  plan: UpdatePlan,
  send: Fields,
  after: XeroContactFull,
): { sent: FieldHashes; seen: FieldHashes } {
  const hashes = nextHashes(
    plan.ours,
    plan.hashes,
    { send, different: plan.different },
    fieldsFromXero(after),
  )
  if (plan.numberHeld) {
    const ours = ownedFields(plan.job.item.input as ContactInput, {
      creating: false,
      xeroPoboxBlank: true,
    })
    hashes.seen.accountNumber = heldNumberMark(ours.accountNumber)
  }
  return hashes
}

/**
 * Updates: each contact read as Xero holds it now (fifty a GET), then
 * judged — merged, archived, erased, or compared — and those with something
 * to send written fifty a `POST`, every element with its ContactID. A
 * number another contact holds is left out (Release 2's rule, checked
 * against the organisation's contacts, read once a drain when needed). A
 * rename onto a taken name tries the suffixes.
 */
async function sendUpdates(
  s: Session,
  jobs: Array<UpdateJob>,
  outcomes: Array<Outcome>,
): Promise<void> {
  if (jobs.length === 0) return
  const read = new Map<string, XeroContactFull>()
  const ids = [...new Set(jobs.map((job) => job.contactId))]
  for (let i = 0; i < ids.length; i += BATCH) {
    const { contacts } = await xeroCall(
      s,
      (token) =>
        getContactsByIds(token, s.target.tenantId, ids.slice(i, i + BATCH)),
      (result) => result.rate,
    )
    for (const contact of contacts) read.set(contact.ContactID, contact)
  }

  const plans: Array<UpdatePlan> = []
  const merged: Array<{ job: UpdateJob; contact: XeroContactFull }> = []
  // Contacts this page writes, or links a client to: one Xero contact is
  // one client, and one POST may not name a contact twice.
  const taken = new Set<string>()
  for (const job of jobs) {
    const { item } = job
    const contact = read.get(job.contactId)
    if (contact && taken.has(job.contactId)) {
      // Two clients of this page on one contact — which should never be:
      // the second is put to the holder rather than written over the
      // first, or failing the page's whole POST.
      outcomes.push({
        kind: 'review',
        clientId: item.clientId,
        rev: item.rev,
        expect: job.expect,
        candidate: candidateOf(contact, 'contested'),
      })
      continue
    }
    if (contact) taken.add(job.contactId)
    if (!contact) {
      // Not in Xero by that id any more (an organisation reset, say).
      outcomes.push({
        kind: 'failed',
        clientId: item.clientId,
        rev: item.rev,
        code: 'contact_missing',
        creating: false,
      })
      continue
    }
    if (contact.ContactStatus === 'ARCHIVED') {
      if (contact.MergedToContactID) merged.push({ job, contact })
      else {
        outcomes.push({
          kind: 'stopped',
          clientId: item.clientId,
          rev: item.rev,
          state: 'archived_in_xero',
          xeroContactId: job.contactId,
        })
      }
      continue
    }
    if (contact.ContactStatus === 'GDPRREQUEST') {
      outcomes.push({
        kind: 'stopped',
        clientId: item.clientId,
        rev: item.rev,
        state: 'gdpr',
        xeroContactId: job.contactId,
      })
      continue
    }
    plans.push(planUpdate(job, contact))
  }

  if (merged.length > 0) {
    const held = new Set<string>(
      await s.ctx.runQuery(internal.xeroSync.contactsHeld, {
        connectionId: s.connectionId,
        contactIds: merged.map(
          ({ contact }) => contact.MergedToContactID ?? '',
        ),
      }),
    )
    for (const { job, contact } of merged) {
      const survivor = contact.MergedToContactID as string
      if (held.has(survivor) || taken.has(survivor)) {
        // Merged into a contact another client here already is — or that
        // another client of this page is being moved to, two of its
        // contacts merged into one: which client that contact is now is
        // the holder's to say.
        outcomes.push({
          kind: 'review',
          clientId: job.item.clientId,
          rev: job.item.rev,
          expect: job.contactId,
          candidate: {
            ...candidateOf(contact, 'contested'),
            contactId: survivor,
          },
        })
      } else {
        taken.add(survivor)
        outcomes.push({
          kind: 'relink',
          clientId: job.item.clientId,
          rev: job.item.rev,
          from: job.contactId,
          xeroContactId: survivor,
          xeroName: contact.Name,
        })
      }
    }
  }

  // Release 2's rule: never the client's number into a contact while
  // another ACTIVE contact has it.
  if (plans.some((plan) => 'accountNumber' in plan.send)) {
    const contacts = await loadContacts(s)
    for (const plan of plans) {
      if (
        'accountNumber' in plan.send &&
        numberHeldElsewhere(
          contacts,
          plan.send.accountNumber,
          plan.contact.ContactID,
        )
      ) {
        delete plan.send.accountNumber
        delete plan.ours.accountNumber
        plan.numberHeld = true
      }
    }
  }

  const posts: Array<UpdatePlan> = []
  for (const plan of plans) {
    if (Object.keys(plan.send).length > 0) {
      posts.push(plan)
      continue
    }
    // Nothing to send: what was compared is stored, at no cost to Xero.
    outcomes.push(
      linkedOutcome(plan.job.item, plan.contact, {
        how: plan.job.how,
        expect: plan.job.expect,
        hashes: updatedHashes(plan, {}, plan.contact),
        wrote: false,
        problem: plan.soft,
        different: plan.different,
      }),
    )
  }

  const clashes: Array<UpdatePlan> = []
  const numberRefused: Array<UpdatePlan> = []
  for (let i = 0; i < posts.length; i += BATCH) {
    const chunk = posts.slice(i, i + BATCH)
    const results = await writeMany(
      s,
      'POST',
      chunk.map((plan) =>
        toXeroUpdate(plan.contact.ContactID, plan.send, plan.contact),
      ),
    )
    chunk.forEach((plan, at) =>
      settleUpdate(s, plan, plan.send, results[at], outcomes, {
        clashes,
        numberRefused,
      }),
    )
  }
  for (const plan of numberRefused) {
    delete plan.send.accountNumber
    delete plan.ours.accountNumber
    plan.numberHeld = true
    if (Object.keys(plan.send).length === 0) {
      outcomes.push(
        linkedOutcome(plan.job.item, plan.contact, {
          how: plan.job.how,
          expect: plan.job.expect,
          hashes: updatedHashes(plan, {}, plan.contact),
          wrote: false,
          problem: plan.soft,
          different: plan.different,
        }),
      )
      continue
    }
    try {
      const result = await writeOne(
        s,
        'POST',
        toXeroUpdate(plan.contact.ContactID, plan.send, plan.contact),
      )
      settleUpdate(s, plan, plan.send, result, outcomes, {
        clashes,
        numberRefused: null,
      })
    } catch (error) {
      outcomes.push(itemRefused(error, plan.job.item, false))
    }
  }
  for (const plan of clashes) {
    try {
      outcomes.push(await resolveRenameClash(s, plan))
    } catch (error) {
      outcomes.push(itemRefused(error, plan.job.item, false))
    }
  }
}

/** One element of an update's answer. */
function settleUpdate(
  s: Session,
  plan: UpdatePlan,
  send: Fields,
  result: ItemResult | undefined,
  outcomes: Array<Outcome>,
  later: {
    clashes: Array<UpdatePlan>
    numberRefused: Array<UpdatePlan> | null
  },
): void {
  const { item } = plan.job
  const contact = result?.contact
  const errors = result?.errors ?? ['Xero sent no result for this contact']
  if (contact && errors.length === 0) {
    if (contact.ContactID !== plan.contact.ContactID) {
      outcomes.push({
        kind: 'retry',
        clientId: item.clientId,
        rev: item.rev,
        code: 'response_mismatch',
      })
      return
    }
    outcomes.push(
      linkedOutcome(item, contact, {
        how: plan.job.how,
        expect: plan.job.expect,
        hashes: updatedHashes(plan, send, contact),
        wrote: true,
        problem: plan.soft,
        different: plan.different,
      }),
    )
    return
  }
  if ('name' in send && errors.some(isNameClash)) {
    later.clashes.push(plan)
    return
  }
  if (
    later.numberRefused &&
    'accountNumber' in send &&
    refusesAccountNumber(errors)
  ) {
    later.numberRefused.push(plan)
    return
  }
  const code = refusalCode(errors)
  logRefusal(s, item.clientId, code, errors, [
    plan.contact.Name,
    item.input?.client.name ?? '',
  ])
  outcomes.push({
    kind: 'failed',
    clientId: item.clientId,
    rev: item.rev,
    code,
    creating: false,
  })
}

/**
 * A rename refused because another contact has the new name: the suffixes,
 * as a create's (decision 4) — and if both are taken, everything else that
 * changed is sent without the name, so a new phone number is not held up
 * by it, and the client shows `name_taken`.
 */
async function resolveRenameClash(
  s: Session,
  plan: UpdatePlan,
): Promise<Outcome> {
  const { item } = plan.job
  const input = item.input as ContactInput
  const client = input.client
  const settled = (
    contact: XeroContactFull,
    send: Fields,
    problem: string | null,
  ) =>
    linkedOutcome(item, contact, {
      how: plan.job.how,
      expect: plan.job.expect,
      hashes: updatedHashes(plan, send, contact),
      wrote: true,
      problem,
      different: plan.different,
    })

  for (const name of suffixNames(
    client.name,
    input.oldestSite?.suburb,
    client.clientNumber,
  )) {
    const result = await writeOne(
      s,
      'POST',
      toXeroUpdate(
        plan.contact.ContactID,
        { ...plan.send, name },
        plan.contact,
      ),
    )
    if (result.contact && result.errors.length === 0) {
      return settled(result.contact, plan.send, plan.soft)
    }
    if (result.errors.some(isNameClash)) continue
    const code = refusalCode(result.errors)
    logRefusal(s, item.clientId, code, result.errors, [name, client.name])
    return {
      kind: 'failed',
      clientId: item.clientId,
      rev: item.rev,
      code,
      creating: false,
    }
  }

  const { name: _name, ...rest } = plan.send
  if (Object.keys(rest).length > 0) {
    const result = await writeOne(
      s,
      'POST',
      toXeroUpdate(plan.contact.ContactID, rest, plan.contact),
    )
    if (result.contact && result.errors.length === 0) {
      return settled(result.contact, rest, 'name_taken')
    }
  }
  return {
    kind: 'failed',
    clientId: item.clientId,
    rev: item.rev,
    code: 'name_taken',
    creating: false,
  }
}

/**
 * Sends what is waiting for one connection's organisation (see the top of
 * this file). Scheduled by the hooks a few seconds after a change, by
 * Start syncing, by itself while there is more, and by the reconciler; for
 * whoever looks after the deployment, `xeroSync:kick`.
 */
export const drain = internalAction({
  args: {
    connectionId: v.id('xeroConnections'),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { connectionId, attempt = 0 }): Promise<null> => {
    // The kill switch: nothing is written, and nothing is claimed — the
    // outbox keeps every change until it is off.
    if (!xeroConfigured() || xeroPaused()) return null

    const holder = crypto.randomUUID()
    const claim: Claim = await ctx.runMutation(internal.xeroSync.claimTenant, {
      connectionId,
      holder,
      purpose: 'drain',
    })
    if (!claim.claimed) {
      if (claim.reason === 'paused') {
        await ctx.scheduler.runAfter(
          Math.max(CALL_GAP_MS, claim.until - Date.now() + 1000),
          internal.xeroSync.drain,
          { connectionId },
        )
      } else if (claim.reason === 'busy' && attempt + 1 < BUSY_TRIES) {
        await ctx.scheduler.runAfter(BUSY_RETRY_MS, internal.xeroSync.drain, {
          connectionId,
          attempt: attempt + 1,
        })
      }
      return null
    }

    // A page of work that settled nothing — which should not happen — waits
    // a minute before the next drain rather than spinning.
    let stalled = false
    let stop: Stop | null = null
    try {
      try {
        const s: Session = {
          ctx,
          connectionId,
          holder,
          purpose: 'drain',
          target: claim.target,
          token: await accessTokenFor(ctx, claim.target.grantId),
          refreshed: false,
          // Spaced from the call before it too: whoever held the
          // organisation last (a match, another business's drain) may have
          // called just before letting it go.
          lastCallAt: Date.now(),
          checkedAt: Date.now(),
          contacts: null,
          created: new Set(),
          deadline: Date.now() + DRAIN_BUDGET_MS,
        }
        for (
          let page = 0;
          page < MAX_PAGES_PER_DRAIN && Date.now() < s.deadline;
          page++
        ) {
          const work: Work | null = await ctx.runQuery(
            internal.xeroSync.nextWork,
            {
              connectionId,
              now: Date.now(),
              allowBackfill:
                s.dayRemaining === undefined || s.dayRemaining >= DAY_RESERVE,
            },
          )
          if (!work || (work.items.length === 0 && !work.backfill)) break

          const sent =
            work.items.length > 0
              ? await sendPage(s, work.items)
              : { outcomes: [], stop: null }
          stop = sent.stop
          const pause =
            stop?.kind === 'pause'
              ? { until: stop.until, why: stop.why }
              : stop?.kind === 'failed'
                ? {
                    until: Date.now() + SERVER_PAUSE_MS,
                    why: 'server' as const,
                  }
                : undefined
          // The walk moves on only past a page every client of which was
          // settled (a failed page backs each off, so counts as settled).
          const settled = stop === null || stop.kind === 'failed'
          if (stop?.kind !== 'lease') {
            await ctx.runMutation(internal.xeroSync.recordResults, {
              connectionId,
              holder,
              outcomes: sent.outcomes,
              backfill: settled ? work.backfill : null,
              ...(s.dayRemaining !== undefined
                ? { dayRemaining: s.dayRemaining }
                : {}),
              ...(pause ? { pause } : {}),
            })
          }
          if (work.items.length > 0 && sent.outcomes.length === 0 && !stop) {
            stalled = true
            break
          }
          if (stop) break
        }
      } catch (error) {
        stop = stopOf(error)
        console.error(
          `[xero] drain of connection ${connectionId} stopped: ${describe(error)}`,
        )
        if (stop.kind === 'pause' || stop.kind === 'failed') {
          await ctx.runMutation(internal.xeroSync.holdOff, {
            connectionId,
            ...(stop.kind === 'pause'
              ? { until: stop.until, why: stop.why }
              : {
                  until: Date.now() + SERVER_PAUSE_MS,
                  why: 'server' as const,
                }),
          })
        }
      }

      if (stop?.kind === 'reconnect' && stop.markOrg) {
        // Xero refuses this organisation to a sign-in it otherwise accepts:
        // the holder reconnects (R1's `orgGone`); everything waits.
        await ctx.runMutation(internal.xero.orgGone, { connectionId })
      }
    } finally {
      // Let go whatever happened above, so the organisation isn't held for
      // the rest of the lease by a drain that has stopped.
      await ctx.runMutation(internal.xeroMatch.releaseTenant, {
        connectionId,
        holder,
      })
    }

    // Asked for again even when the organisation was lost to someone else:
    // that may be a match, or another business's drain, which leaves this
    // connection's rows where they are. Busy, the next drain tries again.
    const now = Date.now()
    const next: number | null = await ctx.runQuery(
      internal.xeroSync.nextDrainAt,
      { connectionId, now },
    )
    if (next !== null) {
      const floor = stalled
        ? STALLED_WAIT_MS
        : stop?.kind === 'lease'
          ? BUSY_RETRY_MS
          : CALL_GAP_MS
      await ctx.scheduler.runAfter(
        Math.max(floor, next - now),
        internal.xeroSync.drain,
        { connectionId },
      )
    }
    return null
  },
})

// ──────────────────────────────────────────────────────── starting it

/**
 * Start syncing, by the connection's holder: from now on PestM8 adds the
 * clients the match left as new, fills in the blanks of those it matched,
 * and sends every change after — to this organisation. Nothing is queued
 * for it before this.
 *
 * Needs a finished match no more than a week old (MATCH_STALE otherwise):
 * the links are what is sent, and a stale one is a book that has moved on.
 * Pressing it twice is a no-op. The tallies start from the match's, move
 * with every link, and are counted afresh when the walk is done.
 */
export const startSyncing = mutation({
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
    const business = await ctx.db.get('businesses', businessId)
    if (!business) throw new ConvexError('NOT_FOUND')
    if (business.plan === DEMO_PLAN) throw new ConvexError('XERO_DEMO')
    if (connection.status === 'needs_reconnect') {
      throw new ConvexError('XERO_RECONNECT')
    }
    if (connection.status !== 'connected') throw new ConvexError('NOT_FOUND')
    if (connection.syncStartedAt !== undefined) return null

    const now = Date.now()
    const sync = await syncRowOf(ctx, connectionId)
    const match = sync?.match
    if (!sync || match?.state !== 'ready' || now - match.at > MATCH_FRESH_MS) {
      throw new ConvexError('MATCH_STALE')
    }

    await ctx.db.patch('xeroConnections', connectionId, {
      syncStartedAt: now,
      syncStartedByMembershipId: env.actor.real._id,
    })
    await ctx.db.patch('xeroSyncState', sync._id, {
      backfillCursor: null,
      backfillDoneAt: undefined,
      backfillHeldUntil: undefined,
      counts: {
        inXero: match.linked,
        review: match.review,
        different: 0,
        failed: 0,
        stopped: 0,
        waiting: 0,
      },
      recent: [],
    })
    await recordAudit(ctx, forSelf(env.actor.real._id), {
      businessId,
      action: 'xero.start',
      entityType: 'xeroConnections',
      entityId: connectionId,
      meta: {
        tenantName: connection.tenantName,
        kind: connection.kind,
        linked: match.linked,
        fresh: match.fresh,
        review: match.review,
        leads: match.leads,
      },
      at: now,
    })
    await ctx.scheduler.runAfter(0, internal.xeroSync.drain, { connectionId })
    return null
  },
})

// ───────────────────────────────────────────────── the client sheet

const lineState = v.union(
  v.literal('in_xero'),
  v.literal('waiting'),
  v.literal('lead'),
  v.literal('to_check'),
  v.literal('archived'),
  v.literal('gdpr'),
  v.literal('different'),
  v.literal('failed'),
  v.literal('not_yet'),
  /** In Xero as another client's contact (Keep both): never sent. */
  v.literal('shared'),
)

const clientLine = v.object({
  connectionId: v.id('xeroConnections'),
  kind: v.union(v.literal('business'), v.literal('member')),
  orgName: v.string(),
  state: lineState,
  lastSentAt: v.union(v.number(), v.null()),
  /** Fields Xero holds otherwise (`FieldKey`s), for "Different in Xero". */
  different: v.array(v.string()),
  /** Why it was not sent, or what about it is not quite right: a code the
   * page words. */
  problemCode: v.union(v.string(), v.null()),
  /** The To check card's contact name, for "Xero already has …". */
  candidateName: v.union(v.string(), v.null()),
  /** `shared` only: the client whose contact this one uses, for "In Xero
   * as {name}'s contact". Null if it is not one the person looking can
   * see, or is gone. */
  sharedWithName: v.union(v.string(), v.null()),
  openUrl: v.union(v.string(), v.null()),
  /** Whether the person looking may press "Send PestM8's details". */
  canOverwrite: v.boolean(),
})

export type ClientLine = Infer<typeof clientLine>

/** The live business connection, and the caller's own member one. */
async function linesConnections(
  ctx: QueryCtx,
  env: ActorEnvelope,
  businessId: Id<'businesses'>,
): Promise<Array<Doc<'xeroConnections'>>> {
  const live = (row: Doc<'xeroConnections'>) =>
    row.status === 'connected' || row.status === 'needs_reconnect'
  const found: Array<Doc<'xeroConnections'>> = []
  if (hasCapability(env, 'business.manage')) {
    for (const status of ['connected', 'needs_reconnect'] as const) {
      const row = await ctx.db
        .query('xeroConnections')
        .withIndex('by_business_and_status', (q) =>
          q.eq('businessId', businessId).eq('status', status),
        )
        .filter((q) => q.eq(q.field('kind'), 'business'))
        .first()
      if (row) {
        found.push(row)
        break
      }
    }
  }
  if (env.actor.real.role !== 'owner') {
    const mine = await ctx.db
      .query('xeroConnections')
      .withIndex('by_membership', (q) =>
        q.eq('membershipId', env.actor.real._id),
      )
      .order('desc')
      .take(50)
    const row = mine.find(
      (connection) =>
        connection.kind === 'member' &&
        connection.businessId === businessId &&
        live(connection),
    )
    if (row) found.push(row)
  }
  return found
}

/** "https://go.xero.com/…" for this contact, when the organisation's short
 * code is known. */
function openUrlOf(
  shortCode: string | undefined,
  contactId: string | undefined,
): string | null {
  if (!shortCode || !contactId) return null
  return `https://go.xero.com/organisationlogin/default.aspx?shortcode=${encodeURIComponent(
    shortCode,
  )}&redirecturl=/Contacts/View/${encodeURIComponent(contactId)}`
}

/**
 * Of the fields Xero holds otherwise, those Send PestM8's details can send:
 * the ones PestM8 has a value for. One cleared in PestM8 can't go — nothing
 * blank is sent until "" is proven to clear in Xero
 * (`XERO_CLEARS_WITH_EMPTY`) — so it stays Different, with no button that
 * would promise otherwise.
 */
async function sendableDifferent(
  ctx: QueryCtx,
  client: Doc<'clients'>,
  different: ReadonlyArray<string>,
): Promise<Array<string>> {
  if (different.length === 0 || XERO_CLEARS_WITH_EMPTY) return [...different]
  const business = await ctx.db.get('businesses', client.businessId)
  const ours = ownedFields(await contactInputOf(ctx, client, business?.state), {
    creating: false,
    xeroPoboxBlank: true,
  })
  return different.filter(
    (field) => field in ours && !isBlank(ours[field as FieldKey]),
  )
}

/** The name of the client a shared one uses the contact of — if the person
 * looking may see that client (a contractor sees their own team's). */
async function sharedWithName(
  ctx: QueryCtx,
  visible: Set<Id<'clients'>> | 'all',
  client: Doc<'clients'>,
  holderId: Id<'clients'> | undefined,
): Promise<string | null> {
  if (holderId === undefined || !inClientScope(visible, holderId)) return null
  const holder = await ctx.db.get('clients', holderId)
  if (!holder || holder.businessId !== client.businessId) return null
  return holder.name
}

/**
 * The client sheet's Xero lines: the business's organisation (for whoever
 * may manage the business) and the caller's own (a member's). Up to two.
 * Empty on a deployment not set up for Xero, for a client in the Recycle bin
 * or archived, and for anyone with no organisation connected — the sheet
 * shows nothing then.
 */
export const clientLines = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  returns: v.array(clientLine),
  handler: async (ctx, { businessId, clientId }) => {
    const env = await requireActor(ctx, businessId)
    const client = await ctx.db.get('clients', clientId)
    const visible = await visibleClientIds(ctx, env)
    if (
      !client ||
      client.businessId !== businessId ||
      !inClientScope(visible, clientId)
    ) {
      throw new ConvexError('NOT_FOUND')
    }
    if (!xeroConfigured() || !inXeroBook(client)) return []

    const lines: Array<ClientLine> = []
    for (const connection of await linesConnections(ctx, env, businessId)) {
      const link = await linkOf(ctx, businessId, connection.tenantId, clientId)
      const queued = await ctx.db
        .query('xeroOutbox')
        .withIndex('by_connection_and_client', (q) =>
          q.eq('connectionId', connection._id).eq('clientId', clientId),
        )
        .first()
      const problem = link?.problem?.code ?? null
      const different = link?.different ?? []
      const state: ClientLine['state'] = (() => {
        // Using another client's contact, before Start syncing as after.
        if (link?.state === 'shared') return 'shared'
        if (connection.syncStartedAt === undefined) {
          // Nothing sent yet — but a client the match found in Xero is
          // there, and one to check is to check, before as after.
          switch (link?.state) {
            case 'linked':
              return 'in_xero'
            case 'needs_review':
              return 'to_check'
            default:
              return client.status === 'lead' ? 'lead' : 'not_yet'
          }
        }
        switch (link?.state) {
          case 'needs_review':
            return 'to_check'
          case 'gdpr':
            return 'gdpr'
          case 'archived_in_xero':
            return 'archived'
          case 'failed':
            return 'failed'
          case 'linked':
            if (different.length > 0) return 'different'
            if (problem && !isSoftXeroProblem(problem)) return 'failed'
            return queued ? 'waiting' : 'in_xero'
          default:
            // No contact yet: the queue or the walk of the book adds it.
            return client.status === 'lead' ? 'lead' : 'waiting'
        }
      })()
      lines.push({
        connectionId: connection._id,
        kind: connection.kind,
        orgName: connection.tenantName,
        state,
        lastSentAt: link?.lastSentAt ?? null,
        different,
        problemCode: problem,
        candidateName:
          link?.state === 'needs_review'
            ? (link.candidate?.name ?? null)
            : null,
        sharedWithName:
          link?.state === 'shared'
            ? await sharedWithName(
                ctx,
                visible,
                client,
                link.sharedWithClientId,
              )
            : null,
        openUrl: openUrlOf(connection.shortCode, link?.xeroContactId),
        canOverwrite:
          state === 'different' &&
          !isSwitched(env.actor) &&
          (connection.kind === 'business'
            ? hasCapability(env, 'business.manage')
            : connection.membershipId === env.actor.real._id) &&
          // Every one of them: the confirm says Xero takes PestM8's.
          (await sendableDifferent(ctx, client, different)).length ===
            different.length,
      })
    }
    return lines
  },
})

/**
 * "Send PestM8's details", on a client Xero holds otherwise: by the
 * connection's holder. For each field PestM8 left alone, takes what Xero
 * holds now as the baseline — marked here, read at the next send, since a
 * mutation cannot ask Xero — so that send puts PestM8's value over it.
 * Queues the client for this organisation, and is audited.
 */
export const overwrite = mutation({
  args: {
    businessId: v.id('businesses'),
    connectionId: v.id('xeroConnections'),
    clientId: v.id('clients'),
  },
  returns: v.null(),
  handler: async (ctx, { businessId, connectionId, clientId }) => {
    const env = await requireWriteActor(ctx, businessId)
    if (isSwitched(env.actor)) throw new ConvexError('SWITCHED')
    const connection = await requireConnectionHolder(
      ctx,
      env,
      await ctx.db.get('xeroConnections', connectionId),
      businessId,
    )
    if (!isLiveXero(connection) || connection.syncStartedAt === undefined) {
      throw new ConvexError('NOT_FOUND')
    }
    const client = await ctx.db.get('clients', clientId)
    if (!client || client.businessId !== businessId || !inXeroBook(client)) {
      throw new ConvexError('NOT_FOUND')
    }
    const link = await linkOf(ctx, businessId, connection.tenantId, clientId)
    if (!link || link.state !== 'linked') return null
    const different = link.different ?? []
    // A field cleared in PestM8 can't be sent, and stays Different.
    const fields = await sendableDifferent(ctx, client, different)
    if (fields.length === 0) return null
    const left = different.filter((field) => !fields.includes(field))
    const after = left.length > 0 ? left : undefined

    const seen: FieldHashes = { ...link.seen }
    for (const field of fields) seen[field] = OVERWRITE_MARK
    await ctx.db.patch('xeroContactLinks', link._id, {
      seen,
      different: after,
    })
    await moveSyncCounts(
      ctx,
      await syncRowOf(ctx, connectionId),
      addSyncCounts(
        syncCounts(link, -1),
        syncCounts({ ...link, different: after }, 1),
      ),
    )
    const now = Date.now()
    await queueClientForXero(ctx, connection, clientId, now)
    await recordAudit(ctx, forSelf(env.actor.real._id), {
      businessId,
      action: 'xero.overwrite',
      entityType: 'clients',
      entityId: clientId,
      meta: {
        tenantName: connection.tenantName,
        fields,
        ...(link.xeroContactId ? { xeroContactId: link.xeroContactId } : {}),
      },
      at: now,
    })
    return null
  },
})

/**
 * For an import's Undo dialog: how many of the clients it brought in are a
 * contact in a Xero organisation here (matched or added). Undo takes them
 * out of PestM8; they stay in Xero. Zero for anyone who cannot import, and
 * counted up to 2,000 clients.
 */
export const importNote = query({
  args: {
    businessId: v.id('businesses'),
    importId: v.id('clientImports'),
  },
  returns: v.object({ inXero: v.number() }),
  handler: async (ctx, { businessId, importId }) => {
    const env = await requireActor(ctx, businessId)
    if (!env.caps['clients.manage'] || !xeroConfigured()) return { inXero: 0 }
    const run = await ctx.db.get('clientImports', importId)
    if (!run || run.businessId !== businessId)
      throw new ConvexError('NOT_FOUND')

    const clients = await ctx.db
      .query('clients')
      .withIndex('by_import', (q) => q.eq('importId', importId))
      .take(IMPORT_NOTE_MAX)
    let inXero = 0
    for (const client of clients) {
      const links = await ctx.db
        .query('xeroContactLinks')
        .withIndex('by_client', (q) => q.eq('clientId', client._id))
        .take(20)
      if (links.some((link) => link.state === 'linked' && link.xeroContactId)) {
        inXero += 1
      }
    }
    return { inXero }
  },
})

// ───────────────────────────────────────────────────────────── upkeep

/**
 * Every ten minutes (crons.ts): drains that should be running and are not —
 * one killed by a deploy, a pause that has ended, a walk held for the day's
 * allowance, changes made while the kill switch was on or a reconnect was
 * needed. For each connected, started connection with a row overdue by a
 * minute, or a walk not finished, and nobody holding its organisation:
 * asks for a drain, a second apart. Indexed reads only; nothing while the
 * kill switch is on or Xero is not set up.
 *
 * By connection rather than from the oldest overdue rows: a connection
 * waiting on a reconnect keeps its rows, and they would be the oldest
 * anywhere, crowding out everyone else's.
 */
export const reconcile = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    if (!xeroConfigured() || xeroPaused()) return { scheduled: 0 }
    const now = Date.now()
    let scheduled = 0
    const connected = ctx.db
      .query('xeroConnections')
      .withIndex('by_status_and_createdAt', (q) => q.eq('status', 'connected'))
    for await (const connection of connected) {
      if (connection.syncStartedAt === undefined) continue
      const sync = await syncRowOf(ctx, connection._id)
      if (sync?.pausedUntil !== undefined && sync.pausedUntil > now) continue
      if (await tenantBusy(ctx, connection.tenantId, '', now)) continue
      const overdue = await ctx.db
        .query('xeroOutbox')
        .withIndex('by_connection_and_dueAt', (q) =>
          q.eq('connectionId', connection._id).lt('dueAt', now - OVERDUE_MS),
        )
        .first()
      const walking =
        sync !== null &&
        sync.backfillDoneAt === undefined &&
        !(sync.backfillHeldUntil !== undefined && sync.backfillHeldUntil > now)
      if (!overdue && !walking) continue
      const business = await ctx.db.get('businesses', connection.businessId)
      if (!business || business.plan === DEMO_PLAN) continue
      await ctx.scheduler.runAfter(
        scheduled * CALL_GAP_MS,
        internal.xeroSync.drain,
        { connectionId: connection._id },
      )
      scheduled += 1
    }
    return { scheduled }
  },
})

/**
 * A disconnected connection's outbox, deleted: nothing will be sent to that
 * organisation through it again. In batches, carrying on in a call of its
 * own. A connection live again (never, today) keeps its rows.
 */
export const dropOutbox = internalMutation({
  args: { connectionId: v.id('xeroConnections') },
  handler: async (ctx, { connectionId }): Promise<{ dropped: number }> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (connection && isLiveXero(connection)) return { dropped: 0 }
    const rows = await ctx.db
      .query('xeroOutbox')
      .withIndex('by_connection_and_dueAt', (q) =>
        q.eq('connectionId', connectionId),
      )
      .take(DROP_BATCH)
    for (const row of rows) await ctx.db.delete('xeroOutbox', row._id)
    if (rows.length === DROP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.xeroSync.dropOutbox, {
        connectionId,
      })
    }
    return { dropped: rows.length }
  },
})

// ────────────────────────────────────────────────────────────── tools

/**
 * For whoever looks after the deployment, before Start syncing on prod:
 * `npx convex run xeroSync:dryRun '{"connectionId": "…"}'`. What a full
 * sync of this organisation would do now — how many contacts it would add
 * and update, what it would skip and why, and up to `limit` (10) sample
 * request bodies — WITHOUT writing anything, to Xero or here. With ten or
 * more to add it reads the organisation's contacts (GET only) to say how
 * many of those a match would link or put To check instead.
 *
 * Returns the sample bodies (client details: read them, don't paste them);
 * only the counts go to the log.
 */
export const dryRun = internalAction({
  args: {
    connectionId: v.id('xeroConnections'),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { connectionId, limit = 10 },
  ): Promise<{
    create: number
    update: number
    skip: Record<string, number>
    queued: number
    prematch: { linked: number; review: number; fresh: number } | null
    samples: Array<{ clientId: Id<'clients'>; kind: string; body: object }>
  }> => {
    if (!xeroConfigured()) throw new ConvexError('XERO_NOT_CONFIGURED')
    const skip: Record<string, number> = {}
    const creates: Array<WorkItem> = []
    let update = 0
    let queued = 0
    const samples: Array<{
      clientId: Id<'clients'>
      kind: string
      body: object
    }> = []

    let cursor: string | null = null
    for (;;) {
      const page: {
        items: Array<WorkItem & { queued: boolean }>
        isDone: boolean
        continueCursor: string
      } | null = await ctx.runQuery(internal.xeroSync.dryRunPage, {
        connectionId,
        cursor,
      })
      if (!page) throw new ConvexError('NOT_FOUND')
      for (const item of page.items) {
        if (item.queued) queued += 1
        const judged = eligibility(item.input, item.link)
        if (judged === 'create') {
          creates.push(item)
          if (samples.length < limit && item.input) {
            const ours = ownedFields(item.input, {
              creating: true,
              xeroPoboxBlank: true,
            })
            samples.push({
              clientId: item.clientId,
              kind: 'create',
              body: toXeroCreate(
                typeof ours.name === 'string' ? ours.name : '',
                diff(ours, null, null).send,
              ),
            })
          }
        } else if (judged === 'update') {
          update += 1
          if (
            samples.length < limit &&
            item.input &&
            item.link?.xeroContactId
          ) {
            // Without reading the contact, what PestM8 owns of it: the
            // send itself depends on what Xero holds.
            samples.push({
              clientId: item.clientId,
              kind: 'update (fields PestM8 owns)',
              body: {
                ContactID: item.link.xeroContactId,
                ...ownedFields(item.input, {
                  creating: false,
                  xeroPoboxBlank: false,
                }),
              },
            })
          }
        } else {
          skip[judged] = (skip[judged] ?? 0) + 1
        }
      }
      if (page.isDone) break
      cursor = page.continueCursor
    }

    let prematch: { linked: number; review: number; fresh: number } | null =
      null
    const open = creates.filter(
      (item) =>
        item.input !== null &&
        (item.link === null ||
          ((item.link.state === 'new' || item.link.state === 'failed') &&
            item.link.decidedAt === undefined)),
    )
    if (open.length >= PREMATCH_MIN) {
      const holder = crypto.randomUUID()
      const claim: Claim = await ctx.runMutation(
        internal.xeroSync.claimTenant,
        { connectionId, holder, purpose: 'dryRun' },
      )
      if (claim.claimed) {
        try {
          const s: Session = {
            ctx,
            connectionId,
            holder,
            purpose: 'dryRun',
            target: claim.target,
            token: await accessTokenFor(ctx, claim.target.grantId),
            refreshed: false,
            lastCallAt: Date.now(),
            checkedAt: Date.now(),
            contacts: null,
            created: new Set(),
            deadline: Date.now() + DRAIN_BUDGET_MS,
          }
          const contacts = await loadContacts(s)
          prematch = { linked: 0, review: 0, fresh: 0 }
          for (const proposal of matchClients(
            open.map((item) => clientForMatch(item.input as ContactInput)),
            contacts,
          )) {
            if (proposal.outcome === 'linked') prematch.linked += 1
            else if (proposal.outcome === 'review') prematch.review += 1
            else prematch.fresh += 1
          }
        } finally {
          await ctx.runMutation(internal.xeroMatch.releaseTenant, {
            connectionId,
            holder,
          })
        }
      }
    }

    const summary = {
      create: creates.length,
      update,
      skip,
      queued,
      prematch,
      samples,
    }
    console.log(
      `[xero] dry run of connection ${connectionId}: ${JSON.stringify({
        create: summary.create,
        update: summary.update,
        skip: summary.skip,
        queued: summary.queued,
        prematch: summary.prematch,
      })}`,
    )
    return summary
  },
})

/** One page of the whole book for `dryRun`: every client, judged as a
 * drain would, and whether it is queued. */
export const dryRunPage = internalQuery({
  args: {
    connectionId: v.id('xeroConnections'),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (
    ctx,
    { connectionId, cursor },
  ): Promise<{
    items: Array<WorkItem & { queued: boolean }>
    isDone: boolean
    continueCursor: string
  } | null> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection) return null
    const business = await ctx.db.get('businesses', connection.businessId)
    const page = await ctx.db
      .query('clients')
      .withIndex('by_business', (q) =>
        q.eq('businessId', connection.businessId),
      )
      .paginate({ numItems: 200, cursor })
    const items: Array<WorkItem & { queued: boolean }> = []
    for (const client of page.page) {
      const queued = await ctx.db
        .query('xeroOutbox')
        .withIndex('by_connection_and_client', (q) =>
          q.eq('connectionId', connectionId).eq('clientId', client._id),
        )
        .first()
      items.push({
        clientId: client._id,
        rev: queued?.rev ?? null,
        input: await contactInputOf(ctx, client, business?.state),
        link: await linkOf(
          ctx,
          connection.businessId,
          connection.tenantId,
          client._id,
        ),
        queued: queued !== null,
      })
    }
    return {
      items,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    }
  },
})

/**
 * Walks the whole book again from the top — after a migration that changed
 * what PestM8 sends, say: `npx convex run xeroSync:resyncAll
 * '{"connectionId": "…"}'`. Unchanged clients still cost nothing.
 *
 * `force` forgets what was last sent, so every client is compared afresh —
 * still compare-before-set: what PestM8 last saw in Xero (`seen`) is kept,
 * so a field someone changed in Xero is still theirs (never taken as the
 * new baseline), and one Different in Xero stays so.
 */
export const resyncAll = internalMutation({
  args: {
    connectionId: v.id('xeroConnections'),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, { connectionId, force }): Promise<null> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection || connection.syncStartedAt === undefined) {
      throw new ConvexError('NOT_FOUND')
    }
    const sync = await ensureSyncRow(ctx, connection)
    await ctx.db.patch('xeroSyncState', sync._id, {
      backfillCursor: null,
      backfillDoneAt: undefined,
      backfillHeldUntil: undefined,
    })
    if (force) {
      await ctx.scheduler.runAfter(0, internal.xeroSync.forgetSent, {
        connectionId,
        cursor: null,
      })
    } else {
      await ctx.scheduler.runAfter(0, internal.xeroSync.drain, { connectionId })
    }
    return null
  },
})

/** `resyncAll`'s `force`: every link of the organisation here forgets what
 * was sent, a batch at a time; then the drain walks the book. */
export const forgetSent = internalMutation({
  args: {
    connectionId: v.id('xeroConnections'),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { connectionId, cursor }): Promise<null> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection) return null
    const page = await ctx.db
      .query('xeroContactLinks')
      .withIndex('by_business_and_tenant_and_client', (q) =>
        q
          .eq('businessId', connection.businessId)
          .eq('tenantId', connection.tenantId),
      )
      .paginate({ numItems: CLEAR_BATCH, cursor })
    for (const link of page.page) {
      if (link.sent === undefined) continue
      // What Xero holds otherwise stays on record as sent, so it stays
      // Different; as does a field "Send PestM8's details" was pressed for,
      // so it still goes.
      const keep = new Set(link.different ?? [])
      for (const [field, hash] of Object.entries(link.seen ?? {})) {
        if (hash === OVERWRITE_MARK) keep.add(field)
      }
      const sent: FieldHashes = {}
      for (const [field, hash] of Object.entries(link.sent)) {
        if (keep.has(field)) sent[field] = hash
      }
      await ctx.db.patch('xeroContactLinks', link._id, {
        sent: Object.keys(sent).length > 0 ? sent : undefined,
      })
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.xeroSync.forgetSent, {
        connectionId,
        cursor: page.continueCursor,
      })
    } else {
      await ctx.scheduler.runAfter(0, internal.xeroSync.drain, { connectionId })
    }
    return null
  },
})

/** Asks for a drain now: `npx convex run xeroSync:kick '{"connectionId":
 * "…"}'`. The drain itself decides whether it may run. */
export const kick = internalMutation({
  args: { connectionId: v.id('xeroConnections') },
  handler: async (ctx, { connectionId }): Promise<null> => {
    await ctx.scheduler.runAfter(0, internal.xeroSync.drain, { connectionId })
    return null
  },
})

const countsArg = v.object({
  inXero: v.number(),
  review: v.number(),
  different: v.number(),
  failed: v.number(),
  stopped: v.number(),
})

/**
 * Counts one organisation's tallies afresh from its links (clients in the
 * Recycle bin or archived left out) and its outbox — the repair for counts
 * that drifted, and what Start syncing asks for. A batch at a time, carrying
 * the sums on in a call of its own.
 */
export const recount = internalMutation({
  args: {
    connectionId: v.id('xeroConnections'),
    cursor: v.optional(v.union(v.string(), v.null())),
    partial: v.optional(countsArg),
  },
  handler: async (ctx, { connectionId, cursor, partial }): Promise<null> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection) return null
    const sums = partial ?? {
      inXero: 0,
      review: 0,
      different: 0,
      failed: 0,
      stopped: 0,
    }
    const page = await ctx.db
      .query('xeroContactLinks')
      .withIndex('by_business_and_tenant_and_client', (q) =>
        q
          .eq('businessId', connection.businessId)
          .eq('tenantId', connection.tenantId),
      )
      .paginate({ numItems: RECOUNT_BATCH, cursor: cursor ?? null })
    for (const link of page.page) {
      const client = await ctx.db.get('clients', link.clientId)
      if (!client || !inXeroBook(client)) continue
      const delta = syncCounts(link, 1)
      sums.inXero += delta.inXero ?? 0
      sums.review += delta.review ?? 0
      sums.different += delta.different ?? 0
      sums.failed += delta.failed ?? 0
      sums.stopped += delta.stopped ?? 0
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.xeroSync.recount, {
        connectionId,
        cursor: page.continueCursor,
        partial: sums,
      })
      return null
    }
    const sync = await syncRowOf(ctx, connectionId)
    if (!sync) return null
    const waiting = (
      await ctx.db
        .query('xeroOutbox')
        .withIndex('by_connection_and_dueAt', (q) =>
          q.eq('connectionId', connectionId),
        )
        .take(WAITING_CAP)
    ).length
    await ctx.db.patch('xeroSyncState', sync._id, {
      counts: { ...sums, waiting },
    })
    return null
  },
})
