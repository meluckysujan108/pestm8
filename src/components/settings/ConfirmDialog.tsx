import { AlertDialog } from 'radix-ui'
import type { ReactNode } from 'react'

/**
 * "Remove this?" before something is taken away, as the Products sheet asks
 * it: an alert dialog with a way out first and the red action second. Not
 * `window.confirm`, which an installed iPhone app draws as a bare system
 * box with the page's address for a title.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirm,
  cancel = 'Cancel',
  onConfirm,
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
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-scrim" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[70] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-canvas p-4 shadow-elevation outline-none">
          <AlertDialog.Title className="text-row-title text-ink [overflow-wrap:anywhere]">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-body text-ink-2">
            {body}
          </AlertDialog.Description>
          <div className="mt-4 flex gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="h-11 flex-1 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.975]"
              >
                {cancel}
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                onClick={onConfirm}
                className="h-11 flex-1 rounded-xl bg-red text-[15px] font-semibold text-white shadow-red transition active:scale-[.975]"
              >
                {confirm}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
