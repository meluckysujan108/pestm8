import { Link } from '@tanstack/react-router'
import {
  BarChart3,
  CalendarDays,
  FileText,
  Settings,
  StickyNote,
  Users,
} from 'lucide-react'
import { BusinessSwitcher } from './BusinessSwitcher'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

const TABS: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/$businessSlug/schedule', label: 'Schedule', icon: CalendarDays },
  { to: '/$businessSlug/clients', label: 'Clients', icon: Users },
  { to: '/$businessSlug/reports', label: 'Reports', icon: FileText },
  { to: '/$businessSlug/notes', label: 'Notes', icon: StickyNote },
  { to: '/$businessSlug/analytics', label: 'Analytics', icon: BarChart3 },
]

export type ShellBusiness = {
  name: string
  slug: string
}

export type ShellMembership = {
  role: 'owner' | 'subcontractor'
  colour: string
}

export function AppShell({
  business,
  membership,
  children,
}: {
  business: ShellBusiness
  membership: ShellMembership
  children: ReactNode
}) {
  return (
    <div className="min-h-dvh lg:flex">
      <nav className="hidden w-60 shrink-0 flex-col gap-1 border-r border-hairline bg-surface px-3 py-5 lg:flex">
        <div className="px-2 pb-4">
          <BusinessSwitcher current={business} membership={membership} />
        </div>
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            params={{ businessSlug: business.slug }}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-row-title text-ink-2 transition hover:bg-surface-2 aria-[current=page]:bg-surface-2 aria-[current=page]:text-red"
          >
            <tab.icon size={20} strokeWidth={1.7} />
            {tab.label}
          </Link>
        ))}
        <div className="mt-auto">
          <Link
            to="/$businessSlug/settings"
            params={{ businessSlug: business.slug }}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-row-title text-ink-2 transition hover:bg-surface-2 aria-[current=page]:bg-surface-2 aria-[current=page]:text-red"
          >
            <Settings size={20} strokeWidth={1.7} />
            Settings
          </Link>
        </div>
      </nav>

      {/* 460px phone shell, a wider tablet column, then fluid to 1280 beside
          the sidebar — the same components re-flowed, not a second app (§2.4). */}
      <div className="mx-auto w-full max-w-[460px] md:max-w-[760px] lg:mx-0 lg:max-w-[1280px] lg:flex-1">
        <main className="pb-[calc(64px+env(safe-area-inset-bottom))] lg:pb-0">
          {children}
        </main>
      </div>

      <nav className="chrome-blur fixed inset-x-0 bottom-0 z-40 flex border-t border-hairline pb-[env(safe-area-inset-bottom)] lg:hidden">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            params={{ businessSlug: business.slug }}
            className="flex flex-1 flex-col items-center gap-1 py-2 text-tab-label text-muted transition aria-[current=page]:text-red"
          >
            <tab.icon size={22} strokeWidth={1.7} />
            {tab.label}
          </Link>
        ))}
        <Link
          to="/$businessSlug/settings"
          params={{ businessSlug: business.slug }}
          className="flex flex-1 flex-col items-center gap-1 py-2 text-tab-label text-muted transition aria-[current=page]:text-red"
        >
          <Settings size={22} strokeWidth={1.7} />
          Settings
        </Link>
      </nav>
    </div>
  )
}
