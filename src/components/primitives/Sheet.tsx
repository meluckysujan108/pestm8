import { Drawer } from 'vaul'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * The frame every bottom sheet in the app is drawn in: the dimmed backdrop,
 * the panel, its grab handle and the ✕ in the corner. What goes inside is the
 * sheet's own — `Sheet` below puts a standard title, body and footer there;
 * a sheet with a header of its own (a job's number and Edit, a month's arrows)
 * uses this directly and draws its own `Drawer.Title`.
 *
 * Eighteen screens had each hand-rolled these six elements with the same
 * eight classes, which is eighteen chances for one of them to drift a corner
 * radius, a close button's size or the home-indicator padding — and they had.
 */
export function SheetShell({
  open,
  onClose,
  children,
  className = '',
}: {
  open: boolean
  /** Dragged down, tapped outside, or ✕: the one way the sheet closes. */
  onClose: () => void
  children: ReactNode
  /** Extra classes on the panel — only for a sheet whose content does not
   * scroll, and so has to clear the home indicator itself. */
  className?: string
}) {
  return (
    <Drawer.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Drawer.Content
          className={`fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none ${className}`}
        >
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />
          {children}
          <SheetCloseButton onClick={onClose} />
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

/**
 * A sheet's scrolling body when it is the last thing in the sheet: clear of
 * the home indicator by the same 24px every sheet uses.
 */
export const SHEET_BODY =
  'min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))]'

/**
 * A bottom sheet with a title, a scrolling body and an optional footer.
 *
 * The content is mounted only while open: a sheet holding a long searchable
 * list should not keep that list rendered behind every other screen.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  /** Names the sheet for screen readers, and heads it on screen. */
  title: string
  description?: string
  children: ReactNode
  /** Pinned below the scrolling content — a Done button, usually. */
  footer?: ReactNode
}) {
  return (
    <SheetShell open={open} onClose={onClose}>
      <div className="px-4 pb-2 pt-3">
        <Drawer.Title className="pr-10 text-sheet-title text-ink">
          {title}
        </Drawer.Title>
        {description ? (
          <Drawer.Description className="mt-0.5 text-caption text-muted">
            {description}
          </Drawer.Description>
        ) : (
          // Radix warns when a dialog has no description; saying nothing is
          // the honest description for a sheet whose title says it all.
          <Drawer.Description className="sr-only">{title}</Drawer.Description>
        )}
      </div>

      {/* Without a footer the content is the last thing in the sheet, so
          it is what has to clear the home indicator. */}
      {open && (
        <div
          className={
            footer ? 'min-h-0 flex-1 overflow-y-auto px-4 pb-2' : SHEET_BODY
          }
        >
          {children}
        </div>
      )}

      {footer && (
        <div className="border-t border-hairline px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3">
          {footer}
        </div>
      )}
    </SheetShell>
  )
}

/**
 * The round ✕ in a sheet's top corner: a 32px circle, as drawn, inside a
 * 44px target — the smallest a thumb (or a glove) hits reliably. Placed so
 * the circle sits 12px from the corner, where every sheet has always had it.
 */
export function SheetCloseButton({
  onClick,
  label = 'Close',
}: {
  onClick: () => void
  label?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="group absolute right-1.5 top-1.5 flex size-11 items-center justify-center rounded-full outline-none"
    >
      <span className="flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted group-focus-visible:ring-2 group-focus-visible:ring-blue">
        <X size={16} strokeWidth={2} />
      </span>
    </button>
  )
}
