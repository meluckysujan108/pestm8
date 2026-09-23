import type { JobStatus } from '../../convex/lib/jobStatus'

/**
 * A job status's colour and label, defined once (Phase 4.3).
 *
 * The hue ramps live in src/styles.css (`--{hue}-bg / -line / -ink`, both
 * themes). This decides which status takes which hue, keyed on the schema's
 * own status union, so a status added to the schema without a colour here is
 * a compile error rather than a grey pill nobody chose.
 *
 * Three signals share a job card, and each keeps its own form so hue never
 * has to carry two meanings at once:
 * - a person is a SOLID mark with no text — the rail, the table border, dots;
 * - a status is a TINTED pill with a border and its word — never hue alone;
 * - overdue has no hue at all (`OVERDUE_CHIP`), and amber stays "warning".
 */

export type StatusTone = 'orange' | 'red' | 'yellow' | 'green' | 'blue' | 'grey'

export const JOB_STATUS = {
  recurring: { label: 'Recurring', tone: 'orange' },
  pending: { label: 'Pending', tone: 'red' },
  booked: { label: 'Booked', tone: 'yellow' },
  completed: { label: 'Completed', tone: 'green' },
  invoiced: { label: 'Invoiced', tone: 'blue' },
  cancelled: { label: 'Cancelled', tone: 'grey' },
} as const satisfies Record<JobStatus, { label: string; tone: StatusTone }>

/**
 * Written out in full: Tailwind finds class names by reading the source, so a
 * class assembled from a template string would never be generated.
 */
export const TONE_PILL: Record<StatusTone, string> = {
  orange: 'border border-orange-line bg-orange-bg text-orange-ink',
  red: 'border border-red-line bg-red-bg text-red-ink',
  yellow: 'border border-yellow-line bg-yellow-bg text-yellow-ink',
  green: 'border border-green-line bg-green-bg text-green-ink',
  blue: 'border border-blue-line bg-blue-bg text-blue-ink',
  grey: 'border border-grey-line bg-grey-bg text-grey-ink',
}

/** For charts: the mid-tone, which holds 3:1 against the card in both
 * themes where the pale fill would not. */
export const TONE_CHART: Record<StatusTone, string> = {
  orange: 'var(--orange-line)',
  red: 'var(--red-line)',
  yellow: 'var(--yellow-line)',
  green: 'var(--green-line)',
  blue: 'var(--blue-line)',
  grey: 'var(--grey-line)',
}

export type StatusStyle = { label: string; pill: string; chart: string }

/**
 * A status this build has never heard of — the backend deployed ahead of the
 * frontend, or a PWA tab still running last week's bundle — gets the grey pill
 * with its raw name, instead of crashing every screen that lists a job.
 */
export function jobStatusStyle(status: string): StatusStyle {
  const known = (
    JOB_STATUS as Partial<Record<string, { label: string; tone: StatusTone }>>
  )[status]
  const tone = known?.tone ?? 'grey'
  return {
    label: known?.label ?? status,
    pill: TONE_PILL[tone],
    chart: TONE_CHART[tone],
  }
}

/**
 * A report's own status pill. Draft keeps the amber warning style — a draft
 * report IS the thing to act on — and the two locked states take the status
 * ramps, which is also what brings them over AA in light: the old
 * `bg-green/12 text-green` pill was 2:1.
 */
export const REPORT_PILL = {
  draft: 'border border-amber-line bg-amber-bg text-amber-ink',
  finalised: TONE_PILL.green,
  sent: TONE_PILL.blue,
} as const

/** Overdue: ink, no hue (see `--overdue` in styles.css). */
export const OVERDUE_CHIP = 'bg-overdue text-overdue-ink'
