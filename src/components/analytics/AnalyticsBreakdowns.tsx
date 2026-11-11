import { LoadFailed } from '#/components/primitives/EmptyState'
import { Bone } from '#/components/shell/Pending'
import { BreakdownCard } from '#/components/analytics/BreakdownCard'
import { STAT_CARD } from '#/components/analytics/StatTile'
import { formatMoney } from '#/lib/format'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'
import type { BreakdownRow } from '#/components/analytics/BreakdownCard'
import type { AnalyticsReport } from '#/components/analytics/AnalyticsOverview'
import type { AnalyticsSearch } from '#/lib/analyticsView'

export type AnalyticsBreakdown = NonNullable<
  FunctionReturnType<typeof api.analytics.breakdowns>
>

const jobs = (count: number) => `${count} ${count === 1 ? 'job' : 'jobs'}`
const percent = (part: number, whole: number) =>
  Math.round((part / whole) * 100)

type Tallied = { completed: number; revenue: number | null }

/** A ranked row: by money for someone who sees it, by jobs otherwise. */
function rowOf(
  key: string,
  label: string,
  tally: Tallied,
  more: Partial<BreakdownRow> = {},
): BreakdownRow {
  return tally.revenue === null
    ? {
        key,
        label,
        value: String(tally.completed),
        amount: tally.completed,
        ...more,
      }
    : {
        key,
        label,
        value: formatMoney(tally.revenue),
        sub: jobs(tally.completed),
        amount: tally.revenue,
        ...more,
      }
}

/**
 * Up to three plain sentences about the range, each a figure already on the
 * page said as a fact. Nothing is said that the figures don't settle: no
 * advice, no guesses at why.
 */
export function insightsOf(
  report: AnalyticsReport | undefined,
  data: AnalyticsBreakdown,
): Array<string> {
  const said: Array<string> = []
  const [top] = data.services
  if (
    data.services.length > 1 &&
    top.revenue !== null &&
    data.revenue !== null &&
    data.revenue > 0
  )
    said.push(
      `${top.name} brought in ${percent(top.revenue, data.revenue)}% of revenue.`,
    )
  if (data.clients.new > 0)
    said.push(
      `${data.clients.new} of the ${data.clients.served} clients you worked for were new.`,
    )
  if (data.recurring.completed > 0 && data.completed > 0)
    said.push(
      `${percent(data.recurring.completed, data.completed)}% of finished jobs were recurring visits.`,
    )
  if (report) {
    const { booked, cancelled } = report.totals
    const made = booked + cancelled
    if (made > 0 && cancelled / made >= 0.1)
      said.push(
        `${cancelled} of ${jobs(made)} were cancelled (${percent(cancelled, made)}%).`,
      )
  }
  return said.slice(0, 3)
}

/**
 * Where the range's finished work came from, under the overview: a few
 * sentences, then services, technicians, clients, suburbs, what repeats and
 * how the report emails went. Tapping a service or a technician narrows the
 * whole page to it.
 *
 * Given its figures (`analytics.breakdowns`), like the overview above it.
 */
