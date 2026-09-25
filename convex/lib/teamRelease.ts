import { forSelf, recordAudit } from './audit'
import { releasedGrants } from './capabilities'
import { factsFromMembership } from './membershipFacts'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/**
 * A contractor's team goes back to answering to the owner — the step that has
 * to come with a contractor stopping being one.
 *
 * "A contractor has a team" has no representation but `parentMembershipId`,
 * and nothing used to clear it. Demote a contractor, or remove them, and their
 * people went on pointing at someone who no longer had a team: still capped by
 * that person's toggles on every read (a removed contractor holds none, so the
 * whole team lost prices and the schedule), still shown under them on the Team
 * screen, and invisible to the owner's "Works under" picker, which lists only
 * contractors.
 *
 * Each person keeps what they could see a moment before (`releasedGrants`);
 * only who they answer to changes. Anyone not active loses the pointer alone,
 * so a later rejoin does not land them on a team that no longer exists.
 *
 * `contractor` must be the row as it was BEFORE the demotion or removal — its
 * grants are the ceiling being baked in. Call it before patching that row.
 */
export async function releaseTeam(
  ctx: MutationCtx,
  {
    contractor,
    actorId,
    reason,
    at,
  }: {
    contractor: Doc<'memberships'>
    actorId: Id<'memberships'>
    reason: 'demoted' | 'removed' | 'left'
    at: number
  },
): Promise<number> {
  const team = await ctx.db
    .query('memberships')
    .withIndex('by_business_parent', (q) =>
      q
        .eq('businessId', contractor.businessId)
        .eq('parentMembershipId', contractor._id),
    )
    .collect()
  const formerParent = factsFromMembership(contractor)

  let released = 0
  for (const member of team) {
    if (member.status !== 'active') {
      await ctx.db.patch(member._id, { parentMembershipId: undefined })
      continue
    }

    const grants = releasedGrants(factsFromMembership(member), formerParent)
    await ctx.db.patch(member._id, {
      parentMembershipId: undefined,
      grants,
      canViewAllJobs: grants.otherSchedules,
    })
    released += 1

    // The same record `team.assignTo` writes for a move to "answers to the
    // owner", with why and from whom, so the history of who worked under whom
    // has no gap where a demotion happened.
    await recordAudit(ctx, forSelf(actorId), {
      businessId: contractor.businessId,
      action: 'membership.assignTo',
      entityType: 'memberships',
      entityId: member._id,
      meta: {
        parentMembershipId: null,
        grants,
        reason: `contractor.${reason}`,
        formerParentMembershipId: contractor._id,
      },
      at,
    })

    /**
     * Any switch between them ends. Going up, a subcontractor could only ever
     * work in their own contractor's account; going down, a contractor only
     * in their own team's. Neither validates any more — `canSwitchInto` would
     * refuse both on the next request — and a row that means nothing should
     * not be left waiting, as `offboard` says of the rows it deletes.
     */
    const switches = [
      ...(await ctx.db
        .query('accountSwitches')
        .withIndex('by_real', (q) => q.eq('realMembershipId', member._id))
        .collect()),
      ...(await ctx.db
        .query('accountSwitches')
        .withIndex('by_target', (q) => q.eq('targetMembershipId', member._id))
        .collect()),
    ]
    for (const row of switches) {
      if (
        row.realMembershipId === contractor._id ||
        row.targetMembershipId === contractor._id
      ) {
        await ctx.db.delete(row._id)
      }
    }
  }
  return released
}
