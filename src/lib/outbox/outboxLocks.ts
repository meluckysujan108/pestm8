/**
 * The Web Locks the outbox holds, so no two tabs of PestM8 act on one
 * booking at once, and no booking goes while an account switch is starting.
 *
 * - **One per booking**, `pestm8-outbox:item:{localId}`: taken before a send
 *   or a settle, and held for as long as the call it covers is out; and by
 *   New Job before it keeps one, until it is sent or taken off the phone
 *   again (book.ts). Taken only if it is free (`ifAvailable`), never waited
 *   for: a frozen tab holding one blocks that booking alone, and every other
 *   goes.
 * - **The send lock**, `pestm8-outbox:send`: every send holds it shared, and
 *   an account switch starting takes it exclusively (switchGate.ts). While
 *   that is asked for, no tab can start a send, and a send already out
 *   finishes first.
 *
 * There is no lock over a tab's whole run: a tab sends one booking at a time
 * by itself. Without Web Locks (Safari before 15.4) nothing is kept, so
 * nothing here is needed.
 */

export const SEND_LOCK = 'pestm8-outbox:send'

/** The lock one booking is acted on under. */
export function itemLock(localId: string): string {
  return `pestm8-outbox:item:${localId}`
}

/** What the outbox asks of `navigator.locks`. */
export type Locks = Pick<LockManager, 'request' | 'query'>

/** A lock held until `release` is called (once counts, however often). */
export type HeldLock = { readonly name: string; release: () => void }

export type TakeOptions = {
  mode?: LockMode
  /** Only if it is free now: null otherwise, at once. */
  ifAvailable?: boolean
  /** Stops waiting: null then. */
  signal?: AbortSignal
}

/**
 * `name`, held until its `release` is called, so it can be handed on with
 * the call it covers rather than tied to whoever took it. Null when it isn't
 * free (`ifAvailable`), the wait was given up (`signal`), or the request
 * failed.
 */
export function takeLock(
  locks: Locks,
  name: string,
  options: TakeOptions = {},
): Promise<HeldLock | null> {
  return new Promise((resolve) => {
    let granted = false
    let letGo: () => void = () => {}
    const held = new Promise<void>((done) => {
      letGo = done
    })
    const request = (() => {
      try {
        return locks.request(name, options, (lock) => {
          if (lock === null) {
            resolve(null)
            return undefined
          }
          granted = true
          let released = false
          resolve({
            name,
            release: () => {
              if (released) return
              released = true
              letGo()
            },
          })
          return held
        })
      } catch (error) {
        return Promise.reject(error)
      }
    })()
    request.catch(() => {
      // Aborted before it was granted, or refused: nothing is held.
      if (!granted) resolve(null)
    })
  })
}

/** Whether any tab, this one included, holds `name` now. */
export async function lockHeld(locks: Locks, name: string): Promise<boolean> {
  try {
    const now = await locks.query()
    return (now.held ?? []).some((lock) => lock.name === name)
  } catch {
    return false
  }
}

/** The browser's Web Locks, where it has them. */
export function browserLocks(): Locks | null {
  try {
    if (typeof navigator === 'undefined') return null
    // Missing before Safari 15.4, whatever the types say.
    return (navigator as { locks?: LockManager }).locks ?? null
  } catch {
    return null
  }
}
