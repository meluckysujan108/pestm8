import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { ChevronDown, Repeat } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { dayKeyOf } from '../../../convex/lib/dates'
import { describeInterval } from '../../../convex/lib/recurrence'
import { FIELD_COMPACT } from '#/components/forms/FormField'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { Bone, RowPending } from '#/components/shell/Pending'
import { ReportLine } from '#/components/reports/ReportRows'
import { SeeAllReports } from '#/components/reports/InlineReports'
import { VisitRow } from '#/components/schedule/VisitRow'
import { personLabel } from '#/lib/assignees'
import { byYear, clientOverview } from '#/lib/clientJobs'
import { formatJobDate } from '#/lib/format'
import { useBusinessDay } from '#/lib/useBusinessDay'
import { useHydrated } from '#/lib/useHydrated'
import { reportsByVisit } from '#/lib/jobHistory'
import { OVERDUE_CHIP } from '#/lib/statusColours'
import type { ReactNode } from 'react'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '../../../convex/_generated/dataModel'
import type { InlineReport } from '#/components/reports/ReportRows'
import type { Day, SeriesView } from '#/lib/clientJobs'

type Summary = NonNullable<FunctionReturnType<typeof api.clients.summary>>
type Visit = Summary['visits'][number]
type Series = Summary['series'][number]

/** One-off jobs drawn at a time. */
const PAGE = 10

/** A site filter's value for every site at once. */
export const ALL_SITES = 'all'

/**
 * A client's jobs: what is coming up, each recurring service as one row that
 * opens to its visits, then the one-off jobs by year and any report no visit
 * here produced. Every visit carries its reports under it.
 *
 * It replaced one list of every visit, recurring projections six months
 * ahead first — 198 rows on the busiest client before anything that had
 * happened — and a list of reports after it, 20 at most, with nothing tying
 * a report to its visit.
 */
export function ClientJobsTab({
  businessId,
  businessSlug,
  timezone,
  clientId,
  clientName,
  site,
  onSite,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  clientId: Id<'clients'>
  clientName: string
  /** Which of their sites, or all of them. */
  site: string
  onSite: (site: string) => void
}) {
  const summaryQuery = useQuery(
    convexQuery(api.clients.summary, { businessId, clientId }),
  )
  const reportsQuery = useQuery(
    convexQuery(api.clients.visitReports, { businessId, clientId }),
  )
  const { data: roster } = useQuery(
    convexQuery(api.memberships.listForBusiness, { businessId }),
  )
  const day = useBusinessDay(timezone)
  const [oneOffLimit, setOneOffLimit] = useState(PAGE)
  const hydrated = useHydrated()

  const summary = summaryQuery.data
  if (summary === undefined || summary === null) {
    return (
      <Section label="Jobs">
        {summaryQuery.isError ? (
          <div className="p-2">
            <LoadFailed
              what="their jobs"
              onRetry={() => void summaryQuery.refetch()}
            />
          </div>
        ) : summary === null ? (
          <Empty>Their jobs are not available.</Empty>
        ) : (
          <RowPending label="Loading their jobs" />
        )}
      </Section>
    )
  }

  // Only a site they still have: one deleted meanwhile falls back to all,
  // rather than leaving the tab empty with no way to say otherwise.
  const propertyId = summary.properties.some((p) => p._id === site)
    ? site
    : undefined
  const overview = clientOverview(summary, { ...day, propertyId })
  // A report replaced by its amendment is the amendment's to show.
  const reports = (reportsQuery.data?.reports ?? []).filter(
    (r) => !r.superseded,
  )
  // Filed under the visits the tab draws; a report on any other (a
  // cancelled visit of a service, one at another site) is with the rest.
  const { byVisit, unlinked } = reportsByVisit(reports, overview.drawn)
  const loose = unlinked.filter(
    (r) => propertyId === undefined || r.propertyId === propertyId,
  )
  const many = summary.properties.length > 1
  const siteOf = (id: string) =>
    many ? summary.properties.find((p) => p._id === id)?.addressLine : undefined
  const nameOf = (membershipId: string) => {
    const person = roster?.find((m) => m._id === membershipId)
    return person ? personLabel(person) : undefined
  }
  const colourOf = (membershipId: string) =>
    roster?.find((m) => m._id === membershipId)?.colour

  const row = (visit: Visit, headedBy: 'service' | 'day' = 'service') => (
    <VisitRow
      key={visit._id}
      businessSlug={businessSlug}
      timezone={timezone}
      visit={visit}
      reports={byVisit.get(visit._id) ?? []}
      headedBy={headedBy}
      site={siteOf(visit.propertyId)}
    />
  )
  const shownOneOffs = overview.oneOffs.slice(0, oneOffLimit)

  return (
    <>
      {many && (
        <label className="mt-6 block">
          <span className="section-label mb-2 block">Site</span>
          <select
            value={propertyId ?? ALL_SITES}
            disabled={!hydrated}
            onChange={(e) => {
              onSite(e.target.value)
              setOneOffLimit(PAGE)
            }}
            className={`${FIELD_COMPACT} w-full`}
          >
            <option value={ALL_SITES}>
              All {summary.properties.length} sites
            </option>
            {summary.properties.map((p) => (
              <option key={p._id} value={p._id}>
                {p.addressLine}, {p.suburb}
              </option>
            ))}
          </select>
        </label>
      )}

      <Section label="Coming up">
        {overview.comingUp.length > 0 ? (
          <div className="divide-y divide-hairline-2">
            {overview.comingUp.map((visit) => row(visit))}
          </div>
        ) : (
          <Empty>Nothing booked.</Empty>
        )}
      </Section>

      {overview.series.length > 0 && (
        <Section label={`Recurring services · ${overview.series.length}`}>
          {overview.series.map((view) => (
            <SeriesRow
              key={view.series._id}
              view={view}
              day={day}
              site={siteOf(view.series.propertyId)}
              who={nameOf(view.series.assignedMembershipId)}
              colour={colourOf(view.series.assignedMembershipId)}
              row={row}
            />
          ))}
        </Section>
      )}

      {overview.oneOffs.length > 0 && (
        <Section label={`One-off jobs · ${overview.oneOffs.length}`}>
          {byYear(shownOneOffs, timezone).map(([year, visits]) => (
            <Group key={year} label={year}>
              {visits.map((visit) => row(visit))}
            </Group>
          ))}
          {overview.oneOffs.length > oneOffLimit && (
            <button
              type="button"
              onClick={() => setOneOffLimit((n) => n + PAGE)}
              className="flex min-h-11 w-full items-center justify-center border-t border-hairline text-body font-semibold text-blue"
            >
              Show {Math.min(PAGE, overview.oneOffs.length - oneOffLimit)} more
            </button>
          )}
        </Section>
      )}

      {overview.series.length === 0 && overview.oneOffs.length === 0 && (
        <p className="mt-3 text-body text-muted">
          No jobs for {propertyId ? 'this site' : clientName} yet.
        </p>
      )}

      {loose.length > 0 && (
        <Section label={`Other reports · ${loose.length}`}>
          <div className="divide-y divide-hairline">
            {loose.map((report: InlineReport) => (
              <ReportLine
                key={report._id}
                businessSlug={businessSlug}
                report={report}
                timezone={timezone}
              />
            ))}
          </div>
        </Section>
      )}
      {reportsQuery.isError && reportsQuery.data === undefined && (
        <LoadFailed
          className="mt-3"
          what="their reports"
          onRetry={() => void reportsQuery.refetch()}
        />
      )}

      {summary.sitesCapped && (
        <p className="mt-3 text-caption text-muted">
          Only their newest {summary.properties.length} sites are shown here.
          The Schedule and Reports have every one.
        </p>
      )}
      {summary.capped && (
        <p className="mt-3 text-caption text-muted">
          Their oldest visits are not all shown here.
        </p>
      )}
      {(reports.length > 0 || reportsQuery.isError) && (
        <div className="mt-3">
          <SeeAllReports businessSlug={businessSlug} term={clientName} />
        </div>
      )}
    </>
  )
}

