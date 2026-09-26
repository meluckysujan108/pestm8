import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { authComponent } from './auth'
import {
  currentSessionId,
  requireActor,
  sweepExpiredSwitches,
} from './lib/actor'
import { recordAudit } from './lib/audit'
import { factsFromMembership } from './lib/membershipFacts'
import {
  beginSwitch,
  canSwitchInto,
  isSwitched,
  switchTargets,
} from './lib/capabilities'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import type { ActorEnvelope } from './lib/actor'
import type { SwitchRefusal } from './lib/capabilities'
import { UNASSIGNED_COLOUR } from './lib/colours'

/**
 * Working inside somebody else's account: starting, stopping, and saying so.
 *
 * The rules live in `lib/capabilities.ts` and the resolution in `lib/actor.ts`.
 * What is here is the lifecycle — the only code that creates or destroys an
 * `accountSwitches` row — plus the two queries the banner and the Settings hub
 * read.
 *
 * Nothing here grants anything. A row is permission to *attempt*; every read
 * and every write re-derives `canSwitchInto` from live rows, so revoking a
 * grant or moving a team takes effect on the next request whether or not this
 * file ever runs again.
 */

/**
 * Refusals safe to tell the caller apart from each other.
 *
 * `targetMembershipId` is client-supplied, so anything that distinguishes one
 * id from another here is an oracle. It was first written to stop anyone
 * finding the then-hidden owner with a loop; the owner is on everyone's roster
 * now, but the same answer still keeps another business's ids, and members who
 * have left, indistinguishable from ids that match nothing at all.
 *
 * So only the two a caller already knows about themselves come back as
 * themselves: that they were not granted access, and that they are already
 * switched. Everything else — the owner, another business, an inactive member,
 * an id that matches nothing at all — is one indistinguishable NOT_FOUND, the
 * same convention `lib/access.ts` uses for "not a member" and "membership
 * revoked".
 */
const TELLABLE: ReadonlyArray<SwitchRefusal> = ['NOT_GRANTED', 'NO_CHAINING']

function refusal(reason: SwitchRefusal): ConvexError<string> {
  return new ConvexError(TELLABLE.includes(reason) ? reason : 'NOT_FOUND')
}

/** Every switch row this session holds in this business. */
async function rowsForSession(
  ctx: QueryCtx,
  sessionId: string,
  businessId: Id<'businesses'>,
) {
  const rows = await ctx.db
    .query('accountSwitches')
    .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
    .collect()
  return rows.filter((r) => r.businessId === businessId)
}

/**
 * Open a switch for this session into `target`, replacing any it holds.
 *
 * The door check lives HERE, not in the callers, so there is no way to create a
 * switch row that skipped it. `chained` is the caller's statement of whether
 * the person is already inside someone else's account: `start` passes the
 * truth (and so refuses A → B → C), while `views.set` passes false because it
 * closes the old switch first and decides on the real person's own authority —
 * which is exactly what a direct switch would have decided.
 */
