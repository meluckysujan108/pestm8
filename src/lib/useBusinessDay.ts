import { useEffect, useMemo, useState } from 'react'
import { endOfDayInZone, startOfDayInZone } from '../../convex/lib/dates'
import { todayKey } from './format'

/**
 * Today where the business is, as a day key and the instants it starts and
 * ends — worked out afresh on every render, and when the app comes back to
 * the front: a phone left on a screen overnight wakes on the next day, not
 * still calling yesterday "today".
 */
export function useBusinessDay(timezone: string) {
  const [, wake] = useState(0)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') wake((n) => n + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
  const key = todayKey(timezone)
  return useMemo(
    () => ({
      key,
      startOfToday: startOfDayInZone(key, timezone),
      startOfTomorrow: endOfDayInZone(key, timezone),
      timezone,
    }),
    [key, timezone],
  )
}
