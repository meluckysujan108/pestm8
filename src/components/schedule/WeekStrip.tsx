import { Repeat } from 'lucide-react'
import { WEEKDAY_INITIALS, addDaysToKey, dayKeyToDate } from '#/lib/format'
import { dayDots } from '#/lib/scheduleFilters'
import { dayPhase, describeDayLoad } from '#/lib/weekView'

/**
 * A day of the week strip (`jobs.listWeek`). `count` is booked work and
 * `recurringCount` that day's projected visits — two numbers, drawn apart and
 * never added (Phase 4.4). Optional so a backend without it draws none.
 */
export type DayLoad = {
  offset: number
  count: number
  recurringCount?: number
  colours: Array<string>
}

/**
 * The week strip (§2.3). Dots are colour-coded per subcontractor so the Owner
 * can see whose day is loaded at a glance, rather than opening each day.
 */
export function WeekStrip({
  startKey,
  selectedKey,
  todayKey,
  load,
  onSelect,
  monochrome = false,
}: {
  startKey: string
  selectedKey: string
  todayKey: string
  load: Array<DayLoad>
  onSelect: (dayKey: string) => void
  /** One neutral dot per busy day rather than one per person (`dayDots`). */
  monochrome?: boolean
}) {
  return (
    <div className="flex gap-1 px-2 pb-2">
      {WEEKDAY_INITIALS.map((initial, i) => {
        const dayKey = addDaysToKey(startKey, i)
        const isSelected = dayKey === selectedKey
        const isToday = dayKey === todayKey
        const day = load.find((d) => d.offset === i)
        const loaded =
          day !== undefined && (day.count > 0 || !!day.recurringCount)

        return (
          <button
            key={dayKey}
            type="button"
            onClick={() => onSelect(dayKey)}
            aria-pressed={isSelected}
            aria-label={dayKey}
            // The label stays the date (tests and the month grid use it);
            // what the day holds is its description.
            aria-describedby={loaded ? `strip-load-${dayKey}` : undefined}
            className="flex flex-1 flex-col items-center gap-1 rounded-xl py-1.5 transition active:scale-[.975]"
          >
            <span className="text-[11px] font-semibold text-muted">
              {initial}
            </span>
            <span
              className={[
                'flex size-9 items-center justify-center rounded-full text-[17px] font-semibold tabular-nums transition',
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
              {dayDots(day?.colours ?? [], monochrome)
                .slice(0, 4)
                .map((colour) => (
                  <span
                    key={colour}
                    aria-hidden
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: colour }}
                  />
                ))}
            </span>
            {/* Below the assignee dots so the two never compete: whose day it
                is, then how loaded it is — booked work, then, apart, the
                projected visits. Neutral on purpose: blue is Invoiced and
                red or orange could be a technician, and a dashed edge says
                "not confirmed". */}
            <span
              aria-hidden
              className="flex h-3.5 items-center gap-1 text-[11px] font-semibold tabular-nums text-ink-2"
            >
              <span data-testid="strip-jobs">
                {day && day.count > 0 ? day.count : ''}
              </span>
              {day?.recurringCount ? (
                <span
                  data-testid="strip-recurring"
                  className="inline-flex items-center gap-px rounded-[4px] border border-dashed border-muted px-0.5 leading-3"
                >
                  <Repeat size={8} strokeWidth={2.4} />
                  {day.recurringCount}
                </span>
              ) : null}
            </span>
            {day && loaded ? (
              <span id={`strip-load-${dayKey}`} className="sr-only">
                {describeDayLoad(day, dayPhase(dayKey, todayKey))}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
