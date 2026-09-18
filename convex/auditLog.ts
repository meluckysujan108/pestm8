import { v } from 'convex/values'
import { internalMutation, query } from './_generated/server'
import { recordAudit } from './lib/audit'
import { hasCapability, requireActor } from './lib/actor'
import { displayPerson, isInScope, reportScope } from './lib/capabilities'
import { factsFromMembership } from './lib/membershipFacts'
import { memberName } from './lib/reportContext'
import type { ActorEnvelope } from './lib/actor'
import type { Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'

/**
 * The way in from an action.
 *
 * This used to claim it was the one place anything wrote an audit row. It was
 * not — eighteen mutations inserted the row by hand and only `email.send` came
 * through here — which is why the claim is gone and the actual single writer is
 * `lib/audit.ts`. This is now just the door for callers with no `ctx.db` of
 * their own: `email.send` is a Node action.
 */
export const log = internalMutation({
  args: {
    businessId: v.id('businesses'),
    actorMembershipId: v.id('memberships'),
    /** The account the change was made in, when that is not the actor. See
     * `schema.ts` — absent means they were working as themselves. */
    onBehalfOfMembershipId: v.optional(v.id('memberships')),
    action: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    meta: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await recordAudit(
      ctx,
      {
        actorMembershipId: args.actorMembershipId,
        onBehalfOfMembershipId: args.onBehalfOfMembershipId,
      },
      {
        businessId: args.businessId,
        action: args.action,
        entityType: args.entityType,
        entityId: args.entityId,
        meta: args.meta,
      },
    )
  },
})

/**
 * Can this caller see the history of this particular thing?
 *
 * Membership alone used to be enough, so a subcontractor who learned a report
 * id — from a link, a note, a colleague — could read who that report was
 * emailed to, and a membership id got them somebody's permission history.
 * History is as sensitive as the thing it describes.
 *
 * So the question for a report or a job is exactly the one reading the thing
 * itself asks: whether the caller's SCOPE covers it. Not a role, and not the
 * old two-valued `canViewAllJobs` flag — the scope is what knows about a
 * contractor's team and about someone working inside another account, and a
 * history rule that disagreed with the thing's own rule would let one be read
 * without the other.
 */
async function canSeeEntityHistory(
  ctx: QueryCtx,
  env: ActorEnvelope,
  businessId: Id<'businesses'>,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  switch (entityType) {
    case 'reports': {
      const report = await ctx.db.get(entityId as Id<'reports'>)
      if (!report || report.businessId !== businessId) return false
      if (report.deletedAt !== undefined) return false
      return reportScope(env.scope, report)
    }
    case 'jobs': {
      const job = await ctx.db.get(entityId as Id<'jobs'>)
      if (!job || job.businessId !== businessId) return false
      return isInScope(env.scope, job)
    }
    // Team and invitation history is management information: the owner's,
    // and not while they are working inside somebody else's account —
    // `business.manage` is dropped for the length of a switch.
    case 'memberships':
    case 'invitations':
      return hasCapability(env, 'business.manage')
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
    const env = await requireActor(ctx, businessId)
    if (
      !(await canSeeEntityHistory(ctx, env, businessId, entityType, entityId))
    ) {
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

    const business = await ctx.db.get(businessId)
    const businessName =
      business?.tradingName ?? business?.name ?? 'The business'

    const actorIds = [
      ...new Set(scoped.map((entry) => entry.actorMembershipId)),
    ]
    const actors = new Map(
      await Promise.all(
        actorIds.map(async (id) => {
          const actor = await ctx.db.get(id)
          if (!actor) return [id, null] as const
          // A history that reads "Emailed" with a colour dot beside it tells an
          // owner nothing about who did it, and "who sent this" is the question
          // the history exists to answer. Named through `displayPerson`, so the
          // owner — invisible as a person on every trail — reads as the
          // business rather than by name.
          const shown = displayPerson(env.actor, factsFromMembership(actor), {
            personName: await memberName(ctx, actor.userId),
            businessName,
          })
          return [id, { name: shown.name, colour: actor.colour }] as const
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
        actorName: actors.get(entry.actorMembershipId)?.name,
        actorColour: actors.get(entry.actorMembershipId)?.colour,
      }))
  },
})
