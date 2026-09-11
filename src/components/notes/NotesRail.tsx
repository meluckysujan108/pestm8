import { AtSign, Briefcase, MapPin, Notebook, Trash2, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { LibraryFilter } from './NoteList'

export const LIBRARY_FILTERS: Array<{ value: LibraryFilter; label: string; icon: LucideIcon }> = [
  { value: 'all', label: 'All Notes', icon: Notebook },
  { value: 'mentions', label: 'Mentions', icon: AtSign },
  { value: 'jobs', label: 'Jobs', icon: Briefcase },
  { value: 'sites', label: 'Sites & clients', icon: MapPin },
  { value: 'team', label: 'Team', icon: Users },
  { value: 'trash', label: 'Recently Deleted', icon: Trash2 },
]

/**
 * The desktop library's left column — the phone app's folder list, except
 * the folders are what a note is about rather than something you file it
 * under. Styled like the app sidebar's own rows so the two read as one nav.
 */
export function NotesRail({
  value,
  unreadMentions,
  onChange,
}: {
  value: LibraryFilter
  unreadMentions: number
  onChange: (next: LibraryFilter) => void
}) {
  return (
    <nav aria-label="Notes folders" className="flex flex-col gap-0.5 p-2">
      {LIBRARY_FILTERS.map((f) => (
        <button
          key={f.value}
          type="button"
          data-active={f.value === value || undefined}
          onClick={() => onChange(f.value)}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-row-title text-ink transition-colors hover:bg-sidebar-accent data-[active]:bg-sidebar-accent data-[active]:text-red"
        >
          <f.icon size={19} strokeWidth={1.8} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{f.label}</span>
          {f.value === 'mentions' && unreadMentions > 0 && (
            <span className="rounded-full bg-blue px-1.5 text-[11px] font-bold leading-[18px] text-white">
              {unreadMentions >= 10 ? '9+' : unreadMentions}
            </span>
          )}
        </button>
      ))}
    </nav>
  )
}
