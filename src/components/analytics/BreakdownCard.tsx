import { useState } from 'react'
import { Check } from 'lucide-react'
import { STAT_CARD } from '#/components/analytics/StatTile'
import type { ReactNode } from 'react'

export type BreakdownRow = {
  key: string
  label: string
  /** A person's colour, from their record: the one colour that is data. */
  colour?: string
  /** The figure the rows are ranked by, as it reads: "$14,200", "58". */
  value: string
  /** What sits beside it, quieter: "58 jobs". */
  sub?: string
  /** The figure itself, for the bar's length against the longest. */
  amount: number
  /** This row is the filter the page is narrowed to. */
  chosen?: boolean
}

/** Rows shown before "Show all". */
const ROWS_SHOWN = 5

/**
 * A ranked breakdown on Analytics: who or what, how much, and a bar for its
 * share of the longest, most first. Five rows, then "Show all".
 *
 * With `onPick` each row is a button that narrows the whole page to it (a
 * service, a technician), and the one chosen is ticked; tapping it again
 * clears it. The bars are ink, not a hue: a length, not a status.
 */
export function BreakdownCard({
  title,
  rows,
  lead,
  empty,
  onPick,
}: {
  title: string
  rows: ReadonlyArray<BreakdownRow>
  /** Lines above the rows: a summary of the card. */
  lead?: ReactNode
  /** Said in the rows' place when there are none. */
  empty: string
  onPick?: (key: string) => void
}) {
  const [all, setAll] = useState(false)
  const longest = Math.max(...rows.map((row) => row.amount), 0)
  const shown = all ? rows : rows.slice(0, ROWS_SHOWN)

  return (
    <div className={STAT_CARD}>
      <h2 className="section-label mb-1">{title}</h2>
      {lead}
      {rows.length === 0 ? (
        <p className="py-3 text-body text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((row) => {
            const body = (
              <>
                <span className="flex items-baseline gap-2">
                  {row.colour !== undefined && (
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 self-center rounded-full"
                      style={{ backgroundColor: row.colour }}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-body text-ink">
                    {row.label}
                  </span>
                  {row.sub && (
                    <span className="shrink-0 text-caption text-muted tabular-nums">
                      {row.sub}
                    </span>
                  )}
                  <span className="shrink-0 text-body font-semibold text-ink tabular-nums">
                    {row.value}
                  </span>
                  {onPick && (
                    <Check
                      size={16}
                      strokeWidth={2.2}
                      aria-hidden
                      className={`shrink-0 self-center text-blue ${row.chosen ? '' : 'invisible'}`}
                    />
                  )}
                </span>
                <span
                  aria-hidden
                  className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-surface-2"
                >
                  <span
                    className="block h-full rounded-full bg-ink-2"
                    style={{
                      width: `${longest > 0 ? (row.amount / longest) * 100 : 0}%`,
                    }}
                  />
                </span>
              </>
            )
            return (
              <li key={row.key}>
                {onPick ? (
                  <button
                    type="button"
                    aria-pressed={row.chosen ?? false}
                    onClick={() => onPick(row.key)}
                    className="block min-h-11 w-full rounded-xl py-2 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:bg-surface-2"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="py-2">{body}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {rows.length > ROWS_SHOWN && !all && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="relative tap-target mt-1 text-body font-semibold text-blue"
        >
          Show all {rows.length}
        </button>
      )}
    </div>
  )
}
