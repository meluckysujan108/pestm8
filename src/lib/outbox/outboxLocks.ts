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
 * - **One per tab that has opened an Edit**, `pestm8-outbox:tab:{tab}`:
 *   taken before its first Edit's lease is written and held for the rest of
 *   the page's life (`holdTabLock`). The browser lets it go when the page
 *   goes (a reload, a closed tab, iOS killing the app), so a lease whose
 *   tab no longer holds it was left by a page that has gone, and holds the
 *   booking from nobody (itemActions.ts `lapseLeftEdits`). Safari lets it go
 *   as a page enters the back/forward cache too, so a page restored from
 *   there takes it again (`retakeTabLock`).
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

/** The lock a tab holds while its Edits' leases are its own. */
export function tabLock(tab: string): string {
  return `pestm8-outbox:tab:${tab}`
}

// The tabs of this page whose lock is taken, or being taken.
const tabsHeld = new Map<string, Promise<boolean>>()

/**
 * This tab's lock (`tabLock`), taken once and never let go: the page holds
 * it until it goes. Whether it is held; asked again after a failure.
 */
export function holdTabLock(locks: Locks, tab: string): Promise<boolean> {
  const had = tabsHeld.get(tab)
  if (had) return had
  const taking = takeLock(locks, tabLock(tab)).then((lock) => {
    if (lock === null) tabsHeld.delete(tab)
    return lock !== null
  })
  tabsHeld.set(tab, taking)
  return taking
}

/**
 * This page, back from the back/forward cache: Safari let go of every lock
 * it held as it went in, and says nothing as it returns, so this tab's lock,
 * if it had taken it, is taken again. Only if it is free, never waited for:
 * a browser that kept it still has it here, and the wait would be for itself.
 */
export async function retakeTabLock(locks: Locks, tab: string): Promise<void> {
  const had = tabsHeld.get(tab)
  if (!had || !(await had)) return
  const taking = takeLock(locks, tabLock(tab), { ifAvailable: true }).then(
    async (lock) => {
      const held = lock !== null || (await lockHeld(locks, tabLock(tab)))
      if (!held) tabsHeld.delete(tab)
      return held
    },
  )
  tabsHeld.set(tab, taking)
  await taking
}

/** The names of every lock any tab holds now, or null if the browser
 * won't say. */
export async function heldLockNames(locks: Locks): Promise<Set<string> | null> {
  try {
    const now = await locks.query()
    return new Set((now.held ?? []).flatMap((lock) => lock.name ?? []))
  } catch {
    return null
  }
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
