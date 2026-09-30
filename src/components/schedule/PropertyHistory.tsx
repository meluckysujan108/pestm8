import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, Repeat } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { dayKeyOf, startOfDayInZone } from '../../../convex/lib/dates'
import { Sheet } from '#/components/primitives/Sheet'
import { StatusPill } from '#/components/primitives/StatusPill'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { NEUTRAL_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { RowPending } from '#/components/shell/Pending'
import { ReportChip, ReportLine } from '#/components/reports/ReportRows'
import { formatJobDate, formatTime, todayKey } from '#/lib/format'
import { useHydrated } from '#/lib/useHydrated'
import { historyCard, pastVisits, reportsByVisit } from '#/lib/jobHistory'
import type { ReactNode } from 'react'
import type { InlineReport } from '#/components/reports/ReportRows'
import type { Id } from '../../../convex/_generated/dataModel'

/** How many of the full history's visits draw at once. */
const PAGE = 30

/** Reports here that no visit shown produced: started from Reports, or for
 * another visit today or one to come. */
const OTHER_REPORTS = 'Other reports here'

type Visit = {
  _id: Id<'jobs'>
  scheduledAt: number
  status: string
  jobType: string
  recurrenceId?: Id<'recurrences'>
}

/**
 * What has happened at this job's address, each visit with its reports.
 *
 * The card holds a few rows: the last visit for this job's own service,
 * which is the one a technician compares against, then the most recent
 * others, then the address's other reports, and the way to every one in
 * Reports. "See all" opens
 * the rest in a sheet of its own, by year.
 *
 * It replaced two sections. "Other visits at this property" took the newest
 * visits by the order they were made in, which for a recurring client is the
 * furthest projection, so it showed next March and called it history; and
 * "Other reports at this property" listed every report with nothing saying
 * which visit it came from.
 */
export function PropertyHistory({
  businessId,
  businessSlug,
  timezone,
  job,
  addressLine,
  clientName,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  job: Visit & { propertyId: Id<'properties'> }
  addressLine: string
  clientName: string
}) {
  const propertyId = job.propertyId
  const visitsQuery = useQuery(
    convexQuery(api.properties.jobHistory, { businessId, propertyId }),
  )
  const reportsQuery = useQuery(
    convexQuery(api.reports.listByProperty, { businessId, propertyId }),
  )
  const [allOpen, setAllOpen] = useState(false)
  const seeAll = useRef<HTMLButtonElement>(null)
  const hydrated = useHydrated()
  // History is the days before today, as of when the sheet opened: a visit
  // does not move into it while it is being read.
  const [startOfToday] = useState(() =>
    startOfDayInZone(todayKey(timezone), timezone),
  )

  const visits = visitsQuery.data
  const reports = reportsQuery.data
  const failed = visitsQuery.isError || reportsQuery.isError

  if (visits === undefined || reports === undefined) {
    return (
      <HistorySection>
        {failed ? (
          <div className="p-2">
            <LoadFailed
              what="this property’s history"
              onRetry={() => {
                void visitsQuery.refetch()
                void reportsQuery.refetch()
              }}
            />
          </div>
        ) : (
          <RowPending label="Loading this property’s history" />
        )}
      </HistorySection>
    )
  }

  // This visit's own reports are in its own section, above.
  const others = reports.filter((r) => r.jobId !== job._id)
  const past = pastVisits(visits, {
    startOfToday,
    excludeJobId: job._id,
    withReports: new Set(others.flatMap((r) => r.jobId ?? [])),
  })
  // Filed under the visits drawn below, so every report here is somewhere
  // on screen: one for a visit that isn't (today's, one to come) is with
  // the others.
  const { byVisit, unlinked } = reportsByVisit(
    others,
    new Set(past.map((v) => v._id)),
  )
  const card = historyCard(job, past)
  const loose = unlinked.slice(0, 2)
  const shown = (card.last ? 1 : 0) + card.recent.length
  const more = past.length > shown || unlinked.length > loose.length

  const row = (visit: Visit) => (
    <VisitRow
      key={visit._id}
      businessSlug={businessSlug}
      timezone={timezone}
      visit={visit}
      reports={byVisit.get(visit._id) ?? []}
    />
  )

  return (
    <HistorySection
      action={
        more && (
          <button
            ref={seeAll}
            type="button"
            aria-haspopup="dialog"
            disabled={!hydrated}
            onClick={() => setAllOpen(true)}
            className="relative tap-target text-caption font-semibold text-blue disabled:opacity-50"
          >
            {past.length > 0 ? `See all ${past.length}` : 'See all'}
          </button>
        )
      }
    >
      {past.length === 0 && unlinked.length === 0 && (
        <p className="px-3.5 py-3 text-body text-muted">
          No earlier visits here.
        </p>
      )}
      {past.length > 0 && shown === 0 && (
        <p className="px-3.5 py-3 text-body text-muted">
          No completed visits here yet.
        </p>
      )}
      {/* Named for this job's services: the visit may have been for more. */}
      {card.last && (
        <Group label={`Last ${job.jobType} here`}>{row(card.last)}</Group>
      )}
      {card.recent.length > 0 && (
        <Group label={card.last ? 'Other recent visits' : 'Recent visits'}>
          {card.recent.map(row)}
        </Group>
      )}
      {loose.length > 0 && (
        <Group label={OTHER_REPORTS}>
          {loose.map((report) => (
            <ReportLine
              key={report._id}
              businessSlug={businessSlug}
              report={report}
              timezone={timezone}
            />
          ))}
        </Group>
      )}
      {/* A property's reports reach the sheet twenty at a time
          (`reports.listByProperty`), so an older visit's may not be under
          it here. The library has every one, a tap away. */}
      {others.length > 0 && (
        <Link
          to="/$businessSlug/reports"
          params={{ businessSlug }}
          search={{ q: clientName }}
          className="flex min-h-11 items-center justify-between gap-2 border-t border-hairline px-3.5 text-body font-semibold text-blue"
        >
          See all in Reports
          <ChevronRight
            aria-hidden
            size={16}
            strokeWidth={2.2}
            className="text-muted-2"
          />
        </Link>
      )}

      <Sheet
        open={allOpen}
        onClose={() => setAllOpen(false)}
        title="History at this property"
        description={addressLine}
        returnFocusRef={seeAll}
        footer={
          <button
            type="button"
            onClick={() => setAllOpen(false)}
            className={`${NEUTRAL_BUTTON_COMPACT} w-full`}
          >
            Done
          </button>
        }
      >
        {/* Not gated on `allOpen`: the sheet keeps its body through the
            slide away, and an emptied one collapses to its title first. */}
        <AllHistory
          businessSlug={businessSlug}
          timezone={timezone}
          clientName={clientName}
          past={past}
          unlinked={unlinked}
          anyReports={others.length > 0}
          row={row}
        />
      </Sheet>
    </HistorySection>
  )
}

/** Every earlier visit, newest first and by year, then the loose reports. */
function AllHistory({
  businessSlug,
  timezone,
  clientName,
  past,
  unlinked,
  anyReports,
  row,
}: {
  businessSlug: string
  timezone: string
  clientName: string
  past: ReadonlyArray<Visit>
  unlinked: ReadonlyArray<InlineReport>
  anyReports: boolean
  row: (visit: Visit) => ReactNode
}) {
  const [limit, setLimit] = useState(PAGE)
  const years = new Map<string, Array<Visit>>()
  for (const visit of past.slice(0, limit)) {
    const year = dayKeyOf(visit.scheduledAt, timezone).slice(0, 4)
    years.set(year, [...(years.get(year) ?? []), visit])
  }

  return (
    <div className="flex flex-col gap-5">
      {past.length === 0 && (
        <p className="text-body text-muted">No earlier visits here.</p>
      )}
      {[...years].map(([year, list]) => (
        <section key={year}>
          <h3 className="section-label mb-2">{year}</h3>
          <div className="divide-y divide-hairline-2 overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
            {list.map(row)}
          </div>
        </section>
      ))}
      {past.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + PAGE)}
          className="flex min-h-11 w-full items-center justify-center rounded-xl text-body font-semibold text-blue"
        >
          Show {Math.min(PAGE, past.length - limit)} more
        </button>
      )}
      {unlinked.length > 0 && (
        <section>
          <h3 className="section-label mb-2">{OTHER_REPORTS}</h3>
          <div className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
            {unlinked.map((report) => (
              <ReportLine
                key={report._id}
                businessSlug={businessSlug}
                report={report}
                timezone={timezone}
              />
            ))}
          </div>
        </section>
      )}
      {/* As on the card: the library has every report, older ones too. */}
      {anyReports && (
        <Link
          to="/$businessSlug/reports"
          params={{ businessSlug }}
          search={{ q: clientName }}
          className="flex min-h-11 w-full items-center justify-center rounded-xl text-body font-semibold text-blue"
        >
          See all in Reports
        </Link>
      )}
    </div>
  )
}

