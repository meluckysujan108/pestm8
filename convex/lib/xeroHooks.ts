import { ConvexError } from 'convex/values'
import { internal } from '../_generated/api'
import { requireCapability } from './actor'
import { forSelf, recordAudit } from './audit'
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
 * Release 3 adds `markClientForXero`, `markClientsForXero`,
 * `ensureClientInXero` and `dropXeroLinksForClient` here: the hooks every
 * client, site and contact write calls to queue its change for each
 * connected organisation.
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
