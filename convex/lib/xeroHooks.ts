import { ConvexError } from 'convex/values'
import { internal } from '../_generated/api'
import { requireCapability } from './actor'
import { forSelf, recordAudit } from './audit'
import { isBinned } from './bin'
import { isSwitched } from './capabilities'
import { xeroConfigured, xeroPaused } from './xeroConfig'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { ActorEnvelope } from './actor'

/**
 * Where the rest of the app touches Xero, from inside its own mutations.
 *
 * Kept here, out of convex/xero.ts, so a mutation elsewhere (offboarding
 * today; every client write from Release 3) can call in without importing a
 * module of Convex functions — and so the list of places that reach Xero is
 * one file long. Mutations only: nothing here calls Xero itself. What has to
 * reach Xero is scheduled, so the write that caused it commits whatever Xero
 * is doing at the time.
 *
 * Release 2 keeps a match's counts true as clients leave and rejoin the
 * book (`dropXeroLinksForClient`, `countXeroLinksOf`); Release 3 keeps its
 * sync tallies the same way (`moveSyncCounts`). A client that stops holding
 * its contact lets go of the clients sharing it (`releaseSharesOf`). Release 3 queues every
 * change for each organisation that is syncing through the four hooks at the
 * end of this file, which every write to a client, its contacts or its sites
 * calls — convex/xeroHooks.test.ts reads the source to hold each one to that.
 */

/** A connection that still means something: being finished, working, or
 * waiting for its holder to sign in to Xero again. */
export const LIVE_XERO_STATUSES = [
  'pending',
  'connected',
  'needs_reconnect',
] as const satisfies ReadonlyArray<Doc<'xeroConnections'>['status']>

export function isLiveXero(connection: Doc<'xeroConnections'>): boolean {
  return connection.status !== 'disconnected'
}

/**
 * The one person who may change this connection, or a refusal.
 *
 * The business's Xero belongs to the business, so it is the owner's to
 * change, through `business.manage` — which a switch already drops, so an
 * owner working inside someone else's account switches back first, as for
 * everything else they administer. A member's own Xero is theirs alone: not
 * the owner's (who sees it read-only on Team), and not anyone switched into
 * their account, because connecting or disconnecting it acts on their own
 * books outside PestM8 (the `canSetLicence` precedent).
 *
 * NOT_FOUND for a connection of another business, whatever the caller may
 * do in their own, so an id says nothing about where it belongs.
 */
export async function requireConnectionHolder(
  _ctx: QueryCtx | MutationCtx,
  env: ActorEnvelope,
  connection: Doc<'xeroConnections'> | null,
  businessId: Id<'businesses'>,
): Promise<Doc<'xeroConnections'>> {
  if (!connection || connection.businessId !== businessId) {
    throw new ConvexError('NOT_FOUND')
  }
  if (connection.kind === 'business') {
    requireCapability(env, 'business.manage')
    return connection
  }
  if (isSwitched(env.actor) || connection.membershipId !== env.actor.real._id) {
    throw new ConvexError('NO_ACCESS')
  }
  return connection
}

/**
 * Disconnect every Xero this person connected here, because they are
 * leaving (`team.offboard`, which both remove and leave go through).
 *
 * The connection stops; what was already copied into their organisation
 * stays there — PestM8 never deletes in Xero, and their books are theirs.
 * The release at Xero (`DELETE /connections`, and revoking the sign-in when
 * nothing else uses it) is scheduled rather than done here, because a
 * mutation cannot call out, and because a removal must not wait on, or fail
 * with, Xero.
 *
 * Audited against whoever ran the removal, one row per connection, so the
 * business's history says which organisation stopped receiving its clients
 * and when. Returns how many were live.
 */
export async function disconnectXeroFor(
  ctx: MutationCtx,
  target: Doc<'memberships'>,
  byMembershipId: Id<'memberships'>,
  reason: 'offboarded',
): Promise<number> {
  const rows = await ctx.db
    .query('xeroConnections')
    .withIndex('by_membership', (q) => q.eq('membershipId', target._id))
    .collect()

  const now = Date.now()
  let count = 0
  for (const connection of rows) {
    if (!isLiveXero(connection)) continue
    await ctx.db.patch('xeroConnections', connection._id, {
      status: 'disconnected',
      disconnectReason: reason,
      disconnectedAt: now,
      disconnectedByMembershipId: byMembershipId,
    })
    await recordAudit(ctx, forSelf(byMembershipId), {
      businessId: connection.businessId,
      action: 'xero.disconnect',
      entityType: 'xeroConnections',
      entityId: connection._id,
      meta: {
        reason,
        tenantName: connection.tenantName,
        kind: connection.kind,
      },
      at: now,
    })
    await ctx.scheduler.runAfter(0, internal.xero.releaseAtXero, {
      connectionId: connection._id,
    })
    // What was waiting to go to their organisation no longer will.
    await ctx.scheduler.runAfter(0, internal.xeroSync.dropOutbox, {
      connectionId: connection._id,
    })
    count += 1
  }
  return count
}