export async function openSwitch(
  ctx: MutationCtx,
  env: ActorEnvelope,
  sessionId: string,
  businessId: Id<'businesses'>,
  targetMembershipId: Id<'memberships'>,
  { chained }: { chained: boolean },
): Promise<{ expiresAt: number }> {
  const targetDoc = await ctx.db.get(targetMembershipId)
  if (!targetDoc) throw new ConvexError('NOT_FOUND')

  const actor = chained
    ? env.actor
    : {
        real: env.actor.real,
        acting: env.actor.real,
        session: null,
        degraded: null,
      }
  const decision = canSwitchInto(actor, factsFromMembership(targetDoc))
  if (!decision.ok) throw refusal(decision.reason)

  /**
   * One row per session. `findSwitch` in lib/actor.ts tolerates duplicates
   * and takes the newest, but that is a fail-safe against this file having a
   * bug, not a licence to leave two. With two rows, `stop` deletes one, the
   * banner clears, and the person carries on writing inside someone else's
   * account under the other — the worst thing this feature can do.
   */
  for (const row of await rowsForSession(ctx, sessionId, businessId)) {
    await ctx.db.delete(row._id)
  }

  const session = beginSwitch(targetMembershipId, Date.now())
  await ctx.db.insert('accountSwitches', {
    sessionId,
    businessId,
    // The person, never the account. `findSwitch` re-checks this on every
    // request so a row cannot outlive the membership it was opened for.
    realMembershipId: env.actor.real._id,
    targetMembershipId,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
  })

  await recordAudit(
    ctx,
    {
      actorMembershipId: env.actor.real._id,
      // Recorded against the account, so "what happened in mine, and who did
      // it" can be answered by the person whose account it is. That question
      // being answerable is what makes handing someone your account
      // reasonable at all.
      onBehalfOfMembershipId: targetMembershipId,
    },
    {
      businessId,
      action: 'switch.start',
      entityType: 'memberships',
      entityId: targetMembershipId,
      at: session.startedAt,
    },
  )

  return { expiresAt: session.expiresAt }
}

/** Close every switch this session holds in this business, each audited. */
export async function closeSwitches(
  ctx: MutationCtx,
  env: ActorEnvelope,
  sessionId: string,
  businessId: Id<'businesses'>,
): Promise<number> {
  const rows = await rowsForSession(ctx, sessionId, businessId)
  for (const row of rows) await ctx.db.delete(row._id)

  for (const row of rows) {
    await recordAudit(
      ctx,
      {
        actorMembershipId: env.actor.real._id,
        onBehalfOfMembershipId: row.targetMembershipId,
      },
      {
        businessId,
        action: 'switch.stop',
        entityType: 'memberships',
        entityId: row.targetMembershipId,
      },
    )
  }
  return rows.length
}

export const start = mutation({
  args: {
    businessId: v.id('businesses'),
    targetMembershipId: v.id('memberships'),
  },
  handler: async (ctx, { businessId, targetMembershipId }) => {
    /**
     * Resolved for READ, deliberately, and this is the one place in the
     * codebase where a mutation should be.
     *
     * `requireWriteActor` fails closed on any switch that no longer validates —
     * which is exactly the state someone is in when they need this mutation
     * most. A row whose grant was revoked never expires, so it would throw
     * before the handler body ran, locking that person out of starting a new
     * switch AND out of `stop`, permanently, with nothing but the hourly sweep
     * able to free them. `requireActor` fails open to the real person and says
     * why, and `isSwitched` is false for a dropped switch — so the chaining
     * check below still sees precisely what it should.
     */
    const env = await requireActor(ctx, businessId)

    const sessionId = await currentSessionId(ctx)
    // Everything about a switch is keyed on the session. A token minted before
    // the claim existed must fail rather than fall back to something coarser:
    // keyed on the person instead, a switch on the office iPad would follow
    // them to the phone in their pocket.
    if (!sessionId) throw new ConvexError('NO_SESSION')

    /**
     * NO_CHAINING is enforced through `isSwitched(actor)`, and the actor was
     * resolved from the row this mutation is about to delete. A → B → C must
     * not become two legal one-hop switches by way of the second call finding
     * someone apparently standing in their own account.
     *
     * What guarantees that is the resolve at the top of the handler, not the
     * order of the check and the delete inside `openSwitch`: `requireActor`
     * runs before anything is touched and its result is memoised per request,
     * so the decision sees the pre-delete state either way. I had this comment
     * claiming the ordering was load-bearing until a reviewer pointed out the
     * test passed with the two swapped — which it does, and for that reason.
     *
     * The check stays above the delete there regardless, because the real
     * rule is "resolve before mutating", and reading it in that order is how
     * the next person sees it. What would break this is an `invalidateActor`
     * between the two.
     */
    return openSwitch(ctx, env, sessionId, businessId, targetMembershipId, {
      chained: isSwitched(env.actor),
    })
  },
})

