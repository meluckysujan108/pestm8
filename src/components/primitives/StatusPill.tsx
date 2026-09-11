export type JobStatus =
  | 'booked'
  | 'inProgress'
  | 'completed'
  | 'invoiced'
  | 'cancelled'

const STYLES: Record<JobStatus, { label: string; className: string }> = {
  booked: { label: 'Booked', className: 'bg-surface-2 text-ink-2' },
  inProgress: { label: 'In Progress', className: 'bg-blue/12 text-blue' },
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

export function StatusPill({ status }: { status: JobStatus }) {
  const { label, className } = STYLES[status]
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-semibold ${className}`}
    >
      {label}
    </span>
  )
}
