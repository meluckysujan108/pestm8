import { v } from 'convex/values'
import { internalMutation, query } from './_generated/server'
import { requireMembership } from './lib/access'
import { canSeeReport } from './reports'
import type { Id } from './_generated/dataModel'
import { memberName } from './lib/reportContext'

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

    // Membership alone is not enough for a report. A subcontractor without
    // `canViewAllJobs` cannot open somebody else's report, and its history
    // says who the client is, where the document went and when — so answering
    // it would hand over by the side door exactly what the front door
    // refuses. Whether they may see the report is the report's own rule, so
    // it is asked rather than re-implemented here.
    if (entityType === 'reports') {
      const report = await ctx.db.get(entityId as Id<'reports'>)
      if (
        !report ||
        report.businessId !== businessId ||
        report.deletedAt !== undefined ||
        !canSeeReport(membership, report)
      ) {
        // Empty rather than an error: a history nobody may read and a history
        // with nothing in it look the same from outside, which is the point.
        return []
      }
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

    const actorIds = [...new Set(scoped.map((entry) => entry.actorMembershipId))]
    const actors = new Map(
      await Promise.all(
        actorIds.map(async (id) => {
          const actor = await ctx.db.get(id)
          return [
            id,
            actor
              ? {
                  // A history that reads "Emailed" with a colour dot beside it
                  // tells an owner nothing about who did it, and "who sent
                  // this" is the question the history exists to answer.
                  name: await memberName(ctx, actor.userId),
                  colour: actor.colour,
                }
              : null,
          ] as const
        }),
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
        actorName: actors.get(entry.actorMembershipId)?.name,
      }))
  },
})
