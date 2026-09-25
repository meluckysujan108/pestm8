import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { components } from './_generated/api'
import { authComponent } from './auth'
import { requireMembership } from './lib/access'
import { inviteState } from './lib/inviteTokens'
import { forSelf, recordAudit } from './lib/audit'
import {
  canAssignTo,
  canDispatchTo,
  canManageMember,
  canSetColour,
  canSetRole,
  NO_GRANTS,
  recomputeGrants,
} from './lib/capabilities'
import { factsFromMembership } from './lib/membershipFacts'
import { clearTwoStepAttempts } from './twoStepAttempts'
import { NOT_STARTED_STATUSES } from './lib/jobStatus'
import type { JobStatus } from './lib/jobStatus'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import {
  hasCapability,
  requireActor,
  requireCapability,
  requireWriteActor,
} from './lib/actor'

/**
 * Offboarding.
 *
 * Until now nothing in the codebase ever set a membership to 'removed'. A
 * subcontractor who finished up, or left on bad terms, kept reading the client
 * book and their own schedule indefinitely, and the only remedy was editing
 * production data by hand.
 *
 * Removing someone is not one write. Their future work has to land on somebody
 * else, their half-finished compliance records have to stay completable, their
 * outstanding invitations have to die, and their session has to stop working.
 * Doing any of that separately leaves a business in a worse state than before.
 */

// Every visit still to be done: a projected `recurring` visit and a `pending`
// one are as much this person's upcoming work as a `booked` one — and so is
// one already `invoiced`, since a visit can be billed before it happens.
const FUTURE_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  ...NOT_STARTED_STATUSES,
  'invoiced',
])

async function futureJobsOf(
  ctx: QueryCtx | MutationCtx,
  membershipId: Id<'memberships'>,
  businessId: Id<'businesses'>,
) {
  const jobs = await ctx.db
    .query('jobs')
    .withIndex('by_assignee_date', (q) =>
      q.eq('assignedMembershipId', membershipId).gte('scheduledAt', Date.now()),
    )
    .collect()
  // The index is per assignee, not per business: a member of two businesses
  // must not have the other one's work counted here.
  return jobs.filter(
    (job) =>
      job.businessId === businessId && FUTURE_JOB_STATUSES.has(job.status),
  )
}

async function activeRecurrencesOf(
  ctx: QueryCtx | MutationCtx,
  membershipId: Id<'memberships'>,
  businessId: Id<'businesses'>,
) {
  const recurrences = await ctx.db
    .query('recurrences')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .collect()
  return recurrences.filter(
    (r) => r.active && r.assignedMembershipId === membershipId,
  )
}

async function openDraftsOf(
  ctx: QueryCtx | MutationCtx,
  membershipId: Id<'memberships'>,
  businessId: Id<'businesses'>,
) {
  const reports = await ctx.db
    .query('reports')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .collect()
  return reports.filter(
    (r) => r.authorMembershipId === membershipId && r.status === 'draft',
  )
}

/**
 * What the owner is shown before confirming. "Remove Kevin" means something
 * different when Kevin has twelve jobs booked and a termite certificate part
 * written, and the confirmation should say so.
 */
export const removalPreview = query({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
  },
  handler: async (ctx, { businessId, membershipId }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'team.manage')
    const target = await ctx.db.get(membershipId)
    if (!target || target.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    // Someone else's workload is not a contractor's to read, any more than
    // they are theirs to remove.
    if (!canManageMember(env.actor, factsFromMembership(target))) {
      throw new ConvexError('NO_ACCESS')
    }

    const user = await authComponent.getAnyUserById(ctx, target.userId)
    const [futureJobs, recurrences, drafts] = await Promise.all([
      futureJobsOf(ctx, membershipId, businessId),
      activeRecurrencesOf(ctx, membershipId, businessId),
      openDraftsOf(ctx, membershipId, businessId),
    ])

    return {
      name: user?.name ?? user?.email ?? 'This person',
      futureJobs: futureJobs.length,
      activeRecurrences: recurrences.length,
      openDrafts: drafts.length,
    }
  },
})

