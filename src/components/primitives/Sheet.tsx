import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { Drawer } from 'vaul'
import { X } from 'lucide-react'
import { useBlocker, useRouter } from '@tanstack/react-router'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import type { ReactNode, RefObject } from 'react'

/**
 * True inside a sheet. A sheet opened from one — a picker over the New Job
 * form, Make recurring over a job — draws its scrim over the sheet below as
 * well as the page: at the usual layer the one below stayed bright, with its
 * own ✕ showing above the new one's, and it was not clear which was which.
 */
const InSheet = createContext(false)

/** A form in the sheet, and whether anything in it has changed. */
type Lock = { changed: boolean }

/**
 * `useSheetLock` as an element, for a sheet whose form state lives in the
 * component that draws the sheet — above the sheet, where the hook would lock
 * the wrong one. Put it inside the sheet's content.
 */
export function SheetLock({
  changed,
  whileUnchanged = true,
}: {
  changed: boolean
  whileUnchanged?: boolean
}) {
  useSheetLock(changed, { whileUnchanged })
  return null
}

/** How a form tells the sheet it is in that it is being edited. */
const LockRegistry = createContext<
  ((id: string, lock: Lock | null) => void) | null
>(null)

/**
 * Called by a form inside a sheet: while it is mounted the sheet cannot be
 * swiped away, closed by a tap outside it, or closed by Escape, and its grab
 * handle goes. ✕, Escape and the phone's Back then ask "Discard your
 * changes?" when `changed`, and simply close when nothing has.
 *
 * An edit mode locks the sheet for as long as it is open, changed or not —
 * a swipe is too easy to make by accident with the keyboard up, and it threw
 * the whole edit away. A form that is the sheet itself (New Job) passes
 * `whileUnchanged: false`, so an untouched one still swipes away like any
 * other sheet.
 *
 * A sheet can hold several at once — a client's details and a contact being
 * added — and is locked while any is.
 */
