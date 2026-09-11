import * as React from 'react'
import { cva } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import { PanelLeft } from 'lucide-react'

import { cn } from '#/lib/utils.ts'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip.tsx'
import type { VariantProps } from 'class-variance-authority'

/**
 * A reduced vendor of shadcn/ui's sidebar, cut down to what this app actually
 * uses. Four deliberate removals from the upstream component:
 *
 * 1. **No mobile Sheet branch.** Upstream swaps the sidebar for a Radix Dialog
 *    below its breakpoint, which means the nav is absent from the DOM whenever
 *    that sheet is closed. Mobile here is a bottom dock that is always
 *    rendered (AppShell), so the branch would serve nothing — and its absence
 *    is what keeps both navs in the DOM at every width, which the
 *    access/navigation tests rely on.
 * 2. **No `offcanvas` collapse.** `icon` is the only mode the shell offers.
 * 3. **No cookie persistence.** Upstream reads `document.cookie` for its
 *    initial open state, which cannot agree with a server render. If the
 *    collapsed state should persist, read the cookie in the route's
 *    `beforeLoad` and pass it as `defaultOpen` — that runs before render.
 * 4. **No `dark:` variants.** The app is light-only by design (styles.css).
 *
 * The `--sidebar-*` colour tokens this leans on are already defined and
 * remapped onto the iOS palette in styles.css, so nothing here introduces the
 * default zinc look.
 */

const SIDEBAR_WIDTH = '15rem'
const SIDEBAR_WIDTH_ICON = '3.25rem'
const SIDEBAR_KEYBOARD_SHORTCUT = 'b'

type SidebarContextValue = {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean) => void
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.')
  }
  return context
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
  const open = openProp ?? internalOpen

  const setOpen = React.useCallback(
    (value: boolean) => {
      if (onOpenChange) onOpenChange(value)
      else setInternalOpen(value)
    },
    [onOpenChange],
  )

  const toggleSidebar = React.useCallback(() => setOpen(!open), [open, setOpen])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleSidebar])

  const value = React.useMemo<SidebarContextValue>(
    () => ({
      state: open ? 'expanded' : 'collapsed',
      open,
      setOpen,
      toggleSidebar,
    }),
    [open, setOpen, toggleSidebar],
  )

  return (
    <SidebarContext.Provider value={value}>
      <TooltipProvider delayDuration={0}>
        <div
          data-slot="sidebar-wrapper"
          style={
            {
              '--sidebar-width': SIDEBAR_WIDTH,
              '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            'group/sidebar-wrapper flex min-h-dvh w-full has-[[data-variant=inset]]:bg-canvas',
            className,
          )}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  )
}

function Sidebar({
  variant = 'inset',
  collapsible = 'icon',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  variant?: 'sidebar' | 'inset'
  collapsible?: 'icon' | 'none'
}) {
  const { state } = useSidebar()

  return (
    // `lg` rather than shadcn's `md`: the shell's breakpoint policy is that the
    // sidebar appears only where there is room for a content column beside it
    // (§2.4). Hidden by CSS, never unmounted.
    <div
      className="group peer hidden text-sidebar-foreground lg:block"
      data-slot="sidebar"
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      data-variant={variant}
    >
      {/* Holds the layout gap open so the inset content doesn't sit under the
          fixed panel. Width-animated in step with it. */}
      <div
        className={cn(
          'relative h-dvh w-[var(--sidebar-width)] bg-transparent transition-[width] duration-200 ease-linear',
          variant === 'inset'
            ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+1rem)]'
            : 'group-data-[collapsible=icon]:w-[var(--sidebar-width-icon)]',
        )}
      />
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-10 hidden h-dvh w-[var(--sidebar-width)] transition-[left,right,width] duration-200 ease-linear lg:flex',
          variant === 'inset'
            ? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+1rem)]'
            : 'border-r border-sidebar-border group-data-[collapsible=icon]:w-[var(--sidebar-width-icon)]',
          className,
        )}
        {...props}
      >
        <div
          data-slot="sidebar-inner"
          className="flex h-full w-full flex-col bg-sidebar"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    // A `div`, not shadcn's `main`: routes render their own landmarks, and the
    // app already has exactly one `<main>` inside AppShell.
    <div
      data-slot="sidebar-inset"
      className={cn(
        'relative flex w-full flex-1 flex-col bg-background',
        'lg:peer-data-[variant=inset]:my-2 lg:peer-data-[variant=inset]:mr-2 lg:peer-data-[variant=inset]:rounded-[18px] lg:peer-data-[variant=inset]:shadow-elevation',
        className,
      )}
      {...props}
    />
  )
}

