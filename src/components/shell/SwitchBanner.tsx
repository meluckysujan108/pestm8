import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { useAccess } from '#/lib/access'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The persistent reminder that what you type is landing in someone else's
 * account.
 *
 * Amber, not the blue the read-only "view as" used, and the difference is the
 * point: one shows you another person's rows, the other signs their name to
 * everything you do. A technician glancing down mid-job needs to tell those
 * apart without reading.
 *
 * It reads `useAccess()` rather than a query of its own, so it cannot disagree
 * with the gates around it — the banner and the buttons are one subscription.
 */
export function SwitchBanner({ businessId }: { businessId: Id<'businesses'> }) {
  const access = useAccess()

  const convexStop = useConvexMutation(api.accountSwitches.stop)
  const stop = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'> }) => convexStop(args),
  })

  const convexSetViewingAs = useConvexMutation(api.memberships.setViewingAs)
  const exitViewing = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'> }) =>
      convexSetViewingAs(args),
  })

  /**
   * A switch that ended by itself — revoked, moved team, the person removed.
   * Reads fail open, so they are already back in their own account and the
   * page still works; without this they would simply find the schedule
   * different and no reason given.
   */
  if (access.degraded) {
    return (
      <div className="flex items-center gap-2 border-b border-hairline bg-surface-2 px-4 py-2">
        <p className="text-caption font-semibold text-ink-2">
          {DEGRADED_COPY[access.degraded] ??
            'You are back in your own account.'}
        </p>
      </div>
    )
  }

  if (access.actingAs) {
    return (
      <div className="flex items-center justify-between gap-2 border-b border-amber-line bg-amber-bg px-4 py-2">
        <p className="min-w-0 text-caption font-semibold text-amber-ink">
          <span className="truncate">
            Working in {access.actingAs.name}’s account
          </span>
          <span className="font-normal"> — everything you do is recorded.</span>
        </p>
        <button
          type="button"
          disabled={stop.isPending}
          onClick={() => stop.mutate({ businessId })}
          className="shrink-0 rounded-full bg-amber-ink/10 px-3 py-1 text-caption font-semibold text-amber-ink transition active:scale-[.95] disabled:opacity-50"
        >
          Switch back
        </button>
      </div>
    )
  }

  // The older read-only lens, which is on its way out but still shipping.
  if (access.viewingAs) {
    return (
      <div className="flex items-center justify-between gap-2 bg-blue px-4 py-2 text-white">
        <p className="truncate text-caption font-semibold">
          Viewing as {access.viewingAs.name}
        </p>
        <button
          type="button"
          disabled={exitViewing.isPending}
          onClick={() => exitViewing.mutate({ businessId })}
          className="shrink-0 rounded-full bg-white/20 px-3 py-1 text-caption font-semibold transition active:scale-[.95] disabled:opacity-50"
        >
          Exit
        </button>
      </div>
    )
  }

  return null
}

/** Said in terms of what happened to them, not of the rule that fired. */
const DEGRADED_COPY: Record<string, string> = {
  SWITCH_EXPIRED: 'That session ended, so you are back in your own account.',
  SWITCH_REVOKED:
    'Your access to that account was turned off. You are back in your own.',
  SWITCH_TEAM_CHANGED:
    'You have moved teams, so you are back in your own account.',
  SWITCH_TARGET_INACTIVE:
    'That person is no longer on the team. You are back in your own account.',
  SWITCH_NOT_PERMITTED: 'You are back in your own account.',
  SWITCH_CHAINED: 'You are back in your own account.',
}
