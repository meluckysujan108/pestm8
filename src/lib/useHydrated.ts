import { useEffect, useState } from 'react'

/**
 * False during SSR and the first client render, true once React has attached
 * its handlers.
 *
 * Every interactive control that only works via JavaScript needs this: before
 * hydration a form does a native GET that reloads the page and clears what was
 * typed, and a button that opens a sheet does nothing at all. Both fail
 * silently, which is why controls disable themselves until this flips rather
 * than appearing ready and ignoring the tap.
 *
 * It doubles as the readiness signal for e2e tests, which wait for the control
 * to become enabled instead of guessing at a timeout.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return hydrated
}
