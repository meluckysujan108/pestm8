/**
 * A client's work, as the Jobs tab of their sheet shows it: what is coming
 * up, each recurring service with its visits, and the one-off jobs — worked
 * out here from `clients.summary`, against the day it is where the business
 * is, so the query itself never reads the clock.
 */

import { occurrencesFrom } from '../../convex/lib/recurrence'
import { dayKeyOf } from '../../convex/lib/dates'
import { isDone } from './jobHistory'
import type { Interval } from '../../convex/lib/recurrence'

type Visit = {
  _id: string
  scheduledAt: number
  status: string
  jobType: string
  propertyId: string
  recurrenceId?: string
  occurrenceAt?: number
}

type Series = {
  _id: string
  jobType: string
  interval: Interval
  active: boolean
  propertyId: string
  anchorDate: number
  /** The latest occurrence the service has used, by anyone's visit. */
  lastTaken?: number
}

/** Booked by a person and not closed. */
const BOOKED = new Set(['pending', 'booked'])

const YEAR = 366 * 24 * 60 * 60 * 1000

export type Day = {
  startOfToday: number
  startOfTomorrow: number
  timezone: string
}

/** Done, and its day has come: an invoice raised ahead is not a visit made. */
export function happened(visit: Visit, day: Day): boolean {
  return isDone(visit) && visit.scheduledAt < day.startOfTomorrow
}

/** From today on, not cancelled, and not already done. */
export function toCome(visit: Visit, day: Day): boolean {
  return (
    visit.scheduledAt >= day.startOfToday &&
    visit.status !== 'cancelled' &&
    !happened(visit, day)
  )
}

export type SeriesView<TSeries, TVisit> = {
  series: TSeries
  /** Visits still to come, soonest first. */
  upcoming: Array<TVisit>
  /** Visits that happened, most recent first. */
  done: Array<TVisit>
  /** Projected visits whose day has passed with nobody booking them. */
  overdue: Array<TVisit>
  /** Booked visits whose day has passed without being closed. */
  notClosed: Array<TVisit>
  /** The next visit, if one is on the books. */
  next: TVisit | undefined
  /** When a running service is next due, if no visit is on the books for it
   * yet: one repeating yearly or longer falls beyond the six months ahead
   * the engine books (lib/recurrence HORIZON_DAYS). */
  nextDue: number | undefined
}

export function seriesView<TSeries extends Series, TVisit extends Visit>(
  series: TSeries,
  visits: ReadonlyArray<TVisit>,
  day: Day,
): SeriesView<TSeries, TVisit> {
  const own = visits.filter((v) => v.recurrenceId === series._id)
  const upcoming = own
    .filter((v) => toCome(v, day))
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
  const done = own
    .filter((v) => happened(v, day))
    .sort((a, b) => b.scheduledAt - a.scheduledAt)
  const before = (v: TVisit) => v.scheduledAt < day.startOfToday
  const overdue = own
    .filter((v) => v.status === 'recurring' && before(v))
    .sort((a, b) => b.scheduledAt - a.scheduledAt)
  const notClosed = own
    .filter((v) => BOOKED.has(v.status) && before(v))
    .sort((a, b) => b.scheduledAt - a.scheduledAt)
  const next = upcoming.at(0)

  let nextDue: number | undefined
  if (!next && series.active) {
    // After every occurrence already used — a visit moved earlier still
    // holds the date it was projected for, and one in the Recycle bin or
    // someone else's still holds its own — and not before today.
    const from = Math.max(
      day.startOfToday,
      series.anchorDate,
      (series.lastTaken ?? -Infinity) + 1,
      ...own.map((v) => Math.max(v.scheduledAt, v.occurrenceAt ?? 0) + 1),
    )
    nextDue = occurrencesFrom(series.anchorDate, series.interval, {
      timezone: day.timezone,
      from,
      until: from + 50 * YEAR,
      limit: 1,
    }).at(0)
  }

  return { series, upcoming, done, overdue, notClosed, next, nextDue }
}

export type ClientOverview<TSeries, TVisit> = {
  /** The next visit on the books: the first of `comingUp`. */
  next: TVisit | undefined
  /** The last visit that happened. */
  last: TVisit | undefined
  /** Running services, first; stopped ones after, for their history. */
  series: Array<SeriesView<TSeries, TVisit>>
  /** The next visit of each running service, and every other visit to come
   * that belongs to no service shown here. */
  comingUp: Array<TVisit>
  /** Visits of no service shown here, most recent first. */
  oneOffs: Array<TVisit>
  /** Every visit the tab draws somewhere: a report on any other one (a
   * cancelled visit of a service, say) is listed with the other reports. */
  drawn: Set<string>
}

export function clientOverview<TSeries extends Series, TVisit extends Visit>(
  summary: {
    series: ReadonlyArray<TSeries>
    visits: ReadonlyArray<TVisit>
  },
  { propertyId, ...day }: Day & { propertyId?: string },
): ClientOverview<TSeries, TVisit> {
  const here = <T extends { propertyId: string }>(rows: ReadonlyArray<T>) =>
    propertyId === undefined
      ? [...rows]
      : rows.filter((r) => r.propertyId === propertyId)
  const allSeries = here(summary.series)
  const visits = here(summary.visits)

  const series = allSeries
    .map((s) => seriesView(s, visits, day))
    .sort(
      (a, b) =>
        Number(b.series.active) - Number(a.series.active) ||
        (a.next?.scheduledAt ?? a.nextDue ?? Infinity) -
          (b.next?.scheduledAt ?? b.nextDue ?? Infinity) ||
        a.series.jobType.localeCompare(b.series.jobType),
    )

  // A visit whose service is not listed here — a one-off, or one taken
  // out of a series someone else runs — is shown as a job of its own.
  const listed = new Set(allSeries.map((s) => s._id))
  const oneOffs = visits
    .filter((v) => v.recurrenceId === undefined || !listed.has(v.recurrenceId))
    .sort((a, b) => b.scheduledAt - a.scheduledAt)

  const comingUp = [
    ...series.flatMap((s) => (s.series.active && s.next ? [s.next] : [])),
    ...oneOffs.filter((v) => toCome(v, day)),
  ].sort((a, b) => a.scheduledAt - b.scheduledAt)

  const last = visits
    .filter((v) => happened(v, day))
    .sort((a, b) => b.scheduledAt - a.scheduledAt)
    .at(0)

  const drawn = new Set<string>([
    ...comingUp.map((v) => v._id),
    ...oneOffs.map((v) => v._id),
    ...series.flatMap((s) =>
      [...s.overdue, ...s.notClosed, ...s.upcoming, ...s.done].map(
        (v) => v._id,
      ),
    ),
  ])

  return { next: comingUp.at(0), last, series, comingUp, oneOffs, drawn }
}

/** Visits by the year they fall in, where the business is, newest first. */
export function byYear<T extends { scheduledAt: number }>(
  visits: ReadonlyArray<T>,
  timezone: string,
): Array<[string, Array<T>]> {
  const years = new Map<string, Array<T>>()
  for (const visit of visits) {
    const year = dayKeyOf(visit.scheduledAt, timezone).slice(0, 4)
    years.set(year, [...(years.get(year) ?? []), visit])
  }
  return [...years]
}
