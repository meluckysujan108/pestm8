import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  formatMoney,
  formatMoneyShort,
  formatShortDate,
  formatShortMonth,
} from '#/lib/format'
import type { Grain } from '../../../convex/lib/analyticsRange'

export type TrendPoint = {
  /** The first day the point covers. */
  start: string
  now: number
  /** The same point of the range compared with, or `null` with none. */
  before: number | null
}

/**
 * A figure over the range, with the range it is compared with drawn under
 * it: this range a solid blue line, the earlier one grey and dashed, so the
 * two are told apart by their line as well as their colour.
 *
 * The page's only `recharts` import, so it is a chunk of its own
 * (`AnalyticsOverview` loads it lazily) and the tiles never wait for it.
 */
export function TrendChart({
  points,
  grain,
  kind,
  today,
}: {
  points: ReadonlyArray<TrendPoint>
  grain: Grain
  /** Money in cents, or a count of jobs. */
  kind: 'money' | 'count'
  today: string
}) {
  const data = points.map((point) => ({ ...point }))
  const compared = points.some((point) => point.before !== null)
  const tick = (start: string) =>
    grain === 'month' ? formatShortMonth(start) : formatShortDate(start)
  const exact = (value: number) =>
    kind === 'money'
      ? formatMoney(value)
      : `${value} ${value === 1 ? 'job' : 'jobs'}`
  const heading = (start: string) =>
    grain === 'day'
      ? formatShortDate(start, today)
      : grain === 'week'
        ? `Week of ${formatShortDate(start, today)}`
        : `${formatShortMonth(start)} ${start.slice(0, 4)}`

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--hairline)" vertical={false} />
        <XAxis
          dataKey="start"
          tickFormatter={tick}
          tick={{ fill: 'var(--muted)', fontSize: 12 }}
          axisLine={{ stroke: 'var(--hairline)' }}
          tickLine={false}
          interval="preserveStartEnd"
          minTickGap={28}
        />
        <YAxis
          tick={{ fill: 'var(--muted)', fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
          tickFormatter={(value: number) =>
            kind === 'money' ? formatMoneyShort(value) : String(value)
          }
          width={kind === 'money' ? 44 : 28}
        />
        <Tooltip
          cursor={{ stroke: 'var(--hairline)' }}
          contentStyle={{
            background: 'var(--surface)',
            border: '1px solid var(--hairline)',
            borderRadius: 12,
            fontSize: 13,
            color: 'var(--ink)',
          }}
          labelFormatter={(start) => heading(String(start))}
          formatter={(value, name) => [
            exact(Number(value)),
            name === 'now' ? 'This range' : 'Before',
          ]}
        />
        {compared && (
          <Line
            type="monotone"
            dataKey="before"
            stroke="var(--muted-2)"
            strokeWidth={2}
            strokeDasharray="4 4"
            dot={false}
            isAnimationActive={false}
          />
        )}
        <Line
          type="monotone"
          dataKey="now"
          stroke="var(--blue)"
          strokeWidth={2}
          dot={points.length <= 12 ? { r: 3, fill: 'var(--blue)' } : false}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
