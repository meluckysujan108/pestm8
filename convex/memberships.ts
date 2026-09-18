import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { authComponent } from './auth'
import { canViewAs, getAuthUserId, requireMembership } from './lib/access'
import { nextColour } from './lib/colours'
import { inviteState } from './lib/inviteTokens'
import { grants, role } from './schema'
import { forSelf, recordAudit } from './lib/audit'
import {
  requireActor,
  requireAssignableRole,
  requireCapability,
  requireWriteActor,
} from './lib/actor'
import {
  canManageMember,
  clampGrants,
  isVisiblePerson,
  NO_GRANTS,
  recomputeGrants,
} from './lib/capabilities'
import {
  factsFromMembership,
  grantsFromMembership,
} from './lib/membershipFacts'

export const listForBusiness = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)

    const members = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()

    /**
     * The owner is not on anyone else's roster.
     *
     * This query feeds six screens — the schedule's filter bar, the assignee
     * picker, the job detail sheet, both note surfaces and Team settings — and
     * returned every member's name, email, licence number and phone to anyone
     * who asked. That is the single place the owner was most visible, and the
     * switch-target list would have inherited it directly.
     *
     * It hides the PERSON, not the work: an owner-assigned job stays on the
     * calendar and in the revenue totals, with the business's name where the
     * technician's would be (`displayPerson`). Dropping the work instead would
     * silently change what the numbers mean.
     */
    const visible = members
      .filter((m) => m.status !== 'removed')
      .filter((m) => isVisiblePerson(env.actor, { _id: m._id, role: m.role }))

    return Promise.all(
      visible.map(async (m) => {
        // A team list showing user ids would be unusable; the auth component
        // owns identity, so the name and email are resolved from there.
        const user = await authComponent.getAnyUserById(ctx, m.userId)
        return {
          _id: m._id,
          userId: m.userId,
          name: user?.name ?? '',
          email: user?.email ?? '',
          role: m.role,
          canViewAllJobs: m.canViewAllJobs,
          canViewOtherAccounts: m.canViewOtherAccounts ?? false,
          licenceNumber: m.licenceNumber,
          phone: m.phone,
          colour: m.colour,
          status: m.status,
        }
      }),
    )
  },
})

/**
 * Superseded by `invitations.create`, which mints a single-use link.
 *
 * Kept as a loud failure rather than deleted: a stale PWA still has the old
 * Team screen, and an owner tapping Invite there must not believe an
 * invitation exists when nothing can redeem it. Deleted at CONTRACT.
 */
export const inviteByEmail = mutation({
  args: {
    businessId: v.id('businesses'),
    email: v.string(),
    role,
  },
  handler: async (ctx, args) => {
    requireCapability(await requireActor(ctx, args.businessId), 'team.manage')
    throw new ConvexError('APP_UPDATE_REQUIRED')
  },
})

/** Superseded by `invitations.listForBusiness`, which also reports each link's
 * state. Kept so a stale Team screen still renders; deleted at CONTRACT. */
export const listInvitations = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    requireCapability(await requireActor(ctx, businessId), 'team.manage')

    const all = await ctx.db
      .query('invitations')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()

    const now = Date.now()
    return all
      .filter((i) => inviteState(i, now) === 'valid')
      .map((i) => ({ _id: i._id, email: i.email, role: i.role }))
  },
})

/** Superseded by `invitations.revoke`. Now a soft revoke: a hard delete left no
 * record that an invitation had ever been issued or withdrawn. */
export const revokeInvitation = mutation({
  args: {
    businessId: v.id('businesses'),
    invitationId: v.id('invitations'),
  },
  handler: async (ctx, { businessId, invitationId }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'team.manage')
    const actor = env.actor.real

    const invitation = await ctx.db.get(invitationId)
    if (!invitation || invitation.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (invitation.claimedAt !== undefined) {
      throw new ConvexError('ALREADY_MEMBER')
    }

    const now = Date.now()
    await ctx.db.patch(invitationId, { revokedAt: now })
    await recordAudit(ctx, forSelf(actor._id), {
      businessId,
      action: 'invitation.revoke',
      entityType: 'invitations',
      entityId: invitationId,
      meta: { email: invitation.email },
      at: now,
    })
  },
})

/**
 * Retired. This used to create an active membership for any invitation whose
 * email matched the signed-in user's — with email verification off and sign-up
 * open, that meant whoever registered an invited address first joined the
 * business, and it ran automatically on every visit to "/".
 *
 * Joining now requires redeeming a single-use link (`invitations.redeem`).
 *
 * The signature is preserved and the body made a no-op on purpose: a PWA still
 * running the old bundle calls this in its `/` beforeLoad, and an argument or
 * name change there would turn every sign-in on that device into a bare
 * "Server Error". Deleted at CONTRACT, once no client calls it.
 */
