import type { ReactNode, Ref } from 'react'

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
 *
 * `focusRef` makes the row somewhere focus can be put (not a tab stop): for
 * a confirm whose button the row loses once it goes through, so focus comes
 * back to the row rather than the top of the page (`ConfirmDialog`'s
 * `returnFocus`).
 */
export function DetailRow({
  label,
  value,
  sub,
  below,
  focusRef,
}: {
  label: string
  value: ReactNode
  sub?: string | false | undefined
  below?: ReactNode
  focusRef?: Ref<HTMLDivElement>
}) {
  return (
    <div
      ref={focusRef}
      tabIndex={focusRef ? -1 : undefined}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 px-3.5 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue"
    >
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
