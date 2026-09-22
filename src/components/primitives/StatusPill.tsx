export type JobStatus =
  | 'recurring'
  | 'pending'
  | 'booked'
  | 'completed'
  | 'invoiced'
  | 'cancelled'

const STYLES: Record<JobStatus, { label: string; className: string }> = {
  // Neutral for now, like Booked — status colours are their own later phase.
  recurring: { label: 'Recurring', className: 'bg-surface-2 text-ink-2' },
  pending: { label: 'Pending', className: 'bg-surface-2 text-ink-2' },
  booked: { label: 'Booked', className: 'bg-surface-2 text-ink-2' },
  // Amber flags this as the state the owner still needs to act on (raise the
  // invoice) — a prompt, not a success — even though the label itself just
  // says "Completed" now.
  completed: {
    label: 'Completed',
    className: 'bg-amber-bg text-amber-ink border border-amber-line',
  },
  invoiced: { label: 'Invoiced', className: 'bg-green/12 text-green' },
  cancelled: { label: 'Cancelled', className: 'bg-surface-2 text-muted' },
}

/**
 * A status this build has never heard of — the backend deployed ahead of the
 * frontend, or a PWA tab still running last week's bundle — is shown by its
 * raw name instead of crashing every screen that lists a job.
 */
function styleOf(status: string): { label: string; className: string } {
  return (
    (STYLES as Partial<Record<string, { label: string; className: string }>>)[
      status
    ] ?? { label: status, className: 'bg-surface-2 text-ink-2' }
  )
}

/** The display name for a job status, for places that are not a pill. */
export function jobStatusLabel(status: string): string {
  return styleOf(status).label
}

export function StatusPill({ status }: { status: JobStatus }) {
  const { label, className } = styleOf(status)
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-semibold ${className}`}
    >
      {label}
    </span>
  )
}
