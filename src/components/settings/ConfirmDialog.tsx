import { useRef } from 'react'
import { AlertDialog } from 'radix-ui'
import type { ReactNode } from 'react'
import {
  HELD_BUTTON,
  PRIMARY_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'

/**
 * With `labelInset`, a button's words are held to the two lines its 44px
 * fits (15px type on 1.45 is 43.5px), ending in "…": each button is half
 * the dialog wide, and a way out that names something has no length limit
 * ("Stay in {business name}"), so a third line would spill out of the
 * button. The words are all still there for a screen reader, and the body
 * says them in full. They also sit 12px in from each end (the buttons have
 * no padding of their own): two lines fill the button top to bottom, and
 * written edge to edge the first line and the "…" ran into its 18px rounded
 * corners. Only where asked (the leave guard's): every other dialog's words
 * are drawn bare, as they always were, across the button's full width.
 */
const LABEL_INSET = 'line-clamp-2 [overflow-wrap:anywhere] px-3'

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
  held = false,
  labelInset = false,
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
  /**
   * It has just come up under a tap that may still be landing (a sheet's
   * "Discard your changes?" asked by a button inside it, `useSheetClose`):
   * neither button takes a tap meanwhile, `aria-disabled` and held pressed
   * in (`HELD_BUTTON`), so the second tap of a double tap is no choice.
   */
  held?: boolean
  /**
   * Its buttons' words may well take two lines (`OutboxLeaveGuard`'s "Stay
   * in {business name}", "Discard and sign out"): they sit 12px in from
   * each end, clear of the rounded corners, held to the two lines that fit
   * (`LABEL_INSET`).
   */
  labelInset?: boolean
}) {
  const opener = useRef<HTMLElement | null>(null)
  const confirmed = useRef(false)
  const words = (text: string) =>
    labelInset ? <span className={LABEL_INSET}>{text}</span> : text

  const confirmButton = (
    <button
      type="button"
      disabled={pending}
      aria-disabled={held || undefined}
      onClick={(event) => {
        // Stopped here, Radix's own close (AlertDialog.Action) doesn't run.
        if (held) {
          event.preventDefault()
          return
        }
        confirmed.current = true
        onConfirm()
      }}
      className={`${PRIMARY_BUTTON_COMPACT} ${HELD_BUTTON} flex-1`}
    >
      {words(pending && pendingLabel ? pendingLabel : confirm)}
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
                aria-disabled={held || undefined}
                onClick={(event) => {
                  if (held) event.preventDefault()
                }}
                className={`${SECONDARY_BUTTON_COMPACT} ${HELD_BUTTON} flex-1`}
              >
                {words(cancel)}
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
