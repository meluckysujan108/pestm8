import { useEffect, useRef, useState } from 'react'

/** How long a Save bar with nothing left to save stays up to say "Saved". */
const SAVED_SHOWN_MS = 2000

/**
 * True from the moment `done` turns true until `ms` later: a Save bar that
 * hides once nothing is left to save still says "Saved" long enough to be
 * read. Timed from the save, not from the form: editing and then undoing the
 * edit is not a second save to announce.
 */
export function useJustSaved(done: boolean, ms = SAVED_SHOWN_MS): boolean {
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    setExpired(false)
    if (!done) return
    const timer = setTimeout(() => setExpired(true), ms)
    return () => clearTimeout(timer)
  }, [done, ms])
  return done && !expired
}

/**
 * The same moment of "Saved", for a form whose save has no single success
 * flag to follow (several mutations, or a save that may send nothing): call
 * `mark()` once it lands, and `recently` stays true for `ms` after.
 */
export function useSavedFlash(ms = SAVED_SHOWN_MS) {
  const [recently, setRecently] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return {
    recently,
    mark: () => {
      setRecently(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setRecently(false), ms)
    },
  }
}