export const claimInvitations = mutation({
  args: {},
  handler: async (): Promise<Array<string>> => [],
})

export const invite = mutation({
  args: {
    businessId: v.id('businesses'),
    userId: v.string(),
    role,
  },
  handler: async (ctx, args) => {
    const env = await requireActor(ctx, args.businessId)
    requireCapability(env, 'team.manage')
    const actor = env.actor.real
    // The owner account is the key to the business; it is never handed out
    // through an invitation, only by the bootstrap runbook.
    requireAssignableRole(args.role)

    const existing = await ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', args.userId).eq('businessId', args.businessId),
      )
      .unique()

    if (existing && existing.status !== 'removed') {
      throw new ConvexError('ALREADY_MEMBER')
    }

    const members = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', args.businessId))
      .collect()
    const colour = nextColour(members.map((m) => m.colour))

    const membershipId = existing
      ? (await ctx.db.patch(existing._id, {
          role: args.role,
          status: 'invited',
          canViewAllJobs: false,
        }),
        existing._id)
      : await ctx.db.insert('memberships', {
          userId: args.userId,
          businessId: args.businessId,
          role: args.role,
          canViewAllJobs: false,
          grants: NO_GRANTS,
          colour,
          status: 'invited',
          createdAt: Date.now(),
        })

    await recordAudit(ctx, forSelf(actor._id), {
      businessId: args.businessId,
      action: 'membership.invite',
      entityType: 'memberships',
      entityId: membershipId,
      meta: { role: args.role },
      at: Date.now(),
    })

    return membershipId
  },
})

/**
 * An invited person activates their own membership. Deliberately not an owner
 * action: joining a business is the subcontractor's decision, which is also the
 * posture that keeps the arrangement looking like genuine contracting (§1.4).
 *
 * Cannot use requireMembership — that demands an already-active membership.
 */
export const accept = mutation({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const userId = await getAuthUserId(ctx)

    const membership = await ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', userId).eq('businessId', businessId),
      )
      .unique()

    if (!membership || membership.status !== 'invited') {
      throw new ConvexError('NOT_FOUND')
    }
    // An 'invited' row created before owner invites were blocked would
    // otherwise still activate into a second owner account here.
    if (membership.role === 'owner') {
      throw new ConvexError('OWNER_INVITE_FORBIDDEN')
    }

    await ctx.db.patch(membership._id, { status: 'active' })

    await recordAudit(ctx, forSelf(membership._id), {
      businessId,
      action: 'membership.accept',
      entityType: 'memberships',
      entityId: membership._id,
      at: Date.now(),
    })

    return membership._id
  },
})

/** Invitations a signed-in user has not yet accepted. */
export const myInvitations = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)

    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    return Promise.all(
      memberships
        .filter((m) => m.status === 'invited')
        .map(async (m) => {
          const business = await ctx.db.get(m.businessId)
          return {
            businessId: m.businessId,
            role: m.role,
            name: business?.name ?? '',
            slug: business?.slug ?? '',
          }
        }),
    )
  },
})

export const setCanViewAllJobs = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    canViewAllJobs: v.boolean(),
  },
  handler: async (ctx, args) => {
    const env = await requireActor(ctx, args.businessId)
    requireCapability(env, 'team.manage')
    const actor = env.actor.real

    const target = await ctx.db.get(args.membershipId)
    if (!target || target.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    // `team.manage` says they may manage somebody; this says whether it is
    // this somebody. A contractor holds the capability business-wide and the
    // reach of their own team only — without this, the first contractor could
    // widen anyone's access in the business through the legacy setters, which
    // `setGrants` already refuses.
    if (!canManageMember(env.actor, factsFromMembership(target))) {
      throw new ConvexError('NO_ACCESS')
    }

    /**
     * Writes through to the grants object as well, and must.
     *
     * `grantsFromMembership` reads `grants` verbatim when the row has one and
     * only falls back to `canViewAllJobs` when it does not. So the moment a row
     * carries grants — which every row now does, whether created that way or
     * backfilled — patching the legacy column alone changes nothing at all.
     * The toggle would still move, still save, still be audited, and the
     * person's schedule would not change.
     *
     * Caught by the e2e suite rather than reasoned about: two journeys that
     * grant business-wide visibility and then assert it started failing the
     * moment new members began arriving with a grants object.
     */
    const nextGrants = {
      ...grantsFromMembership(target),
      otherSchedules: args.canViewAllJobs,
    }
    await ctx.db.patch(args.membershipId, {
      canViewAllJobs: args.canViewAllJobs,
      grants: nextGrants,
    })

    await recordAudit(ctx, forSelf(actor._id), {
      businessId: args.businessId,
      action: 'membership.setCanViewAllJobs',
      entityType: 'memberships',
      entityId: args.membershipId,
      meta: { canViewAllJobs: args.canViewAllJobs },
      at: Date.now(),
    })
  },
})

