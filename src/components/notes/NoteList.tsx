import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { usePaginatedQuery } from 'convex/react'
import { Briefcase, ListChecks, MapPin, Pin, User } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { EmptyState } from '#/components/primitives/EmptyState'
import { editedLabel, noteGroupLabel, noteGroupOf } from '#/lib/noteDates'
import { LIBRARY_FILTERS } from './NotesRail'
import type { Id } from '../../../convex/_generated/dataModel'
import type { DecoratedNote } from '../../../convex/notes'

export type LibraryFilter = 'all' | 'mentions' | 'jobs' | 'sites' | 'team' | 'trash'

const folderLabel = (filter: LibraryFilter) =>
  LIBRARY_FILTERS.find((f) => f.value === filter)?.label ?? 'All Notes'

type Row = DecoratedNote & { unread?: boolean }

const EMPTY: Record<LibraryFilter, { title: string; body: string }> = {
  all: { title: 'No notes yet', body: 'Gate codes, dogs on site, where the key lives — anything the team should know.' },
  mentions: { title: 'Nobody has tagged you', body: 'Notes that @mention you land here.' },
  jobs: { title: 'No job notes', body: 'Attach a note to a job and it shows up on that job too.' },
  sites: { title: 'No site or client notes', body: 'Standing knowledge about a property or a client.' },
  team: { title: 'No team notes', body: 'Procedures, mix ratios, supplier numbers.' },
  trash: { title: 'Recently Deleted is empty', body: 'Deleted notes stay here for 30 days.' },
}

/**
 * The middle column: pinned first, then the phone's date sections (Today,
 * Yesterday, Previous 7 Days, …), newest edited on top. A search term swaps
 * the whole list for full-text hits.
 */
export function NoteList({
  businessId,
  timezone,
  filter,
  query,
  selectedId,
  onSelect,
}: {
  businessId: Id<'businesses'>
  timezone: string
  filter: LibraryFilter
  query: string
  selectedId: Id<'notes'> | null
  onSelect: (id: Id<'notes'>) => void
}) {
  const searching = query.trim() !== ''
  const paging = !searching && filter !== 'mentions'

  const paged = usePaginatedQuery(
    api.notes.list,
    paging ? { businessId, filter } : 'skip',
    { initialNumItems: 30 },
  )
  // The server drops rows the viewer may not see AFTER paginating, so a
  // page can legitimately come back empty with more behind it. Keep asking
  // rather than showing an empty state that is not true.
  const { status: pageStatus, results: pageResults, loadMore } = paged
  useEffect(() => {
    if (paging && pageStatus === 'CanLoadMore' && pageResults.length === 0) loadMore(30)
  }, [paging, pageStatus, pageResults.length, loadMore])

  const { data: pinned } = useQuery({
    ...convexQuery(api.notes.listPinned, { businessId }),
    enabled: filter === 'all' && !searching,
  })
  const { data: mentions } = useQuery({
    ...convexQuery(api.notes.listMentions, { businessId }),
    enabled: filter === 'mentions' && !searching,
  })
  const { data: hits } = useQuery({
    ...convexQuery(api.notes.search, {
      businessId,
      q: query.trim(),
      filter: filter === 'mentions' ? 'all' : filter,
    }),
    enabled: searching,
  })

  const now = Date.now()
  const sections: Array<{ key: string; label: string; rows: Array<Row> }> = []

  if (searching) {
    if (hits && hits.length > 0) {
      sections.push({ key: 'hits', label: `Results in ${folderLabel(filter)}`, rows: hits })
    }
  } else if (filter === 'mentions') {
    const unread = (mentions ?? []).filter((n) => n.unread)
    const read = (mentions ?? []).filter((n) => !n.unread)
    if (unread.length) sections.push({ key: 'unread', label: 'New', rows: unread })
    if (read.length) sections.push({ key: 'read', label: 'Earlier', rows: read })
  } else {
    const pinnedRows: Array<Row> =
      filter === 'all' ? (pinned ?? []) : paged.results.filter((n) => n.pinnedAt !== undefined)
    const pinnedIds = new Set(pinnedRows.map((n) => n._id))
    if (pinnedRows.length && filter !== 'trash') {
      sections.push({ key: 'pinned', label: 'Pinned', rows: pinnedRows })
    }
    const groups = new Map<string, Array<Row>>()
    for (const note of paged.results) {
      if (pinnedIds.has(note._id) && filter !== 'trash') continue
      const key = noteGroupOf(note.deletedAt ?? note.updatedAt, timezone, now)
      groups.set(key, [...(groups.get(key) ?? []), note])
    }
    for (const key of [...groups.keys()].sort()) {
      sections.push({ key, label: noteGroupLabel(key), rows: groups.get(key)! })
    }
  }

  const loading =
    (searching && hits === undefined) ||
    (filter === 'mentions' && mentions === undefined) ||
    (paging && paged.status === 'LoadingFirstPage') ||
    (paging &&
      paged.results.length === 0 &&
      (paged.status === 'CanLoadMore' || paged.status === 'LoadingMore'))

  if (loading) return <p className="px-4 py-8 text-center text-caption text-muted">Loading…</p>

  if (sections.length === 0) {
    return (
      <div className="px-4 py-4">
        {searching ? (
          <EmptyState
            title="No matches"
            body={`Nothing in ${folderLabel(filter)} mentions “${query.trim()}”.`}
          />
        ) : (
          <EmptyState title={EMPTY[filter].title} body={EMPTY[filter].body} />
        )}
      </div>
    )
  }

  return (
    <div className="pb-6">
      {sections.map((section) => (
        <section key={section.key}>
          <h3 className="section-label px-4 pb-1.5 pt-4 lg:px-3">{section.label}</h3>
          <div className="mx-4 overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation lg:mx-2 lg:rounded-xl lg:border-0 lg:bg-transparent lg:shadow-none">
            {section.rows.map((note) => (
              <NoteRow
                key={note._id}
                note={note}
                timezone={timezone}
                now={now}
                selected={note._id === selectedId}
                onSelect={() => onSelect(note._id)}
              />
            ))}
          </div>
        </section>
      ))}
      {!searching && filter !== 'mentions' && paged.status === 'CanLoadMore' && (
        <button
          type="button"
          onClick={() => paged.loadMore(30)}
          className="mx-auto mt-4 block rounded-full bg-surface-2 px-4 py-2 text-[13px] font-semibold text-blue"
        >
          Show more
        </button>
      )}
    </div>
  )
}