export function useSheetLock(
  changed: boolean,
  { whileUnchanged = true }: { whileUnchanged?: boolean } = {},
) {
  const register = useContext(LockRegistry)
  const id = useId()
  const active = whileUnchanged || changed
  useEffect(() => {
    register?.(id, active ? { changed } : null)
  }, [register, id, active, changed])
  useEffect(() => () => register?.(id, null), [register, id])
}

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
  returnFocusRef,
  initialFocusRef,
}: {
  open: boolean
  /** Dragged down, tapped outside, or ✕: the one way the sheet closes.
   * While a form in it is being edited (`useSheetLock`) only ✕, Escape and
   * Back close it, and they ask first when something has changed. */
  onClose: () => void
  children: ReactNode
  /** Extra classes on the panel — only for a sheet whose content does not
   * scroll, and so has to clear the home indicator itself. */
  className?: string
  /** Where focus goes when the sheet shuts (see `Sheet`). */
  returnFocusRef?: RefObject<HTMLElement | null>
  /** Where focus goes as it opens (see `Sheet`). */
  initialFocusRef?: RefObject<HTMLElement | null>
}) {
  const overSheet = useContext(InSheet)
  const [locks, setLocks] = useState<ReadonlyMap<string, Lock>>(() => new Map())
  const register = useCallback((id: string, lock: Lock | null) => {
    setLocks((current) => {
      const had = current.get(id)
      if (lock === null ? had === undefined : had?.changed === lock.changed) {
        return current
      }
      const next = new Map(current)
      if (lock === null) next.delete(id)
      else next.set(id, lock)
      return next
    })
  }, [])
  const locked = open && locks.size > 0
  const changed = locked && [...locks.values()].some((lock) => lock.changed)
  const [asking, setAsking] = useState(false)
  if (asking && !changed) setAsking(false)
  // Whether the sheet is still open once a Back has gone through: one opened
  // from the address has closed with it; one opened from state has not.
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  })

  /** ✕ or Escape, while a form is open. */
  function requestClose() {
    if (changed) setAsking(true)
    else onClose()
  }

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) => !next && requestClose()}
      // While a form in it is being edited, Vaul refuses the swipe, the tap
      // outside and Escape; the last two are asked about below instead.
      dismissible={!locked}
      // Over another sheet, the body lock stays the first sheet's. Vaul keeps
      // one lock for the page (iOS Safari, outside the installed app), and a
      // sheet not told it is nested undoes it as it closes — the page then
      // scrolled under New Job after every pick.
      nested={overSheet}
    >
      <Drawer.Portal>
        <Drawer.Overlay
          className={`fixed inset-0 bg-scrim ${overSheet ? 'z-50' : 'z-40'}`}
        />
        <Drawer.Content
          className={`fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-sheet bg-canvas outline-none ${className}`}
          // Vaul holds on to the pointer at every press — for a drag that may
          // follow — so a tap still lands on its button when what is under it
          // moves mid-tap (a field's warning line appearing as it loses
          // focus, pushing Save down). Locked, Vaul does not start a drag,
          // so the sheet holds the pointer itself.
          onPointerDown={(event) => {
            if (!locked || !(event.target instanceof Element)) return
            event.target.setPointerCapture(event.pointerId)
          }}
          // Vaul drops Escape silently while the sheet is locked; ask instead.
          onEscapeKeyDown={(event) => {
            if (!locked) return
            event.preventDefault()
            requestClose()
          }}
          // Locked, a tap outside does nothing — it is how a phone's keyboard
          // gets put away, and must not close an edit or ask about one.
          onPointerDownOutside={(event) => {
            if (locked) event.preventDefault()
          }}
          onOpenAutoFocus={
            initialFocusRef
              ? (event) => {
                  // Vaul keeps focus where it was unless asked, so a phone's
                  // keyboard does not rise over a sheet nobody has typed in
                  // yet. Where there is a keyboard already — a mouse means a
                  // desk — the field is ready to type into. On a phone the
                  // sheet itself takes focus, which raises no keyboard: left
                  // on the field that opened it, focus sat inside a sheet
                  // just hidden from screen readers, which went on reading it.
                  if (window.matchMedia('(pointer: fine)').matches) {
                    initialFocusRef.current?.focus()
                  } else if (event.target instanceof HTMLElement) {
                    event.target.focus()
                  }
                }
              : undefined
          }
          onCloseAutoFocus={
            returnFocusRef
              ? (event) => {
                  // Instead of Radix's own, which is the missing trigger.
                  event.preventDefault()
                  returnFocusRef.current?.focus()
                }
              : undefined
          }
        >
          {/* The grab handle, gone while the sheet cannot be dragged; its
              space stays, so nothing moves. */}
          <div
            aria-hidden
            className={`mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline ${locked ? 'invisible' : ''}`}
          />
          <LockRegistry.Provider value={register}>
            <InSheet.Provider value>{children}</InSheet.Provider>
          </LockRegistry.Provider>
          <SheetCloseButton onClick={requestClose} />
        </Drawer.Content>
      </Drawer.Portal>
      {changed && (
        <DiscardGuard
          asking={asking}
          onKeep={() => setAsking(false)}
          onDiscard={() => {
            setAsking(false)
            onClose()
          }}
          onLeft={() => {
            setAsking(false)
            if (openRef.current) onClose()
          }}
        />
      )}
    </Drawer.Root>
  )
}

/**
 * "Discard your changes?", asked when a sheet with unsaved changes is closed
 * with ✕ or Escape (`asking`) — and, where there is a router, when the
 * phone's Back gesture or button tries to leave. Back is caught only as Back:
 * the sheet's own closes and saves navigate too (a job's sheet lives in the
 * address), and those must go through.
 */
function DiscardGuard({
  onLeft,
  ...props
}: {
  asking: boolean
  onKeep: () => void
  onDiscard: () => void
  /** Back went through: close the sheet too if it is still open. */
  onLeft: () => void
}) {
  // Sheets are also drawn where there is no router: the UI harness's
  // specimens, and component tests.
  const router = useRouter({ warn: false }) as unknown
  return router ? (
    <BackGuard {...props} onLeft={onLeft} />
  ) : (
    <DiscardDialog {...props} />
  )
}

function blockBack({ action }: { action: string }) {
  return action === 'BACK' || action === 'FORWARD' || action === 'GO'
}