// ─────────────────────────────────────────── a match's counts (Release 2)

const MATCH_COUNT_KEYS = [
  'linked',
  'review',
  'fresh',
  'different',
  'shared',
] as const

/** A move of a finished match's counts (`xeroSyncState.match`). */
export type MatchCountsDelta = Partial<
  Record<(typeof MATCH_COUNT_KEYS)[number], number>
>

/** What one link of this state adds to its organisation's counts (`sign`
 * 1), or takes from them (−1). A Different client is counted under `fresh`
 * too: Release 3 adds it as a new contact, as it does one nothing matched.
 * A client using another's contact (`shared`) has a list of its own. The
 * states only sending reaches (archived or erased in Xero, refused) are on
 * none of the match page's lists, so in none of its counts. */
export function linkCounts(
  state: Doc<'xeroContactLinks'>['state'],
  sign: 1 | -1,
): MatchCountsDelta {
  switch (state) {
    case 'linked':
      return { linked: sign }
    case 'needs_review':
      return { review: sign }
    case 'new':
      return { fresh: sign }
    case 'separate':
      return { fresh: sign, different: sign }
    case 'shared':
      return { shared: sign }
    case 'archived_in_xero':
    case 'gdpr':
    case 'failed':
      return {}
  }
}

/** Adds two moves together. */
export function addCounts(
  a: MatchCountsDelta,
  b: MatchCountsDelta,
): MatchCountsDelta {
  const sum: MatchCountsDelta = { ...a }
  for (const key of MATCH_COUNT_KEYS) {
    if (b[key] !== undefined) sum[key] = (sum[key] ?? 0) + b[key]
  }
  return sum
}

/**
 * Moves one connection's finished match counts, so Settings, the hub's
 * badge and the match page's chips agree with the lists without a run. Not
 * while a run is under way: it zeroed them, and sets them itself when it is
 * done. Never below nought.
 */
export async function moveMatchCounts(
  ctx: MutationCtx,
  sync: Doc<'xeroSyncState'> | null,
  delta: MatchCountsDelta,
): Promise<void> {
  const match = sync?.match
  if (!sync || match?.state !== 'ready') return
  if (MATCH_COUNT_KEYS.every((key) => !delta[key])) return
  const moved = (field: (typeof MATCH_COUNT_KEYS)[number]) =>
    // `shared` is absent on a match finished before sharing existed.
    Math.max(0, (match[field] ?? 0) + (delta[field] ?? 0))
  await ctx.db.patch('xeroSyncState', sync._id, {
    match: {
      ...match,
      linked: moved('linked'),
      review: moved('review'),
      fresh: moved('fresh'),
      different: moved('different'),
      shared: moved('shared'),
    },
  })
}

/** Whether a client is in the book Xero gets: not in the Recycle bin, and
 * not archived the old way (`archivedAt`). Only those are matched, listed
 * and counted. */
export function inXeroBook(client: Doc<'clients'>): boolean {
  return !isBinned(client) && client.archivedAt === undefined
}

// ─────────────────────────────────────────── a sync's counts (Release 3)

/** A move of an organisation's sync tallies (`xeroSyncState.counts`). */
export type SyncCountsDelta = Partial<
  Record<'inXero' | 'review' | 'different' | 'failed' | 'stopped', number>
>

const SYNC_COUNT_KEYS = [
  'inXero',
  'review',
  'different',
  'failed',
  'stopped',
] as const

/**
 * Problems a contact can have that leave it in Xero and up to date in all
 * but one detail (lib/xeroContact.ts `MapperProblem`): an email Xero would
 * refuse, left out; people past Xero's five, left out. Listed under Recent
 * problems and shown on the client, but not counted as failed.
 */
export function isSoftXeroProblem(code: string): boolean {
  return code === 'email_not_ascii' || code === 'persons_full'
}

/**
 * What one link adds to its organisation's sync tallies (`sign` 1), or takes
 * from them (−1) — for a client in the book; one in the Recycle bin or
 * archived is in none. Null for no link at all.
 */