function NoteRow({
  note,
  timezone,
  now,
  selected,
  onSelect,
}: {
  note: Row
  timezone: string
  now: number
  selected: boolean
  onSelect: () => void
}) {
  const place =
    note.kind === 'job' && note.job
      ? `${note.job.jobNumber ? `#${note.job.jobNumber} · ` : ''}${note.job.jobType}`
      : note.kind === 'site'
        ? [note.addressLine, note.suburb].filter(Boolean).join(', ')
        : note.kind === 'client'
          ? note.clientName
          : null
  const PlaceIcon = note.kind === 'job' ? Briefcase : note.kind === 'client' ? User : MapPin

  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={`flex w-full gap-3 border-b border-hairline-2 px-3.5 py-3 text-left transition last:border-b-0 lg:rounded-xl lg:border-b-0 ${
        selected ? 'lg:bg-surface-2' : 'hover:bg-surface-2/60'
      }`}
    >
      <span
        aria-hidden
        className="mt-1 w-[3px] shrink-0 self-stretch rounded-full"
        style={{ backgroundColor: note.authorColour }}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {note.unread && <span aria-label="Unread" className="size-2 shrink-0 rounded-full bg-blue" />}
          <span className="truncate text-row-title text-ink">{note.title || 'New note'}</span>
          {note.pinnedAt !== undefined && (
            <Pin size={12} strokeWidth={2.4} className="shrink-0 text-amber-ink" fill="currentColor" />
          )}
        </span>
        <span className="mt-0.5 flex gap-1.5 text-caption">
          <span className="shrink-0 text-ink-2">{editedLabel(note.updatedAt, timezone, now)}</span>
          <span className="truncate text-muted">{note.preview || 'No additional text'}</span>
        </span>
        {(place || note.checklistTotal) && (
          <span className="mt-1 flex items-center gap-2 text-caption text-muted">
            {place && (
              <span className="flex min-w-0 items-center gap-1">
                <PlaceIcon size={12} strokeWidth={2.2} className="shrink-0" />
                <span className="truncate">{place}</span>
              </span>
            )}
            {note.checklistTotal ? (
              <span
                className={`flex shrink-0 items-center gap-1 ${
                  note.checklistDone === note.checklistTotal ? 'text-green' : ''
                }`}
              >
                <ListChecks size={12} strokeWidth={2.2} />
                {note.checklistDone}/{note.checklistTotal}
              </span>
            ) : null}
          </span>
        )}
      </span>
    </button>
  )
}
