export type JobStatus = 'booked' | 'completed' | 'invoiced' | 'cancelled'

const STYLES: Record<JobStatus, { label: string; className: string }> = {
  booked: { label: 'Booked', className: 'bg-surface-2 text-ink-2' },
  // Amber is specifically "completed, awaiting invoice" — the state the owner
  // needs to act on, so it reads as a prompt rather than a success.
  completed: {
    label: 'Awaiting invoice',
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
