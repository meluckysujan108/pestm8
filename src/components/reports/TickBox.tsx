import { Check } from 'lucide-react'

/**
 * The square an address is ticked in: the send sheet's recipients, and the
 * client's copy on the sheet that locks a report.
 *
 * Unticked it is an outline, not a fill. The fill it used to have
 * (`surface-3`) sat on a `surface-2` row two shades away, so an unticked
 * address showed no box at all and read as a line of text rather than a
 * choice that was off.
 */
export function TickBox({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex size-5 shrink-0 items-center justify-center rounded-md border-[1.5px] ${
        on ? 'border-ink bg-ink text-surface' : 'border-muted bg-surface'
      }`}
    >
      {on && <Check size={13} strokeWidth={2.2} />}
    </span>
  )
}
