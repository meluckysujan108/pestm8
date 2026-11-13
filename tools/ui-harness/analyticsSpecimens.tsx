import { useState } from 'react'
import { AnalyticsBreakdowns } from '#/components/analytics/AnalyticsBreakdowns'
import { AnalyticsOverview } from '#/components/analytics/AnalyticsOverview'
import { ExportButton } from '#/components/analytics/ExportButton'
import { PaidCard } from '#/components/analytics/PaidCard'
import { PaperworkCard } from '#/components/analytics/PaperworkCard'
import type { AnalyticsPayments } from '#/components/analytics/PaidCard'
import type { AnalyticsPaperwork } from '#/components/analytics/PaperworkCard'
import type { AnalyticsBreakdown } from '#/components/analytics/AnalyticsBreakdowns'
import { resolveRange } from '#/lib/analyticsView'
import type { ReactNode } from 'react'
import type { AnalyticsReport } from '#/components/analytics/AnalyticsOverview'
import type { AnalyticsSearch } from '#/lib/analyticsView'
import type { Compare } from '../../convex/lib/analyticsRange'

/**
 * The Analytics overview, from sample figures: it is given what it shows
 * (`AnalyticsOverview`), so there is no query to answer here. Its To bill
 * card opens Payments, whose specimens are in `specimens.tsx`.
 */

const TODAY = '2026-11-11'

function Phone({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto min-h-screen w-full max-w-[460px] bg-canvas">
      {/* PageHeader needs the sidebar provider; this is its markup. */}
      <header className="chrome-blur sticky top-0 z-30 border-b border-hairline px-4 pt-3 pb-3">
        <p className="section-label mb-0.5 truncate">Swan River Pest Co</p>
        <h1 className="truncate text-page-title text-ink">{title}</h1>
      </header>
      {children}
    </div>
  )
}

/** Thirty days of sample revenue: a rising week-shaped wave, in cents. */
const DAYS = Array.from({ length: 30 }, (_, i) => {
  const day = new Date(Date.UTC(2026, 9, 13 + i))
  const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6
  const completed = weekend ? (i % 3 === 0 ? 1 : 0) : 4 + ((i * 7) % 4)
  const beforeCompleted = weekend ? 0 : 3 + ((i * 5) % 4)
  return {
    start: day.toISOString().slice(0, 10),
    completed,
    revenue: completed * (24000 + ((i * 37) % 9) * 1000),
    beforeCompleted,
    beforeRevenue: beforeCompleted * (25500 + ((i * 13) % 7) * 1000),
  }
})

const sum = (pick: (d: (typeof DAYS)[number]) => number) =>
  DAYS.reduce((total, d) => total + pick(d), 0)

const REPORT: AnalyticsReport = {
  scope: 'business',
  pricesHidden: false,
  range: { from: '2026-10-13', to: TODAY },
  comparison: { from: '2026-09-13', to: '2026-10-12' },
  grain: 'day',
  totals: {
    revenue: sum((d) => d.revenue),
    completed: sum((d) => d.completed),
    booked: sum((d) => d.completed) + 9,
    cancelled: 4,
    averageJob: Math.round(sum((d) => d.revenue) / sum((d) => d.completed)),
  },
  before: {
    revenue: sum((d) => d.beforeRevenue),
    completed: sum((d) => d.beforeCompleted),
    booked: sum((d) => d.beforeCompleted) + 6,
    cancelled: 6,
    averageJob: Math.round(
      sum((d) => d.beforeRevenue) / sum((d) => d.beforeCompleted),
    ),
  },
  series: DAYS,
  bookedAhead: { days: 28, count: 74, value: 2190000 },
  uninvoiced: {
    count: 17,
    value: 428000,
    oldCount: 6,
    oldValue: 163500,
    oldAfterDays: 14,
    more: false,
  },
  services: [
    { name: 'General Pest Control', count: 58 },
    { name: 'Termite Inspection', count: 31 },
    { name: 'Rodents', count: 22 },
    { name: 'Termite Treatment', count: 9 },
  ],
  people: [
    { membershipId: 'm_1', name: 'Terence', colour: '#0a84ff', count: 61 },
    { membershipId: 'm_2', name: 'Jas', colour: '#34c759', count: 48 },
    { membershipId: 'm_3', name: 'Miko', colour: '#af52de', count: 33 },
  ] as never,
}