export const stop = mutation({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    /**
     * The way out, so it refuses nothing it can possibly help.
     *
     * Resolved for read for the same reason as `start`: a switch that has gone
     * bad must not be able to trap someone inside it. If the membership itself
     * is gone this still throws NO_ACCESS from `requireActor` — but by then the
     * row grants nothing anyway, because every request re-derives the grant.
     */
    const env = await requireActor(ctx, businessId)
    const sessionId = await currentSessionId(ctx)
    if (!sessionId) return { stopped: false }

    return {
      stopped: (await closeSwitches(ctx, env, sessionId, businessId)) > 0,
    }
  },
})

/**
 * What the banner says.
 *
 * `degraded` carries the reason a stored switch stopped validating — revoked,
 * the team moved, the person removed. Reads fail open, so the page keeps
 * working and shows the caller their own account; without this they would
 * simply find themselves somewhere else with no explanation.
 *
 * It deliberately does NOT take the client's clock to decide expiry, and an
 * earlier version of this did. Queries do not consult a clock — that is what
 * keeps them cacheable — so a banner that checked expiry would have been the
 * only read in the app that thought the switch was over, while the schedule,
 * the reports list and every other query carried on serving the target's rows.
 * Saying "you are back in your own account" over someone else's jobs is worse
 * than either answer on its own.
 *
 * So the banner reports what the reads are actually doing, and hands the
 * client `expiresAt` to render however it likes — a countdown, or a prompt to
 * switch back. The moment it matters is a write, and writes check the server's
 * own clock and refuse.
 */
export const current = query({
  args: {
    businessId: v.id('businesses'),
  },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    if (env.actor.session === null) {
      return {
        actingAs: null,
        expiresAt: null,
        degraded: env.actor.degraded,
      }
    }

    const user = await authComponent.getAnyUserById(
      ctx,
      (await ctx.db.get(env.actor.acting._id))?.userId ?? '',
    )
    return {
      actingAs: {
        membershipId: env.actor.acting._id,
        name: user?.name ?? '',
      },
      expiresAt: env.actor.session.expiresAt,
      degraded: null,
    }
  },
})

/**
 * The accounts this caller may work in — the Settings hub's list, for everyone
 * but the owner (who switches from the view menu, via `views.options`).
 *
 * Built from `switchTargets`, which filters by the same `canSwitchInto` the
 * mutation enforces, so the menu cannot offer something `start` would refuse.
 * The owner is never in it: they are not a permitted target for anyone, so
 * they fall out of the filter rather than needing to be removed from it.
 */
export const targets = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)

    const members = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()

    const allowed = switchTargets(
      env.actor,
      members.filter((m) => m.status === 'active').map(factsFromMembership),
    )
    const byId = new Map(members.map((m) => [m._id, m]))

    return Promise.all(
      allowed.map(async (person) => {
        const row = byId.get(person._id)
        const user = row
          ? await authComponent.getAnyUserById(ctx, row.userId)
          : null
        return {
          membershipId: person._id,
          name: user?.name ?? '',
          colour: row?.colour ?? UNASSIGNED_COLOUR,
          role: person.role,
        }
      }),
    )
  },
})

/**
 * Hourly tidy-up of switches that have aged out.
 *
 * Reads deliberately do not consult the clock — Convex queries are not re-run
 * because time passed, and a wall-clock read in `requireActor` would make every
 * gated query uncacheable — so for a read, a switch ends when its row goes
 * away. This is what makes it go away.
 *
 * It is hygiene, not enforcement. Writes check `expiresAt` themselves and
 * refuse, so an expired switch can never be used to change anything, however
 * long this takes to run.
 */
export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx: MutationCtx) => {
    const deleted = await sweepExpiredSwitches(ctx)
    return { deleted }
  },
})
