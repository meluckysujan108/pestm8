import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, ChevronDown, ListChecks, Pin, Plus } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { editedLabel } from '#/lib/noteDates'
import { useHydrated } from '#/lib/useHydrated'
import { NoteEditor } from './NoteEditor'
import type { Id } from '../../../convex/_generated/dataModel'
import type { DecoratedNote } from '../../../convex/notes'
import type { MentionItem } from './MentionList'

/**
 * Notes inside a job or client sheet. Rows expand in place into the same
 * synced editor the library uses, so there is one way to write a note
 * wherever you are — with a link out to the library for the full view.
 */
export function InlineNotesSection({
  businessId,
  businessSlug,
  timezone,
  label,
  notes,
  members,
  empty,
  addLabel,
  onAdd,
  adding,
  openId,
  onOpen,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  label: string
  notes: Array<DecoratedNote> | undefined
  members: Array<MentionItem>
  empty: string
  addLabel: string
  onAdd?: () => void
  adding?: boolean
  openId: Id<'notes'> | null
  onOpen: (id: Id<'notes'> | null) => void
}) {
  const hydrated = useHydrated()

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="section-label">{label}</h3>
        {onAdd && (
          <button
            type="button"
            disabled={!hydrated || adding}
            onClick={onAdd}
            className="flex items-center gap-1 text-caption font-semibold text-blue disabled:opacity-50"
          >
            <Plus size={13} strokeWidth={2.4} />
            {addLabel}
          </button>
        )}
      </div>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {notes === undefined ? (
          <p className="px-3.5 py-3 text-caption text-muted">Loading…</p>
        ) : notes.length === 0 ? (
          <p className="px-3.5 py-3 text-body text-muted">{empty}</p>
        ) : (
          notes.map((note) => (
            <InlineNote
              key={note._id}
              businessId={businessId}
              businessSlug={businessSlug}
              timezone={timezone}
              note={note}
              members={members}
              open={openId === note._id}
              onToggle={() => onOpen(openId === note._id ? null : note._id)}
            />
          ))
        )}
      </div>
    </section>
  )
}

function InlineNote({
  businessId,
  businessSlug,
  timezone,
  note,
  members,
  open,
  onToggle,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  note: DecoratedNote
  members: Array<MentionItem>
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="border-b border-hairline-2 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-start gap-2.5 px-3.5 py-3 text-left"
      >
        <span
          aria-hidden
          className="mt-1.5 size-2 shrink-0 rounded-full"
          style={{ backgroundColor: note.authorColour }}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-row-title text-ink">{note.title || 'New note'}</span>
            {note.pinnedAt !== undefined && (
              <Pin size={12} strokeWidth={2.4} className="shrink-0 text-amber-ink" fill="currentColor" />
            )}
          </span>
          {!open && note.preview && (
            <span className="mt-0.5 line-clamp-2 text-body text-ink-2">{note.preview}</span>
          )}
          <span className="mt-0.5 flex items-center gap-2 text-caption text-muted">
            <span className="truncate">
              {note.authorName}
              {note.authorRole === 'owner' ? ' · Owner' : ''} ·{' '}
              {editedLabel(note.updatedAt, timezone, Date.now())}
            </span>
            {note.checklistTotal ? (
              <span className="flex shrink-0 items-center gap-1">
                <ListChecks size={12} strokeWidth={2.2} />
                {note.checklistDone}/{note.checklistTotal}
              </span>
            ) : null}
          </span>
        </span>
        <ChevronDown
          size={16}
          strokeWidth={2}
          className={`mt-1 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="border-t border-hairline-2 px-2.5 pb-3 pt-1">
          <NoteEditor
            businessId={businessId}
            noteId={note._id}
            members={members}
            editable={note.canEdit}
            inline
            trailingTools={
              <Link
                to="/$businessSlug/notes"
                params={{ businessSlug }}
                search={{ noteId: note._id }}
                aria-label="Open in Notes"
                className="flex size-9 items-center justify-center rounded-lg text-blue"
              >
                <ArrowUpRight size={18} strokeWidth={2.2} />
              </Link>
            }
          />
        </div>
      )}
    </div>
  )
}

/** The mention roster for a sheet's editors. */
export function useMentionRoster(businessId: Id<'businesses'>): Array<MentionItem> {
  const { data } = useQuery(convexQuery(api.memberships.listForBusiness, { businessId }))
  return (data ?? [])
    .filter((m) => m.status === 'active')
    .map((m) => ({ id: m._id, label: m.name || m.email, colour: m.colour, role: m.role }))
}