function SidebarRail({ className, ...props }: React.ComponentProps<'button'>) {
  const { toggleSidebar } = useSidebar()

  return (
    <button
      type="button"
      data-slot="sidebar-rail"
      aria-label="Toggle sidebar"
      tabIndex={-1}
      title="Toggle sidebar"
      onClick={toggleSidebar}
      className={cn(
        'absolute inset-y-0 -right-2 z-20 hidden w-4 -translate-x-1/2 cursor-w-resize transition-all ease-linear lg:flex',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 hover:after:bg-sidebar-border',
        'group-data-[state=collapsed]:cursor-e-resize',
        className,
      )}
      {...props}
    />
  )
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<'button'>) {
  const { toggleSidebar } = useSidebar()

  return (
    <button
      type="button"
      data-slot="sidebar-trigger"
      aria-label="Toggle sidebar"
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      className={cn(
        'flex size-8 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink active:scale-[.95]',
        className,
      )}
      {...props}
    >
      <PanelLeft size={18} strokeWidth={1.7} />
    </button>
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-1 overflow-auto group-data-[collapsible=icon]:overflow-hidden',
        className,
      )}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        'section-label flex h-7 shrink-0 items-center px-2 transition-[margin,opacity] duration-200 ease-linear',
        'group-data-[collapsible=icon]:-mt-7 group-data-[collapsible=icon]:opacity-0',
        className,
      )}
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn('flex w-full min-w-0 flex-col gap-0.5', className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn('group/menu-item relative', className)}
      {...props}
    />
  )
}

const sidebarMenuButtonVariants = cva(
  [
    'peer/menu-button flex w-full items-center gap-3 overflow-hidden rounded-xl text-left text-row-title outline-none',
    'transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring',
    'data-[active=true]:bg-sidebar-accent data-[active=true]:text-red',
    // Icon mode squares the button to the rail width and takes the label out
    // of the layout with `sr-only` rather than `hidden`: `display:none` would
    // strip the link's accessible name, and every nav lookup — keyboard,
    // screen reader, and this repo's tests — goes through that name. Relying
    // on `overflow-hidden` alone is not enough either; a 20px icon does not
    // fill a 36px button, so the label leaks out as a clipped first letter.
    'group-data-[collapsible=icon]:!size-9 group-data-[collapsible=icon]:!p-0 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0',
    'group-data-[collapsible=icon]:[&>span:last-child]:sr-only',
    '[&>svg]:shrink-0 [&>span:last-child]:truncate',
  ].join(' '),
  {
    variants: {
      size: {
        default: 'h-10 px-3',
        lg: 'h-12 px-2',
      },
    },
    defaultVariants: { size: 'default' },
  },
)

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  size = 'default',
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof sidebarMenuButtonVariants> & {
    asChild?: boolean
    isActive?: boolean
    tooltip?: string
  }) {
  const Comp = asChild ? Slot.Root : 'button'
  const { state } = useSidebar()

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ size }), className)}
      {...props}
    />
  )

  if (!tooltip) return button

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={state !== 'collapsed'}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      className={cn(
        'pointer-events-none absolute right-2 flex h-5 min-w-5 select-none items-center justify-center rounded-full bg-red px-1.5 text-[11px] font-bold tabular-nums text-white',
        'peer-data-[size=default]/menu-button:top-2.5 peer-data-[size=lg]/menu-button:top-3.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
}
