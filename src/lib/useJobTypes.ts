import { useQuery } from '@tanstack/react-query'
import { DEFAULT_JOB_TYPES } from '../../convex/lib/jobTypes'
import { rq } from './routeQueries'
import type { JobTypeEntry } from '../../convex/lib/jobTypes'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * The business's job types (Settings → Job types), A–Z, deleted ones
 * included and marked — a job booked as one still shows it, and still
 * suggests its report.
 *
 * The business layout warms the list on the way in, so it is normally here
 * before anything asks. Until it is — a phone with no signal — the built-in
 * nine stand in, so New Job never opens on an empty picker; `loaded` says
 * which, for anything that must not act on a guess (the report buttons).
 * Not suspended on: the picker and the report buttons are inside sheets that
 * are already on screen.
 */
export function useJobTypes(businessId: Id<'businesses'>): {
  entries: ReadonlyArray<JobTypeEntry>
  loaded: boolean
} {
  const data = useQuery(rq.jobTypes(businessId)).data
  return { entries: data ?? DEFAULT_JOB_TYPES, loaded: data !== undefined }
}
