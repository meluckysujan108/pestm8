import type { ReactNode } from 'react'

/**
 * An empty list: what goes here, and — when there is truly nothing yet —
 * the one thing to do about it, right where the eye already is. Not for
 * "nothing matches this search", where the thing to do is change the search.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body?: string
  /** The way to fill it: an `EmptyStateButton`, or a link styled with
   * `EMPTY_ACTION_CLASS`. */
  action?: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface px-4 py-10 text-center shadow-elevation">
      <p className="text-row-title text-ink">{title}</p>
      {body && <p className="mt-1 text-body text-muted">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

/**
 * A search or a filter that found nothing: one quiet line and the way back,
 * where `EmptyState` would say the list itself is empty. The thing to do is
 * change the search, so that is what it offers.
 */
export function NoMatches({
  term,
  hint,
  clearLabel,
  onClear,
}: {
  /** What was searched for, quoted back; omit when only filters are on. */
  term?: string
  hint?: string
  /** "Clear search", "Clear filters" — what `onClear` will undo. */
  clearLabel: string
  onClear: () => void
}) {
  const shown = term?.trim()
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-1 px-4 py-8 text-center"
    >
      <p className="text-body text-ink">
        {shown ? `No matches for “${shown}”` : 'No matches'}
      </p>
      {hint && <p className="text-caption text-muted">{hint}</p>}
      <button
        type="button"
        onClick={onClear}
        className="relative tap-target mt-1 text-body font-semibold text-blue"
      >
        {clearLabel}
      </button>
    </div>
  )
}

/** Quieter than a page's red button: an invitation, not an alarm. */
export const EMPTY_ACTION_CLASS =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-surface-2 px-4 text-[16px] font-semibold text-blue transition active:scale-[.975] disabled:opacity-50'

export function EmptyStateButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={EMPTY_ACTION_CLASS}
    >
      {children}
    </button>
  )
}