export function syncCounts(
  link: Pick<
    Doc<'xeroContactLinks'>,
    'state' | 'different' | 'problem' | 'xeroContactId'
  > | null,
  sign: 1 | -1,
): SyncCountsDelta {
  if (!link) return {}
  switch (link.state) {
    case 'linked': {
      const delta: SyncCountsDelta = { inXero: sign }
      if ((link.different?.length ?? 0) > 0) delta.different = sign
      // In Xero, but its last change was refused: Settings lists it.
      if (link.problem && !isSoftXeroProblem(link.problem.code)) {
        delta.failed = sign
      }
      return delta
    }
    case 'needs_review':
      return { review: sign }
    case 'failed':
      return { failed: sign }
    case 'archived_in_xero':
    case 'gdpr':
      return { stopped: sign }
    // Shared: never sent, and in Xero only as its holder, which is counted.
    case 'new':
    case 'separate':
    case 'shared':
      return {}
  }
}

/** Adds two moves together. */
export function addSyncCounts(
  a: SyncCountsDelta,
  b: SyncCountsDelta,
): SyncCountsDelta {
  const sum: SyncCountsDelta = { ...a }
  for (const key of SYNC_COUNT_KEYS) {
    if (b[key] !== undefined) sum[key] = (sum[key] ?? 0) + b[key]
  }
  return sum
}

/**
 * Moves one connection's sync tallies, so Settings and the hub agree with
 * the links without a scan. Only once Start syncing has made them
 * (`counts` set); never below nought. `xeroSync.recount` is the repair.
 */
export async function moveSyncCounts(
  ctx: MutationCtx,
  sync: Doc<'xeroSyncState'> | null,
  delta: SyncCountsDelta,
): Promise<void> {
  const counts = sync?.counts
  if (!sync || !counts) return
  if (SYNC_COUNT_KEYS.every((key) => !delta[key])) return
  const moved = { ...counts }
  for (const key of SYNC_COUNT_KEYS) {
    moved[key] = Math.max(0, counts[key] + (delta[key] ?? 0))
  }
  await ctx.db.patch('xeroSyncState', sync._id, { counts: moved })
}

/** Every organisation's counts this client's links are in, moved by `sign`
 * for each link — and, with `drop`, the links deleted. */
async function moveClientLinks(
  ctx: MutationCtx,
  clientId: Id<'clients'>,
  sign: 1 | -1,
  { drop, counted }: { drop: boolean; counted: boolean },
): Promise<void> {
  const links = await ctx.db
    .query('xeroContactLinks')
    .withIndex('by_client', (q) => q.eq('clientId', clientId))
    .collect()
  for (const link of links) {
    if (counted) {
      // Every connection of this business to this organisation: the live
      // one, and any it replaced (whose counts nobody reads, but which
      // shouldn't lie either). A handful at most.
      const rows = ctx.db
        .query('xeroSyncState')
        .withIndex('by_tenant', (q) => q.eq('tenantId', link.tenantId))
      for await (const sync of rows) {
        if (sync.businessId !== link.businessId) continue
        // Each patches only its own field (`match`, `counts`), so the one
        // read serves both.
        await moveMatchCounts(ctx, sync, linkCounts(link.state, sign))
        await moveSyncCounts(ctx, sync, syncCounts(link, sign))
      }
    }
    if (drop) await ctx.db.delete('xeroContactLinks', link._id)
  }
}

/**
 * A client leaves the book Xero gets (into the Recycle bin, or archived)
 * or comes back to it (restored, unarchived): its links stay, for a
 * restore, but the lists hide them while it is out, so the counts follow.
 * Call it only when the client's place in the book really changed —
 * `inXeroBook` before and after.
 *
 * Out of the book it holds no contact (`xeroMatch.othersLinkedTo`), so the
 * clients that used its contact go back To check (`releaseSharesOf`). A
 * restore does not take them back: whether they are still the same
 * customer is the holder's to say again.
 */
export async function countXeroLinksOf(
  ctx: MutationCtx,
  clientId: Id<'clients'>,
  sign: 1 | -1,
): Promise<void> {
  if (sign === -1) await releaseSharesOf(ctx, clientId)
  await moveClientLinks(ctx, clientId, sign, { drop: false, counted: true })
}

// ─────────────────────────────── the same customer's contact (2026-10-16)

/** Clients using one client's contact, read at most: two or three at most
 * in practice — one per PestM8 duplicate of a customer. */
const SHARES_MAX = 200

/**
 * Moves every count of this business's connections to one organisation:
 * the live one and any it replaced (whose counts nobody reads, but which
 * shouldn't lie either). A handful at most.
 */