/**
 * Distinct from setCanViewAllJobs (a data-scope grant): this governs whether
 * a subcontractor can also view the app through OTHER members' eyes via the
 * header account menu's "view as" — never grantable for viewing the owner,
 * even when on (enforced again, unconditionally, in lib/access.ts's own
 * canViewAs check — this guard here just fails loud and early).
 */
export const setCanViewOtherAccounts = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    canViewOtherAccounts: v.boolean(),
  },
  handler: async (ctx, args) => {
    const env = await requireActor(ctx, args.businessId)
    requireCapability(env, 'team.manage')
    const actor = env.actor.real

    const target = await ctx.db.get(args.membershipId)
    if (!target || target.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (target.role === 'owner') throw new ConvexError('NO_ACCESS')
    // `team.manage` says they may manage somebody; this says whether it is
    // this somebody. A contractor holds the capability business-wide and the
    // reach of their own team only — without this, the first contractor could
    // widen anyone's access in the business through the legacy setters, which
    // `setGrants` already refuses.
    if (!canManageMember(env.actor, factsFromMembership(target))) {
      throw new ConvexError('NO_ACCESS')
    }


    await ctx.db.patch(args.membershipId, {
      canViewOtherAccounts: args.canViewOtherAccounts,
    })

    await recordAudit(ctx, forSelf(actor._id), {
      businessId: args.businessId,
      action: 'membership.setCanViewOtherAccounts',
      entityType: 'memberships',
      entityId: args.membershipId,
      meta: { canViewOtherAccounts: args.canViewOtherAccounts },
      at: Date.now(),
    })
  },
})

export const setRole = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    role,
  },
  handler: async (ctx, args) => {
    const env = await requireActor(ctx, args.businessId)
    requireCapability(env, 'team.manage')
    const actor = env.actor.real

    // Which roles exist and which may be handed out are different questions;
    // `ASSIGNABLE_ROLES` answers the second. This is also what stops an owner
    // promoting someone into a second owner account, which nothing refused
    // before — the invite paths did, but this one did not.
    requireAssignableRole(args.role)

    const target = await ctx.db.get(args.membershipId)
    if (!target || target.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    if (target.role === 'owner' && args.role !== 'owner') {
      const owners = await ctx.db
        .query('memberships')
        .withIndex('by_business', (q) => q.eq('businessId', args.businessId))
        .collect()
      const activeOwners = owners.filter(
        (m) => m.role === 'owner' && m.status === 'active',
      )
      if (activeOwners.length <= 1) throw new ConvexError('LAST_OWNER')
    }

    /**
     * A change of role is a change of what someone may hold, so the grants are
     * re-derived rather than carried across.
     *
     * Promoting a subcontractor to contractor takes their `switchInto` with it:
     * it named the contractor they worked under, and they no longer work under
     * anyone. Leaving it would point a contractor at an account they have no
     * standing in — `canSwitchInto` refuses it on every request, but a grant
     * that reads as live and is not is a worse record than no grant.
     */
    const becoming = {
      ...factsFromMembership(target),
      role: args.role,
      // A contractor answers to the owner, not to another contractor.
      parentMembershipId:
        args.role === 'subcontractor' ? target.parentMembershipId ?? null : null,
    }
    const parentDoc = becoming.parentMembershipId
      ? await ctx.db.get(becoming.parentMembershipId)
      : null
    const roleGrants = recomputeGrants(
      becoming,
      parentDoc ? factsFromMembership(parentDoc) : null,
    )

    await ctx.db.patch(args.membershipId, {
      role: args.role,
      parentMembershipId: becoming.parentMembershipId ?? undefined,
      grants: roleGrants,
      canViewAllJobs: roleGrants.otherSchedules,
    })

    await recordAudit(ctx, forSelf(actor._id), {
      businessId: args.businessId,
      action: 'membership.setRole',
      entityType: 'memberships',
      entityId: args.membershipId,
      meta: { role: args.role },
      at: Date.now(),
    })
  },
})

