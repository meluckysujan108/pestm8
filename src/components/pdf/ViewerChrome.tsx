import { DropdownMenu } from 'radix-ui'
import {
  ChevronLeft,
  ChevronRight,
  CircleArrowDown,
  CircleCheck,
  CircleEllipsis,
  CircleMinus,
  Download,
  FileUp,
  LayoutGrid,
  LoaderCircle,
  Pencil,
  Search,
  Share,
} from 'lucide-react'
import type { ReactNode, Ref } from 'react'
import type { ViewerActions, ViewerPager } from './types'

/**
 * The viewer's two bars, drawn as iOS draws them over a document: translucent,
 * blurred, tinted buttons, a title in the middle — and both slide away
 * together when the page is tapped, so the document gets the whole screen.
 *
 * A hidden bar is `visibility: hidden` as well as moved and faded, so its
 * buttons cannot be reached by Tab or a screen reader while they are not
 * there to see.
 */

const BAR_MOTION =
  'transition-[translate,opacity,visibility] duration-300 ease-sheet motion-reduce:transition-none'

export function TopBar({
  barRef,
  doneRef,
  visible,
  title,
  pages,
  onDone,
  menu,
  pager,
}: {
  barRef: Ref<HTMLElement>
  doneRef: Ref<HTMLButtonElement>
  visible: boolean
  title: string
  /** 0 until the document is open. */
  pages: number
  onDone: () => void
  /** The More menu, or null when there is nothing to put in it. */
  menu: ReactNode
  /** Which of several files this is, said under the title. */
  pager?: ViewerPager
}) {
  const files =
    pager && pager.count > 1
      ? `File ${pager.index + 1} of ${pager.count}`
      : null
  return (
    <header
      ref={barRef}
      className={[
        'chrome-blur absolute inset-x-0 top-0 z-10 border-b border-hairline pt-[env(safe-area-inset-top)]',
        BAR_MOTION,
        visible ? '' : 'invisible -translate-y-full opacity-0',
      ].join(' ')}
    >
      <div className="grid h-11 grid-cols-[minmax(0,1fr)_minmax(0,2.6fr)_minmax(0,1fr)] items-center pl-[max(0.25rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))]">
        <div className="flex justify-start">
          <button
            ref={doneRef}
            type="button"
            onClick={onDone}
            className="h-11 rounded-lg px-3 text-[17px] font-semibold text-blue outline-none transition active:opacity-50 focus-visible:ring-2 focus-visible:ring-blue"
          >
            Done
          </button>
        </div>
        <div className="min-w-0 text-center">
          <h2 className="truncate text-body font-semibold leading-tight text-ink">
            {title}
          </h2>
          {files ? (
            <p className="truncate text-[11px] leading-tight text-muted">
              {/* Each its own element, so the page count still reads as
                  "3 pages" on its own to whatever looks for it. */}
              <span>{files}</span>
              {pages > 0 && (
                <>
                  {' · '}
                  <span>{pages === 1 ? '1 page' : `${pages} pages`}</span>
                </>
              )}
            </p>
          ) : (
            pages > 0 && (
              <p className="truncate text-[11px] leading-tight text-muted">
                {pages === 1 ? '1 page' : `${pages} pages`}
              </p>
            )
          )}
        </div>
        <div className="flex justify-end">{menu}</div>
      </div>
    </header>
  )
}

export function BottomBar({
  barRef,
  visible,
  lift,
  children,
}: {
  barRef: Ref<HTMLElement>
  visible: boolean
  /** Pixels to rise by, to sit on top of the software keyboard. */
  lift: number
  children: ReactNode
}) {
  return (
    <footer
      ref={barRef}
      className={[
        'chrome-blur absolute inset-x-0 bottom-0 z-10 border-t border-hairline pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
        BAR_MOTION,
        visible ? '' : 'invisible translate-y-full opacity-0',
      ].join(' ')}
      style={lift > 0 ? { transform: `translateY(${-lift}px)` } : undefined}
    >
      {children}
    </footer>
  )
}