async function moveTenantCounts(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  tenantId: string,
  match: MatchCountsDelta,
  sync: SyncCountsDelta,
): Promise<void> {
  const rows = ctx.db
    .query('xeroSyncState')
    .withIndex('by_tenant', (q) => q.eq('tenantId', tenantId))
  for await (const row of rows) {
    if (row.businessId !== businessId) continue
    // Each patches only its own field, so the one read serves both.
    await moveMatchCounts(ctx, row, match)
    await moveSyncCounts(ctx, row, sync)
  }
}

/** The latest match run's id for this organisation, which an undecided row
 * is tagged with so that run's finish keeps it (as `xeroMatch.reopen`
 * does): the newest of this business's connections to it. */
async function latestRunId(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  tenantId: string,
): Promise<string> {
  let latest: { at: number; runId: string } | null = null
  const rows = ctx.db
    .query('xeroSyncState')
    .withIndex('by_tenant', (q) => q.eq('tenantId', tenantId))
  for await (const row of rows) {
    if (row.businessId !== businessId || !row.match) continue
    if (!latest || row.match.at > latest.at) {
      latest = { at: row.match.at, runId: row.match.runId }
    }
  }
  return latest?.runId ?? ''
}

/**
 * A client stops holding its Xero contact in an organisation — unlinked,
 * given to another client, its contact merged or archived in Xero, put in
 * the Recycle bin, archived, merged into another client, wiped — so every
 * client that was the same customer and used that contact (`shared`) goes
 * back To check, asked about the contact it used (`was_shared`): is it that
 * contact now, a contact of its own, or the same customer as whoever holds
 * the contact next? Nothing is sent for it meanwhile (`review`), and it is
 * never quietly linked: the holder's "same customer" was about the client
 * that held it.
 *
 * The ONE place a shared link is let go, called from every path that ends
 * a hold: `xeroMatch` (unlink, give, a run's re-proposal or clean-up, a
 * stale link Same clears), `xeroSync` (a contact archived, erased or put To
 * check by Xero), `countXeroLinksOf` (bin, archive) and
 * `dropXeroLinksForClient` (wipe, an import's undo, clientMerge.ts `merge`).
 * Idempotent: with nothing shared, one indexed read.
 *
 * One organisation (`tenantId`), or every one. `runId` tags the rows for a
 * match run under way, so its finish keeps them; otherwise the latest
 * match's. Counts move with them. Returns how many of them are in the book
 * — a run under way moves its own totals by that.
 */
export async function releaseSharesOf(
  ctx: MutationCtx,
  holderId: Id<'clients'>,
  { tenantId, runId }: { tenantId?: string; runId?: string } = {},
): Promise<number> {
  const rows = await ctx.db
    .query('xeroContactLinks')
    .withIndex('by_sharedWithClientId', (q) =>
      q.eq('sharedWithClientId', holderId),
    )
    .take(SHARES_MAX)
  let inBook = 0
  for (const row of rows) {
    if (tenantId !== undefined && row.tenantId !== tenantId) continue
    // Released already (`was_shared`, still naming whose contact it was),
    // or answered since.
    if (row.state !== 'shared') continue
    const client = await ctx.db.get('clients', row.clientId)
    const counted = client !== null && inXeroBook(client)
    // Without a contact to ask about (never, but defensively) it is new.
    const state = row.xeroContactId ? 'needs_review' : 'new'
    await ctx.db.patch('xeroContactLinks', row._id, {
      state,
      candidate: row.xeroContactId
        ? {
            contactId: row.xeroContactId,
            name: row.xeroName ?? '',
            reason: 'was_shared',
          }
        : undefined,
      xeroContactId: undefined,
      xeroName: undefined,
      how: undefined,
      // `sharedWithClientId` is kept, so the card can say whose contact it
      // used; the holder's next answer clears it.
      decidedAt: undefined,
      decidedByMembershipId: undefined,
      runId: runId ?? (await latestRunId(ctx, row.businessId, row.tenantId)),
      sent: undefined,
      seen: undefined,
      different: undefined,
      problem: undefined,
    })
    if (counted) {
      inBook += 1
      await moveTenantCounts(
        ctx,
        row.businessId,
        row.tenantId,
        addCounts(linkCounts('shared', -1), linkCounts(state, 1)),
        addSyncCounts(
          syncCounts(row, -1),
          syncCounts({ state, xeroContactId: undefined }, 1),
        ),
      )
    }
  }
  return inBook
}