export function AnalyticsBreakdowns({
  data,
  report,
  search,
  stale = false,
  failed = false,
  onRetry,
  onSearch,
}: {
  /** `undefined` while the first figures load. */
  data: AnalyticsBreakdown | undefined
  /** The overview's figures, for what the sentences say about them. */
  report: AnalyticsReport | undefined
  search: AnalyticsSearch
  stale?: boolean
  failed?: boolean
  onRetry?: () => void
  onSearch: (next: Partial<AnalyticsSearch>) => void
}) {
  if (failed && !data)
    return <LoadFailed what="the breakdowns" onRetry={onRetry} />
  if (!data)
    return (
      <div className="grid gap-3 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={STAT_CARD}>
            <Bone className="mb-3 h-3 w-20" />
            {[0, 1, 2].map((row) => (
              <Bone key={row} className="my-3 h-5 w-full" />
            ))}
          </div>
        ))}
      </div>
    )

  const insights = insightsOf(report, data)
  const chosenService = search.service?.trim().toLowerCase()
  const { clients, recurring, emails } = data

  return (
    <div
      aria-busy={stale || undefined}
      className={`flex flex-col gap-3 transition-opacity ${stale ? 'opacity-60' : ''}`}
    >
      {insights.length > 0 && (
        <div className={STAT_CARD}>
          <h2 className="section-label mb-1">Worth knowing</h2>
          <ul className="flex flex-col gap-1">
            {insights.map((line) => (
              <li key={line} className="text-body text-ink-2">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid items-start gap-3 md:grid-cols-2">
        <BreakdownCard
          title="Services"
          empty="No finished jobs in these dates."
          rows={data.services.map((s) =>
            rowOf(s.name, s.name, s, {
              chosen: s.name.toLowerCase() === chosenService,
            }),
          )}
          onPick={(name) =>
            onSearch({
              service: name.toLowerCase() === chosenService ? undefined : name,
            })
          }
        />

        {data.scope === 'business' && (
          <BreakdownCard
            title="Technicians"
            empty="No finished jobs in these dates."
            rows={data.team.map((member) =>
              rowOf(member.membershipId, member.name, member, {
                colour: member.colour,
                chosen: member.membershipId === search.staff,
              }),
            )}
            onPick={(membershipId) =>
              onSearch({
                staff: membershipId === search.staff ? undefined : membershipId,
              })
            }
          />
        )}

        <BreakdownCard
          title="Clients"
          empty="No finished jobs in these dates."
          lead={
            clients.served > 0 && (
              <p className="mb-1 text-body text-ink-2">
                {clients.served} {clients.served === 1 ? 'client' : 'clients'},{' '}
                {clients.new} new · {jobs(clients.person.completed)} for homes,{' '}
                {clients.business.completed} for businesses
                {data.partial && ' (the busiest properties only)'}
              </p>
            )
          }
          rows={clients.top.map((client) =>
            rowOf(client.clientId, client.name, client),
          )}
        />

        <BreakdownCard
          title="Suburbs"
          empty="No finished jobs in these dates."
          rows={data.areas.map((area) => rowOf(area.suburb, area.suburb, area))}
        />
      </div>

      <div className="grid items-start gap-3 md:grid-cols-2">
        <div className={STAT_CARD}>
          <h2 className="section-label mb-1">Recurring</h2>
          <p className="text-metric-sm text-ink">
            {recurring.yearlyValue === null
              ? String(recurring.services)
              : formatMoney(recurring.yearlyValue)}
          </p>
          <p className="mt-1 text-body text-ink-2">
            {recurring.yearlyValue === null
              ? `running ${recurring.services === 1 ? 'service' : 'services'}`
              : `a year, from ${recurring.services}${recurring.more ? ' or more' : ''} running ${recurring.services === 1 ? 'service' : 'services'}`}
          </p>
          <p className="mt-0.5 text-caption text-muted">
            {recurring.completed === 0
              ? 'No recurring visits finished in these dates.'
              : `${recurring.completed} recurring ${recurring.completed === 1 ? 'visit' : 'visits'} finished in these dates${recurring.revenue === null ? '' : ` (${formatMoney(recurring.revenue)})`}.`}
          </p>
        </div>

        {emails && (
          <div className={STAT_CARD}>
            <h2 className="section-label mb-2">Report emails</h2>
            <dl className="grid grid-cols-3 gap-3 text-center">
              {(
                [
                  ['Sent', emails.sent],
                  ['Failed', emails.failed],
                  ['Bounced', emails.bounced],
                ] as const
              ).map(([name, count]) => (
                <div key={name} className="flex flex-col-reverse">
                  <dt className="text-caption text-muted">{name}</dt>
                  <dd className="text-row-title text-ink tabular-nums">
                    {count >= data.emailsCapped
                      ? `${data.emailsCapped}+`
                      : count}
                  </dd>
                </div>
              ))}
            </dl>
            {emails.failed + emails.bounced > 0 && (
              <p className="mt-2 text-caption text-amber-ink">
                Each one is in its report’s Email list, with why.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