function BackGuard({
  asking,
  onKeep,
  onDiscard,
  onLeft,
}: {
  asking: boolean
  onKeep: () => void
  onDiscard: () => void
  onLeft: () => void
}) {
  const router = useRouter()
  const blocker = useBlocker({
    shouldBlockFn: blockBack,
    withResolver: true,
    // A reload is deliberate, and the browser's own "Leave site?" box is
    // not this app's.
    enableBeforeUnload: false,
  })
  const blocked = blocker.status === 'blocked'
  return (
    <DiscardDialog
      asking={asking || blocked}
      onKeep={() => {
        if (blocked) blocker.reset()
        onKeep()
      }}
      onDiscard={() => {
        if (!blocked) {
          onDiscard()
          return
        }
        // Back goes on — and a sheet opened from state rather than the
        // address (New Job) is still open on the page Back lands on, with
        // the change in it, so it is closed once the move has landed.
        const stop = router.subscribe('onResolved', () => {
          stop()
          onLeft()
        })
        blocker.proceed()
      }}
    />
  )
}

function DiscardDialog({
  asking,
  onKeep,
  onDiscard,
}: {
  asking: boolean
  onKeep: () => void
  onDiscard: () => void
}) {
  return (
    <ConfirmDialog
      open={asking}
      onOpenChange={(open) => !open && onKeep()}
      title="Discard your changes?"
      body="What you changed here hasn’t been saved. Discarding puts it back as it was."
      cancel="Keep editing"
      confirm="Discard"
      onConfirm={onDiscard}
    />
  )
}

/**
 * A sheet's scrolling body when it is the last thing in the sheet: clear of
 * the home indicator by the same 24px every sheet uses.
 */
export const SHEET_BODY =
  'min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))]'

/** A sheet's scrolling body when a `SHEET_FOOTER` is pinned below it. */
export const SHEET_BODY_ABOVE_FOOTER =
  'min-h-0 flex-1 overflow-y-auto px-4 pb-2'

/**
 * A footer pinned under a sheet's scrolling body — a Done, or an edit form's
 * Cancel and Save — clear of the home indicator. A submit button here sits
 * outside its form, so it names the form with `form=`.
 */
export const SHEET_FOOTER =
  'border-t border-hairline px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3'

/**
 * A bottom sheet with a title, a scrolling body and an optional footer.
 *
 * The content is mounted only while open, and while it slides away: a sheet
 * holding a long searchable list should not keep that list rendered behind
 * every other screen, nor shrink to its title as it leaves.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  returnFocusRef,
  initialFocusRef,
}: {
  open: boolean
  onClose: () => void
  /** Names the sheet for screen readers, and heads it on screen. */
  title: string
  description?: string
  children: ReactNode
  /** Pinned below the scrolling content — a Done button, usually. */
  footer?: ReactNode
  /**
   * Where focus goes when the sheet shuts — the button that opened it.
   * These sheets are opened from state, not a Drawer.Trigger, so without
   * this focus goes back to no trigger at all: the top of the page, for a
   * keyboard or screen reader. Left out, the sheet behaves as it always has.
   */
  returnFocusRef?: RefObject<HTMLElement | null>
  /**
   * A search field to type into as the sheet opens — on a computer only. On
   * a phone focus stays put, as in every sheet: a keyboard that rises on
   * its own covers half of what the person opened the sheet to see.
   */
  initialFocusRef?: RefObject<HTMLElement | null>
}) {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  useEffect(() => {
    if (open) return
    // Vaul's exit takes half a second. Unmounted at once, a picker closed by
    // a pick collapsed to its title and Done before it slid away.
    const leaving = window.setTimeout(() => setMounted(false), 500)
    return () => window.clearTimeout(leaving)
  }, [open])

  return (
    <SheetShell
      open={open}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      initialFocusRef={initialFocusRef}
    >
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
      {mounted && (
        <div className={footer ? SHEET_BODY_ABOVE_FOOTER : SHEET_BODY}>
          {children}
        </div>
      )}

      {footer && <div className={SHEET_FOOTER}>{footer}</div>}
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
        <X size={16} strokeWidth={2.2} />
      </span>
    </button>
  )
}