/**
 * The holder's contact is a different one now, though it is the same
 * customer's — Xero merged the old one into it (`xeroSync` relink) — or
 * Xero renamed it: the clients sharing it follow, still shared. Nothing is
 * sent for them either way; this keeps what their lines and the match page
 * show true.
 */
export async function moveSharesOf(
  ctx: MutationCtx,
  holderId: Id<'clients'>,
  tenantId: string,
  to: { xeroContactId: string; xeroName: string },
): Promise<void> {
  const rows = await ctx.db
    .query('xeroContactLinks')
    .withIndex('by_sharedWithClientId', (q) =>
      q.eq('sharedWithClientId', holderId),
    )
    .take(SHARES_MAX)
  for (const row of rows) {
    if (row.tenantId !== tenantId || row.state !== 'shared') continue
    if (
      row.xeroContactId === to.xeroContactId &&
      row.xeroName === to.xeroName
    ) {
      continue
    }
    await ctx.db.patch('xeroContactLinks', row._id, {
      xeroContactId: to.xeroContactId,
      xeroName: to.xeroName,
    })
  }
}

// ───────────────────────────────── a client merged into another (2026-10-16)

/** A client's link in one organisation, if it has one. */
async function linkIn(
  ctx: QueryCtx | MutationCtx,
  client: Doc<'clients'>,
  tenantId: string,
): Promise<Doc<'xeroContactLinks'> | null> {
  return await ctx.db
    .query('xeroContactLinks')
    .withIndex('by_business_and_tenant_and_client', (q) =>
      q
        .eq('businessId', client.businessId)
        .eq('tenantId', tenantId)
        .eq('clientId', client._id),
    )
    .first()
}

/**
 * Whether a link is the client's own Xero contact: linked to it (a change
 * refused or not), or stopped there — archived, or erased at the person's
 * request — which is still that contact, kept so it is never made again. A
 * client sharing another's contact has none of its own; one To check,
 * Different, new or never added has none yet.
 */
export function holdsOwnContact(
  link: Pick<Doc<'xeroContactLinks'>, 'state' | 'xeroContactId'> | null,
): boolean {
  if (!link || link.xeroContactId === undefined) return false
  switch (link.state) {
    case 'linked':
    case 'failed':
    case 'archived_in_xero':
    case 'gdpr':
      return true
    case 'needs_review':
    case 'separate':
    case 'new':
    case 'shared':
      return false
  }
}

/**
 * What merging B (`from`) into A (`into`) does in one organisation:
 * - `takes_over`: B is a contact of its own there and A is none, so A takes
 *   B's contact over (`handOverContacts`) — the same customer's, with its
 *   history — rather than being added beside it as a second one;
 * - `stays`: both are, so A keeps its own and B's stays in Xero, linked to
 *   nothing (PestM8 never deletes there);
 * - `none`: B has no contact of its own there; A keeps whatever it has.
 */
export type MergeXeroOutcome = 'takes_over' | 'stays' | 'none'

export function mergeOutcome(
  fromLink: Pick<Doc<'xeroContactLinks'>, 'state' | 'xeroContactId'> | null,
  intoLink: Pick<Doc<'xeroContactLinks'>, 'state' | 'xeroContactId'> | null,
): MergeXeroOutcome {
  if (!holdsOwnContact(fromLink)) return 'none'
  return holdsOwnContact(intoLink) ? 'stays' : 'takes_over'
}

/**
 * What a merge of B into A would do in each organisation this business has
 * connected — for its confirm (clientMerge.ts `mergePreview`). Live
 * connections only (connected, or waiting on a reconnect), one per
 * organisation; empty on a deployment not set up for Xero. The merge itself
 * goes by every link B has, a disconnected organisation's too
 * (`handOverContacts`).
 */
export async function mergeOutcomesOf(
  ctx: QueryCtx | MutationCtx,
  from: Doc<'clients'>,
  into: Doc<'clients'>,
): Promise<
  Array<{
    connectionId: Id<'xeroConnections'>
    kind: Doc<'xeroConnections'>['kind']
    orgName: string
    outcome: MergeXeroOutcome
  }>
> {
  if (!xeroConfigured()) return []
  const found: Array<{
    connectionId: Id<'xeroConnections'>
    kind: Doc<'xeroConnections'>['kind']
    orgName: string
    outcome: MergeXeroOutcome
  }> = []
  const tenants = new Set<string>()
  for (const status of ['connected', 'needs_reconnect'] as const) {
    const rows = await ctx.db
      .query('xeroConnections')
      .withIndex('by_business_and_status', (q) =>
        q.eq('businessId', from.businessId).eq('status', status),
      )
      .take(50)
    for (const connection of rows) {
      if (tenants.has(connection.tenantId)) continue
      tenants.add(connection.tenantId)
      found.push({
        connectionId: connection._id,
        kind: connection.kind,
        orgName: connection.tenantName,
        outcome: mergeOutcome(
          await linkIn(ctx, from, connection.tenantId),
          await linkIn(ctx, into, connection.tenantId),
        ),
      })
    }
  }
  return found
}