export const setLicence = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    licenceNumber: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireMembership(ctx, args.businessId)

    const target = await ctx.db.get(args.membershipId)
    if (!target || target.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    // A licence belongs to the person who holds it: owners maintain the team
    // roster, but everyone else may only set their own.
    if (actor.role !== 'owner' && actor._id !== args.membershipId) {
      throw new ConvexError('NO_ACCESS')
    }

    const licenceNumber = args.licenceNumber.trim().slice(0, 64)
    const previous = target.licenceNumber

    await ctx.db.patch(args.membershipId, { licenceNumber })

    // This number is printed on every certificate that person signs. Changing
    // it silently — particularly an owner changing someone else's — left no
    // trace at all, which is the opposite of what a compliance dispute needs.
    if (previous !== licenceNumber) {
      await recordAudit(ctx, forSelf(actor._id), {
        businessId: args.businessId,
        action: 'membership.setLicence',
        entityType: 'memberships',
        entityId: args.membershipId,
        meta: { from: previous ?? '', to: licenceNumber },
        at: Date.now(),
      })
    }
  },
})

/**
 * Self-service only — no owner-on-behalf override, unlike setLicence. Name
 * and email live in the Better Auth user record and are edited directly via
 * authClient's own update methods; phone has no home there, so it lives on
 * the membership (a work number may reasonably differ per business).
 */
export const setProfile = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireMembership(ctx, args.businessId)
    if (actor._id !== args.membershipId) throw new ConvexError('NO_ACCESS')

    await ctx.db.patch(args.membershipId, { phone: args.phone })
  },
})

/**
 * Always self-only to write (the caller's own membership, never an
 * argument-supplied one) — "view as" can only ever change what YOU see.
 * Validated here too (not just read-side in resolveViewScope) so a rejected
 * attempt fails immediately with a clear error rather than silently no-op.
 */
export const setViewingAs = mutation({
  args: {
    businessId: v.id('businesses'),
    targetMembershipId: v.optional(v.id('memberships')),
  },
  handler: async (ctx, args) => {
    const actor = await requireMembership(ctx, args.businessId)

    if (args.targetMembershipId === undefined) {
      await ctx.db.patch(actor._id, { viewingAsMembershipId: undefined })
      return
    }

    const target = await ctx.db.get(args.targetMembershipId)
    if (!target) throw new ConvexError('NOT_FOUND')
    if (!canViewAs(actor, target)) throw new ConvexError('NO_ACCESS')

    await ctx.db.patch(actor._id, {
      viewingAsMembershipId: args.targetMembershipId,
    })
  },
})

/**
 * Sets one person's four toggles, in one write.
 *
 * One mutation rather than four, because `clampGrants` decides all four
 * together against what the granter themselves holds: a contractor cannot hand
 * out sight of prices they cannot see, and `switchInto` is only ever the
 * target's own current contractor. Four independent mutations would each have
 * to re-derive that, and would disagree the first time one of them was missed.
 *
 * The caller sends the whole object, including the toggles they are not
 * changing. That matters more than it looks on a legacy row: writing a
 * `grants` object for the first time is what makes `grantsFromMembership` stop
 * falling back to `canViewAllJobs`, so anything absent from that first write
 * silently becomes false. The row sends what is currently in effect with one
 * field changed, and `team.roster` below hands it exactly that.
 */
export const setGrants = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    grants,
  },
  handler: async (ctx, args) => {
    const env = await requireWriteActor(ctx, args.businessId)
    requireCapability(env, 'team.manage')

    const target = await ctx.db.get(args.membershipId)
    if (!target || target.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    // `team.manage` says they may manage someone; this says whether it is this
    // someone. A contractor holds the capability business-wide and the reach
    // of their own team only.
    const facts = factsFromMembership(target)
    if (!canManageMember(env.actor, facts)) throw new ConvexError('NO_ACCESS')

    const clamped = clampGrants(env.actor, facts, args.grants)
    await ctx.db.patch(args.membershipId, {
      grants: clamped,
      // Kept in step while anything still reads it: the legacy column is the
      // fallback for rows with no `grants`, and this row now has one.
      canViewAllJobs: clamped.otherSchedules,
    })

    await recordAudit(ctx, forSelf(env.actor.real._id), {
      businessId: args.businessId,
      action: 'membership.setGrants',
      entityType: 'memberships',
      entityId: args.membershipId,
      meta: { grants: clamped },
    })

    // Returned so the caller can see what survived the clamp, rather than
    // showing a toggle as on when the server refused it.
    return clamped
  },
})