/** As someone who may not see prices gets it: every count, no money. */
const NO_PRICES: AnalyticsReport = {
  ...REPORT,
  scope: 'assignee',
  pricesHidden: true,
  totals: { ...REPORT.totals, revenue: null, averageJob: null },
  before: REPORT.before && {
    ...REPORT.before,
    revenue: null,
    averageJob: null,
  },
  series: DAYS.map((d) => ({ ...d, revenue: null, beforeRevenue: null })),
  bookedAhead: { days: 28, count: 21, value: null },
  uninvoiced: {
    ...REPORT.uninvoiced,
    count: null,
    value: null,
    oldCount: null,
    oldValue: null,
  },
  people: [],
}

/** A business with nothing finished in the range. */
const QUIET: AnalyticsReport = {
  ...REPORT,
  totals: { revenue: 0, completed: 0, booked: 2, cancelled: 0, averageJob: 0 },
  before: {
    revenue: 0,
    completed: 0,
    booked: 0,
    cancelled: 0,
    averageJob: 0,
  },
  series: DAYS.map((d) => ({
    start: d.start,
    completed: 0,
    revenue: 0,
    beforeCompleted: 0,
    beforeRevenue: 0,
  })),
  bookedAhead: { days: 28, count: 2, value: 52000 },
  uninvoiced: {
    ...REPORT.uninvoiced,
    count: 0,
    value: 0,
    oldCount: 0,
    oldValue: 0,
  },
  services: [{ name: 'General Pest Control', count: 2 }],
  people: [],
}

const BREAKDOWN: AnalyticsBreakdown = {
  scope: 'business',
  pricesHidden: false,
  partial: false,
  completed: REPORT.totals.completed,
  revenue: REPORT.totals.revenue,
  services: [
    { name: 'General Pest Control', completed: 58, revenue: 1420000 },
    { name: 'Termite Inspection', completed: 31, revenue: 980000 },
    { name: 'Rodents', completed: 22, revenue: 615000 },
    { name: 'Termite Treatment', completed: 9, revenue: 540000 },
    { name: 'Bird Proofing', completed: 4, revenue: 210000 },
    { name: 'Possum Removal', completed: 3, revenue: 96000 },
  ],
  team: [
    {
      membershipId: 'm_1',
      name: 'Terence',
      colour: '#0a84ff',
      completed: 61,
      revenue: 1730000,
    },
    {
      membershipId: 'm_2',
      name: 'Jas',
      colour: '#34c759',
      completed: 48,
      revenue: 1264000,
    },
    {
      membershipId: 'm_3',
      name: 'Miko',
      colour: '#af52de',
      completed: 14,
      revenue: 396000,
    },
  ] as never,
  clients: {
    served: 96,
    new: 18,
    newJobs: 21,
    person: { completed: 88, revenue: 2110000 },
    business: { completed: 35, revenue: 1280000 },
    top: [
      {
        clientId: 'c_1',
        name: 'Ray White Bayswater',
        completed: 9,
        revenue: 342000,
      },
      { clientId: 'c_2', name: 'Harbour Café', completed: 4, revenue: 168000 },
      { clientId: 'c_3', name: 'S. Patel', completed: 1, revenue: 96000 },
      {
        clientId: 'c_4',
        name: 'Swan Strata Management',
        completed: 3,
        revenue: 87000,
      },
    ] as never,
  },
  areas: [
    { suburb: 'Joondalup', completed: 21, revenue: 588000 },
    { suburb: 'Bayswater', completed: 17, revenue: 512000 },
    { suburb: 'Fremantle', completed: 14, revenue: 431000 },
    { suburb: 'Morley', completed: 12, revenue: 302000 },
    { suburb: 'Subiaco', completed: 9, revenue: 296000 },
    { suburb: 'Scarborough', completed: 8, revenue: 204000 },
    { suburb: 'Midland', completed: 6, revenue: 151000 },
  ],
  recurring: {
    services: 64,
    more: false,
    yearlyValue: 8640000,
    completed: 47,
    revenue: 1128000,
  },
  emails: { sent: 118, failed: 1, bounced: 2 },
  emailsCapped: 500,
}

