import {
  EmptyState,
  EmptyStateButton,
} from '#/components/primitives/EmptyState'

/**
 * A day or week the phone keeps no copy of, asked for with the line down:
 * in the list's place, under the heading that names it, with the way back
 * to a day it does keep. Said instead of a placeholder that would wait for
 * good. It goes by itself once the signal is back and the day can load.
 */
export function NotKeptDay({
  label,
  onToday,
}: {
  /** The day or week asked for, as its heading says it: "Monday 9 November",
   * "9–15 November". */
  label: string
  onToday: () => void
}) {
  return (
    <EmptyState
      title="Not on this phone"
      body={`This phone keeps this week and next. ${label} shows when you have signal.`}
      action={
        <EmptyStateButton onClick={onToday}>Go to today</EmptyStateButton>
      }
    />
  )
}