/** A contact one client handed to another in a merge, for its audit. */
export type HandedOver = {
  tenantId: string
  state: Doc<'xeroContactLinks'>['state']
  xeroContactId: string
}

/**
 * B is being merged into A (clientMerge.ts `merge`, before B goes into the
 * bin): in every organisation where B is a contact of its own and A is none
 * (`mergeOutcome` `takes_over`), A takes that contact over — B's link
 * becomes A's. Without this A would be added there as a new contact, a
 * duplicate of B's, with the customer's invoices split between the two.
 * Every organisation B has a link in, connected or not: links outlive a
 * disconnect, and pass to whoever connects it next.
 *
 * - A's link there (none, new, To check, Different, not added, or sharing
 *   another client's contact — B's own among them) becomes B's: the same
 *   contact and state (linked; or archived or erased in Xero, so A is never
 *   added there either), `how: relinked`, decided by whoever merged — a
 *   later match never undoes it. What was sent and seen carries over: it
 *   describes the contact, so compare before set sends what of A differs
 *   from what B sent where Xero still holds that, and leaves the
 *   bookkeeper's own changes alone.
 * - Clients sharing B's contact there are the same customer: they follow it
 *   to A, still shared, rather than being put To check.
 * - B's link there goes, and the counts move with it all.
 *
 * Where A has a contact of its own already, nothing here: B's link goes with
 * B (`dropXeroLinksForClient`), its contact stays in Xero linked to
 * nothing, and whoever shared it goes back To check. Returns what was
 * handed over, for the merge's audit.
 */
export async function handOverContacts(
  ctx: MutationCtx,
  {
    from,
    into,
    by,
    now,
  }: {
    from: Doc<'clients'>
    into: Doc<'clients'>
    by: Id<'memberships'>
    now: number
  },
): Promise<Array<HandedOver>> {
  const handed: Array<HandedOver> = []
  const links = await ctx.db
    .query('xeroContactLinks')
    .withIndex('by_client', (q) => q.eq('clientId', from._id))
    .collect()
  for (const link of links) {
    const intoLink = await linkIn(ctx, into, link.tenantId)
    const contactId = link.xeroContactId
    if (
      mergeOutcome(link, intoLink) !== 'takes_over' ||
      contactId === undefined
    ) {
      continue
    }

    // Whoever shared B's contact here follows it to A. A itself, if it was
    // one of them, takes the contact below.
    const sharers = await ctx.db
      .query('xeroContactLinks')
      .withIndex('by_sharedWithClientId', (q) =>
        q.eq('sharedWithClientId', from._id),
      )
      .take(SHARES_MAX)
    for (const row of sharers) {
      if (
        row.tenantId !== link.tenantId ||
        row.state !== 'shared' ||
        row.clientId === into._id
      ) {
        continue
      }
      await ctx.db.patch('xeroContactLinks', row._id, {
        sharedWithClientId: into._id,
      })
    }

    const after = {
      state: link.state,
      how: 'relinked' as const,
      xeroContactId: contactId,
      ...(link.xeroName !== undefined ? { xeroName: link.xeroName } : {}),
      decidedAt: now,
      decidedByMembershipId: by,
      ...(link.sent !== undefined ? { sent: link.sent } : {}),
      ...(link.seen !== undefined ? { seen: link.seen } : {}),
      ...(link.lastSentAt !== undefined ? { lastSentAt: link.lastSentAt } : {}),
    }
    if (intoLink) {
      // Everything A's link said of another question goes.
      await ctx.db.patch('xeroContactLinks', intoLink._id, {
        xeroName: undefined,
        candidate: undefined,
        sharedWithClientId: undefined,
        runId: undefined,
        sent: undefined,
        seen: undefined,
        different: undefined,
        problem: undefined,
        lastSentAt: undefined,
        ...after,
      })
    } else {
      await ctx.db.insert('xeroContactLinks', {
        businessId: link.businessId,
        tenantId: link.tenantId,
        clientId: into._id,
        ...after,
      })
    }
    await ctx.db.delete('xeroContactLinks', link._id)

    // Both are in the book (the merge checked), but only what is counted
    // moves.
    let match: MatchCountsDelta = {}
    let sync: SyncCountsDelta = {}
    if (inXeroBook(from)) {
      match = addCounts(match, linkCounts(link.state, -1))
      sync = addSyncCounts(sync, syncCounts(link, -1))
    }
    if (inXeroBook(into)) {
      if (intoLink) {
        match = addCounts(match, linkCounts(intoLink.state, -1))
        sync = addSyncCounts(sync, syncCounts(intoLink, -1))
      }
      match = addCounts(match, linkCounts(after.state, 1))
      sync = addSyncCounts(sync, syncCounts(after, 1))
    }
    await moveTenantCounts(ctx, link.businessId, link.tenantId, match, sync)
    handed.push({
      tenantId: link.tenantId,
      state: link.state,
      xeroContactId: contactId,
    })
  }
  return handed
}

