import {
  BarChart3,
  Briefcase,
  CalendarDays,
  Contact,
  FileText,
  Package,
  Settings,
  StickyNote,
  Target,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/** The two sections that carry a badge, named by route rather than by label,
 * so renaming a tab cannot quietly drop its badge. */
export const NOTES_TO = '/$businessSlug/notes'
export const JOB_TO = '/$businessSlug/job'

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
 * The app has more sections than a phone dock can hold legibly, so they are
 * split: four destinations a technician uses every day, and a burger holding
 * the rest. Four plus the burger is five cells, and five is what fits at 390px
 * without the labels truncating.
 */
export const PRIMARY_NAV: Array<NavItem> = [
  { to: '/$businessSlug/schedule', label: 'Schedule', icon: CalendarDays },
  // Contact, not Users: Users is the team, and the two sat side by side in
  // the sidebar and Settings meaning different people.
  { to: '/$businessSlug/clients', label: 'Clients', icon: Contact },
  { to: '/$businessSlug/reports', label: 'Reports', icon: FileText },
  { to: NOTES_TO, label: 'Notes', icon: StickyNote },
]

/** Behind the burger: the sections that are not a daily destination. */
export const MORE_NAV: Array<NavItem> = [
  { to: JOB_TO, label: 'Jobs', icon: Briefcase },
  { to: '/$businessSlug/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/$businessSlug/products', label: 'Products', icon: Package },
  { to: '/$businessSlug/leads', label: 'Leads', icon: Target },
]

/** Settings is separate for the same layout reason it always was: it is pinned
 * to the bottom of the sidebar rather than living in a list. Both navs still
 * read it from this one declaration. */
export const SETTINGS_ITEM: NavItem = {
  to: '/$businessSlug/settings',
  label: 'Settings',
  icon: Settings,
}

/** What the burger menu holds, in order, with Settings last. */
export const MORE_ITEMS: Array<NavItem> = [...MORE_NAV, SETTINGS_ITEM]
