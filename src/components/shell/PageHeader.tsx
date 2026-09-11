import { ChevronDown } from 'lucide-react'
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
      <div className="min-w-0">
        {kicker &&
          (onKickerClick ? (
            <button
              type="button"
              onClick={onKickerClick}
              className="mb-0.5 flex items-center gap-1 text-blue"
            >
              <span className="section-label truncate !text-blue">
                {kicker}
              </span>
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
