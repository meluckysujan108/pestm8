import { useEffect, useState } from 'react'
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { DropdownMenu } from 'radix-ui'
import { ChevronLeft, Plus, Search, X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { FilterDropdown } from '#/components/primitives/FilterDropdown'
import { NOTE_TEMPLATES, NOTE_TEMPLATE_KEYS } from '../../../convex/lib/noteTemplates'
import { useHydrated } from '#/lib/useHydrated'
import { NoteEditor } from './NoteEditor'
import { NoteEditorHeader } from './NoteEditorHeader'
import { NoteList } from './NoteList'
import { LIBRARY_FILTERS, NotesRail } from './NotesRail'
import type { Id } from '../../../convex/_generated/dataModel'
import type { NoteTemplateKey } from '../../../convex/lib/noteTemplates'
import type { LibraryFilter } from './NoteList'

/** Which template the "+" defaults to, given where you are. */
const DEFAULT_TEMPLATE: Record<LibraryFilter, NoteTemplateKey> = {
  all: 'blank',
  mentions: 'blank',
  jobs: 'jobVisit',
  sites: 'siteAccess',
  team: 'teamMemo',
  trash: 'blank',
}

export function NotesLibrary({
  business,
  filter,
  noteId,
  query,
  onFilter,
  onOpen,
  onCreated,
  onQuery,
}: {
  business: { _id: Id<'businesses'>; slug: string; name: string; timezone: string }
  filter: LibraryFilter
  noteId: Id<'notes'> | null
  query: string
  onFilter: (next: LibraryFilter) => void
  onOpen: (id: Id<'notes'> | null) => void
  /** Opens a just-made note, leaving a folder it would not appear in. */
  onCreated: (id: Id<'notes'>, keepFolder: boolean) => void
  onQuery: (q: string) => void
}) {
  const hydrated = useHydrated()
  // A note started from the Jobs folder is meant to be about a job: open
  // the picker straight away rather than leaving it stranded as a memo.
  const [attachOnOpen, setAttachOnOpen] = useState<Id<'notes'> | null>(null)

  const { data: roster } = useSuspenseQuery(
    convexQuery(api.memberships.listForBusiness, { businessId: business._id }),
  )
  const members = roster
    .filter((m) => m.status === 'active')
    .map((m) => ({ id: m._id, label: m.name || m.email, colour: m.colour, role: m.role }))

  const { data: unread } = useQuery(
    convexQuery(api.notes.unreadMentionCount, { businessId: business._id }),
  )

  const convexCreate = useConvexMutation(api.notes.create)
  const create = useMutation({
    mutationFn: (template: NoteTemplateKey) =>
      convexCreate({ businessId: business._id, template }),
    onSuccess: (id) => {
      if (filter === 'jobs') setAttachOnOpen(id)
      // A new note has no links, so only All Notes and Team can show it.
      onCreated(id, filter === 'all' || filter === 'team')
    },
  })

  const newNote = (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label="New note"
        disabled={!hydrated || create.isPending}
        className="flex size-9 items-center justify-center rounded-full bg-red text-white shadow-red transition active:scale-[.95] disabled:opacity-50"
      >
        <Plus size={20} strokeWidth={2.4} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 w-60 rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
        >
          {NOTE_TEMPLATE_KEYS.map((key) => (
            <DropdownMenu.Item
              key={key}
              onSelect={() => create.mutate(key)}
              className="flex cursor-default flex-col rounded-xl px-2.5 py-2 outline-none data-[highlighted]:bg-surface-2"
            >
              <span className="text-row-title text-ink">
                {NOTE_TEMPLATES[key].label}
                {key === DEFAULT_TEMPLATE[filter] && key !== 'blank' ? ' · suggested' : ''}
              </span>
              <span className="text-caption text-muted">{NOTE_TEMPLATES[key].blurb}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )

  const editor = noteId && (
    <OpenNote
      key={noteId}
      businessId={business._id}
      businessSlug={business.slug}
      timezone={business.timezone}
      noteId={noteId}
      members={members}
      attachOnOpen={attachOnOpen === noteId}
      onBack={() => onOpen(null)}
    />
  )

  // One tree for every width, switched by CSS: a phone shows the list OR
  // the open note, a desktop shows rail | list | note. Branching on a JS
  // media query here would first-paint the phone tree on every desktop
  // refresh and remount the editor once the effect caught up.
  return (
    <>
      <div className={noteId ? 'hidden lg:contents' : 'contents'}>
        <PageHeader
          businessId={business._id}
          businessSlug={business.slug}
          kicker={business.name}
          title="Notes"
          action={newNote}
        />
      </div>

      <div className="flex flex-col lg:h-[calc(100dvh-81px)] lg:flex-row">
        <aside className="hidden w-52 shrink-0 overflow-y-auto border-r border-hairline lg:block">
          <NotesRail value={filter} unreadMentions={unread ?? 0} onChange={onFilter} />
        </aside>

        <div
          className={`${noteId ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col lg:w-80 lg:shrink-0 lg:border-r lg:border-hairline`}
        >
          <div className="flex items-center gap-2 px-4 pt-3 lg:px-3">
            <div className="lg:hidden">
              <FilterDropdown
                label="Folder"
                value={filter}
                active={filter !== 'all'}
                options={LIBRARY_FILTERS.map((f) => ({
                  value: f.value,
                  label: f.label,
                  count: f.value === 'mentions' && unread ? unread : undefined,
                }))}
                onChange={(v) => onFilter(v as LibraryFilter)}
              />
            </div>
            <SearchBox value={query} onChange={onQuery} />
          </div>
          <div className="min-h-0 flex-1 lg:overflow-y-auto">
            <NoteList
              businessId={business._id}
              timezone={business.timezone}
              filter={filter}
              query={query}
              selectedId={noteId}
              onSelect={onOpen}
            />
          </div>
        </div>

        <div
          className={`${noteId ? 'flex min-h-dvh' : 'hidden'} min-w-0 flex-1 flex-col lg:flex lg:min-h-0`}
        >
          {editor || (
            <div className="flex flex-1 items-center justify-center p-8 text-center">
              <p className="max-w-xs text-body text-muted">
                Pick a note, or press + to start one. What you type is saved as you go and shared with the team.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function OpenNote({
  businessId,
  businessSlug,
  timezone,
  noteId,
  members,
  attachOnOpen,
  onBack,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  noteId: Id<'notes'>
  members: Array<{ id: string; label: string; colour: string; role: 'owner' | 'subcontractor' }>
  attachOnOpen: boolean
  onBack: () => void
}) {
  const { data: note } = useQuery(convexQuery(api.notes.get, { businessId, noteId }))

  // A phone always needs a way back, whatever state the note is in.
  const back = (
    <button
      type="button"
      onClick={onBack}
      className="flex h-9 items-center gap-0.5 pr-2 text-[17px] text-blue lg:hidden"
    >
      <ChevronLeft size={22} strokeWidth={2.2} />
      Notes
    </button>
  )

  if (note === undefined) {
    return (
      <div className="px-3 pt-[calc(8px+env(safe-area-inset-top))]">
        {back}
        <p className="px-1 py-8 text-center text-caption text-muted">Loading…</p>
      </div>
    )
  }
  if (note === null) {
    return (
      <div className="px-3 pt-[calc(8px+env(safe-area-inset-top))]">
        {back}
        <div className="px-1 py-8 text-center">
          <p className="text-row-title text-ink">This note isn't available</p>
          <button type="button" onClick={onBack} className="mt-2 text-[15px] font-semibold text-blue">
            Back to notes
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <NoteEditorHeader
        businessId={businessId}
        businessSlug={businessSlug}
        timezone={timezone}
        note={note}
        initialPickerOpen={attachOnOpen}
        onBack={onBack}
        onGone={onBack}
      />
      <NoteEditor
        businessId={businessId}
        noteId={noteId}
        members={members}
        editable={note.canEdit}
      />
    </>
  )
}

/** Local state so typing is instant; the URL (and the query) follow after a pause. */
function SearchBox({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (draft === value) return
    const t = setTimeout(() => onChange(draft), 250)
    return () => clearTimeout(t)
  }, [draft, value, onChange])

  return (
    <label className="flex h-10 flex-1 items-center gap-2 rounded-xl bg-surface-3 px-3">
      <Search size={16} strokeWidth={2} className="shrink-0 text-muted" />
      <span className="sr-only">Search notes</span>
      <input
        type="search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search"
        className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {draft && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setDraft('')
            onChange('')
          }}
          className="flex size-5 items-center justify-center rounded-full bg-muted-2/40 text-white"
        >
          <X size={12} strokeWidth={2.6} />
        </button>
      )}
    </label>
  )
}
