import { Link } from '@tanstack/react-router'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { Bone } from '#/components/shell/Pending'
import { BreakdownCard } from '#/components/analytics/BreakdownCard'
import { STAT_CARD } from '#/components/analytics/StatTile'
import { formatMoney } from '#/lib/format'
import { PAYMENT_METHOD } from '#/lib/payments'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'

export type AnalyticsPayments = NonNullable<
  FunctionReturnType<typeof api.analytics.payments>
>

const payments = (count: number) =>
  `${count} ${count === 1 ? 'payment' : 'payments'}`

/**
 * How the money that came in during the range was paid: a row a method,
 * most money first (`analytics.payments`), with the way to Payments, where
 * each one is listed.
 *
 * It says it is counted on the day the money came in: a job done last month
 * and paid this month is in this card and not in this range's revenue, and
 * two totals that differ with no word why read as a mistake.
 */
export function PaidCard({
  businessSlug,
  data,
  failed = false,
  onRetry,
}: {
  businessSlug: string
  /** `undefined` while it loads. */
  data: AnalyticsPayments | undefined
  failed?: boolean
  onRetry?: () => void
}) {
  if (failed && !data)
    return <LoadFailed what="the payments" onRetry={onRetry} />
  if (!data)
    return (
      <div className={STAT_CARD}>
        <Bone className="mb-3 h-3 w-28" />
        {[0, 1, 2].map((row) => (
          <Bone key={row} className="my-3 h-5 w-full" />
        ))}
      </div>
    )

  return (
    <BreakdownCard
      title="How you were paid"
      empty="No payments recorded in these dates."
      lead={
        data.count > 0 && (
          <p className="mb-1 text-body text-ink-2">
            {data.value === null
              ? `${payments(data.count)} received`
              : `${formatMoney(data.value)} received in ${payments(data.count)}`}
            {data.more && ', or more'}, counted on the day the money came in.{' '}
            <Link
              to="/$businessSlug/payments"
              params={{ businessSlug }}
              search={{ tab: 'paid' }}
              className="font-semibold text-blue"
            >
              Open Payments
            </Link>
          </p>
        )
      }
      rows={data.methods.map((row) =>
        row.value === null
          ? {
              key: row.method,
              label: PAYMENT_METHOD[row.method].label,
              value: String(row.count),
              amount: row.count,
            }
          : {
              key: row.method,
              label: PAYMENT_METHOD[row.method].label,
              value: formatMoney(row.value),
              sub: payments(row.count),
              amount: row.value,
            },
      )}
    />
  )
}
