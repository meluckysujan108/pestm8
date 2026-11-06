import { parseJobListStatus } from '#/lib/scheduleFilters'
import type { JobListStatus } from '#/lib/routeQueries'

/**
 * The views the Job section can be read in.
 *
 * A list rather than a pair of hard-coded branches: the section is built to
 * hold more than one view, and the next one — a Recurring view with its own
 * content — is added by filling in the route it already points at.
 *
 * `path` is the tail the router leaves on the URL, which is what tells the
 * switcher which view is on screen; the main view owns the section's own path
 * and so matches nothing extra.
 */
export type JobView = 'job' | 'recurring'

export const JOB_VIEWS: ReadonlyArray<{
  value: JobView
  label: string
  to: string
  path: string
}> = [
  {
    value: 'job',
    label: 'Job',
    to: '/$businessSlug/job',
    path: '/job',
  },
  {
    value: 'recurring',
    label: 'Recurring Job',
    to: '/$businessSlug/job/recurring',
    path: '/job/recurring',
  },
]

/**
 * Which view a URL is showing. Derived from the path rather than held in
 * state, so a reload, a back button and a pasted link all agree — and so a
 * view added to the list above needs nothing here.
 *
 * The longest match wins: the section's own path is a prefix of every view
 * under it, so matching in order would make everything look like the main one.
 */
export function activeJobView(pathname: string): JobView {
  const match = [...JOB_VIEWS]
    .sort((a, b) => b.path.length - a.path.length)
    .find((view) => pathname === view.path || pathname.endsWith(view.path))
  return match?.value ?? 'job'
}

/**
 * The Recurring Job view's orders other than its default (what is to book
 * first), as its address names them: `?sort=next`, `?sort=client`.
 */
export const RECURRING_JOB_SORTS = ['next', 'client'] as const

/**
 * Whose Recurring Jobs and in what order, as the Recurring Job view's
 * address says, read where that view's own route isn't the one asking (the
 * section's switch row, which draws its filter icon). Anything else there is
 * the default: everyone's, to book first.
 */
export function recurringJobFiltersOf(search: Record<string, unknown>): {
  staffId: string
  sort: 'toBook' | (typeof RECURRING_JOB_SORTS)[number]
} {
  const { staff, sort } = search
  return {
    staffId: typeof staff === 'string' && staff !== '' ? staff : 'all',
    sort: RECURRING_JOB_SORTS.find((s) => s === sort) ?? 'toBook',
  }
}

/**
 * The Job tab's orders, both newest first: when each job was booked (the
 * default, absent from the address) or the day of its visit (`?sort=visit`).
 */
export const JOB_LIST_SORTS = ['visit'] as const
export type JobListSort = 'booked' | (typeof JOB_LIST_SORTS)[number]

export const JOB_LIST_SORT_OPTIONS: Array<{
  value: JobListSort
  label: string
}> = [
  { value: 'booked', label: 'Newest booked' },
  { value: 'visit', label: 'Latest visit' },
]

/**
 * The Job tab's status, person and order, as its address says, read where
 * the tab's own route isn't the one asking (the section's switch row).
 * Anything else there is the default: every status, everyone's, newest
 * booked first.
 */
export function jobListFiltersOf(search: Record<string, unknown>): {
  status: JobListStatus | undefined
  staffId: string
  sort: JobListSort
} {
  const { status, staff, sort } = search
  return {
    status: parseJobListStatus(status),
    staffId: typeof staff === 'string' && staff !== '' ? staff : 'all',
    sort: JOB_LIST_SORTS.find((s) => s === sort) ?? 'booked',
  }
}
