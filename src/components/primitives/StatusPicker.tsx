import { Check, ChevronDown } from 'lucide-react'
import { NEUTRAL_BUTTON_COMPACT } from './buttons'
import { Sheet } from './Sheet'
import type { ReactNode, Ref, RefObject } from 'react'

/**
 * A status pill that can be changed: the pill and a chevron, one button,
 * 44px to a finger. Tapping it opens a `StatusPicker`. The pill keeps its
 * own look (`StatusPill`, `ClientStatusPill`); this only makes it a control.
 */
export function StatusPillButton({
  pill,
  ariaLabel,
  onClick,
  disabled = false,
  buttonRef,
}: {
  pill: ReactNode
  /** What it changes, read after the status itself: "Change job status"
   * makes "Pending, change job status". */
  ariaLabel: string
  onClick: () => void
  disabled?: boolean
  buttonRef?: Ref<HTMLButtonElement>
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-haspopup="dialog"
      disabled={disabled}
      onClick={onClick}
      className="relative tap-target flex items-center gap-1 rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.97] disabled:opacity-50"
    >
      {/* Named by the pill's own word first — the status is read, and a
          voice command saying the word finds it — then what it does. */}
      {pill}
      <span className="sr-only">
        , {ariaLabel.charAt(0).toLowerCase() + ariaLabel.slice(1)}
      </span>
      <ChevronDown
        aria-hidden
        size={14}
        strokeWidth={2.2}
        className="text-muted"
      />
    </button>
  )
}

export type StatusChoice<T extends string> = {
  value: T
  /** The pill as the status shows everywhere else. */
  pill: ReactNode
  /** One line on what the status means, so choosing one is not a guess. */
  meaning: string
}

/**
 * Choosing a status — a job's or a client's — in a sheet of its own: every
 * status as its pill, what it means beside it, the current one ticked. A tap
 * chooses; the caller saves it and closes the sheet (or asks first, as
 * Cancelled does).
 *
 * It replaced a menu that floated under the job's pill. That menu sat inside
 * a sheet, the arrangement that failed to scroll on Android, and its rows
 * were under 44px; it also had no room to say what a status means.
 */
export function StatusPicker<T extends string>({
  open,
  onClose,
  title,
  description,
  choices,
  value,
  onChoose,
  returnFocusRef,
}: {
  open: boolean
  onClose: () => void
  /** "Job status", "Client status". */
  title: string
  /** Whose status: "Job #2320 · General Pest Control". */
  description?: string
  choices: ReadonlyArray<StatusChoice<T>>
  value: string
  onChoose: (value: T) => void
  /** The pill that opened it, to go back to. */
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      returnFocusRef={returnFocusRef}
      footer={
        <button
          type="button"
          onClick={onClose}
          className={`${NEUTRAL_BUTTON_COMPACT} w-full`}
        >
          Done
        </button>
      }
    >
      <ul className="flex flex-col gap-1.5">
        {choices.map((choice) => {
          const on = choice.value === value
          return (
            <li key={choice.value}>
              <button
                type="button"
                aria-current={on ? 'true' : undefined}
                onClick={() => onChoose(choice.value)}
                className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition active:scale-[.99] ${
                  on ? 'border-blue bg-blue/8' : 'border-hairline bg-surface'
                }`}
              >
                <span className="w-[92px] shrink-0">{choice.pill}</span>
                <span className="min-w-0 flex-1 text-caption text-ink-2">
                  {choice.meaning}
                </span>
                {on && (
                  <Check
                    size={17}
                    strokeWidth={2.2}
                    className="shrink-0 text-blue"
                  />
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}