async function offboard(
  ctx: MutationCtx,
  {
    actor,
    target,
    businessId,
    reassignTo,
    action,
  }: {
    /** Only the id is ever used — for the audit row and `removedByMembershipId`
     * — so this takes the id rather than the whole row. That lets the caller
     * pass either a membership document or the resolved actor's facts, which
     * are not the same shape and do not need to be. */
    actor: { _id: Id<'memberships'> }
    target: Doc<'memberships'>
    businessId: Id<'businesses'>
    reassignTo?: Id<'memberships'>
    action: 'membership.remove' | 'membership.leave'
  },
) {
  const now = Date.now()

  const [futureJobs, recurrences, drafts] = await Promise.all([
    futureJobsOf(ctx, target._id, businessId),
    activeRecurrencesOf(ctx, target._id, businessId),
    openDraftsOf(ctx, target._id, businessId),
  ])

  // Work does not silently disappear from the schedule. If there is anything
  // booked ahead, the caller has to say who picks it up.
  if (futureJobs.length > 0 || recurrences.length > 0) {
    if (!reassignTo) throw new ConvexError('NEEDS_REASSIGNMENT')

    const successor = await ctx.db.get(reassignTo)
    if (
      !successor ||
      successor.businessId !== businessId ||
      successor.status !== 'active' ||
      successor._id === target._id
    ) {
      throw new ConvexError('INVALID_ASSIGNEE')
    }

    for (const job of futureJobs) {
      await ctx.db.patch(job._id, { assignedMembershipId: successor._id })
    }
    for (const recurrence of recurrences) {
      await ctx.db.patch(recurrence._id, {
        assignedMembershipId: successor._id,
      })
    }
  }

  // A half-written Treatment Record is a record the business is required to
  // keep, and only its author can finalise one. Leaving them attached to a
  // removed member would strand them forever, so they move to whoever ran the
  // removal — with the original author preserved in the audit entry.
  for (const draft of drafts) {
    await ctx.db.patch(draft._id, { authorMembershipId: actor._id })
  }

  await ctx.db.patch(target._id, {
    status: 'removed',
    removedAt: now,
    removedByMembershipId: actor._id,
    canViewAllJobs: false,
    canViewOtherAccounts: false,
    viewingAsMembershipId: undefined,
    // Their grants go with them. A membership id is never reused, so a stale
    // `switchInto` could not be redeemed by anyone — but leaving a removed
    // person holding a grant makes the row read as though they still have
    // access to someone's account, which is the opposite of what it now means.
    grants: NO_GRANTS,
  })

  /**
   * Both directions of a switch end here, which is what the `by_real` and
   * `by_target` indexes were added for and what nothing had used.
   *
   * Access is already revoked without this: `canSwitchInto` is re-derived from
   * live rows on every single request, so a surviving row grants exactly
   * nothing the moment the membership stops being active. It is cleaned up
   * because a row that means nothing should not still exist — it would resume
   * having meaning if the ids it names ever came back, and it makes the table
   * a worse answer to "who is in whose account right now".
   */
  for (const index of ['by_real', 'by_target'] as const) {
    const rows = await ctx.db
      .query('accountSwitches')
      .withIndex(index, (q) =>
        index === 'by_real'
          ? q.eq('realMembershipId', target._id)
          : q.eq('targetMembershipId', target._id),
      )
      .collect()
    for (const row of rows) await ctx.db.delete(row._id)
  }

  // Their chosen views go the same way, for the same reason: a row naming a
  // membership that has ended should not be waiting if the ids come back.
  const views = await ctx.db
    .query('sessionViews')
    .withIndex('by_real', (q) => q.eq('realMembershipId', target._id))
    .collect()
  for (const row of views) await ctx.db.delete(row._id)

  // Anyone currently looking through this person's eyes stops doing so.
  const siblings = await ctx.db
    .query('memberships')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .collect()
  for (const sibling of siblings) {
    if (sibling.viewingAsMembershipId === target._id) {
      await ctx.db.patch(sibling._id, { viewingAsMembershipId: undefined })
    }
  }

  // An outstanding link for their address would let them walk straight back in.
  const user = await authComponent.getAnyUserById(ctx, target.userId)
  const email = user?.email.toLowerCase()
  if (email) {
    const invitations = await ctx.db
      .query('invitations')
      .withIndex('by_email', (q) => q.eq('email', email))
      .collect()
    for (const invitation of invitations) {
      if (invitation.businessId !== businessId) continue
      if (inviteState(invitation, now) !== 'valid') continue
      await ctx.db.patch(invitation._id, { revokedAt: now })
    }
  }

  // Convex access stops on their next call regardless, because requireMembership
  // re-reads the membership every time. Deleting the sessions also ends the web
  // session on the device in their pocket — but only if this was their last
  // active membership, since a person can work for two businesses.
  const otherActive = await ctx.db
    .query('memberships')
    .withIndex('by_user', (q) => q.eq('userId', target.userId))
    .collect()
  const stillMemberElsewhere = otherActive.some(
    (m) => m._id !== target._id && m.status === 'active',
  )
  if (!stillMemberElsewhere) {
    await deleteAllAuthRows(ctx, 'session', target.userId)
  }

  await recordAudit(ctx, forSelf(actor._id), {
    businessId,
    action,
    entityType: 'memberships',
    entityId: target._id,
    meta: {
      reassignedJobs: futureJobs.length,
      reassignedRecurrences: recurrences.length,
      transferredDrafts: drafts.length,
      reassignedTo: reassignTo,
      sessionsRevoked: !stillMemberElsewhere,
    },
    at: now,
  })

  return {
    reassignedJobs: futureJobs.length,
    reassignedRecurrences: recurrences.length,
    transferredDrafts: drafts.length,
  }
}

