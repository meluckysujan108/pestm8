import { useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Banknote,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Ellipsis,
  Landmark,
  Receipt,
} from 'lucide-react'
import type { api } from '../../../convex/_generated/api'
import { EmptyState, LoadFailed } from '#/components/primitives/EmptyState'
import { Segmented } from '#/components/primitives/Segmented'
import { ListPending } from '#/components/shell/Pending'
import { formatJobDate, formatMoney } from '#/lib/format'
import { rq } from '#/lib/routeQueries'
import {
  PAYMENTS_TABS,
  PAYMENT_METHOD,
  countsFromLine,
  jobsWord,
  monthName,
  outstandingCaption,
  owingCaption,
  paidCaption,
  stepMonth,
  toBillCaption,
} from '#/lib/payments'
import type { PaymentMethod, PaymentsTab } from '#/lib/payments'
import { useHydrated } from '#/lib/useHydrated'
import { dayKeyOf } from '../../../convex/lib/dates'
import { CountsFromSheet } from './CountsFromSheet'
import { HandOvers } from './HandOvers'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '../../../convex/_generated/dataModel'

type Summary = NonNullable<FunctionReturnType<typeof api.payments.summary>>

type Business = { _id: Id<'businesses'>; timezone: string }

const CARD = 'rounded-2xl border border-hairline bg-surface shadow-elevation'
const ROWS = `${CARD} divide-y divide-hairline overflow-hidden`

const METHOD_GLYPH: Record<
  PaymentMethod,
  ComponentType<{
    size?: number
    strokeWidth?: number
    className?: string
    'aria-hidden'?: boolean
  }>
> = {
  cash: Banknote,
  card: CreditCard,
  bankTransfer: Landmark,
  cheque: Receipt,
  other: Ellipsis,
  noCharge: Receipt,
}

/**
 * The owner's money: what is owed, what is still to bill, and what came in,
 * each split by person, with money one person holds for another above them.
 * A row opens its job (`onOpenJob`), where a payment is recorded as anywhere.
 *
 * Everything the page knows lives in the address (`tab`, `month`), so it is
 * a view rather than a route: the harness draws it without a router.
 */
export function PaymentsView({
  business,
  tab,
  month,
  onTab,
  onMonth,
  onOpenJob,
}: {
  business: Business
  tab: PaymentsTab
  /** "2026-11"; this month when absent. */
  month: string | undefined
  onTab: (tab: PaymentsTab) => void
  onMonth: (month: string | undefined) => void
  onOpenJob: (jobId: Id<'jobs'>) => void
}) {
  const hydrated = useHydrated()
  const summary = useQuery(
    rq.paymentsSummary(
      business._id,
      dayKeyOf(Date.now(), business.timezone).slice(0, 7),
    ),
  )

  return (
    <>
      <div className="px-4 pt-3">
        <Segmented
          label="Payments"
          value={tab}
          options={PAYMENTS_TABS}
          disabled={!hydrated}
          onChange={onTab}
        />
      </div>

      <section className="px-4 pt-4 pb-6">
        {summary.data === undefined ? (
          summary.isError ? (
            <LoadFailed
              what="your payments"
              onRetry={() => void summary.refetch()}
            />
          ) : (
            <ListPending label="Loading payments" count={3} />
          )
        ) : summary.data === null ? null : (
          <>
            <HandOvers
              businessId={business._id}
              pairs={summary.data.toHandOver}
            />
            {tab === 'paid' ? (
              <PaidTab
                business={business}
                month={month}
                onMonth={onMonth}
                onOpenJob={onOpenJob}
              />
            ) : (
              <OutstandingTab
                key={tab}
                business={business}
                list={tab}
                summary={summary.data}
                onOpenJob={onOpenJob}
              />
            )}
          </>
        )}
      </section>
    </>
  )
}

/** A total at the top of a tab, as Analytics draws its cards. */
function Headline({
  label,
  value,
  caption,
  children,
}: {
  label: string
  value: number | null
  caption: string | null
  children?: ReactNode
}) {
  return (
    <div className={`${CARD} p-4`}>
      <p className="section-label mb-1">{label}</p>
      <p className="text-metric-lg tabular-nums text-ink">
        {formatMoney(value)}
      </p>
      {caption && <p className="mt-1 text-body text-muted">{caption}</p>}
      {children}
    </div>
  )
}

/**
 * Each person's share, where there is more than one person's: a
 * subcontractor is self-employed, and a total for the business alone would
 * tell the owner they have money that was never theirs.
 */
