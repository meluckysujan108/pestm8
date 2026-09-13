import { useCallback, useEffect, useRef, useState } from 'react'

export type SaveStatus =
  | 'draft'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'error'
  | 'submitted'

/**
 * Debounced autosave for a report draft.
 *
 * A technician fills these in under a house on one bar of signal, and losing a
 * half-completed inspection to a backgrounded tab is the failure that matters.
 * So edits save themselves, and the manual button becomes a retry rather than
 * the only way to persist anything.
 *
 * Deliberate properties:
 * - **Never saves on mount.** The baseline starts as whatever came from the
 *   server, so opening a draft and touching nothing writes nothing.
 * - **Only one save in flight.** Convex replaces `data` wholesale, so two
 *   overlapping writes race and the loser's edits vanish.
 * - **A stale acknowledgement never paints "Saved".** The value that was sent
 *   is compared against the value now on screen; if they differ, the status
 *   goes back to dirty and another save is scheduled rather than claiming work
 *   is safe when it is not.
 * - **`maxWaitMs`** guarantees a save during continuous typing, which plain
 *   debouncing would postpone indefinitely.
 */
export function useAutosave<T>({
  value,
  enabled,
  save,
  debounceMs = 1200,
  maxWaitMs = 5000,
}: {
  value: T
  enabled: boolean
  save: (value: T) => Promise<unknown>
  debounceMs?: number
  maxWaitMs?: number
}): {
  status: SaveStatus
  lastSavedAt?: number
  /**
   * Resolves once the server holds what is on screen, or the save failed.
   * Returns whether it holds it. Waits for a save already in flight rather than
   * returning past it — a caller about to act on the server's copy (switch a
   * draft to a new form, say) must not act on an older one.
   */
  flush: () => Promise<boolean>
} {
  const [status, setStatus] = useState<SaveStatus>('draft')
  const [lastSavedAt, setLastSavedAt] = useState<number | undefined>()

  const valueRef = useRef(value)
  valueRef.current = value

  // Held in a ref because callers pass a fresh closure every render; depending
  // on it directly would reschedule the timer on each keystroke.
  const saveRef = useRef(save)
  saveRef.current = save

  /** Serialised form of what the server is believed to hold. */
  const savedRef = useRef(JSON.stringify(value))
  const inFlight = useRef(false)
  const inFlightPromise = useRef<Promise<void> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtySince = useRef<number | null>(null)

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  /** Sends what is on screen. Resolves false only when the save failed. */
  const run = useCallback(async (): Promise<boolean> => {
    clearTimer()
    if (inFlight.current) return true

    const pending = valueRef.current
    const snapshot = JSON.stringify(pending)
    if (snapshot === savedRef.current) return true

    inFlight.current = true
    setStatus('saving')
    let settle: () => void = () => {}
    inFlightPromise.current = new Promise<void>((resolve) => {
      settle = resolve
    })
    try {
      await saveRef.current(pending)
      savedRef.current = snapshot
      setLastSavedAt(Date.now())

      // Edits made while the request was in flight are not covered by it.
      if (JSON.stringify(valueRef.current) === snapshot) {
        dirtySince.current = null
        setStatus('saved')
      } else {
        // A fresh dirty period, not a continuation. Leaving the old timestamp
        // here lets `waited` exceed maxWaitMs permanently, which pins `delay`
        // at zero and turns every later keystroke into its own request.
        dirtySince.current = Date.now()
        setStatus('dirty')
      }
      return true
    } catch {
      setStatus('error')
      return false
    } finally {
      inFlight.current = false
      inFlightPromise.current = null
      settle()
    }
  }, [])

  const flush = useCallback(async () => {
    if (!enabled) return true
    // Bounded: a technician typing continuously during the flush cannot hold
    // it open forever, and each pass sends everything on screen at that moment.
    for (let pass = 0; pass < 4; pass += 1) {
      if (inFlightPromise.current) await inFlightPromise.current
      if (JSON.stringify(valueRef.current) === savedRef.current) return true
      if (!(await run())) return false
    }
    return JSON.stringify(valueRef.current) === savedRef.current
  }, [enabled, run])

  useEffect(() => {
    if (!enabled) return

    const snapshot = JSON.stringify(value)
    if (snapshot === savedRef.current) return

    if (dirtySince.current === null) dirtySince.current = Date.now()
    setStatus((current) => (current === 'saving' ? current : 'dirty'))

    const waited = Date.now() - dirtySince.current
    const delay = Math.max(0, Math.min(debounceMs, maxWaitMs - waited))

    clearTimer()
    timer.current = setTimeout(() => void run(), delay)
    return clearTimer
  }, [value, enabled, debounceMs, maxWaitMs, run])

  // A backgrounded tab may never come back. `visibilitychange` is the only
  // event mobile browsers reliably fire before discarding a page; `pagehide`
  // covers the desktop close.
  useEffect(() => {
    if (!enabled) return
    const onHide = () => {
      if (document.visibilityState === 'hidden') void run()
    }
    const onPageHide = () => void run()
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [enabled, run])

  return { status, lastSavedAt, flush }
}
