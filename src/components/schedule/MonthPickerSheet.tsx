import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Drawer } from 'vaul'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { WEEKDAY_INITIALS, dayKeyToDate, formatMonthLabel } from '#/lib/format'
import type { Id } from '../../../convex/_generated/dataModel'

function monthKeyOf(dayKey: string) {
  return dayKey.slice(0, 7)
}

function shiftMonth(monthKey: string, delta: number) {
  const [year, month] = monthKey.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1 + delta, 1))
  return d.toISOString().slice(0, 7)
}

/** Monday-first grid, matching the week strip. */
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

export function MonthPickerSheet({
  businessId,
  open,
  monthKey,
  selectedKey,
  todayKey,
  onSelect,
  onMonthChange,
  onClose,
}: {
  businessId: Id<'businesses'>
  open: boolean
  monthKey: string
  selectedKey: string
  todayKey: string
  onSelect: (dayKey: string) => void
  onMonthChange: (monthKey: string) => void
  onClose: () => void
}) {
  return (
    <Drawer.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />
          {open && (
            <MonthGrid
              businessId={businessId}
              monthKey={monthKey}
              selectedKey={selectedKey}
              todayKey={todayKey}
              onSelect={onSelect}
              onMonthChange={onMonthChange}
            />
          )}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

function MonthGrid({
  businessId,
  monthKey,
  selectedKey,
  todayKey,
  onSelect,
  onMonthChange,
}: {
  businessId: Id<'businesses'>
  monthKey: string
  selectedKey: string
  todayKey: string
  onSelect: (dayKey: string) => void
  onMonthChange: (monthKey: string) => void
}) {
  const { data: days } = useSuspenseQuery(
    convexQuery(api.jobs.listMonth, { businessId, monthKey }),
  )

  const byDay = new Map(days.map((d) => [d.dayKey, d]))

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => onMonthChange(shiftMonth(monthKey, -1))}
          className="flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
        >
          <ChevronLeft size={20} strokeWidth={1.7} />
        </button>
        <Drawer.Title className="text-sheet-title text-ink">
          {formatMonthLabel(`${monthKey}-01`)}
        </Drawer.Title>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => onMonthChange(shiftMonth(monthKey, 1))}
          className="flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
        >
          <ChevronRight size={20} strokeWidth={1.7} />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-7 gap-1">
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
              className="flex flex-col items-center gap-0.5 rounded-xl py-1.5 transition active:scale-[.95]"
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

              <span className="flex h-3.5 items-center text-[11px] font-semibold tabular-nums text-muted">
                {day && day.count > 0 ? day.count : ''}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-4 flex justify-center">
        <button
          type="button"
          onClick={() => {
            onMonthChange(monthKeyOf(todayKey))
            onSelect(todayKey)
          }}
          className="text-body font-semibold text-blue"
        >
          Today
        </button>
      </div>
    </div>
  )
}
