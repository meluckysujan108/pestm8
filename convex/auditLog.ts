import { v } from 'convex/values'
import { internalMutation, query } from './_generated/server'
import { requireMembership } from './lib/access'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'

/**
 * The one place anything writes an audit-log row — kept separate from the
 * mutations that trigger these events (`reports.finalise`, `email.send`)
 * because `email.send` is a Node action and can't touch `ctx.db` itself.
 */
export const log = internalMutation({
  args: {
    businessId: v.id('businesses'),
    actorMembershipId: v.id('memberships'),
    action: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    meta: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('auditLog', { ...args, at: Date.now() })
  },
})

/**
 * Can this member see the history of this particular thing?
 *
 * Membership alone used to be enough, so a subcontractor who learned a report
 * id — from a link, a note, a colleague — could read who that report was
 * emailed to, and a membership id got them somebody's permission history.
 * History is as sensitive as the thing it describes.
 */
async function canSeeEntityHistory(
  ctx: QueryCtx,
  membership: Doc<'memberships'>,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  if (membership.role === 'owner') return true

  switch (entityType) {
    case 'reports': {
      const report = await ctx.db.get(entityId as Id<'reports'>)
      if (!report || report.businessId !== membership.businessId) return false
      // The same rule the report itself uses: authored by you, or your scope
      // covers the whole business.
      return (
        report.authorMembershipId === membership._id ||
        membership.canViewAllJobs
      )
    }
    case 'jobs': {
      const job = await ctx.db.get(entityId as Id<'jobs'>)
      if (!job || job.businessId !== membership.businessId) return false
      return (
        job.assignedMembershipId === membership._id || membership.canViewAllJobs
      )
    }
    // Team and invitation history is management information.
    case 'memberships':
    case 'invitations':
      return false
    default:
      return false
  }
}

/**
 * History for one entity (a report, most often) — the action bar's "Email
 * Logs" and "Action Logs" tabs both read this, filtered by `action` prefix
 * client-side rather than as two separate queries.
 */
export const forEntity = query({
  args: {
    businessId: v.id('businesses'),
    entityType: v.string(),
    entityId: v.string(),
  },
  handler: async (ctx, { businessId, entityType, entityId }) => {
    const membership = await requireMembership(ctx, businessId)
    if (!(await canSeeEntityHistory(ctx, membership, entityType, entityId))) {
      // Empty rather than an error: the caller may legitimately be looking at
      // something with no history, and the two should be indistinguishable.
      return []
    }

    const entries = await ctx.db
      .query('auditLog')
      .withIndex('by_entity', (q) =>
        q.eq('entityType', entityType).eq('entityId', entityId),
      )
      .collect()

    // The index isn't scoped by business — entity ids are Convex-global, so
    // this can't leak another tenant's rows, but filtering explicitly keeps
    // the guarantee obvious rather than implicit.
    const scoped = entries.filter((entry) => entry.businessId === businessId)

    const actorIds = [
      ...new Set(scoped.map((entry) => entry.actorMembershipId)),
    ]
    const actors = new Map(
      await Promise.all(
        actorIds.map(async (id) => [id, await ctx.db.get(id)] as const),
      ),
    )

    return scoped
      .sort((a, b) => b.at - a.at)
      .map((entry) => ({
        _id: entry._id,
        action: entry.action,
        meta: entry.meta,
        at: entry.at,
        actorColour: actors.get(entry.actorMembershipId)?.colour,
      }))
  },
})
