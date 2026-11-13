import { addDaysToKey } from './format'
import { isValidRange } from '../../convex/lib/analyticsRange'
import type { Compare, DayRange } from '../../convex/lib/analyticsRange'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * What the Analytics page is looking at, as its address says it: which days,
 * compared with what, and narrowed to whom and which service. Each is left
 * out of the address at its default (design-system.md, Filters and views),
 * so a plain `/analytics` is the last 30 days against the 30 before.
 */

export const RANGE_PRESETS = [
  '7d',
  '30d',
  'month',
  'lastMonth',
  '90d',
  'fy',
  '12m',
] as const

export type RangePreset = (typeof RANGE_PRESETS)[number]

export const DEFAULT_PRESET: RangePreset = '30d'

export const RANGE_LABEL: Record<RangePreset, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  month: 'This month',
  lastMonth: 'Last month',
  '90d': 'Last 90 days',
  fy: 'This financial year',
  '12m': 'Last 12 months',
}

export const COMPARE_OPTIONS: Array<{ value: Compare; label: string }> = [
  { value: 'previous', label: 'Days before' },
  { value: 'year', label: 'Year before' },
  { value: 'none', label: 'Nothing' },
]

export type AnalyticsSearch = {
  range?: RangePreset
  from?: string
  to?: string
  compare?: Exclude<Compare, 'previous'>
  staff?: string
  service?: string
}

export function parseRangePreset(raw: unknown): RangePreset | undefined {
  return RANGE_PRESETS.find((preset) => preset === raw)
}

/** The days a preset covers, ending today (or, for last month, before it). */
export function presetRange(preset: RangePreset, today: string): DayRange {
  const [year, month] = today.split('-').map(Number)
  const first = (y: number, m: number) =>
    `${y}-${String(m).padStart(2, '0')}-01`
  switch (preset) {
    case '7d':
      return { from: addDaysToKey(today, -6), to: today }
    case '30d':
      return { from: addDaysToKey(today, -29), to: today }
    case '90d':
      return { from: addDaysToKey(today, -89), to: today }
    case '12m':
      return { from: addDaysToKey(today, -364), to: today }
    case 'month':
      return { from: first(year, month), to: today }
    case 'lastMonth': {
      const from = month === 1 ? first(year - 1, 12) : first(year, month - 1)
      return { from, to: addDaysToKey(first(year, month), -1) }
    }
    // The Australian financial year: 1 July to 30 June.
    case 'fy':
      return { from: first(month >= 7 ? year : year - 1, 7), to: today }
  }
}

export type ResolvedRange = DayRange & { preset: RangePreset | 'custom' }

/**
 * The range the address asks for. Dates of its own (`from` and `to`) win
 * over a preset; dates that are no range fall back to the default, as an
 * address typed wrong should.
 */
export function resolveRange(
  search: Pick<AnalyticsSearch, 'range' | 'from' | 'to'>,
  today: string,
): ResolvedRange {
  if (search.from !== undefined && search.to !== undefined) {
    const custom = { from: search.from, to: search.to }
    if (isValidRange(custom)) return { ...custom, preset: 'custom' }
  }
  const preset = search.range ?? DEFAULT_PRESET
  return { ...presetRange(preset, today), preset }
}

/** A range, as the address carries it: nothing at all for the default. */
export function rangeSearch(
  choice: RangePreset | DayRange,
): Pick<AnalyticsSearch, 'range' | 'from' | 'to'> {
  if (typeof choice === 'string')
    return {
      range: choice === DEFAULT_PRESET ? undefined : choice,
      from: undefined,
      to: undefined,
    }
  return { range: undefined, from: choice.from, to: choice.to }
}

export type Change = {
  /** Whole per cent, signed. */
  percent: number
  direction: 'up' | 'down' | 'same'
}

/**
 * How a figure moved against the one before it. Nothing to say when either
 * is withheld, there is no comparison, or the earlier figure was zero: from
 * nothing, any amount is not a percentage.
 */
export function changeOf(
  now: number | null,
  before: number | null | undefined,
): Change | null {
  if (now === null || before === null || before === undefined) return null
  if (before === 0) return null
  const percent = Math.round(((now - before) / before) * 100)
  return {
    percent,
    direction: percent > 0 ? 'up' : percent < 0 ? 'down' : 'same',
  }
}

/** "Up 12%", "Down 3%", "No change" — a change said aloud. */
export function changeWords(change: Change): string {
  if (change.direction === 'same') return 'No change'
  return `${change.direction === 'up' ? 'Up' : 'Down'} ${Math.abs(change.percent)}%`
}

/**
 * What `analytics.report` is asked, from the address: read by the route's
 * loader and by the page, which must agree to the byte or the page asks a
 * second question the loader never warmed.
 */
export function analyticsArgs(
  businessId: Id<'businesses'>,
  search: AnalyticsSearch,
  today: string,
) {
  const { from, to } = resolveRange(search, today)
  return {
    businessId,
    from,
    to,
    today,
    compare: search.compare ?? ('previous' as const),
    ...(search.staff ? { staff: search.staff as Id<'memberships'> } : {}),
    ...(search.service ? { service: search.service } : {}),
  }
}

/** What `analytics.breakdowns` is asked, the same way. */
export function breakdownArgs(
  businessId: Id<'businesses'>,
  search: AnalyticsSearch,
  today: string,
) {
  const { from, to } = resolveRange(search, today)
  return {
    businessId,
    from,
    to,
    ...(search.staff ? { staff: search.staff as Id<'memberships'> } : {}),
    ...(search.service ? { service: search.service } : {}),
  }
}

/** The address's search, read where there is no validated copy of it yet
 * (a loader): each key through the same rules as the route's own. */
export function analyticsSearchOf(
  read: (key: string) => string | undefined,
): AnalyticsSearch {
  const compare = read('compare')
  return {
    range: parseRangePreset(read('range')),
    from: read('from'),
    to: read('to'),
    compare: compare === 'year' || compare === 'none' ? compare : undefined,
    staff: read('staff') || undefined,
    service: read('service') || undefined,
  }
}
