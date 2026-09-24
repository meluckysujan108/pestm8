import { DropdownMenu } from 'radix-ui'
import {
  CircleArrowDown,
  CircleCheck,
  CircleEllipsis,
  CircleMinus,
  Download,
  FileUp,
  LayoutGrid,
  LoaderCircle,
  Search,
  Share,
} from 'lucide-react'
import type { ReactNode, Ref } from 'react'
import type { ViewerActions } from './types'

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
  'transition-[translate,opacity,visibility] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none'

export function TopBar({
  barRef,
  doneRef,
  visible,
  title,
  pages,
  onDone,
  menu,
}: {
  barRef: Ref<HTMLElement>
  doneRef: Ref<HTMLButtonElement>
  visible: boolean
  title: string
  /** 0 until the document is open. */
  pages: number
  onDone: () => void
  menu: ReactNode
}) {
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
          <h2 className="truncate text-[15px] font-semibold leading-tight text-ink">
            {title}
          </h2>
          {pages > 0 && (
            <p className="truncate text-[11px] leading-tight text-muted">
              {pages === 1 ? '1 page' : `${pages} pages`}
            </p>
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
}) {
  const { keep } = actions
  return (
    <div className="flex h-[52px] items-center justify-around px-2">
      {actions.share && (
        <ToolbarButton label="Share" disabled={!canShare} onClick={onShare}>
          <Share size={22} strokeWidth={1.8} />
        </ToolbarButton>
      )}
      <ToolbarButton
        label="Search"
        buttonRef={searchButtonRef}
        disabled={!ready}
        pressed={searchOpen}
        onClick={onSearch}
      >
        <Search size={22} strokeWidth={1.8} />
      </ToolbarButton>
      <ToolbarButton
        label="Pages"
        disabled={!ready}
        pressed={gridOpen}
        onClick={onPages}
      >
        <LayoutGrid size={22} strokeWidth={1.8} />
      </ToolbarButton>
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
              strokeWidth={1.8}
              className="animate-spin"
            />
          ) : keep.kept ? (
            <CircleCheck size={22} strokeWidth={1.8} />
          ) : (
            <CircleArrowDown size={22} strokeWidth={1.8} />
          )}
        </ToolbarButton>
      )}
    </div>
  )
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
        <CircleEllipsis size={24} strokeWidth={1.8} />
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
          <MenuItem
            icon={<Download size={18} strokeWidth={1.8} />}
            disabled={!canSave}
            onSelect={onSave}
          >
            {actions.saveLabel}
          </MenuItem>
          {replace && (
            <MenuItem
              icon={<FileUp size={18} strokeWidth={1.8} />}
              onSelect={replace}
            >
              Replace PDF…
            </MenuItem>
          )}
          {keep && (
            <MenuItem
              icon={
                keep.kept ? (
                  <CircleMinus size={18} strokeWidth={1.8} />
                ) : (
                  <CircleArrowDown size={18} strokeWidth={1.8} />
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
