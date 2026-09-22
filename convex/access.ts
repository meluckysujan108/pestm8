import { v } from 'convex/values'
import { query } from './_generated/server'
import { authComponent } from './auth'
import { requireActor } from './lib/actor'
import { ALL_CAPABILITIES, canChooseView } from './lib/capabilities'
import type { Capability } from './lib/capabilities'

/**
 * Who the caller is right now, for the UI.
 *
 * One subscription behind every gate in the client, and behind the banner, so
 * they cannot disagree with each other. It is a live query rather than
 * something read once at route load, and that is the whole point: a switch
 * changes the answer mid-session, and admin capabilities drop the moment it
 * happens. The route context in `$businessSlug/route.tsx` is a `beforeLoad`
 * snapshot — it does not re-run on a mutation, so anything gated on it would
 * keep an owner's full administration UI on screen while the server had
 * already stopped honouring it.
 *
 * Convex re-runs this by itself: `requireActor` reads the `accountSwitches`
 * row, so starting or stopping a switch invalidates every query that resolved
 * through it. Nothing has to remember to refresh.
 */
export const me = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)

    const nameOf = async (membershipId: (typeof env.readScope)['_id']) => {
      const row = await ctx.db.get(membershipId)
      if (!row) return ''
      const user = await authComponent.getAnyUserById(ctx, row.userId)
      return user?.name ?? ''
    }

    const switched = env.actor.session !== null

    return {
      /** Always the real person: their profile, their licence, their name on
       * an audit row. Never the account they are working in. */
      membershipId: env.actor.real._id,
      role: env.actor.real.role,

      /**
       * Already intersected across the switch, with the administration
       * capabilities forced to false while one is open. The client must gate on
       * these and never on `role` — a role comparison cannot express "an owner,
       * but currently working inside someone else's account".
       */
      caps: Object.fromEntries(
        ALL_CAPABILITIES.map((c) => [c, env.caps[c]]),
      ) as Record<Capability, boolean>,

      /** The account being worked in, when that is not their own. */
      actingAs: switched
        ? {
            membershipId: env.actor.acting._id,
            name: await nameOf(env.actor.acting._id),
          }
        : null,
      expiresAt: env.actor.session?.expiresAt ?? null,

      /**
       * Why a switch that was open is no longer in effect. Reads fail open, so
       * the page keeps working and shows them their own account; without a
       * reason they would simply find themselves somewhere else.
       */
      degraded: env.actor.degraded,

      /**
       * Which of the owner's views is showing, for the dropdown and for the
       * screens that simplify in "Just my jobs". Null for anyone who does not
       * get the dropdown (`canChooseView`), so the client renders it on this
       * alone and never has to know the rule.
       *
       * 'account' while a switch is open: the chosen view is set aside, not
       * lost, and resumes when he switches back.
       */
      view: canChooseView(env.actor.real)
        ? { mode: switched ? ('account' as const) : env.view }
        : null,

      /** The older read-only "view as", which still exists and is not the same
       * thing: it shows another person's rows and grants nothing. */
      viewingAs:
        !switched && env.viewingAsLegacy
          ? {
              membershipId: env.readScope._id,
              name: await nameOf(env.readScope._id),
            }
          : null,
    }
  },
})