/** The same, as someone who may not see prices gets it. */
const BREAKDOWN_NO_PRICES: AnalyticsBreakdown = {
  ...BREAKDOWN,
  scope: 'assignee',
  pricesHidden: true,
  revenue: null,
  services: BREAKDOWN.services.map((row) => ({ ...row, revenue: null })),
  team: [],
  clients: {
    ...BREAKDOWN.clients,
    person: { completed: 88, revenue: null },
    business: { completed: 35, revenue: null },
    top: BREAKDOWN.clients.top.map((row) => ({ ...row, revenue: null })),
  },
  areas: BREAKDOWN.areas.map((row) => ({ ...row, revenue: null })),
  recurring: { ...BREAKDOWN.recurring, yearlyValue: null, revenue: null },
  emails: null,
}

const PAID: AnalyticsPayments = {
  pricesHidden: false,
  count: 109,
  value: 3142000,
  methods: [
    { method: 'card', count: 61, value: 1687000 },
    { method: 'bankTransfer', count: 29, value: 1104000 },
    { method: 'cash', count: 17, value: 306000 },
    { method: 'cheque', count: 2, value: 45000 },
  ],
  more: false,
}

const PAPERWORK: AnalyticsPaperwork = {
  checked: 96,
  missing: 7,
  more: false,
  jobs: [
    ['K. Thompson', 'Scarborough', 'General Pest Control', '2026-11-10', 371],
    ['S. Patel', 'Subiaco', 'Termite Treatment', '2026-11-03', 355],
    ['M. O’Brien', 'Joondalup', 'General Pest Control', '2026-10-27', 340],
    [
      'Harbour Café',
      'Fremantle',
      'Rodents, General Pest Control',
      '2026-10-19',
      322,
    ],
    ['J. Nguyen', 'Morley', 'Termite Inspection', '2026-10-16', 318],
    [
      'Ray White Bayswater',
      'Bayswater',
      'Termite Inspection',
      '2026-10-14',
      309,
    ],
    ['L. Rossi', 'Midland', 'General Pest Control', '2026-10-13', 305],
  ].map(([client, suburb, jobType, dayKey, jobNumber], i) => ({
    jobId: `late_${i}` as never,
    jobNumber: jobNumber as number,
    client: client as string,
    suburb: suburb as string,
    jobType: jobType as string,
    dayKey: dayKey as string,
  })),
}

function overview(
  report: AnalyticsReport | undefined,
  opts: {
    failed?: boolean
    note?: ReactNode
    breakdown?: AnalyticsBreakdown
  } = {},
) {
  return function Overview() {
    const [search, setSearch] = useState<AnalyticsSearch>({})
    const compare: Compare = search.compare ?? 'previous'
    return (
      <Phone title="Analytics">
        <AnalyticsOverview
          businessSlug="swan-river"
          today={TODAY}
          range={resolveRange(search, TODAY)}
          compare={compare}
          search={search}
          report={
            report && compare === 'none'
              ? { ...report, comparison: null, before: null }
              : report
          }
          failed={opts.failed}
          onRetry={() => {}}
          onSearch={(next) => setSearch((prev) => ({ ...prev, ...next }))}
        >
          {(report || opts.breakdown) && (
            <AnalyticsBreakdowns
              data={opts.breakdown}
              report={report}
              search={search}
              onSearch={(next) => setSearch((prev) => ({ ...prev, ...next }))}
            />
          )}
          {opts.breakdown && (
            <>
              <PaidCard businessSlug="swan-river" data={PAID} />
              <PaperworkCard
                businessSlug="swan-river"
                today={TODAY}
                data={PAPERWORK}
              />
              <ExportButton
                report={report}
                breakdown={opts.breakdown}
                paid={PAID}
              />
            </>
          )}
          {opts.note}
        </AnalyticsOverview>
      </Phone>
    )
  }
}

export const ANALYTICS_SPECIMENS = {
  analytics: overview(REPORT, { breakdown: BREAKDOWN }),
  'analytics-no-prices': overview(NO_PRICES, {
    breakdown: BREAKDOWN_NO_PRICES,
    note: (
      <p className="text-caption text-muted">
        These figures cover your own jobs.
      </p>
    ),
  }),
  'analytics-quiet': overview(QUIET),
  'analytics-loading': overview(undefined),
  'analytics-failed': overview(undefined, { failed: true }),
}
