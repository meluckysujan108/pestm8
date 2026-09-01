import { Link, useParams } from '@tanstack/react-router'
import { ChevronDown, Settings } from 'lucide-react'
import type { ReactNode } from 'react'

export function PageHeader({
  kicker,
  title,
  action,
  onKickerClick,
}: {
  kicker?: string
  title: string
  action?: ReactNode
  /** Makes the kicker a control — the schedule uses it to open the month grid. */
  onKickerClick?: () => void
}) {
  // Settings is reached from the avatar, not a seventh tab (§2.2).
  const params = useParams({ strict: false }) as { businessSlug?: string }

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
        {params.businessSlug && (
          <Link
            to="/$businessSlug/settings"
            params={{ businessSlug: params.businessSlug }}
            aria-label="Settings"
            className="flex size-9 items-center justify-center rounded-full bg-surface-2 text-row-title text-ink-2 transition active:scale-[.95]"
          >
            <Settings size={18} strokeWidth={1.7} />
          </Link>
        )}
      </div>
    </header>
  )
}