function VisitRow({
  businessSlug,
  timezone,
  visit,
  reports,
}: {
  businessSlug: string
  timezone: string
  visit: Visit
  reports: ReadonlyArray<InlineReport>
}) {
  const dayKey = dayKeyOf(visit.scheduledAt, timezone)
  return (
    <div className="px-3.5 py-2">
      <Link
        to="/$businessSlug/schedule"
        params={{ businessSlug }}
        search={{ date: dayKey, jobId: visit._id }}
        className="flex min-h-11 items-center justify-between gap-2"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-body text-ink">
            <span className="truncate">{visit.jobType}</span>
            {visit.recurrenceId !== undefined && (
              <>
                <Repeat
                  aria-hidden
                  size={13}
                  strokeWidth={2}
                  className="shrink-0 text-muted"
                />
                <span className="sr-only">, recurring</span>
              </>
            )}
          </span>
          <span className="block truncate text-caption text-muted">
            {formatJobDate(dayKey, todayKey(timezone))} ·{' '}
            {formatTime(visit.scheduledAt, timezone)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <StatusPill status={visit.status} />
          <ChevronRight
            aria-hidden
            size={16}
            strokeWidth={2.2}
            className="text-muted-2"
          />
        </span>
      </Link>
      {reports.length > 0 && (
        <div className="mb-0.5 mt-1 flex flex-col gap-1.5">
          {reports.map((report) => (
            <ReportChip
              key={report._id}
              businessSlug={businessSlug}
              report={report}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function HistorySection({
  action,
  children,
}: {
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex min-h-5 items-center justify-between gap-2">
        <h3 className="section-label">History at this property</h3>
        {action}
      </div>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {children}
      </div>
    </section>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-hairline-2 first:border-t-0">
      <h4 className="section-label truncate px-3.5 pb-0.5 pt-3">{label}</h4>
      <div className="divide-y divide-hairline-2">{children}</div>
    </div>
  )
}
