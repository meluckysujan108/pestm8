import type { ReactNode } from 'react'

export function PageHeader({
  kicker,
  title,
  action,
}: {
  kicker?: string
  title: string
  action?: ReactNode
}) {
  return (
    <header className="chrome-blur sticky top-0 z-30 flex items-end justify-between gap-3 border-b border-hairline px-4 pb-3 pt-[calc(12px+env(safe-area-inset-top))]">
      <div>
        {kicker && <p className="section-label mb-0.5">{kicker}</p>}
        <h1 className="text-page-title text-ink">{title}</h1>
      </div>
      {action}
    </header>
  )
}
