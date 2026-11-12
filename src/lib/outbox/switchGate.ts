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
 * at most SWITCH_WAIT_MS, then goes ahead, still asking, so no other tab
 * starts one until the start is done: a frozen tab's send must not stop a
 * switch, and one that lands after it is refused by the server
 * (`NOT_OWN_ACCOUNT`), so nothing is booked as someone else either way.
 *
 * A sign-out holds sends the same way (`holdSends`) while it counts the
 * bookings, and again from a yes until it has discarded them; while its
 * question is up it holds only this tab's (`holdSendsHere`), as the question
 * is up for as long as the person leaves it, and no tab may hold every
 * other's sends for that long (lib/outbox/leaveAsk.ts).
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
 * from the phone while it is out (`holdSends`): it starts once a send
 * already out has finished, or SWITCH_WAIT_MS has gone by.
 */
export async function duringSwitchStart<T>(
  start: () => Promise<T>,
  locks: Locks | null = browserLocks(),
): Promise<T> {
  const release = await holdSends(SWITCH_WAIT_MS, locks)
  try {
    return await start()
  } finally {
    release()
  }
}

/**
 * Holds this tab's sends (G6) until the function it returns is called (once
 * counts, however often); every other tab sends on. For a sign-out's
 * question while it is on screen (lib/outbox/leaveAsk.ts).
 */
export function holdSendsHere(): () => void {
  starting++
  notify()
  let released = false
  return () => {
    if (released) return
    released = true
    starting--
    notify()
  }
}

/**
 * Holds every send from the phone until the function it resolves to is
 * called (once counts, however often): in this tab at once (G6), and in
 * every tab from when it asks for the send lock exclusively, which a send
 * already out finishes under first. It resolves once it has the lock, or
 * once `waitMs` has gone by, still asking: a request waiting for the lock
 * keeps every tab's new send out as one holding it does (a send takes it
 * only if it is free, outboxLocks.ts), so the hold covers every tab until it
 * is let go, when a request never granted is given up, and a lock had late
 * let go. For an account switch starting (`duringSwitchStart`), and for a
 * sign-out while it counts and from a yes until it has discarded them
 * (lib/outbox/leaveAsk.ts), so no booking it counts as not sent can start
 * going under it.
 */
export async function holdSends(
  waitMs: number,
  locks: Locks | null = browserLocks(),
): Promise<() => void> {
  const here = holdSendsHere()
  let held: HeldLock | null = null
  let released = false
  const controller = new AbortController()
  const release = () => {
    if (released) return
    released = true
    // Never granted: asked for no longer. Granted: let go.
    controller.abort()
    held?.release()
    here()
  }
  if (locks) {
    const asked = takeLock(locks, SEND_LOCK, {
      mode: 'exclusive',
      signal: controller.signal,
    })
    void asked.then((lock) => {
      // Had after the hold was let go: let go at once.
      if (released) lock?.release()
      else held = lock
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      asked,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs)
      }),
    ])
    clearTimeout(timer)
  }
  return release
}
