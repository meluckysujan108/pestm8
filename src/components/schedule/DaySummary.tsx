import { isOverdueProjection } from '#/lib/jobCardActions'
import { OVERDUE_CHIP } from '#/lib/statusColours'
import { startOfDayInZone } from '../../../convex/lib/dates'
import type { ReactNode } from 'react'
import type { JobStatus } from '#/components/primitives/StatusPill'

/**
 * The line under a view's heading, the same height on every view and every
 * day, whatever it says or doesn't: one line, cut short rather than wrapped,
 * so changing view or filter never moves what is under it.
 */
export const SUMMARY_LINE =
  'flex h-5 min-w-0 items-center gap-x-1.5 overflow-hidden text-caption leading-5 whitespace-nowrap text-ink-2 tabular-nums'

/** That line, with something to say or nothing (its height kept). */
export function SummaryLine({ children }: { children?: ReactNode }) {
  return <p className={SUMMARY_LINE}>{children ?? ' '}</p>
}

/**
 * A day's numbers. Three, never one: booked work, projected visits due
 * today, and projected visits whose day has passed. A projection is work
 * nobody has committed to, so it is in no job total anywhere (the month
 * grid, the team legend, the dashboard); and "overdue" means what the card's
 * marker and the nav badge mean by it, so a visit due later today is not
 * one. Filtered, the booked number says how many of the day's are showing.
 */
export function DaySummary({
  jobs,
  shown,
  timezone,
  todayKey,
}: {
  /** The whole day. */
  jobs: ReadonlyArray<{ status: JobStatus; scheduledAt: number }>
  /** What the filters let through. */
  shown: ReadonlyArray<{ status: JobStatus; scheduledAt: number }>
  timezone: string
  todayKey: string
}) {
  // Today's start rather than the clock: "overdue" changes only at midnight,
  // and the page's today is the one it hydrates with.
  const now = startOfDayInZone(todayKey, timezone)
  const all = jobs.filter((j) => j.status !== 'recurring').length
  const booked = shown.filter((j) => j.status !== 'recurring').length
  const overdue = shown.filter((j) =>
    isOverdueProjection(j, timezone, now),
  ).length
  const due = shown.filter(
    (j) => j.status === 'recurring' && !isOverdueProjection(j, timezone, now),
  ).length
  return (
    <SummaryLine>
      <span>
        {booked === all ? all : `${booked} of ${all}`}{' '}
        {all === 1 ? 'job' : 'jobs'}
      </span>
      {due > 0 && <span>· {due} due</span>}
      {overdue > 0 && (
        <span
          className={`rounded-full px-2 text-[12px] leading-5 font-semibold ${OVERDUE_CHIP}`}
        >
          {overdue} overdue
        </span>
      )}
    </SummaryLine>
  )
}
