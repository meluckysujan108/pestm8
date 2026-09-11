import { ChevronDown } from 'lucide-react'
import { SidebarTrigger } from '#/components/ui/sidebar.tsx'
import { AccountMenu } from './AccountMenu'
import type { ReactNode } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'

export function PageHeader({
  kicker,
  title,
  action,
  onKickerClick,
  businessId,
  businessSlug,
}: {
  kicker?: string
  title: string
  action?: ReactNode
  /** Makes the kicker a control — the schedule uses it to open the month grid. */
  onKickerClick?: () => void
  businessId: Id<'businesses'>
  businessSlug: string
}) {
  return (
    <header className="chrome-blur sticky top-0 z-30 flex items-end justify-between gap-3 border-b border-hairline px-4 pb-3 pt-[calc(12px+env(safe-area-inset-top))]">
      {/* Collapse control lives with the page title rather than in the sidebar
          itself, so it stays reachable once the sidebar is down to icons.
          Every PageHeader renders inside AppShell's SidebarProvider, so this
          needs nothing from the nine routes that use it. */}
      <SidebarTrigger className="mb-1 hidden shrink-0 lg:flex" />

      <div className="min-w-0 flex-1">
        {kicker &&
          (onKickerClick ? (
            <button
              type="button"
              onClick={onKickerClick}
              className="mb-0.5 flex items-center gap-1 text-blue"
            >
              <span className="section-label truncate !text-blue">{kicker}</span>
              <ChevronDown size={13} strokeWidth={2.4} />
            </button>
          ) : (
            <p className="section-label mb-0.5 truncate">{kicker}</p>
          ))}
        <h1 className="text-page-title text-ink">{title}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {action}
        <AccountMenu businessId={businessId} businessSlug={businessSlug} />
      </div>
    </header>
  )
}
