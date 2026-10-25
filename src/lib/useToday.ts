import { useEffect, useState } from 'react'
import { dayKeyOf } from '../../convex/lib/dates'

/** How often an open page checks whether the day has turned over. */
const TODAY_CHECK_MS = 60_000

/**
 * Today's day key in the business's time zone, read off the phone's clock at
 * `now`.
 */
export function nextToday(now: number, timezone: string): string {
  return dayKeyOf(now, timezone)
}

/**
 * Today in the business's time zone, as a page should draw it: `initial` —
 * the day its loader saw — until the page has hydrated, then the phone's.
 *
 * The HTML may be a copy the service worker kept from yesterday, rendered
 * with yesterday as today. Drawn with the phone's today straight away, the
 * first render would not match that HTML. So the phone's day is read in an
 * effect, which runs only once hydrated (as `useHydrated`'s own does), and
 * the page moves to it from there. It is read again when the page comes
 * back into view and every minute, so a schedule left open past midnight
 * moves on to the new day.
 */
export function useToday(timezone: string, initial: string): string {
  const [today, setToday] = useState(initial)
  useEffect(() => {
    // The same day again leaves the state as it is, so nothing re-renders.
    const read = () => setToday(nextToday(Date.now(), timezone))
    const onVisible = () => {
      if (document.visibilityState === 'visible') read()
    }
    read()
    const timer = setInterval(read, TODAY_CHECK_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [timezone])
  return today
}