export const remove = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    reassignTo: v.optional(v.id('memberships')),
  },
  handler: async (ctx, { businessId, membershipId, reassignTo }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'team.manage')
    const actor = env.actor.real

    const target = await ctx.db.get(membershipId)
    if (!target || target.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (target._id === actor._id) throw new ConvexError('CANNOT_REMOVE_SELF')
    // The owner account is the key to the business. It is not removable from
    // inside the app at all, which also makes "last owner" unreachable here.
    if (target.role === 'owner') throw new ConvexError('LAST_OWNER')
    if (target.status === 'removed') throw new ConvexError('NOT_FOUND')
    // `team.manage` says they may manage somebody; this says whether it is
    // this somebody. A contractor holds the capability business-wide and the
    // reach of their own team only — without this, they could remove anyone
    // in the business but the owner.
    if (!canManageMember(env.actor, factsFromMembership(target))) {
      throw new ConvexError('NO_ACCESS')
    }
    // And their work goes only where this person could have booked it
    // (`canDispatchTo`): a contractor hands it to themselves or their own
    // team, not onto another contractor's calendar. `offboard` still checks
    // the rest — active, this business, not the person leaving.
    if (reassignTo !== undefined) {
      const successor = await ctx.db.get(reassignTo)
      if (
        successor &&
        !canDispatchTo(env.actor, factsFromMembership(successor))
      ) {
        throw new ConvexError('INVALID_ASSIGNEE')
      }
    }

    return offboard(ctx, {
      actor,
      target,
      businessId,
      reassignTo,
      action: 'membership.remove',
    })
  },
})

/**
 * Leaving is the subcontractor's own decision, the mirror of joining being
 * theirs (§1.4). An owner cannot leave: there would be nobody holding the
 * business.
 */
export const leave = mutation({
  args: {
    businessId: v.id('businesses'),
    reassignTo: v.optional(v.id('memberships')),
  },
  handler: async (ctx, { businessId, reassignTo }) => {
    const actor = await requireMembership(ctx, businessId)
    if (actor.role === 'owner') throw new ConvexError('LAST_OWNER')

    return offboard(ctx, {
      actor,
      target: actor,
      businessId,
      reassignTo,
      action: 'membership.leave',
    })
  },
})

