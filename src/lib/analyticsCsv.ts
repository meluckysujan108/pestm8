import type { AnalyticsBreakdown } from '#/components/analytics/AnalyticsBreakdowns'
import type { AnalyticsReport } from '#/components/analytics/AnalyticsOverview'

/**
 * The Analytics page as a spreadsheet: one file, one row a figure, in the
 * order the page shows them. Four columns whatever the row, so it opens as a
 * table and filters by its first column.
 *
 * Money is dollars with two decimals and no symbol, so a spreadsheet reads
 * it as a number. A figure the viewer may not see is an empty cell, as the
 * page shows "—": never a zero.
 */

const HEADER = ['Section', 'Name', 'Jobs completed', 'Revenue']

/**
 * One cell. Quoted when it holds a comma, a quote or a line break, and a
 * name that starts like a formula is given a leading apostrophe: a client
 * called "=HYPERLINK(…)" must open as text, not run.
 */
function cell(value: string | number | null): string {
  if (value === null) return ''
  if (typeof value === 'number') return String(value)
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

const dollars = (cents: number | null) =>
  cents === null ? null : (cents / 100).toFixed(2)

/** The file's name: what it is and the days it covers. */
export function analyticsCsvName(report: AnalyticsReport): string {
  return `analytics-${report.range.from}-to-${report.range.to}.csv`
}

export function analyticsCsv(
  report: AnalyticsReport,
  breakdown: AnalyticsBreakdown | undefined,
): string {
  const rows: Array<Array<string | number | null>> = [HEADER]
  const add = (
    section: string,
    name: string,
    completed: number | null,
    revenue: number | null,
  ) => rows.push([section, name, completed, dollars(revenue)])

  const { totals, before, bookedAhead, uninvoiced } = report
  const days = `${report.range.from} to ${report.range.to}`
  add('Summary', `This range (${days})`, totals.completed, totals.revenue)
  if (before && report.comparison)
    add(
      'Summary',
      `Compared with (${report.comparison.from} to ${report.comparison.to})`,
      before.completed,
      before.revenue,
    )
  add('Summary', 'Average job', null, totals.averageJob)
  add('Summary', 'Booked (not cancelled)', totals.booked, null)
  add('Summary', 'Cancelled', totals.cancelled, null)
  add(
    'Summary',
    `Booked ahead (next ${bookedAhead.days} days)`,
    bookedAhead.count,
    bookedAhead.value,
  )
  add('Summary', 'Awaiting invoice', uninvoiced.count, uninvoiced.value)

  for (const point of report.series)
    add('Over time', point.start, point.completed, point.revenue)

  if (breakdown) {
    for (const row of breakdown.services)
      add('Services', row.name, row.completed, row.revenue)
    for (const row of breakdown.team)
      add('Technicians', row.name, row.completed, row.revenue)
    for (const row of breakdown.clients.top)
      add('Clients', row.name, row.completed, row.revenue)
    for (const row of breakdown.areas)
      add('Suburbs', row.suburb, row.completed, row.revenue)
    add(
      'Recurring',
      'Visits finished in this range',
      breakdown.recurring.completed,
      breakdown.recurring.revenue,
    )
    add(
      'Recurring',
      `A year, from ${breakdown.recurring.services} running services`,
      null,
      breakdown.recurring.yearlyValue,
    )
  }

  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
