import { useState } from 'react'
import { ChevronDown, Repeat } from 'lucide-react'
import { dayKeyOf } from '../../../convex/lib/dates'
import { describeInterval } from '../../../convex/lib/recurrence'
import { VisitRow } from './VisitRow'
import { personLabel } from '#/lib/assignees'
import { seriesView } from '#/lib/clientJobs'
import { formatJobDate } from '#/lib/format'
import { OVERDUE_CHIP } from '#/lib/statusColours'
import { useHydrated } from '#/lib/useHydrated'
import type { ReactNode } from 'react'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'
import type { Day, SeriesView } from '#/lib/clientJobs'
import type { Role } from '../../../convex/lib/capabilities'
import type { Id } from '../../../convex/_generated/dataModel'

type Services = FunctionReturnType<typeof api.recurrences.services>
type Service = Services['services'][number]
type Visit = Services['visits'][number]
type LooseVisit = Services['loose'][number]

/** Coming visits drawn in an opened card before "more ahead". */
const AHEAD = 5

/**
 * The Recurring Job page by service: one card per running service — whose,
 * where, how often, who does it, when next, how many ahead, and how many to
 * book — each opening to its visits. Services with visits to book come
 * first, then the soonest.
 *
 * It replaced a card per visit, which for three services was 127 cards and
 * about 45 phone screens, and never showed the services themselves: "which
 * contracts do we have?" had no answer here. A service with nothing in the
 * next six months (every 15 years, say) has its card too.
 */
export function RecurringServices({
  data,
  day,
  roster,
  businessSlug,
  onOpenJob,
}: {
  data: Services
  day: Day & { key: string }
  roster:
    | ReadonlyArray<{
        _id: Id<'memberships'>
        name: string
        role: Role
        colour: string
      }>
    | undefined
  businessSlug: string
  onOpenJob: (jobId: string) => void
}) {
  // A card says the suburb, as cards do; the street too only where one
  // client has services at more than one of their sites.
  const sitesOf = new Map<string, Set<string>>()
  for (const s of data.services) {
    sitesOf.set(
      s.clientName,
      (sitesOf.get(s.clientName) ?? new Set()).add(s.propertyId),
    )
  }
  const views = data.services
    .map((service) => seriesView(service, data.visits, day))
    .sort(
      (a, b) =>
        Number(b.overdue.length > 0) - Number(a.overdue.length > 0) ||
        (a.next?.scheduledAt ?? a.nextDue ?? Infinity) -
          (b.next?.scheduledAt ?? b.nextDue ?? Infinity) ||
        a.series.clientName.localeCompare(b.series.clientName),
    )

  return (
    <ul className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-start xl:grid-cols-3">
      {views.map((view) => {
        const person = roster?.find(
          (m) => m._id === view.series.assignedMembershipId,
        )
        return (
          <li key={view.series._id}>
            <ServiceCard
              view={view}
              day={day}
              withStreet={(sitesOf.get(view.series.clientName)?.size ?? 0) > 1}
              who={person ? personLabel(person) : undefined}
              colour={person?.colour}
              businessSlug={businessSlug}
              onOpenJob={onOpenJob}
            />
          </li>
        )
      })}
      {data.loose.length > 0 && (
        <li>
          <OtherVisits
            visits={data.loose}
            day={day}
            businessSlug={businessSlug}
            onOpenJob={onOpenJob}
          />
        </li>
      )}
    </ul>
  )
}

/**
 * Recurring visits the view shows whose service it does not: one left to
 * book when its service was stopped, or one handed to this person out of
 * someone else's. The overdue badge counts them, so they are here to act on.
 */
