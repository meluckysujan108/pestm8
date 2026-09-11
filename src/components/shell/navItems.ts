import {
  BarChart3,
  CalendarDays,
  FileText,
  Settings,
  StickyNote,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type NavItem = {
  to: string
  label: string
  icon: LucideIcon
}

/**
 * One definition, rendered by both the desktop sidebar and the mobile dock.
 * They were previously two hand-kept copies, with Settings written out a third
 * and fourth time because it is pinned to the end rather than living in the
 * list — which is exactly how a nav item ends up in one nav and not the other.
 *
 * Settings is separate here for the same layout reason, but it is still a
 * single declaration both navs read.
 */
export const NAV_ITEMS: Array<NavItem> = [
  { to: '/$businessSlug/schedule', label: 'Schedule', icon: CalendarDays },
  { to: '/$businessSlug/clients', label: 'Clients', icon: Users },
  { to: '/$businessSlug/reports', label: 'Reports', icon: FileText },
  { to: '/$businessSlug/notes', label: 'Notes', icon: StickyNote },
  { to: '/$businessSlug/analytics', label: 'Analytics', icon: BarChart3 },
]

export const SETTINGS_ITEM: NavItem = {
  to: '/$businessSlug/settings',
  label: 'Settings',
  icon: Settings,
}

/** What the dock renders: the tabs plus Settings, in order. */
export const DOCK_ITEMS: Array<NavItem> = [...NAV_ITEMS, SETTINGS_ITEM]
