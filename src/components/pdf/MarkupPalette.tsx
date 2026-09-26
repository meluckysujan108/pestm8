import { RotateCcw } from 'lucide-react'
import { ToolbarButton } from './ViewerChrome'
import type { Ref } from 'react'

/**
 * Markup mode's tools, in the bottom toolbar's place — as the search bar
 * takes it for Find — so the thumb that draws is already where they are.
 *
 * One pen, so no pen picker: Undo (your newest mark, wherever it is), Clear
 * (your marks on the page being read, after a second tap) and Done. Nothing
 * here can reach anyone else's marks; the caller's note says who sees them.
 */
export function MarkupPalette({
  note,
  canUndo,
  onUndo,
  page,
  canClear,
  clearArmed,
  onClear,
  onDone,
  doneRef,
}: {
  /** E.g. that the marks are for the team and are not shared. */
  note: string | undefined
  canUndo: boolean
  onUndo: () => void
  /** The page being read, 0-based. */
  page: number
  /** You have marks on that page. */
  canClear: boolean
  /** The first tap has been made: the next one clears. */
  clearArmed: boolean
  onClear: () => void
  onDone: () => void
  doneRef: Ref<HTMLButtonElement>
}) {
  const n = page + 1
  return (
    <div role="group" aria-label="Markup">
      {note && (
        <p className="px-4 pt-2 text-center text-caption text-muted">{note}</p>
      )}
      <div className="flex h-[52px] items-center gap-1 px-1">
        <ToolbarButton
          label="Undo my last mark"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <RotateCcw size={22} strokeWidth={1.7} />
        </ToolbarButton>
        <div className="flex min-w-0 flex-1 justify-center">
          {/* The app's confirm dialogs sit under the viewer (z-60/70 against
              its z-80), so this one asks in place: see `clearConfirm.ts`. */}
          <button
            type="button"
            disabled={!canClear}
            onClick={onClear}
            className={[
              'h-11 min-w-0 max-w-full truncate rounded-lg px-3 text-body font-semibold outline-none transition active:opacity-50 focus-visible:ring-2 focus-visible:ring-blue disabled:text-muted-2',
              clearArmed && canClear ? 'text-red' : 'text-blue',
            ].join(' ')}
          >
            {clearArmed && canClear
              ? `Tap again to clear page ${n}`
              : `Clear my marks on page ${n}`}
          </button>
        </div>
        <button
          ref={doneRef}
          type="button"
          onClick={onDone}
          // Named apart from the top bar's Done, which closes the whole viewer.
          aria-label="Done marking up"
          className="h-11 shrink-0 rounded-lg px-2.5 text-[17px] font-semibold text-blue outline-none transition active:opacity-50 focus-visible:ring-2 focus-visible:ring-blue"
        >
          Done
        </button>
      </div>
    </div>
  )
}
