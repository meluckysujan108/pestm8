import type { ReactNode } from 'react'

/**
 * A card of facts, one row each: a job's price, work order and repeats; a
 * client's number and ABN. A description list, so each value is read with
 * its name.
 */
export function DetailRows({ children }: { children: ReactNode }) {
  return <dl className="divide-y divide-hairline">{children}</dl>
}

/**
 * One of a card's facts: its name on the left, its value on the right, and
 * anything more about it (a warning, an action) under both.
 */
export function DetailRow({
  label,
  value,
  sub,
  below,
}: {
  label: string
  value: ReactNode
  sub?: string | false | undefined
  below?: ReactNode
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 px-3.5 py-2.5">
      <dt className="text-body text-ink-2">{label}</dt>
      <dd className="min-w-0 text-right">
        <span className="block break-words text-body font-semibold text-ink">
          {value}
        </span>
        {sub && <span className="block text-caption text-muted">{sub}</span>}
      </dd>
      {below && <dd className="col-span-2 mt-1.5">{below}</dd>}
    </div>
  )
}
