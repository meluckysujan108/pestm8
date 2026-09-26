import {
  AtSign,
  BookUser,
  Briefcase,
  MapPin,
  Notebook,
  NotebookPen,
  Trash2,
  Users,
} from 'lucide-react'
import { useAccess } from '#/lib/access'
import type { LucideIcon } from 'lucide-react'
import type { LibraryFilter } from './NoteList'

export const LIBRARY_FILTERS: Array<{ value: LibraryFilter; label: string; icon: LucideIcon }> = [
  { value: 'mine', label: 'My notes', icon: NotebookPen },
  { value: 'all', label: 'All Notes', icon: Notebook },
  { value: 'mentions', label: 'Mentions', icon: AtSign },
  { value: 'jobs', label: 'Jobs', icon: Briefcase },
  { value: 'sites', label: 'Sites & clients', icon: MapPin },
  { value: 'team', label: 'Team', icon: Users },
  { value: 'everyone', label: 'Everyone’s notes', icon: BookUser },
  { value: 'trash', label: 'Recently Deleted', icon: Trash2 },
]

/**
 * The folders this person is offered. "Everyone's notes" — the team's
 * personal notes — only to the owner in God view as himself: not in "Just my
 * jobs", not switched into an account, not looking through anyone. That is
 * the one view in which he has asked to see the whole business.
 */
export function useLibraryFolders() {
  const access = useAccess()
  const godView = access.view?.mode === 'everyone' && access.viewingAs === null
  return {
    godView,
    folders: LIBRARY_FILTERS.filter((f) => f.value !== 'everyone' || godView),
  }
}

/**
 * The desktop library's left column — the phone app's folder list. My notes
 * and Everyone's notes are whose a note is; the rest are what it is about,
 * rather than something you file it under. Styled like the app sidebar's own
 * rows so the two read as one nav.
 */
export function NotesRail({
  folders,
  value,
  unreadMentions,
  onChange,
}: {
  folders: typeof LIBRARY_FILTERS
  value: LibraryFilter
  unreadMentions: number
  onChange: (next: LibraryFilter) => void
}) {
  return (
    <nav aria-label="Notes folders" className="flex flex-col gap-0.5 p-2">
      {folders.map((f) => (
        <button
          key={f.value}
          type="button"
          data-active={f.value === value || undefined}
          onClick={() => onChange(f.value)}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-row-title text-ink transition-colors hover:bg-sidebar-accent data-[active]:bg-sidebar-accent data-[active]:text-red"
        >
          <f.icon size={19} strokeWidth={1.7} className="shrink-0" />
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
