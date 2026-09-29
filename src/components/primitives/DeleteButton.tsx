import { Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Delete, at the foot of a sheet or below an edit form: a red word on a grey
 * fill, full width. Never a red fill — the red button is the `ConfirmDialog`
 * this opens, which says what goes and where it can be got back from.
 */
export function DeleteButton({
  children,
  disabled,
  onClick,
  className = 'mt-6',
}: {
  /** The verb and the thing: "Delete client", "Delete this property". */
  children: ReactNode
  disabled?: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-body font-semibold text-red transition active:scale-[.975] disabled:opacity-50 ${className}`}
    >
      <Trash2 aria-hidden size={16} strokeWidth={2} />
      {children}
    </button>
  )
}