/**
 * The team, for managing it — as distinct from `memberships.listForBusiness`,
 * which is the roster six ordinary screens read.
 *
 * Separate because the two answer different questions and one of them is
 * management information. Grants belong to whoever may change them, not to
 * every picker and mention list in the app, and putting them on the shared
 * roster would have shipped a person's access settings to every screen that
 * needed a colour and a name.
 */
export const roster = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'team.manage')
    // Only the owner may open a member's licence document (licences.ts), so
    // only the owner is told who has one.
    const seesLicences = hasCapability(env, 'business.manage')

    const members = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()

    return Promise.all(
      members
        .filter((m) => m.status !== 'removed')
        .map(async (m) => {
          const user = await authComponent.getAnyUserById(ctx, m.userId)
          const facts = factsFromMembership(m)
          return {
            _id: m._id,
            name: user?.name ?? '',
            email: user?.email ?? '',
            role: m.role,
            status: m.status,
            colour: m.colour,
            licenceNumber: m.licenceNumber,
            /**
             * What is in effect right now, which for a row that has never been
             * written is derived from the legacy column rather than stored.
             * The toggle sends this object back with one field changed, so
             * that first write cannot silently zero the others.
             */
            grants: facts.grants,
            parentMembershipId: m.parentMembershipId ?? null,
            /** The legacy read-only view-as, which is a different thing from
             * `grants.switchInto` and still has its own column. */
            canViewOtherAccounts: m.canViewOtherAccounts ?? false,
            /** Whether this caller may change any of it — an owner may manage
             * anyone but themselves; a contractor, only their own team. */
            canManage: canManageMember(env.actor, facts),
            /** Whether this caller may change this person's role — the owner
             * only (`canSetRole`); a contractor manages their team but does
             * not hand out roles. An added field, so an older client ignores
             * it. */
            canSetRole: canSetRole(env.actor, facts),
            /** Whether this caller may hand work to this person — what
             * `team.remove` asks of the successor (`canDispatchTo`), and the
             * same flag `memberships.listForBusiness` carries. A contractor
             * hands a departing person's work to themselves or their own
             * team. An added field, like the two above. */
            bookable: canDispatchTo(env.actor, facts),
            /** Whether this caller may set this person's colour — the owner,
             * for anyone including themselves (`canSetColour`). An added
             * field, so an older client simply shows no picker. */
            canSetColour: canSetColour(env.actor, facts),
            /** Whether this person has two-step sign-in set up — what the
             * owner's "Reset two-step sign-in" is offered on. An added field,
             * so an older client simply shows no reset. */
            twoStepOn: user?.twoFactorEnabled === true,
            /** Whether there is a licence document the caller may open —
             * the "View licence" button. An added field: absent on an older
             * backend, which means no button. */
            hasLicenceFile: seesLicences && m.licenceFile !== undefined,
          }
        }),
    )
  },
})

/**
 * Puts a subcontractor on a contractor's team, or takes them off one.
 *
 * "A contractor has a team" has no representation other than this column, so
 * this is the whole of it. `null` means they answer to the owner directly,
 * which is what every member is today.
 *
 * The grants are re-derived rather than left alone, and that is the point of
 * the mutation rather than a tidy-up afterwards. A subcontractor's toggles are
 * ceilinged by their contractor's — a contractor cannot let someone see prices
 * they cannot see themselves — so the ceiling changes the instant the team
 * does. `switchInto` goes further and dies outright: it names the contractor
 * who granted it, so moving to a different team makes it inert by
 * construction, whether or not this code remembers to clear it.
 */
