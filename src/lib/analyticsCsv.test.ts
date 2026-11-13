import { describe, expect, test } from 'vitest'
import { analyticsCsv, analyticsCsvName } from './analyticsCsv'
import type { AnalyticsBreakdown } from '#/components/analytics/AnalyticsBreakdowns'
import type { AnalyticsReport } from '#/components/analytics/AnalyticsOverview'

const REPORT = {
  range: { from: '2026-11-01', to: '2026-11-02' },
  comparison: { from: '2026-10-30', to: '2026-10-31' },
  totals: {
    revenue: 50000,
    completed: 2,
    booked: 3,
    cancelled: 1,
    averageJob: 25000,
  },
  before: {
    revenue: 12050,
    completed: 1,
    booked: 1,
    cancelled: 0,
    averageJob: 12100,
  },
  series: [
    { start: '2026-11-01', revenue: 20000, completed: 1 },
    { start: '2026-11-02', revenue: 30000, completed: 1 },
  ],
  bookedAhead: { days: 28, count: 4, value: 80000 },
  uninvoiced: { count: 1, value: 20000 },
} as unknown as AnalyticsReport

const BREAKDOWN = {
  services: [{ name: 'Rodents, mice', completed: 1, revenue: 30000 }],
  team: [{ name: 'Terence', completed: 2, revenue: 50000 }],
  clients: {
    top: [
      { name: '=HYPERLINK("http://x")', completed: 1, revenue: 30000 },
      { name: 'M. "Mick" O’Brien', completed: 1, revenue: 20000 },
    ],
  },
  areas: [{ suburb: 'Bayswater', completed: 2, revenue: 50000 }],
  recurring: { services: 3, completed: 1, revenue: 20000, yearlyValue: 240000 },
} as unknown as AnalyticsBreakdown

describe('the Analytics spreadsheet', () => {
  const lines = analyticsCsv(REPORT, BREAKDOWN).trimEnd().split('\r\n')

  test('is four columns, in the page’s order, money as dollars', () => {
    expect(lines[0]).toBe('Section,Name,Jobs completed,Revenue')
    expect(lines[1]).toBe(
      'Summary,This range (2026-11-01 to 2026-11-02),2,500.00',
    )
    expect(lines[2]).toBe(
      'Summary,Compared with (2026-10-30 to 2026-10-31),1,120.50',
    )
    expect(lines).toContain('Over time,2026-11-02,1,300.00')
    expect(lines).toContain('Technicians,Terence,2,500.00')
    expect(lines).toContain('Suburbs,Bayswater,2,500.00')
    expect(lines.every((line) => line.split(',').length >= 4)).toBe(true)
  })

  test('quotes what holds a comma or a quote, and defuses a formula', () => {
    expect(lines).toContain('Services,"Rodents, mice",1,300.00')
    expect(lines).toContain('Clients,"M. ""Mick"" O’Brien",1,200.00')
    expect(lines).toContain(`Clients,"'=HYPERLINK(""http://x"")",1,300.00`)
  })

  test('a withheld figure is an empty cell, never a zero', () => {
    const hidden = {
      ...REPORT,
      comparison: null,
      before: null,
      totals: { ...REPORT.totals, revenue: null, averageJob: null },
      uninvoiced: { count: null, value: null },
    } as unknown as AnalyticsReport
    const out = analyticsCsv(hidden, undefined).split('\r\n')
    expect(out[1]).toBe('Summary,This range (2026-11-01 to 2026-11-02),2,')
    expect(out).toContain('Summary,To bill,,')
    expect(out.some((line) => line.startsWith('Services'))).toBe(false)
  })

  test('is named for the days it covers', () => {
    expect(analyticsCsvName(REPORT)).toBe(
      'analytics-2026-11-01-to-2026-11-02.csv',
    )
  })
})
