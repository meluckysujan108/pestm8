/**
 * Asked before the person leaves what this page holds for them: signing out
 * (Settings), or switching to another business (the sidebar's switcher).
 *
 * Something kept on this phone that would be lost by leaving registers a
 * guard, which asks the person (a ConfirmDialog) and answers whether to go
 * ahead. None is registered yet. The first will be the jobs booked with no
 * signal and not sent yet: "Sign out and discard 2 jobs not sent yet?".
 *
 * The guards are asked one at a time, in the order they were registered,
 * and the first to say stay ends it. A guard that throws counts as stay:
 * nothing is thrown away on an answer nobody gave.
 */

export type LeaveReason = 'signOut' | 'switchBusiness'

/** True to go ahead, false to stay. */
export type LeaveGuard = (reason: LeaveReason) => boolean | Promise<boolean>

const guards = new Set<LeaveGuard>()

/** Adds `guard`; the function returned takes it away again. */
export function registerLeaveGuard(guard: LeaveGuard): () => void {
  guards.add(guard)
  return () => {
    guards.delete(guard)
  }
}

/** Whether every guard lets the person leave, for `reason`. */
export async function confirmLeave(reason: LeaveReason): Promise<boolean> {
  for (const guard of [...guards]) {
    try {
      if (!(await guard(reason))) return false
    } catch {
      return false
    }
  }
  return true
}