/** A toolbar button: an icon, a name for screen readers, 44pt square. */
export function ToolbarButton({
  label,
  onClick,
  disabled,
  pressed,
  busy,
  buttonRef,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  busy?: boolean
  buttonRef?: Ref<HTMLButtonElement>
  children: ReactNode
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onClick}
      className={[
        'flex size-11 items-center justify-center rounded-full outline-none transition active:opacity-50 focus-visible:ring-2 focus-visible:ring-blue disabled:text-muted-2',
        pressed ? 'bg-fill-track text-blue' : 'text-blue',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

export function Toolbar({
  actions,
  canShare,
  ready,
  searchOpen,
  gridOpen,
  onShare,
  onSearch,
  onPages,
  searchButtonRef,
  markup,
  pager,
}: {
  actions: ViewerActions
  /** The file has arrived, so there is something to hand over. */
  canShare: boolean
  /** The document is open, so it can be searched and paged through. */
  ready: boolean
  searchOpen: boolean
  gridOpen: boolean
  onShare: () => void
  onSearch: () => void
  onPages: () => void
  searchButtonRef: Ref<HTMLButtonElement>
  /** The pen, for someone who may draw; absent draws no Markup button. */
  markup?: {
    open: boolean
    onToggle: () => void
    buttonRef: Ref<HTMLButtonElement>
  }
  /** Steps between the files of one thing, at either end of the bar. */
  pager?: ViewerPager
}) {
  const { keep } = actions
  const paged = pager !== undefined && pager.count > 1
  return (
    <div className="flex h-[52px] items-center justify-around px-2">
      {paged && (
        <ToolbarButton
          label="Previous file"
          disabled={pager.index <= 0}
          onClick={pager.onPrevious}
        >
          <ChevronLeft size={24} strokeWidth={2} />
        </ToolbarButton>
      )}
      {actions.share && (
        <ToolbarButton label="Share" disabled={!canShare} onClick={onShare}>
          <Share size={22} strokeWidth={1.7} />
        </ToolbarButton>
      )}
      <ToolbarButton
        label="Search"
        buttonRef={searchButtonRef}
        disabled={!ready}
        pressed={searchOpen}
        onClick={onSearch}
      >
        <Search size={22} strokeWidth={1.7} />
      </ToolbarButton>
      <ToolbarButton
        label="Pages"
        disabled={!ready}
        pressed={gridOpen}
        onClick={onPages}
      >
        <LayoutGrid size={22} strokeWidth={1.7} />
      </ToolbarButton>
      {markup && (
        <ToolbarButton
          label="Markup"
          buttonRef={markup.buttonRef}
          disabled={!ready}
          pressed={markup.open}
          onClick={markup.onToggle}
        >
          <Pencil size={21} strokeWidth={1.7} />
        </ToolbarButton>
      )}
      {keep && (
        <ToolbarButton
          label="Keep on this phone"
          pressed={keep.kept}
          busy={keep.busy}
          disabled={keep.busy}
          onClick={keep.toggle}
        >
          {keep.busy ? (
            <LoaderCircle
              size={22}
              strokeWidth={1.7}
              className="animate-spin"
            />
          ) : keep.kept ? (
            <CircleCheck size={22} strokeWidth={1.7} />
          ) : (
            <CircleArrowDown size={22} strokeWidth={1.7} />
          )}
        </ToolbarButton>
      )}
      {paged && (
        <ToolbarButton
          label="Next file"
          disabled={pager.index >= pager.count - 1}
          onClick={pager.onNext}
        >
          <ChevronRight size={24} strokeWidth={2} />
        </ToolbarButton>
      )}
    </div>
  )
}

/**
 * Whether the More menu has anything in it. A draft's preview offers no Save
 * (it must not leave the app) and no Replace or Keep, and an empty menu is a
 * button that opens onto nothing — so then there is no button.
 */
export function hasMoreMenu(actions: ViewerActions): boolean {
  return !!actions.save || !!actions.replace || !!actions.keep
}

/**
 * The top bar's "…": save a copy, replace the file, keep it on the phone.
 *
 * A Radix DropdownMenu (a menu, not a popover), as the header's view menu
 * is: a list of commands is what `role=menu` says, and a second
 * `role=dialog` inside the viewer's own would confuse both screen readers
 * and the unscoped dialog locators in e2e. Layered above the viewer (z-80).
 */
export function MoreMenu({
  actions,
  canSave,
  onSave,
}: {
  actions: ViewerActions
  canSave: boolean
  onSave: () => void
}) {
  const { keep, replace } = actions
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        type="button"
        aria-label="More"
        className="flex size-11 items-center justify-center rounded-full text-blue outline-none transition active:opacity-50 focus-visible:ring-2 focus-visible:ring-blue"
      >
        <CircleEllipsis size={24} strokeWidth={1.7} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-[90] min-w-60 rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
        >
          {/* Every item acts inside the tap that chose it: Safari opens the
              share sheet (Save to Files) and the file picker (Replace) only
              from a user gesture. */}
          {actions.save && (
            <MenuItem
              icon={<Download size={18} strokeWidth={1.7} />}
              disabled={!canSave}
              onSelect={onSave}
            >
              {actions.saveLabel ?? 'Download'}
            </MenuItem>
          )}
          {replace && (
            <MenuItem
              icon={<FileUp size={18} strokeWidth={1.7} />}
              onSelect={replace}
            >
              {actions.replaceLabel ?? 'Replace PDF…'}
            </MenuItem>
          )}
          {keep && (
            <MenuItem
              icon={
                keep.kept ? (
                  <CircleMinus size={18} strokeWidth={1.7} />
                ) : (
                  <CircleArrowDown size={18} strokeWidth={1.7} />
                )
              }
              disabled={keep.busy}
              onSelect={keep.toggle}
            >
              {keep.kept ? 'Remove from this phone' : 'Keep on this phone'}
            </MenuItem>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function MenuItem({
  icon,
  disabled,
  onSelect,
  children,
}: {
  icon: ReactNode
  disabled?: boolean
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 text-[16px] text-ink outline-none transition data-[disabled]:cursor-default data-[disabled]:text-muted-2 data-[highlighted]:bg-surface-2"
    >
      {children}
      <span aria-hidden className="text-ink-2">
        {icon}
      </span>
    </DropdownMenu.Item>
  )
}
