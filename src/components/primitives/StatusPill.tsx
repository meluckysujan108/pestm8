import { jobStatusStyle } from '#/lib/statusColours'

/** The schema's own union, re-exported under the name this file always had,
 * so its importers need not change. */
export type { JobStatus } from '../../../convex/lib/jobStatus'

/** The display name for a job status, for places that are not a pill. */
export function jobStatusLabel(status: string): string {
  return jobStatusStyle(status).label
}

/**
 * A job's status, as a tinted pill that always says its word. The colour is
 * decided in one place (src/lib/statusColours.ts); a status this build has
 * never heard of shows its raw name in grey rather than crashing the list.
 */
export function StatusPill({ status }: { status: string }) {
  const { label, pill } = jobStatusStyle(status)
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-[3px] text-[12px] font-semibold ${pill}`}
    >
      {label}
    </span>
  )
}