// ──────────────────────────────── a client's changes, queued (Release 3)
//
// Every write to a client, its contacts or its sites calls one of these, in
// the same mutation (convex/xeroHooks.test.ts holds the source to it). They
// queue; they never judge. Whether a client belongs in Xero at all — a lead
// not yet booked, one in the bin — is decided when the queue is sent, from
// the client as it is then, so a change of status between the two is never
// missed.
//
// What they queue is a row of `xeroOutbox` per (sending connection, client),
// which convex/xeroSync.ts `drain` sends. On a deployment not set up for
// Xero (e2e, local, every test that does not fake it) they do nothing at all,
// and they read nothing of a business that has never pressed Start syncing
// beyond its connections — a handful of rows.

/** How long after a change its send waits, so a burst of edits to one client
 * — a name, then a phone, then a site — goes to Xero as one write. */
export const XERO_SEND_DELAY_MS = 5000
/** A queued row older than this keeps its time when changed again, so a
 * client being edited steadily is still sent rather than pushed back for
 * ever. */
const XERO_SEND_STARVE_MS = 60_000

/**
 * The connections of a business that are sending: Start syncing pressed,
 * and connected — or waiting for their holder to reconnect, when changes
 * queue all the same and go once they have. Not a disconnected one, whose
 * rows were deleted with it. A handful at most.
 */
async function sendingConnections(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
): Promise<Array<Doc<'xeroConnections'>>> {
  const rows: Array<Doc<'xeroConnections'>> = []
  for (const status of ['connected', 'needs_reconnect'] as const) {
    const found = await ctx.db
      .query('xeroConnections')
      .withIndex('by_business_and_status', (q) =>
        q.eq('businessId', businessId).eq('status', status),
      )
      .collect()
    rows.push(...found.filter((row) => row.syncStartedAt !== undefined))
  }
  return rows
}

/**
 * Queues one client for one connection. A client already waiting has its
 * `rev` raised — so a send in flight for the old version does not clear it —
 * and its time put back a few seconds, unless it has waited a minute
 * already. A new row asks for a drain in a few seconds, unless an earlier
 * row of this connection already has one coming by then (the drain, done,
 * looks for what is left and comes back for it).
 *
 * No drain is asked for while the kill switch is on or the connection needs
 * reconnecting: either would refuse it. The reconciler (convex/crons.ts)
 * sends what waited once they are over.
 */
export async function queueClientForXero(
  ctx: MutationCtx,
  connection: Doc<'xeroConnections'>,
  clientId: Id<'clients'>,
  now: number,
): Promise<void> {
  const row = await ctx.db
    .query('xeroOutbox')
    .withIndex('by_connection_and_client', (q) =>
      q.eq('connectionId', connection._id).eq('clientId', clientId),
    )
    .first()
  if (row) {
    const starving = now - row.firstQueuedAt > XERO_SEND_STARVE_MS
    // A row backing off after a failed send keeps the later time.
    const dueAt = starving
      ? row.dueAt
      : row.attempts > 0
        ? Math.max(row.dueAt, now + XERO_SEND_DELAY_MS)
        : now + XERO_SEND_DELAY_MS
    await ctx.db.patch('xeroOutbox', row._id, { rev: row.rev + 1, dueAt })
    return
  }

  const dueAt = now + XERO_SEND_DELAY_MS
  const coming = await ctx.db
    .query('xeroOutbox')
    .withIndex('by_connection_and_dueAt', (q) =>
      q.eq('connectionId', connection._id).lte('dueAt', dueAt),
    )
    .first()
  await ctx.db.insert('xeroOutbox', {
    businessId: connection.businessId,
    connectionId: connection._id,
    clientId,
    rev: 1,
    dueAt,
    firstQueuedAt: now,
    attempts: 0,
  })
  if (!coming && connection.status === 'connected' && !xeroPaused()) {
    await ctx.scheduler.runAfter(XERO_SEND_DELAY_MS, internal.xeroSync.drain, {
      connectionId: connection._id,
    })
  }
}

