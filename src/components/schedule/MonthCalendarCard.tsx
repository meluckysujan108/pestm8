import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { WeatherGlyph } from './WeatherGlyph'
import { useDayWeather } from '#/lib/useDayWeather'
import { WEEKDAY_INITIALS, dayKeyToDate, formatMonthLabel } from '#/lib/format'
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
  state,
  monthKey,
  selectedKey,
  todayKey,
  onSelect,
  onMonthChange,
}: {
  businessId: Id<'businesses'>
  state: string
  monthKey: string
  selectedKey: string
  todayKey: string
  onSelect: (dayKey: string) => void
  onMonthChange: (monthKey: string) => void
}) {
  const { data: days } = useSuspenseQuery(
    convexQuery(api.jobs.listMonth, { businessId, monthKey }),
  )
  const { data: team } = useSuspenseQuery(
    convexQuery(api.jobs.monthTeamLoad, { businessId, monthKey }),
  )

  const byDay = new Map(days.map((d) => [d.dayKey, d]))

  const weather = useDayWeather(
    businessId,
    state,
    days
      .filter((d) => d.suburb)
      .map((d) => ({
        dayKey: d.dayKey,
        suburb: d.suburb,
        postcode: d.postcode,
      })),
  )

  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4 shadow-elevation">
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => onMonthChange(shiftMonth(monthKey, -1))}
          className="flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
        >
          <ChevronLeft size={20} strokeWidth={1.7} />
        </button>
        <span className="text-sheet-title text-ink">
          {formatMonthLabel(`${monthKey}-01`)}
        </span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => onMonthChange(shiftMonth(monthKey, 1))}
          className="flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
        >
          <ChevronRight size={20} strokeWidth={1.7} />
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
              className="flex flex-col items-center gap-0.5 rounded-xl py-1.5 transition hover:bg-surface-2 active:scale-[.95]"
            >
              <span
                className={[
                  'flex size-9 items-center justify-center rounded-full text-[16px] font-semibold tabular-nums transition',
                  isSelected
                    ? 'bg-red text-white'
                    : isToday
                      ? 'text-red'
                      : 'text-ink',
                ].join(' ')}
              >
                {dayKeyToDate(dayKey).getUTCDate()}
              </span>

              <span className="flex h-1.5 items-center gap-0.5">
                {(day?.colours ?? []).slice(0, 3).map((colour) => (
                  <span
                    key={colour}
                    aria-hidden
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: colour }}
                  />
                ))}
              </span>

              <span className="flex h-3.5 items-center">
                <WeatherGlyph weather={weather[dayKey]} size={11} />
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-3 flex justify-center">
        <button
          type="button"
          onClick={() => {
            onMonthChange(todayKey.slice(0, 7))
            onSelect(todayKey)
          }}
          className="text-body font-semibold text-blue"
        >
          Today
        </button>
      </div>

      {team.length > 0 && (
        <div className="mt-4 border-t border-hairline pt-3.5">
          <p className="section-label mb-2.5">Team this month</p>
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
      )}
    </div>
  )
}
