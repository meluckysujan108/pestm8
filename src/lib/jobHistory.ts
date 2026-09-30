/**
 * What a job's sheet shows of the visits around it: the property's history,
 * and the series' next visit.
 *
 * `properties.jobHistory` returns every visit at the address, in the order
 * they were CREATED, newest first. For a recurring client that is six months
 * of projected visits, so the sheet's "Other visits at this property" used to
 * show March next year and call it history. What happened is ordered by when
 * it was booked for, and taken from the past only.
 */

import { splitJobTypes } from '../../convex/lib/jobTypes'

type Visit = {
  _id: string
  scheduledAt: number
  status: string
  jobType: string
  recurrenceId?: string
}

/** Visits that happened: what a report can be about. */
const DONE = new Set(['completed', 'invoiced'])

/** A visit still to come, which the series' "Next" can be. */
const COMING = new Set(['pending', 'booked', 'recurring'])

export function isDone(visit: { status: string }): boolean {
  return DONE.has(visit.status)
}

/**
 * The property's visits before today, newest first, without this job. Today's
 * are the Schedule's: a visit this morning still marked Booked is not history
 * yet, just not closed.
 *
 * A projection whose day has passed (`recurring`) is left out: nobody booked
 * it, so it is a visit still to arrange, not one that took place — unless a
 * report was written on it (`withReports`), which says the work was done
 * whatever the status says. Cancelled and never-closed visits stay in — the
 * full history is the record — but the card shows only what happened
 * (`historyCard`).
 */
export function pastVisits<T extends Visit>(
  visits: ReadonlyArray<T>,
  {
    startOfToday,
    excludeJobId,
    withReports = new Set(),
  }: {
    startOfToday: number
    excludeJobId: string
    withReports?: ReadonlySet<string>
  },
): Array<T> {
  return visits
    .filter(
      (v) =>
        v._id !== excludeJobId &&
        v.scheduledAt < startOfToday &&
        (v.status !== 'recurring' || withReports.has(v._id)),
    )
    .sort((a, b) => b.scheduledAt - a.scheduledAt)
}

/**
 * The same service as this job: its series, or a visit for every service
 * this job is for, in whatever order they were picked. A job for General Pest
 * Control is compared with the last visit that included it, even one that
 * was for a termite inspection as well.
 */
export function sameService(job: Visit, other: Visit): boolean {
  if (job.recurrenceId !== undefined && job.recurrenceId === other.recurrenceId)
    return true
  const services = splitJobTypes(job.jobType).map((s) => s.toLowerCase())
  const theirs = new Set(
    splitJobTypes(other.jobType).map((s) => s.toLowerCase()),
  )
  return services.length > 0 && services.every((s) => theirs.has(s))
}

/**
 * The card's few rows: the last visit for this job's service, then the most
 * recent others, all of them visits that happened.
 */
export function historyCard<T extends Visit>(
  job: Visit,
  past: ReadonlyArray<T>,
  others = 2,
): { last: T | undefined; recent: Array<T> } {
  const done = past.filter(isDone)
  const last = done.find((v) => sameService(job, v))
  const recent = done
    .filter((v) => v !== last)
    .slice(0, last ? others : others + 1)
  return { last, recent }
}

/**
 * The series' next visit still to come: after this one, and after now, so a
 * past visit opened from history says when the service is next due rather
 * than naming the visit that followed it.
 */
export function nextVisit<T extends Visit>(
  job: Visit,
  visits: ReadonlyArray<T>,
  now: number,
): T | undefined {
  if (job.recurrenceId === undefined) return undefined
  const after = Math.max(job.scheduledAt, now)
  return visits
    .filter(
      (v) =>
        v._id !== job._id &&
        v.recurrenceId === job.recurrenceId &&
        v.scheduledAt > after &&
        COMING.has(v.status),
    )
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .at(0)
}

/**
 * Each shown visit's reports, and the rest: reports started from Reports
 * with no job, for a job since moved or in the Recycle bin, for another visit
 * today, or started early for one to come. `visitIds` is the visits the
 * history draws, so no report is filed under a visit that is not on screen.
 * This job's own are the caller's to leave out; they sit in its own section.
 */
export function reportsByVisit<TReport extends { jobId?: string }>(
  reports: ReadonlyArray<TReport>,
  visitIds: ReadonlySet<string>,
): { byVisit: Map<string, Array<TReport>>; unlinked: Array<TReport> } {
  const byVisit = new Map<string, Array<TReport>>()
  const unlinked: Array<TReport> = []
  for (const report of reports) {
    if (report.jobId !== undefined && visitIds.has(report.jobId)) {
      const list = byVisit.get(report.jobId) ?? []
      list.push(report)
      byVisit.set(report.jobId, list)
    } else {
      unlinked.push(report)
    }
  }
  return { byVisit, unlinked }
}

/**
 * The visits a report started from Reports can be for: today's, soonest
 * first, then the most recent that happened or were never closed. Not a
 * cancelled visit, and not a projection from before today nobody booked;
 * nothing to come after today, whose report is not due yet.
 */
export function visitChoices<T extends Visit>(
  visits: ReadonlyArray<T>,
  {
    startOfToday,
    startOfTomorrow,
    earlier = 8,
  }: { startOfToday: number; startOfTomorrow: number; earlier?: number },
): { today: Array<T>; past: Array<T> } {
  const today = visits
    .filter(
      (v) =>
        v.scheduledAt >= startOfToday &&
        v.scheduledAt < startOfTomorrow &&
        v.status !== 'cancelled',
    )
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
  const past = visits
    .filter(
      (v) =>
        v.scheduledAt < startOfToday &&
        v.status !== 'cancelled' &&
        v.status !== 'recurring',
    )
    .sort((a, b) => b.scheduledAt - a.scheduledAt)
    .slice(0, earlier)
  return { today, past }
}