/** Whether a client has a link in any organisation: a lead with none has
 * never been in Xero, and waits for its first booking. */
async function hasAnyLink(
  ctx: MutationCtx,
  clientId: Id<'clients'>,
): Promise<boolean> {
  const link = await ctx.db
    .query('xeroContactLinks')
    .withIndex('by_client', (q) => q.eq('clientId', clientId))
    .first()
  return link !== null
}

/**
 * Something Xero's copy of this client is made from changed — its name,
 * number, email or phone, a contact, a site, its place in the book — so each
 * organisation it is synced to gets it again.
 *
 * Queued for every sending connection of its business, whatever the client
 * now is: in the bin, archived, a lead. The drain decides from the client as
 * it is when it is sent, so a status change in between is never missed —
 * with one cheap exception: a lead that is in no organisation yet, which
 * nothing sends until it is booked (`activateLeadAt` marks it then).
 */
export async function markClientForXero(
  ctx: MutationCtx,
  clientId: Id<'clients'>,
): Promise<void> {
  if (!xeroConfigured()) return
  const client = await ctx.db.get('clients', clientId)
  if (!client) return
  const connections = await sendingConnections(ctx, client.businessId)
  if (connections.length === 0) return
  if (client.status === 'lead' && !(await hasAnyLink(ctx, clientId))) return
  const now = Date.now()
  for (const connection of connections) {
    await queueClientForXero(ctx, connection, clientId, now)
  }
}

/** `markClientForXero` for several clients at once — a delete or a restore
 * from the Recycle bin, which can take a client, sites and contacts of
 * several. Each is queued once, however often it is named. */
export async function markClientsForXero(
  ctx: MutationCtx,
  clientIds: Iterable<Id<'clients'>>,
): Promise<void> {
  if (!xeroConfigured()) return
  for (const clientId of new Set(clientIds)) {
    await markClientForXero(ctx, clientId)
  }
}

/**
 * Work was booked for a client that is not a lead (`activateLeadAt`). It is
 * queued only for an organisation that has no contact for it yet, or failed
 * to make one — so booking a job for a client already in Xero costs Xero
 * nothing. One the match left as new is added by the walk of the book after
 * Start syncing, if it has not been already.
 */
export async function ensureClientInXero(
  ctx: MutationCtx,
  clientId: Id<'clients'>,
): Promise<void> {
  if (!xeroConfigured()) return
  const client = await ctx.db.get('clients', clientId)
  if (!client) return
  const connections = await sendingConnections(ctx, client.businessId)
  if (connections.length === 0) return
  const now = Date.now()
  for (const connection of connections) {
    const link = await ctx.db
      .query('xeroContactLinks')
      .withIndex('by_business_and_tenant_and_client', (q) =>
        q
          .eq('businessId', client.businessId)
          .eq('tenantId', connection.tenantId)
          .eq('clientId', clientId),
      )
      .first()
    if (!link || link.state === 'failed') {
      await queueClientForXero(ctx, connection, clientId, now)
    }
  }
}

/**
 * A client is about to be wiped for good (bin.ts `wipeStep`, clientImports.ts
 * `undoStep`), or was merged into another (clientMerge.ts `merge`): its links go,
 * in every organisation, and the counts they were in drop — unless it was
 * already out of the book (in the bin), when they were dropped as it went
 * in. Anything still queued for it goes too: there is nothing left to send.
 * Clients that used its contact go back To check (`releaseSharesOf`). The
 * contacts stay in Xero; PestM8 never deletes there.
 *
 * Call it before the client's row is deleted: whether its links are still
 * counted is read from the client. Once the row is gone there is no telling,
 * so the links go and the counts are left as they are.
 */
export async function dropXeroLinksForClient(
  ctx: MutationCtx,
  clientId: Id<'clients'>,
): Promise<void> {
  const client = await ctx.db.get('clients', clientId)
  // Whoever used its contact goes back To check, in every organisation.
  await releaseSharesOf(ctx, clientId)
  await moveClientLinks(ctx, clientId, -1, {
    drop: true,
    counted: client !== null && inXeroBook(client),
  })
  const queued = await ctx.db
    .query('xeroOutbox')
    .withIndex('by_client', (q) => q.eq('clientId', clientId))
    .collect()
  for (const row of queued) {
    await ctx.db.delete('xeroOutbox', row._id)
  }
}
