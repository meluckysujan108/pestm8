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
