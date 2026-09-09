import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api } from '../../../convex/_generated/api'
import { formatMoney } from '#/lib/format'
import type { ReactNode } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'

const STATUS_LABEL: Record<string, string> = {
  booked: 'Booked',
  inProgress: 'In Progress',
  completed: 'Completed',
  invoiced: 'Invoiced',
}
const STATUS_COLOUR: Record<string, string> = {
  booked: 'var(--amber)',
  inProgress: 'var(--red)',
  completed: 'var(--green)',
  invoiced: 'var(--blue)',
}

/** "2026-09" → "Sep" — compact enough for 6 months across a 460px x-axis. */
function shortMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number)
  return new Intl.DateTimeFormat('en-AU', { month: 'short' }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  )
}

const TOOLTIP_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--hairline)',
  borderRadius: 12,
  fontSize: 13,
}

/**
 * The Analytics page's charts — a separate lazy chunk from `analytics.tsx`
 * (see that file's `React.lazy` import), so `recharts` (~150KB gzipped)
 * never loads on Schedule or any other route. This component owns its own
 * data fetch rather than receiving it as a prop specifically so the query
 * and the `recharts` import stay in the same chunk.
 */
export function AnalyticsCharts({ businessId }: { businessId: Id<'businesses'> }) {
  const { data } = useSuspenseQuery(
    convexQuery(api.analytics.overview, { businessId }),
  )
  if (!data) return null

  const revenueByMonth = data.revenueByMonth.map((r) => ({
    ...r,
    label: shortMonthLabel(r.month),
  }))
  const volumeByMonth = data.volumeByMonth.map((r) => ({
    ...r,
    label: shortMonthLabel(r.month),
  }))

  return (
    <div className="flex flex-col gap-4 px-4 pb-8 md:grid md:grid-cols-2">
      <ChartCard title="Revenue">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={revenueByMonth} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke="var(--hairline)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
              axisLine={{ stroke: 'var(--hairline)' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: number) => formatMoney(value).replace(/\.00$/, '')}
              width={56}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value) => formatMoney(Number(value))}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="var(--blue)"
              strokeWidth={2}
              dot={{ r: 3, fill: 'var(--blue)' }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Jobs booked">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={volumeByMonth} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke="var(--hairline)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
              axisLine={{ stroke: 'var(--hairline)' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
              width={32}
            />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Bar dataKey="value" fill="var(--blue)" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Status breakdown">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Pie
              data={data.statusBreakdown}
              dataKey="count"
              nameKey="status"
              innerRadius="55%"
              outerRadius="80%"
              paddingAngle={2}
            >
              {data.statusBreakdown.map((entry) => (
                <Cell
                  key={entry.status}
                  fill={STATUS_COLOUR[entry.status] ?? 'var(--muted)'}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <ul className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1">
          {data.statusBreakdown.map((entry) => (
            <li
              key={entry.status}
              className="flex items-center gap-1.5 text-caption text-muted"
            >
              <span
                className="size-2.5 rounded-full"
                style={{ background: STATUS_COLOUR[entry.status] ?? 'var(--muted)' }}
              />
              {STATUS_LABEL[entry.status] ?? entry.status} ({entry.count})
            </li>
          ))}
        </ul>
      </ChartCard>

      {/* A workload comparison of one person is meaningless — only shown to
          someone who can see the whole team's jobs. */}
      {data.scope === 'business' && data.technicianLoad.length > 0 && (
        <ChartCard title="Technician workload">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data.technicianLoad}
              layout="vertical"
              margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
            >
              <CartesianGrid stroke="var(--hairline)" horizontal={false} />
              <XAxis
                type="number"
                allowDecimals={false}
                tick={{ fill: 'var(--muted)', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fill: 'var(--ink)', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={80}
              />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="count" radius={[0, 6, 6, 0]}>
                {data.technicianLoad.map((entry) => (
                  <Cell key={entry.membershipId} fill={entry.colour} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4 shadow-elevation">
      <p className="section-label mb-2">{title}</p>
      <div className="h-64 md:h-72">{children}</div>
    </div>
  )
}
