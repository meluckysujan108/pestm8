import { useRef } from 'react'
import { AlertDialog } from 'radix-ui'
import type { ReactNode } from 'react'
import {
  PRIMARY_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'

/**
 * "Remove this?" before something is taken away, as the Products sheet asks
 * it: an alert dialog with a way out first and the red action second. Not
 * `window.confirm`, which an installed iPhone app draws as a bare system
 * box with the page's address for a title.
 *
 * Opened from state, not from an `AlertDialog.Trigger` — the button that asks
 * is part of the row it would remove — so Radix has nothing to hand focus
 * back to when it closes, and it would fall to the page, sending someone on a
 * keyboard or a screen reader back to the top. It goes back to whatever had
 * focus when the dialog opened, or to `returnFocus`'s choice: the caller's
 * say, for when that element is about to go (the row just removed), or never
 * had focus at all (a tap on an iPhone does not focus a button).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirm,
  cancel = 'Cancel',
  onConfirm,
  returnFocus,
  pending = false,
  pendingLabel,
  error,
  closeOnConfirm = true,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  body: ReactNode
  /** The red button's words: "Remove", "Delete". */
  confirm: string
  /** The way out's words. */
  cancel?: string
  onConfirm: () => void
  /** Where focus goes when the dialog closes, having been confirmed or not;
   * null or undefined for whatever had it when the dialog opened. */
  returnFocus?: (confirmed: boolean) => HTMLElement | null | undefined
  /** The action is running: its button waits, and says so. */
  pending?: boolean
  /** Said on the button while `pending` — "Cancelling…". */
  pendingLabel?: string
  /** Why the action did not go through, above the buttons. Only seen when
   * `closeOnConfirm` is false, since the dialog is otherwise gone. */
  error?: ReactNode
  /** False keeps the dialog open after the tap, for an action whose outcome
   * the dialog itself has to report (it closes itself on success). */
  closeOnConfirm?: boolean
}) {
  const opener = useRef<HTMLElement | null>(null)
  const confirmed = useRef(false)

  const confirmButton = (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        confirmed.current = true
        onConfirm()
      }}
      className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
    >
      {pending && pendingLabel ? pendingLabel : confirm}
    </button>
  )

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-scrim" />
        <AlertDialog.Content
          // Called as the dialog mounts, before focus moves into it.
          onOpenAutoFocus={() => {
            confirmed.current = false
            const active = document.activeElement
            opener.current =
              active instanceof HTMLElement && active !== document.body
                ? active
                : null
          }}
          onCloseAutoFocus={(event) => {
            // Radix's own would focus the trigger there is not.
            event.preventDefault()
            const target = returnFocus?.(confirmed.current) ?? opener.current
            if (target?.isConnected) target.focus({ preventScroll: true })
          }}
          className="fixed left-1/2 top-1/2 z-[70] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-canvas p-4 shadow-elevation outline-none"
        >
          <AlertDialog.Title className="text-row-title text-ink [overflow-wrap:anywhere]">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-body text-ink-2">
            {body}
          </AlertDialog.Description>
          {error && (
            <p role="alert" className="mt-2 text-caption text-amber-ink">
              {error}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
              >
                {cancel}
              </button>
            </AlertDialog.Cancel>
            {closeOnConfirm ? (
              <AlertDialog.Action asChild>{confirmButton}</AlertDialog.Action>
            ) : (
              confirmButton
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
