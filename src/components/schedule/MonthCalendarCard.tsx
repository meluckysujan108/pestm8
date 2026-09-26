import { Suspense, useDeferredValue } from 'react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import {
  WEEKDAY_INITIALS,
  dayKeyToDate,
  formatMonthLabel,
  addDaysToKey,
} from '#/lib/format'
import { useViewMode } from '#/lib/access'
import { dayDots } from '#/lib/scheduleFilters'
import { MonthDaysPending } from '#/components/shell/Pending'
import type { Id } from '../../../convex/_generated/dataModel'

function shiftMonth(monthKey: string, delta: number) {
  const [year, month] = monthKey.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1 + delta, 1))
  return d.toISOString().slice(0, 7)
}

/** Monday-first grid, matching the week strip and month sheet. */
function gridFor(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number)
  const first = new Date(Date.UTC(year, month - 1, 1))
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const lead = (first.getUTCDay() + 6) % 7

  const cells: Array<string | null> = Array.from({ length: lead }, () => null)
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${monthKey}-${String(d).padStart(2, '0')}`)
  }
  return cells
}

/**
 * Desktop-only (§2.4): a persistent month grid beside the day agenda, instead
 * of the mobile week strip + sheet. Same dots, same colours-are-per-subcontractor
 * model as the mobile month picker — the legend below just names them.
 */
export function MonthCalendarCard({
  businessId,
  monthKey,
  selectedKey,
  todayKey,
  weekStart,
  onSelect,
  onMonthChange,
}: {
  businessId: Id<'businesses'>
  monthKey: string
  selectedKey: string
  todayKey: string
  /** In the Week View: the Monday of the week beside the grid, whose row is
   * shaded so the grid says which week the pane is showing. */
  weekStart?: string
  onSelect: (dayKey: string) => void
  onMonthChange: (monthKey: string) => void
}) {
  // "Just my jobs": the legend would list one person, him, and the dots would
  // all be his colour — so neither is per-person there.
  const mine = useViewMode() === 'mine'

  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4 shadow-elevation">
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => onMonthChange(shiftMonth(monthKey, -1))}
          className="relative tap-target flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
        >
          <ChevronLeft size={20} strokeWidth={2} />
        </button>
        <span className="text-sheet-title text-ink">
          {formatMonthLabel(`${monthKey}-01`)}
        </span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => onMonthChange(shiftMonth(monthKey, 1))}
          className="relative tap-target flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
        >
          <ChevronRight size={20} strokeWidth={2} />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1">
        {WEEKDAY_INITIALS.map((initial, i) => (
          <span
            key={i}
            aria-hidden
            className="pb-1 text-center text-[11px] font-semibold text-muted"
          >
            {initial}
          </span>
        ))}
      </div>

      {/* The card's frame, month and weekdays need nothing but the month, so
          they stay put — with the button just pressed — while the days and
          the legend load, each behind its own boundary so the two queries go
          out together rather than one after the other. */}
      <Suspense fallback={<MonthDaysPending cells={gridFor(monthKey)} />}>
        <MonthDays
          businessId={businessId}
          monthKey={monthKey}
          selectedKey={selectedKey}
          todayKey={todayKey}
          weekStart={weekStart}
          onSelect={onSelect}
          mine={mine}
        />
      </Suspense>

      <div className="mt-3 flex justify-center">
        <button
          type="button"
          onClick={() => {
            onMonthChange(todayKey.slice(0, 7))
            onSelect(todayKey)
          }}
          className="relative tap-target text-body font-semibold text-blue"
        >
          Today
        </button>
      </div>

      {!mine && (
        <Suspense fallback={null}>
          <TeamThisMonth businessId={businessId} monthKey={monthKey} />
        </Suspense>
      )}
    </div>
  )
}

function MonthDays({
  businessId,
  monthKey,
  selectedKey,
  todayKey,
  weekStart,
  onSelect,
  mine,
}: {
  businessId: Id<'businesses'>
  monthKey: string
  selectedKey: string
  todayKey: string
  weekStart?: string
  onSelect: (dayKey: string) => void
  mine: boolean
}) {
  const weekEnd = weekStart ? addDaysToKey(weekStart, 6) : undefined
  const { data: days } = useSuspenseQuery(
    convexQuery(api.jobs.listMonth, { businessId, monthKey }),
  )
  const byDay = new Map(days.map((d) => [d.dayKey, d]))

  return (
    <div className="mt-1 grid grid-cols-7 gap-1">
      {gridFor(monthKey).map((dayKey, i) => {
        if (!dayKey) return <span key={`pad-${i}`} />

        const day = byDay.get(dayKey)
        const isSelected = dayKey === selectedKey
        const isToday = dayKey === todayKey

        return (
          <button
            key={dayKey}
            type="button"
            aria-label={dayKey}
            aria-pressed={isSelected}
            onClick={() => onSelect(dayKey)}
            className={`flex flex-col items-center gap-0.5 rounded-xl py-1.5 transition hover:bg-surface-2 active:scale-[.95] ${
              // An outline, not a fill: a grey fill under the dots took the
              // lighter technician colours below 3:1 against it.
              weekStart && weekEnd && dayKey >= weekStart && dayKey <= weekEnd
                ? 'ring-1 ring-inset ring-muted'
                : ''
            }`}
          >
            <span
              className={[
                'flex size-9 items-center justify-center rounded-full text-[16px] font-semibold tabular-nums transition',
                isSelected
                  ? 'bg-red-fill text-white'
                  : isToday
                    ? 'text-red'
                    : 'text-ink',
              ].join(' ')}
            >
              {dayKeyToDate(dayKey).getUTCDate()}
            </span>

            <span className="flex h-1.5 items-center gap-0.5">
              {dayDots(day?.colours ?? [], mine)
                .slice(0, 3)
                .map((colour) => (
                  <span
                    key={colour}
                    aria-hidden
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: colour }}
                  />
                ))}
            </span>

            <span className="flex h-3.5 items-center text-[11px] font-semibold tabular-nums text-muted">
              {day && day.count > 0 ? day.count : ''}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function TeamThisMonth({
  businessId,
  monthKey,
}: {
  businessId: Id<'businesses'>
  monthKey: string
}) {
  // Paging a month keeps the last month's legend up until the next month's
  // arrives, instead of dropping it and closing the card's bottom edge.
  const shownMonth = useDeferredValue(monthKey)
  const { data: team } = useSuspenseQuery(
    convexQuery(api.jobs.monthTeamLoad, { businessId, monthKey: shownMonth }),
  )
  if (team.length === 0) return null
  // Last month's names under this month's title until the new ones land, so
  // they say so meanwhile.
  const stale = shownMonth !== monthKey

  return (
    <div
      aria-busy={stale || undefined}
      className={`mt-4 border-t border-hairline pt-3.5 transition-opacity delay-150 motion-reduce:duration-0 ${stale ? 'opacity-60' : 'delay-0'}`}
    >
      <h2 className="section-label mb-2.5">Team this month</h2>
      <ul className="flex flex-col gap-2">
        {team.map((member) => (
          <li
            key={member.membershipId}
            className="flex items-center justify-between gap-2 text-body"
          >
            <span className="flex min-w-0 items-center gap-2 text-ink-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: member.colour }}
              />
              <span className="truncate">{member.name}</span>
            </span>
            <span className="shrink-0 text-caption tabular-nums text-muted">
              {member.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