function OtherVisits({
  visits,
  day,
  businessSlug,
  onOpenJob,
}: {
  visits: ReadonlyArray<LooseVisit>
  day: Day & { key: string }
  businessSlug: string
  onOpenJob: (jobId: string) => void
}) {
  const before = (v: LooseVisit) => v.scheduledAt < day.startOfToday
  const sorted = [...visits].sort((a, b) => a.scheduledAt - b.scheduledAt)
  const toBook = sorted.filter((v) => v.status === 'recurring' && before(v))
  const notClosed = sorted.filter((v) => v.status !== 'recurring' && before(v))
  const coming = sorted.filter((v) => !before(v))
  const row = (visit: LooseVisit) => (
    <VisitRow
      key={visit._id}
      businessSlug={businessSlug}
      timezone={day.timezone}
      visit={visit}
      reports={[]}
      site={[visit.clientName, visit.suburb].filter(Boolean).join(', ')}
      onOpen={onOpenJob}
    />
  )
  return (
    <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
      <div className="px-3.5 py-3">
        <p className="text-row-title text-ink">Other visits</p>
        <p className="text-caption text-muted">
          From services that have stopped, or someone else’s.
        </p>
      </div>
      <div className="border-t border-hairline">
        {toBook.length > 0 && <Group label="To book">{toBook.map(row)}</Group>}
        {notClosed.length > 0 && (
          <Group label="Not closed">{notClosed.map(row)}</Group>
        )}
        {coming.length > 0 && (
          <Group label="Coming up">{coming.map(row)}</Group>
        )}
      </div>
    </div>
  )
}

function ServiceCard({
  view,
  day,
  withStreet,
  who,
  colour,
  businessSlug,
  onOpenJob,
}: {
  view: SeriesView<Service, Visit>
  day: Day & { key: string }
  withStreet: boolean
  who: string | undefined
  colour: string | undefined
  businessSlug: string
  onOpenJob: (jobId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [allAhead, setAllAhead] = useState(false)
  const hydrated = useHydrated()
  const { series, upcoming, overdue, notClosed, next, nextDue } = view
  const on = (ts: number) => formatJobDate(dayKeyOf(ts, day.timezone), day.key)
  const shownAhead = allAhead ? upcoming : upcoming.slice(0, AHEAD)
  const row = (visit: Visit) => (
    <VisitRow
      key={visit._id}
      businessSlug={businessSlug}
      timezone={day.timezone}
      visit={visit}
      reports={[]}
      headedBy="day"
      onOpen={onOpenJob}
    />
  )

  return (
    <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
      <button
        type="button"
        aria-expanded={open}
        disabled={!hydrated}
        onClick={() => setOpen((shown) => !shown)}
        className="flex w-full items-start gap-3 px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue"
      >
        <span
          aria-hidden
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-orange-bg text-orange-ink"
        >
          <Repeat size={16} strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-row-title text-ink">
            {series.clientName}
          </span>
          <span className="block text-body text-ink-2">
            {series.jobType} · {describeInterval(series.interval)}
          </span>
          <span className="block text-caption text-muted">
            {withStreet
              ? [series.addressLine, series.suburb].filter(Boolean).join(', ')
              : series.suburb}
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
            {next ? (
              <span className="font-semibold text-ink-2">
                Next {on(next.scheduledAt)}
              </span>
            ) : nextDue !== undefined ? (
              <span className="font-semibold text-ink-2">
                Due {on(nextDue)}
              </span>
            ) : null}
            <span>· {upcoming.length} ahead</span>
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
        <div className="border-t border-hairline">
          {overdue.length > 0 && (
            <Group label="To book">{overdue.map(row)}</Group>
          )}
          {notClosed.length > 0 && (
            <Group label="Not closed">{notClosed.map(row)}</Group>
          )}
          <Group label="Coming up">
            {upcoming.length > 0 ? (
              shownAhead.map(row)
            ) : (
              <p className="px-3.5 py-3 text-body text-muted">
                {nextDue !== undefined
                  ? `Next due ${on(nextDue)}, beyond what is booked ahead.`
                  : 'Nothing booked.'}
              </p>
            )}
            {!allAhead && upcoming.length > AHEAD && (
              <button
                type="button"
                onClick={() => setAllAhead(true)}
                className="flex min-h-11 w-full items-center justify-center border-t border-hairline-2 text-body font-semibold text-blue outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue"
              >
                {upcoming.length - AHEAD} more ahead
              </button>
            )}
          </Group>
        </div>
      )}
    </div>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-hairline-2 first:border-t-0">
      {/* Under the page's own h1: no heading between. */}
      <h2 className="section-label px-3.5 pb-0.5 pt-3">{label}</h2>
      <div className="divide-y divide-hairline-2">{children}</div>
    </div>
  )
}
