import { WEEKDAY_INITIALS, addDaysToKey, dayKeyToDate } from '#/lib/format'

export type DayLoad = { offset: number; count: number; colours: Array<string> }

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
}: {
  startKey: string
  selectedKey: string
  todayKey: string
  load: Array<DayLoad>
  onSelect: (dayKey: string) => void
}) {
  return (
    <div className="flex gap-1 px-2 pb-2">
      {WEEKDAY_INITIALS.map((initial, i) => {
        const dayKey = addDaysToKey(startKey, i)
        const isSelected = dayKey === selectedKey
        const isToday = dayKey === todayKey
        const day = load.find((d) => d.offset === i)

        return (
          <button
            key={dayKey}
            type="button"
            onClick={() => onSelect(dayKey)}
            aria-pressed={isSelected}
            aria-label={dayKey}
            className="flex flex-1 flex-col items-center gap-1 rounded-xl py-1.5 transition active:scale-[.975]"
          >
            <span className="text-[11px] font-semibold text-muted">
              {initial}
            </span>
            <span
              className={[
                'flex size-9 items-center justify-center rounded-full text-[17px] font-semibold tabular-nums transition',
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
              {(day?.colours ?? []).slice(0, 4).map((colour) => (
                <span
                  key={colour}
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: colour }}
                />
              ))}
            </span>
            {/* Below the assignee dots so the two never compete: whose day it
                is, then how loaded it is. */}
            <span className="flex h-3.5 items-center text-[11px] font-semibold tabular-nums text-muted">
              {day && day.count > 0 ? day.count : ''}
            </span>
          </button>
        )
      })}
    </div>
  )
}