export const assignTo = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    /** The contractor to work under, or null to answer to the owner. */
    parentMembershipId: v.union(v.null(), v.id('memberships')),
  },
  handler: async (ctx, { businessId, membershipId, parentMembershipId }) => {
    const env = await requireWriteActor(ctx, businessId)
    requireCapability(env, 'team.manage')

    const target = await ctx.db.get(membershipId)
    if (!target || target.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (!canManageMember(env.actor, factsFromMembership(target))) {
      throw new ConvexError('NO_ACCESS')
    }
    // Only a subcontractor belongs to a team. A contractor's own place in the
    // business is beside the owner, not under another contractor — the model
    // is one level deep, and `switchDecision` assumes it.
    if (target.role !== 'subcontractor') {
      throw new ConvexError('NOT_A_TEAM_MEMBER')
    }

    let parent = null
    if (parentMembershipId !== null) {
      const row = await ctx.db.get(parentMembershipId)
      // Opaque, like every other target lookup: which ids exist and what role
      // they hold is not something a caller gets to enumerate.
      if (
        !row ||
        row.businessId !== businessId ||
        row.status !== 'active' ||
        row.role !== 'contractor' ||
        row._id === target._id
      ) {
        throw new ConvexError('NOT_FOUND')
      }
      parent = row
    }
    // Who may be moved was settled above; this is where to. A contractor may
    // let their own people go back to the owner, not hand them to another
    // contractor (`canAssignTo`).
    if (
      !canAssignTo(
        env.actor,
        factsFromMembership(target),
        parent && factsFromMembership(parent),
      )
    ) {
      throw new ConvexError('NO_ACCESS')
    }

    const moved = {
      ...factsFromMembership(target),
      parentMembershipId: parent?._id ?? null,
    }
    const nextGrants = recomputeGrants(
      moved,
      parent && factsFromMembership(parent),
    )

    await ctx.db.patch(membershipId, {
      parentMembershipId: parent?._id ?? undefined,
      grants: nextGrants,
      canViewAllJobs: nextGrants.otherSchedules,
    })

    await recordAudit(ctx, forSelf(env.actor.real._id), {
      businessId,
      action: 'membership.assignTo',
      entityType: 'memberships',
      entityId: membershipId,
      meta: { parentMembershipId: parent?._id ?? null, grants: nextGrants },
    })

    return nextGrants
  },
})

/**
 * The business owner resets someone's two-step sign-in — for the technician
 * who has lost their phone AND their recovery codes, which is otherwise a
 * locked account with nobody able to open it.
 *
 * What it does: deletes their authenticator secret and recovery codes, marks
 * the account as not set up, and signs them out everywhere. Their next sign-in
 * is password only, straight into the set-up screen, and the app refuses them
 * everything until they have set it up again. It does not reveal or change
 * their password.
 *
 * That last point is also the risk, and why the rules are narrow: in the
 * window between the reset and the person setting it up again, their password
 * alone gets into the set-up screen. So the owner is told to confirm it really
 * is them (in person, or on a call) before pressing it.
 *
 * - Only the owner, as themselves. `team.manage` alone is not enough: a
 *   contractor holds it for their own team, and should not be able to weaken
 *   a subcontractor's sign-in. And not from inside someone else's account —
 *   a switch drops `team.manage`, as it does all administration.
 * - Only an active member of THIS business, and never the caller themselves.
 * - Refused outright when the person is also an active member of another
 *   business. Two-step sign-in belongs to the account, not the membership, so
 *   business A's owner resetting it would weaken that person's sign-in into
 *   business B, whose owner never agreed to it. That account is reset by the
 *   operator instead (`resetTwoFactorForEmail`).
 * - Audit-logged, against the member.
 */
export const resetTwoFactor = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
  },
  handler: async (ctx, { businessId, membershipId }) => {
    // Administration, so the capability model's rule: `team.manage` drops
    // while a switch is open (nobody administers on anyone's behalf), and the
    // REAL person must be the owner — a contractor holds `team.manage` for
    // their own team, and this is not theirs to do.
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'team.manage')
    const owner = env.actor.real
    if (owner.role !== 'owner') throw new ConvexError('NO_ACCESS')

    const target = await ctx.db.get(membershipId)
    if (
      !target ||
      target.businessId !== businessId ||
      target.status !== 'active'
    ) {
      throw new ConvexError('NOT_FOUND')
    }
    if (target._id === owner._id) throw new ConvexError('CANNOT_RESET_SELF')
    if (target.role === 'owner') throw new ConvexError('NO_ACCESS')

    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_user', (q) => q.eq('userId', target.userId))
      .collect()
    if (
      memberships.some(
        (m) => m.businessId !== businessId && m.status === 'active',
      )
    ) {
      throw new ConvexError('MEMBER_OF_ANOTHER_BUSINESS')
    }

    await clearTwoFactor(ctx, target.userId)

    await recordAudit(ctx, forSelf(owner._id), {
      businessId,
      action: 'membership.twoFactorReset',
      entityType: 'memberships',
      entityId: target._id,
    })

    return null
  },
})

