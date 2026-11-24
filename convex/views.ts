import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { authComponent } from './auth'
import { components } from './_generated/api'
import { closeSwitches, openSwitch } from './accountSwitches'
import { currentSessionId, requireActor } from './lib/actor'
import { canChooseView, licenceStatus, switchTargets } from './lib/capabilities'
import { factsFromMembership } from './lib/membershipFacts'
import { UNASSIGNED_COLOUR } from './lib/colours'

/**
 * The view menu: Overview, My jobs, or — for the owner — somebody else's
 * account.
 *
 * Everyone whose lists can show more than their own work gets the first two
 * (`canChooseView`): the owner, a contractor with a team, and anyone allowed
 * to see everyone's schedule. Working in another account stays the owner's
 * here; everyone else who may do that does it from Settings, as before.
 *
 * Two of those are a LENS on their own account (`sessionViews`, read by
 * `requireActor` into `listScope`) and the third is a switch (`accountSwitches`,
 * which this reaches only through `openSwitch`/`closeSwitches` — that file stays
 * the one place a switch row is made or destroyed). Presenting them as one
 * control is the point: to the owner they are all answers to "whose work am I
 * looking at", and he should not have to know which kind of row each writes.
 */

/**
 * What the menu offers, for the people who get it.
 *
 * `accounts` is evaluated as the real person standing in their own account,
 * not as whoever they are working as: the dropdown has to list everyone even
 * while he is inside Kevin's account, so that Jo is one tap away rather than
 * "switch back, then switch again". `accountSwitches.targets` answers the
 * narrower question the Settings hub asks everyone else, and returns nobody
 * while switched.
 */
export const options = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    const real = env.actor.real
    if (!canChooseView(env.realScope)) return null

    // Only the owner's menu lists accounts, so only his reads the team.
    const members =
      real.role === 'owner'
        ? await ctx.db
            .query('memberships')
            .withIndex('by_business', (q) => q.eq('businessId', businessId))
            .collect()
        : []

    const unswitched = { real, acting: real, session: null, degraded: null }
    const allowed = switchTargets(
      unswitched,
      members.filter((m) => m.status === 'active').map(factsFromMembership),
    )
    const byId = new Map(members.map((m) => [m._id, m]))
    const nameOf = async (userId: string | undefined) =>
      userId
        ? ((await authComponent.getAnyUserById(ctx, userId))?.name ?? '')
        : ''

    const me = byId.get(real._id) ?? (await ctx.db.get(real._id))
    return {
      /** What Overview holds: the whole business, or a contractor's team.
       * Added field — an older menu reads only `me` and `accounts`. */
      overview:
        env.realScope.kind === 'business'
          ? ('everyone' as const)
          : ('team' as const),
      me: {
        membershipId: real._id,
        name: await nameOf(me?.userId),
        colour: me?.colour ?? UNASSIGNED_COLOUR,
        // Working his own jobs means signing his own certificates, which a
        // blank licence number refuses. Better to say so in the place he
        // chooses to work them than at the end of an inspection.
        //
        // `0` rather than the clock: a query does not read it (see `now` in
        // lib/actor.ts), and expiry is enforced at finalise regardless. This
        // is a prompt, not a gate.
        licenceMissing: licenceStatus(real.licence, 0) === 'missing',
      },
      accounts: await Promise.all(
        allowed.map(async (person) => {
          const row = byId.get(person._id)
          return {
            membershipId: person._id,
            name: await nameOf(row?.userId),
            colour: row?.colour ?? UNASSIGNED_COLOUR,
            role: person.role,
          }
        }),
      ),
    }
  },
})

/**
 * Choose what to look at, in one transaction.
 *
 * One mutation rather than the client calling `stop`, then `start`, then a
 * third thing: each of those is a state the whole UI would re-render into on
 * the way — Overview flashing up between Kevin's account and Jo's — and a
 * failure halfway would leave him somewhere he did not pick.
 */
export const set = mutation({
  args: {
    businessId: v.id('businesses'),
    view: v.union(
      v.object({ kind: v.literal('everyone') }),
      v.object({ kind: v.literal('mine') }),
      v.object({
        kind: v.literal('account'),
        membershipId: v.id('memberships'),
      }),
    ),
  },
  handler: async (ctx, { businessId, view }) => {
    /**
     * Resolved for READ, like `accountSwitches.start` and for its reason: a
     * switch that has stopped validating must not trap anyone inside it, and
     * this is how he gets out.
     */
    const env = await requireActor(ctx, businessId)

    // The REAL person's own scope, never the account being worked in. Asked
    // of `acting`, this would refuse the owner the way back out of Kevin's
    // account.
    if (!canChooseView(env.realScope)) throw new ConvexError('NO_ACCESS')

    // Like a switch, a view belongs to one sign-in. A token minted before the
    // claim existed must fail rather than fall back to the person, or a choice
    // made on the office machine would follow him to the phone.
    const sessionId = await currentSessionId(ctx)
    if (!sessionId) throw new ConvexError('NO_SESSION')

    await closeSwitches(ctx, env, sessionId, businessId)

    if (view.kind === 'account') {
      // Decided on his own authority, exactly as a direct switch would be —
      // the one just closed confers nothing.
      await openSwitch(ctx, env, sessionId, businessId, view.membershipId, {
        chained: false,
      })
      // His own view is left as it was, so "Switch back" returns him to it.
      return null
    }

    const existing = (
      await ctx.db
        .query('sessionViews')
        .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
        .collect()
    ).filter((row) => row.businessId === businessId)
    for (const row of existing) await ctx.db.delete(row._id)

    // Both choices are written, though no row already reads as My jobs: a
    // row says what was picked on this device, not what a default happens
    // to be today.
    await ctx.db.insert('sessionViews', {
      sessionId,
      businessId,
      realMembershipId: env.actor.real._id,
      mode: view.kind,
      updatedAt: Date.now(),
    })
    return null
  },
})

/**
 * Forget every chosen view — the runbook's step before rolling the BACKEND
 * back past Overview for the whole team: the older schema refuses the
 * 'everyone' rows this build writes. Every device returns to My jobs (or,
 * under the older backend, to its Overview default); nothing else is touched.
 */
export const clearAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('sessionViews').collect()
    for (const row of rows) await ctx.db.delete(row._id)
    return { deleted: rows.length }
  },
})

/**
 * Delete views whose sign-in has ended.
 *
 * Hygiene rather than enforcement: a row for a dead session is never read,
 * because nothing can present that session id again. It is kept tidy because
 * the table should answer "who is looking at what" truthfully — and it is its
 * own job rather than a step in the switch sweep, so that neither can stop the
 * other running.
 *
 * Asks Better Auth directly, with the same lookup `getAuthUser` makes: a
 * session that is gone, or past its expiry, ends the view.
 */
export const sweepEnded = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    let deleted = 0
    for (const row of await ctx.db.query('sessionViews').collect()) {
      const session: unknown = await ctx.runQuery(
        components.betterAuth.adapter.findOne,
        {
          model: 'session',
          where: [
            { field: '_id', value: row.sessionId },
            { field: 'expiresAt', operator: 'gt', value: now },
          ],
        },
      )
      if (session === null) {
        await ctx.db.delete(row._id)
        deleted++
      }
    }
    return { deleted }
  },
})