/**
 * A recurring service as one row — how often, where, who, when next, how
 * many ahead and done — that opens in place to its visits: any to book,
 * the next few, and what has been done.
 */
function SeriesRow({
  view,
  day,
  site,
  who,
  colour,
  row,
}: {
  view: SeriesView<Series, Visit>
  day: Day & { key: string }
  site: string | undefined
  who: string | undefined
  colour: string | undefined
  row: (visit: Visit, headedBy?: 'service' | 'day') => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [allDone, setAllDone] = useState(false)
  const [allAhead, setAllAhead] = useState(false)
  const { series, upcoming, done, overdue, notClosed, next, nextDue } = view
  const on = (ts: number) => formatJobDate(dayKeyOf(ts, day.timezone), day.key)
  const shownDone = allDone ? done : done.slice(0, 3)
  const shownAhead = allAhead ? upcoming : upcoming.slice(0, 3)

  return (
    <div className="border-b border-hairline last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
        className="flex w-full items-start gap-3 px-3.5 py-3 text-left"
      >
        <span
          aria-hidden
          className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${
            series.active
              ? 'bg-orange-bg text-orange-ink'
              : 'bg-surface-2 text-muted'
          }`}
        >
          <Repeat size={16} strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-row-title text-ink">
            {series.jobType}
          </span>
          <span className="block text-caption text-ink-2">
            {[describeInterval(series.interval), site]
              .filter(Boolean)
              .join(' · ')}
            {who && (
              <>
                {' · '}
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: colour }}
                  />
                  {who}
                </span>
              </>
            )}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-muted">
            {!series.active ? (
              <span className="font-semibold text-ink-2">Stopped</span>
            ) : next ? (
              <span className="font-semibold text-ink-2">
                Next {on(next.scheduledAt)}
              </span>
            ) : nextDue !== undefined ? (
              <span className="font-semibold text-ink-2">
                Due {on(nextDue)}
              </span>
            ) : null}
            {series.active && <span>· {upcoming.length} ahead</span>}
            <span>· {done.length} done</span>
            {overdue.length > 0 && (
              <span
                className={`rounded-full px-1.5 text-[11px] font-bold ${OVERDUE_CHIP}`}
              >
                {overdue.length} to book
              </span>
            )}
          </span>
        </span>
        <ChevronDown
          aria-hidden
          size={16}
          strokeWidth={2.2}
          className={`mt-1 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="mx-3.5 mb-3 overflow-hidden rounded-xl border border-hairline-2">
          {overdue.length > 0 && (
            <Group label="To book">
              {overdue.map((visit) => row(visit, 'day'))}
            </Group>
          )}
          {notClosed.length > 0 && (
            <Group label="Not closed">
              {notClosed.map((visit) => row(visit, 'day'))}
            </Group>
          )}
          {(series.active || upcoming.length > 0) && (
            <Group label="Coming up">
              {upcoming.length > 0 ? (
                shownAhead.map((visit) => row(visit, 'day'))
              ) : (
                <Empty>
                  {nextDue !== undefined
                    ? `Next due ${on(nextDue)}, beyond what is booked ahead.`
                    : 'Nothing booked.'}
                </Empty>
              )}
              {!allAhead && upcoming.length > 3 && (
                <button
                  type="button"
                  onClick={() => setAllAhead(true)}
                  className="flex min-h-11 w-full items-center justify-center border-t border-hairline-2 text-body font-semibold text-blue"
                >
                  {upcoming.length - 3} more ahead
                </button>
              )}
            </Group>
          )}
          <Group label="Done">
            {shownDone.length > 0 ? (
              shownDone.map((visit) => row(visit, 'day'))
            ) : (
              <Empty>None yet.</Empty>
            )}
            {!allDone && done.length > 3 && (
              <button
                type="button"
                onClick={() => setAllDone(true)}
                className="flex min-h-11 w-full items-center justify-center border-t border-hairline-2 text-body font-semibold text-blue"
              >
                All {done.length} done visits
              </button>
            )}
          </Group>
        </div>
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">{label}</h3>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {children}
      </div>
    </section>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-hairline-2 first:border-t-0">
      <h4 className="section-label px-3.5 pb-0.5 pt-3">{label}</h4>
      <div className="divide-y divide-hairline-2">{children}</div>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3.5 py-3 text-body text-muted">{children}</p>
}

/**
 * Under a client's name: when they are next visited, when they were last,
 * and how many services and reports they have — the answer to "when are you
 * next coming?" without opening anything.
 */
export function ClientAtAGlance({
  businessId,
  clientId,
  timezone,
}: {
  businessId: Id<'businesses'>
  clientId: Id<'clients'>
  timezone: string
}) {
  const { data: summary, isError } = useQuery(
    convexQuery(api.clients.summary, { businessId, clientId }),
  )
  const { data: reports } = useQuery(
    convexQuery(api.clients.visitReports, { businessId, clientId }),
  )
  const day = useBusinessDay(timezone)
  const on = (ts: number) => formatJobDate(dayKeyOf(ts, timezone), day.key)

  let cells: Array<{ label: string; value: ReactNode; sub?: string }>
  if (!summary) {
    // Loading holds the strip's shape; a failure says nothing it can't.
    const blank =
      isError || summary === null ? '—' : <Bone className="h-4 w-16" />
    cells = [
      { label: 'Next visit', value: blank },
      { label: 'Last visit', value: blank },
      { label: 'Services', value: blank },
    ]
  } else {
    const overview = clientOverview(summary, day)
    const due = overview.series
      .flatMap((s) => (s.series.active && s.nextDue !== undefined ? [s] : []))
      .sort((a, b) => (a.nextDue ?? 0) - (b.nextDue ?? 0))
      .at(0)
    const running = overview.series.filter((s) => s.series.active).length
    const count = reports?.reports.filter((r) => !r.superseded).length
    cells = [
      overview.next
        ? {
            label: 'Next visit',
            value: on(overview.next.scheduledAt),
            sub: overview.next.jobType,
          }
        : due?.nextDue !== undefined
          ? {
              label: 'Next visit',
              value: on(due.nextDue),
              sub: `Due · ${due.series.jobType}`,
            }
          : { label: 'Next visit', value: 'None booked' },
      overview.last
        ? {
            label: 'Last visit',
            value: on(overview.last.scheduledAt),
            sub: overview.last.jobType,
          }
        : { label: 'Last visit', value: 'None yet' },
      {
        label: 'Services',
        value: running > 0 ? `${running} recurring` : 'None',
        sub:
          count === undefined
            ? undefined
            : `${count}${reports?.capped ? '+' : ''} report${count === 1 ? '' : 's'}`,
      },
    ]
  }

  return (
    <dl className="mt-3 grid grid-cols-3 divide-x divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
      {cells.map((cell) => (
        <div key={cell.label} className="min-w-0 px-3 py-2.5">
          <dt className="section-label truncate">{cell.label}</dt>
          <dd className="mt-0.5">
            {/* Wrapped, not cut: the year or month cut off is the answer. */}
            <span className="block break-words text-body font-semibold text-ink">
              {cell.value}
            </span>
            {cell.sub && (
              <span className="line-clamp-2 text-caption text-muted">
                {cell.sub}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