/**
 * For the operator, not the app: the owner themselves, or someone who works
 * for two businesses, has lost their phone and their recovery codes, and no
 * owner may reset them (`resetTwoFactor`). Internal, so nothing a browser
 * sends can reach it; run with
 * `npx convex run --prod team:resetTwoFactorForEmail '{"email":"…"}'` once the
 * person's identity has been confirmed outside the app. Writes an audit row
 * into every business they are an active member of, attributed to their own
 * membership (there is no acting member) with `meta.by: 'operator'`.
 */
export const resetTwoFactorForEmail = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const user: { _id: string } | null = await ctx.runQuery(
      components.betterAuth.adapter.findOne,
      {
        model: 'user',
        where: [{ field: 'email', value: email.trim().toLowerCase() }],
      },
    )
    if (!user) throw new ConvexError('NOT_FOUND')

    await clearTwoFactor(ctx, user._id)

    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect()
    for (const m of memberships) {
      if (m.status !== 'active') continue
      await recordAudit(ctx, forSelf(m._id), {
        businessId: m.businessId,
        action: 'membership.twoFactorReset',
        entityType: 'memberships',
        entityId: m._id,
        meta: { by: 'operator' },
      })
    }
    return null
  },
})

/**
 * The reset itself, shared by the two doors above. Reaches into the Better
 * Auth component the way `offboard` does for sessions: the component's tables
 * are its own, so its adapter functions are the only way in.
 *
 * Order: the secret first, then the flag, then the sessions. Every step makes
 * the account less usable, never more — and it is one transaction, so a
 * failure part-way rolls all of it back rather than leaving it half-done.
 */
async function clearTwoFactor(ctx: MutationCtx, userId: string): Promise<void> {
  await deleteAllAuthRows(ctx, 'twoFactor', userId)
  await ctx.runMutation(components.betterAuth.adapter.updateOne, {
    input: {
      model: 'user',
      where: [{ field: '_id', value: userId }],
      update: { twoFactorEnabled: false, updatedAt: Date.now() },
    },
  })
  // Signed out everywhere: a session opened with the old authenticator must
  // not outlive it, and the next sign-in has to land on the set-up screen.
  await deleteAllAuthRows(ctx, 'session', userId)
  // And no lock carried over from wrong codes against the old authenticator.
  await clearTwoStepAttempts(ctx, userId)
}

/**
 * Every row of one of the auth component's per-user tables, for one user —
 * ALL of them, page after page. The component's `deleteMany` deletes one page
 * and says whether there is more; taking a single page of 200 meant an account
 * with more sessions than that (a password on an account not yet set up opens
 * one per sign-in, and a script can open hundreds) kept the rest, and "signed
 * out everywhere" was not true. One transaction, so a reset is still
 * all-or-nothing; a person has nowhere near enough sessions to reach the
 * transaction's limits legitimately, and if a script has made that many the
 * reset failing loudly is better than it half-working.
 */
async function deleteAllAuthRows(
  ctx: MutationCtx,
  model: 'session' | 'twoFactor',
  userId: string,
): Promise<void> {
  let cursor: string | null = null
  for (;;) {
    const page: { isDone: boolean; continueCursor: string } =
      await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
        input: { model, where: [{ field: 'userId', value: userId }] },
        paginationOpts: { numItems: 200, cursor },
      })
    if (page.isDone) return
    cursor = page.continueCursor
  }
}
