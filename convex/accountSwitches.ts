import { internalMutation } from './_generated/server'
import { sweepExpiredSwitches } from './lib/actor'

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
  handler: async (ctx) => {
    const deleted = await sweepExpiredSwitches(ctx)
    return { deleted }
  },
})
