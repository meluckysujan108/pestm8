import { ConvexError } from 'convex/values'
import { internal } from '../_generated/api'
import { requireCapability } from './actor'
import { forSelf, recordAudit } from './audit'
import { isBinned } from './bin'
import { isSwitched } from './capabilities'
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
 * book (`deleteXeroLinksOf`, `countXeroLinksOf`). Release 3 adds
 * `markClientForXero`, `markClientsForXero` and `ensureClientInXero` here:
 * the hooks every client, site and contact write calls to queue its change
 * for each connected organisation.
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
    count += 1
  }
  return count
}

// ─────────────────────────────────────────── a match's counts (Release 2)

/** A move of a finished match's counts (`xeroSyncState.match`). */
export type MatchCountsDelta = Partial<
  Record<'linked' | 'review' | 'fresh' | 'different', number>
>

/** What one link of this state adds to its organisation's counts (`sign`
 * 1), or takes from them (−1). A Different client is counted under `fresh`
 * too: Release 3 adds it as a new contact, as it does one nothing matched. */
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
  }
}

/** Adds two moves together. */
export function addCounts(
  a: MatchCountsDelta,
  b: MatchCountsDelta,
): MatchCountsDelta {
  const sum: MatchCountsDelta = { ...a }
  for (const key of ['linked', 'review', 'fresh', 'different'] as const) {
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
  const moved = (field: 'linked' | 'review' | 'fresh' | 'different') =>
    Math.max(0, match[field] + (delta[field] ?? 0))
  await ctx.db.patch('xeroSyncState', sync._id, {
    match: {
      ...match,
      linked: moved('linked'),
      review: moved('review'),
      fresh: moved('fresh'),
      different: moved('different'),
    },
  })
}

/** Whether a client is in the book Xero gets: not in the Recycle bin, and
 * not archived the old way (`archivedAt`). Only those are matched, listed
 * and counted. */
export function inXeroBook(client: Doc<'clients'>): boolean {
  return !isBinned(client) && client.archivedAt === undefined
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
        await moveMatchCounts(ctx, sync, linkCounts(link.state, sign))
      }
    }
    if (drop) await ctx.db.delete('xeroContactLinks', link._id)
  }
}

/**
 * A client is wiped for good (bin.ts `wipeStep`, clientImports.ts
 * `undoStep`): its links go, in every organisation, and the counts they
 * were in drop — unless it was already out of the book (in the bin), when
 * they were dropped as it went in. The contacts stay in Xero; PestM8 never
 * deletes there.
 */
export async function deleteXeroLinksOf(
  ctx: MutationCtx,
  client: Doc<'clients'>,
): Promise<void> {
  await moveClientLinks(ctx, client._id, -1, {
    drop: true,
    counted: inXeroBook(client),
  })
}

/**
 * A client leaves the book Xero gets (into the Recycle bin, or archived)
 * or comes back to it (restored, unarchived): its links stay, for a
 * restore, but the lists hide them while it is out, so the counts follow.
 * Call it only when the client's place in the book really changed —
 * `inXeroBook` before and after.
 */
export async function countXeroLinksOf(
  ctx: MutationCtx,
  clientId: Id<'clients'>,
  sign: 1 | -1,
): Promise<void> {
  await moveClientLinks(ctx, clientId, sign, { drop: false, counted: true })
}
