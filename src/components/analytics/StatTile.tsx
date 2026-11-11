import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { Bone } from '#/components/shell/Pending'
import { changeWords } from '#/lib/analyticsView'
import type { ReactNode } from 'react'
import type { Change } from '#/lib/analyticsView'

/**
 * The card every figure on Analytics sits in (design-system.md 4.5): one
 * place for its border, radius and lift, so a tile, the chart and a list of
 * rows are plainly the same kind of thing.
 */
export const STAT_CARD =
  'rounded-2xl border border-hairline bg-surface p-4 shadow-elevation'

/**
 * How a figure moved against the range it is compared with: an arrow and a
 * percentage, green up and red down, with the words for a screen reader.
 * Never colour alone: the arrow says the direction.
 */
export function ChangeMark({ change }: { change: Change }) {
  const Icon =
    change.direction === 'up'
      ? ArrowUp
      : change.direction === 'down'
        ? ArrowDown
        : Minus
  const tone =
    change.direction === 'up'
      ? 'text-green-ink'
      : change.direction === 'down'
        ? 'text-red-ink'
        : 'text-grey-ink'
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-caption font-semibold tabular-nums ${tone}`}
    >
      <Icon size={13} strokeWidth={2.2} aria-hidden />
      <span aria-hidden>{Math.abs(change.percent)}%</span>
      <span className="sr-only">{changeWords(change)}</span>
    </span>
  )
}

/**
 * A figure's shape over the range, as small as a word: no axis, no numbers,
 * nothing to read out (the tile's figure and change say it). Drawn by hand
 * so a tile never waits for the charts' chunk.
 */
export function Sparkline({
  values: every,
}: {
  values: ReadonlyArray<number>
}) {
  const width = 64
  const height = 22
  const pad = 2
  // At most ten points: thirty days drawn 64px wide is a scribble, and a
  // business's weekends would be most of what it showed.
  const size = Math.ceil(every.length / 10)
  const values = Array.from(
    { length: Math.ceil(every.length / size) || 0 },
    (_, i) =>
      every.slice(i * size, (i + 1) * size).reduce((sum, v) => sum + v, 0),
  )
  const max = Math.max(...values, 0)
  const points =
    values.length < 2
      ? [
          [pad, height - pad],
          [width - pad, height - pad],
        ]
      : values.map((value, i) => [
          pad + (i * (width - pad * 2)) / (values.length - 1),
          max === 0
            ? height - pad
            : height - pad - (value / max) * (height - pad * 2),
        ])
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 text-blue"
    >
      <polyline
        points={points
          .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
          .join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * One headline figure: what it is, the figure, and under it either how it
 * moved with its shape over the range, or a line of its own. The line under
 * the figure is always there, so a row of tiles is one height whatever each
 * has to say.
 */
export function StatTile({
  label,
  value,
  change,
  spark,
  note,
}: {
  label: string
  value: string
  /** Against the comparison; `null` when there is nothing to compare. */
  change?: Change | null
  spark?: ReadonlyArray<number>
  /** Said in the change's place: what the figure covers. */
  note?: ReactNode
}) {
  return (
    <div className={STAT_CARD}>
      <p className="section-label mb-1">{label}</p>
      <p className="truncate text-metric-sm text-ink">{value}</p>
      <div className="mt-1.5 flex min-h-[22px] items-center justify-between gap-2">
        {note !== undefined ? (
          <p className="truncate text-caption text-muted">{note}</p>
        ) : change ? (
          <ChangeMark change={change} />
        ) : (
          <span className="text-caption text-muted">
            <span aria-hidden>—</span>
            <span className="sr-only">Nothing to compare with</span>
          </span>
        )}
        {spark && <Sparkline values={spark} />}
      </div>
    </div>
  )
}

/** A tile still loading: its box, with nothing to read. */
export function StatTilePending() {
  return (
    <div className={STAT_CARD}>
      <Bone className="mb-2 h-3 w-16" />
      <Bone className="h-7 w-24" />
      <Bone className="mt-2.5 h-4 w-12" />
    </div>
  )
}
