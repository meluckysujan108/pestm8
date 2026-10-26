import { SWITCH_WAIT_MS } from './outboxSet'
import { SEND_LOCK, browserLocks, takeLock } from './outboxLocks'
import type { HeldLock, Locks } from './outboxLocks'

/**
 * "An account switch is starting": no booking kept on the phone may go while
 * one is, here or in another tab (sender.ts, gate G6).
 *
 * A switch belongs to the sign-in session, which every tab of PestM8 shares
 * (convex/lib/actor.ts), so a switch started anywhere applies to a send this
 * tab already has queued. In this tab, `duringSwitchStart` says so for as
 * long as the start is out. Across tabs, the same start first asks for the
 * send lock exclusively (outboxLocks.ts): while that is asked for, no tab
 * starts a send, and a send already out finishes first. It waits for that
 * at most SWITCH_WAIT_MS, then goes ahead: a frozen tab's send must not stop
 * a switch, and one that lands after it is refused by the server
 * (`NOT_OWN_ACCOUNT`), so nothing is booked as someone else either way.
 */

let starting = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // One listener's trouble is not another's.
    }
  }
}

/** Whether a switch is starting in this tab. */
export function switchStarting(): boolean {
  return starting > 0
}

/**
 * For tests: no switch starting, and nobody listening, as a new page load
 * has it, so one test's start left out never holds another's sends.
 */
export function resetSwitchGateForTests(): void {
  starting = 0
  listeners.clear()
}

/** Called whenever `switchStarting` may say otherwise. */
export function onSwitchGate(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * `start` (a switch into another account: Settings', or someone's account
 * picked in the View menu, lib/useSetView.ts), with no booking sent
 * from the phone while it is out: in this tab at once, and in every tab
 * once the send lock is had, or SWITCH_WAIT_MS has gone by.
 */
export async function duringSwitchStart<T>(
  start: () => Promise<T>,
  locks: Locks | null = browserLocks(),
): Promise<T> {
  starting++
  notify()
  let held: HeldLock | null = null
  try {
    if (locks) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), SWITCH_WAIT_MS)
      try {
        held = await takeLock(locks, SEND_LOCK, {
          mode: 'exclusive',
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
    }
    return await start()
  } finally {
    held?.release()
    starting--
    notify()
  }
}