function ByPerson({
  people,
}: {
  people: ReadonlyArray<{
    membershipId: string
    name: string | null
    value: number
    caption?: string
  }>
}) {
  const shown = people.filter((one) => one.value > 0)
  if (shown.length < 2) return null
  return (
    <div className="mt-6">
      <h2 className="section-label mb-2">By person</h2>
      <ul className={ROWS}>
        {shown.map((one) => (
          <li
            key={one.membershipId}
            className="flex min-h-[52px] items-center gap-3 px-3.5 py-2.5"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body text-ink">
                {one.name ?? 'No longer on the team'}
              </span>
              {one.caption && (
                <span className="block text-caption text-muted">
                  {one.caption}
                </span>
              )}
            </span>
            <span className="shrink-0 text-body font-semibold tabular-nums text-ink">
              {formatMoney(one.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A row that opens its job: the client, a line about it, and a figure. */
function JobRow({
  title,
  caption,
  value,
  onOpen,
}: {
  title: string
  caption: string
  value: string
  onOpen: () => void
}) {
  const hydrated = useHydrated()
  return (
    <li>
      <button
        type="button"
        disabled={!hydrated}
        onClick={onOpen}
        className="flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2.5 text-left outline-none transition focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue active:bg-surface-2 disabled:opacity-100"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body text-ink">
            {title || 'No client'}
          </span>
          <span className="block text-caption text-muted">{caption}</span>
        </span>
        <span className="shrink-0 text-body font-semibold tabular-nums text-ink">
          {value}
        </span>
        <ChevronRight
          aria-hidden
          size={17}
          strokeWidth={2.2}
          className="-mr-1 shrink-0 text-muted-2"
        />
      </button>
    </li>
  )
}

/** Owing or To bill: the total, each person's, then the jobs oldest first. */
function OutstandingTab({
  business,
  list,
  summary,
  onOpenJob,
}: {
  business: Business
  list: 'owing' | 'toBill'
  summary: Summary
  onOpenJob: (jobId: Id<'jobs'>) => void
}) {
  const hydrated = useHydrated()
  const [moving, setMoving] = useState(false)
  const moveRef = useRef<HTMLButtonElement>(null)
  const jobs = useQuery(rq.paymentsOutstanding(business._id, list))
  const today = dayKeyOf(Date.now(), business.timezone)
  const owing = list === 'owing'
  const count = owing ? summary.owing : summary.toBill
  const value = owing ? summary.owingValue : summary.toBillValue
  const rows = jobs.data?.rows ?? []
  // Names only help where the list holds more than one person's work.
  const showLead = new Set(rows.map((row) => row.lead)).size > 1

  return (
    <>
      {/* Withheld from someone who cannot see prices: a card of "—" says
          nothing the list below doesn't. */}
      {count !== 0 && value !== null && (
        <Headline
          label={owing ? 'Owing' : 'To bill'}
          value={value}
          caption={
            owing
              ? owingCaption(count, summary.owingSince, {
                  timezone: business.timezone,
                  today,
                })
              : toBillCaption(count)
          }
        />
      )}

      <ByPerson
        people={summary.byPerson.map((one) => ({
          membershipId: one.membershipId,
          name: one.name,
          value: owing ? one.owingValue : one.toBillValue,
          caption: jobsWord(owing ? one.owing : one.toBill),
        }))}
      />

      <div className={count === 0 || value === null ? '' : 'mt-6'}>
        {jobs.data === undefined ? (
          jobs.isError ? (
            <LoadFailed what="the jobs" onRetry={() => void jobs.refetch()} />
          ) : (
            <ListPending label="Loading jobs" count={3} />
          )
        ) : jobs.data === null ? null : rows.length === 0 ? (
          <EmptyState
            title={owing ? 'Nothing owing' : 'Nothing to bill'}
            body={
              owing
                ? 'Jobs invoiced and not yet paid appear here, oldest first.'
                : 'Jobs done and not billed yet appear here, oldest first.'
            }
          />
        ) : (
          <>
            <h2 className="section-label mb-2">Oldest first</h2>
            <ul className={ROWS}>
              {rows.map((row) => (
                <JobRow
                  key={row._id}
                  title={row.clientName}
                  caption={outstandingCaption(row, list, {
                    timezone: business.timezone,
                    today,
                    showLead,
                    pricesHidden: jobs.data?.pricesHidden ?? false,
                  })}
                  value={formatMoney(
                    jobs.data?.pricesHidden ? null : row.owing,
                  )}
                  onOpen={() => onOpenJob(row._id)}
                />
              ))}
            </ul>
            {jobs.data.more && (
              <p className="mt-2 text-caption text-muted">
                Showing the oldest {rows.length}.
              </p>
            )}
          </>
        )}
      </div>

      {(summary.countsFrom !== null || summary.canMoveCountsFrom) && (
        <p className="mt-4 text-caption text-muted">
          {countsFromLine(
            summary.countsFrom,
            summary.olderNotCounted,
            business.timezone,
            today,
          )}
          {summary.canMoveCountsFrom && (
            <>
              {' '}
              <button
                ref={moveRef}
                type="button"
                disabled={!hydrated}
                onClick={() => setMoving(true)}
                className="relative tap-target font-semibold text-blue disabled:opacity-50"
              >
                {summary.olderNotCounted ? 'Count them' : 'Change'}
              </button>
            </>
          )}
        </p>
      )}

      {summary.canMoveCountsFrom && (
        <CountsFromSheet
          open={moving}
          onClose={() => setMoving(false)}
          returnFocusRef={moveRef}
          business={business}
          countsFrom={summary.countsFrom}
        />
      )}
    </>
  )
}

/** One month's money in: the total by method, each person's, then each day. */
function PaidTab({
  business,
  month,
  onMonth,
  onOpenJob,
}: {
  business: Business
  month: string | undefined
  onMonth: (month: string | undefined) => void
  onOpenJob: (jobId: Id<'jobs'>) => void
}) {
  const hydrated = useHydrated()
  const today = dayKeyOf(Date.now(), business.timezone)
  const thisMonth = today.slice(0, 7)
  const shown = month ?? thisMonth
  const paid = useQuery(rq.paymentsPaidIn(business._id, shown))
  const name = monthName(shown, thisMonth)
  const data = paid.data
  const hidden = data?.pricesHidden ?? false

  // This month leaves the address bare, as every default does.
  const go = (by: number) => {
    const next = stepMonth(shown, by)
    onMonth(next >= thisMonth ? undefined : next)
  }

  const days: Array<{
    dayKey: string
    total: number
    rows: NonNullable<typeof data>['rows']
  }> = []
  for (const row of data?.rows ?? []) {
    const last = days.at(-1)
    if (last?.dayKey === row.dayKey) {
      last.rows.push(row)
      last.total += row.amount
    } else {
      days.push({ dayKey: row.dayKey, total: row.amount, rows: [row] })
    }
  }
  const showWhose = new Set((data?.rows ?? []).map((row) => row.whose)).size > 1

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          disabled={!hydrated || data?.hasEarlier === false}
          onClick={() => go(-1)}
          className="relative tap-target flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95] disabled:text-muted-2"
        >
          <ChevronLeft size={20} strokeWidth={2} />
        </button>
        <h2 aria-live="polite" className="text-row-title text-ink">
          {name}
        </h2>
        <button
          type="button"
          aria-label="Next month"
          disabled={!hydrated || shown >= thisMonth}
          onClick={() => go(1)}
          className="relative tap-target flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95] disabled:text-muted-2"
        >
          <ChevronRight size={20} strokeWidth={2} />
        </button>
      </div>

      {data === undefined ? (
        paid.isError ? (
          <LoadFailed
            what={`the payments for ${name}`}
            onRetry={() => void paid.refetch()}
          />
        ) : (
          <ListPending label="Loading payments" count={3} />
        )
      ) : data === null ? null : data.rows.length === 0 ? (
        <EmptyState
          title={`Nothing paid in ${name}`}
          body="Payments recorded on a job appear here on the day they came in."
        />
      ) : (
        <>
          {data.total !== null && (
            <Headline
              label={`Paid in ${name}`}
              value={data.total}
              // More than one page holds: the total is only theirs.
              caption={
                data.more
                  ? `From the newest ${data.rows.length} payments.`
                  : null
              }
            >
              {data.byMethod.length > 0 && (
                <ul className="mt-3 flex flex-col gap-2 border-t border-hairline pt-3">
                  {data.byMethod.map(({ method, value, count }) => {
                    const Glyph = METHOD_GLYPH[method]
                    return (
                      <li
                        key={method}
                        className="flex items-center gap-2.5 text-body"
                      >
                        <Glyph
                          size={17}
                          strokeWidth={2}
                          aria-hidden
                          className="shrink-0 text-ink-2"
                        />
                        <span className="min-w-0 flex-1 truncate text-ink-2">
                          {PAYMENT_METHOD[method].label}
                          <span className="text-muted">
                            {' · '}
                            {count} {count === 1 ? 'payment' : 'payments'}
                          </span>
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums text-ink">
                          {formatMoney(value)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Headline>
          )}

          <ByPerson people={data.byPerson} />

          {days.map((day, index) => (
            <div
              key={day.dayKey}
              className={data.total === null && index === 0 ? '' : 'mt-6'}
            >
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="section-label">
                  {formatJobDate(day.dayKey, today)}
                </h3>
                {!hidden && (
                  <span className="text-caption tabular-nums text-muted">
                    {formatMoney(day.total)}
                  </span>
                )}
              </div>
              <ul className={ROWS}>
                {day.rows.map((row) => (
                  <JobRow
                    key={row._id}
                    title={row.clientName}
                    caption={paidCaption(row, {
                      timezone: business.timezone,
                      showWhose,
                    })}
                    value={formatMoney(hidden ? null : row.amount)}
                    onOpen={() => onOpenJob(row.jobId)}
                  />
                ))}
              </ul>
            </div>
          ))}
          {data.more && (
            <p className="mt-2 text-caption text-muted">
              Showing the newest {data.rows.length} payments in {name}.
            </p>
          )}
        </>
      )}
    </>
  )
}
