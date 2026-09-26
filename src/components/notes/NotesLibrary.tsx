import { useState } from 'react'
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { ChevronLeft, Plus } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import type { Role } from '../../../convex/lib/capabilities'
import { PageHeader } from '#/components/shell/PageHeader'
import { FilterDropdown } from '#/components/primitives/FilterDropdown'
import { SearchBox } from '#/components/primitives/SearchBox'
import { useHydrated } from '#/lib/useHydrated'
import { useAccess } from '#/lib/access'
import { personLabel } from '#/lib/assignees'
import { NoteEditor } from './NoteEditor'
import { NoteEditorHeader } from './NoteEditorHeader'
import { NoteList } from './NoteList'
import { rq } from '#/lib/routeQueries'
import { NotesRail, useLibraryFolders } from './NotesRail'
import type { Id } from '../../../convex/_generated/dataModel'
import type { LibraryFilter } from './NoteList'
import { TextPending } from '#/components/shell/Pending'

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
  const { godView, folders } = useLibraryFolders()
  const isOwner = useAccess().role === 'owner'
  // "Everyone's notes" left in the URL from God view shows My notes in any
  // other view, rather than a folder the rail no longer lists.
  const folder: LibraryFilter =
    filter === 'everyone' && !godView ? 'mine' : filter

  const { data: roster } = useSuspenseQuery(
    rq.roster(business._id),
  )
  const members = roster
    .filter((m) => m.status === 'active')
    .map((m) => ({ id: m._id, label: personLabel(m), colour: m.colour, role: m.role }))

  const { data: unread } = useQuery(
    convexQuery(api.notes.unreadMentionCount, { businessId: business._id }),
  )

  // One tap, a blank page of your own. The template menu that used to sit
  // here is gone at the owner's request: this section is mainly personal
  // notes, and site notes are still written from a job's "Before you arrive".
  const convexCreate = useConvexMutation(api.notes.create)
  const create = useMutation({
    mutationFn: () =>
      convexCreate({ businessId: business._id, visibility: 'private' }),
    // A personal note is listed in My notes and All Notes; from anywhere
    // else, go to My notes to show it.
    onSuccess: (id) => {
      setJustMade(id)
      onCreated(id, folder === 'mine' || folder === 'all')
    },
  })
  // The note + just made opens with the cursor in its title, once; one
  // opened from the list does not steal focus from wherever the person was.
  const [justMade, setJustMade] = useState<Id<'notes'> | null>(null)

  const newNote = (
    <button
      type="button"
      aria-label="New note"
      disabled={!hydrated || create.isPending}
      onClick={() => create.mutate()}
      className="relative tap-target flex size-9 items-center justify-center rounded-full bg-red-fill text-white shadow-red transition active:scale-[.95] disabled:opacity-50"
    >
      <Plus size={20} strokeWidth={2} />
    </button>
  )

  const editor = noteId && (
    <OpenNote
      key={noteId}
      businessId={business._id}
      businessSlug={business.slug}
      timezone={business.timezone}
      noteId={noteId}
      members={members}
      isOwner={isOwner}
      autoFocus={justMade === noteId}
      // Once: reopened later from the list, it must not grab focus again.
      onAutoFocused={() => setJustMade(null)}
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
          <NotesRail
            folders={folders}
            value={folder}
            unreadMentions={unread ?? 0}
            onChange={onFilter}
          />
        </aside>

        <div
          className={`${noteId ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col lg:w-80 lg:shrink-0 lg:border-r lg:border-hairline`}
        >
          <div className="flex items-center gap-2 px-4 pt-3 lg:px-3">
            <div className="lg:hidden">
              <FilterDropdown
                label="Folder"
                value={folder}
                active={folder !== 'mine'}
                options={folders.map((f) => ({
                  value: f.value,
                  label: f.label,
                  count: f.value === 'mentions' && unread ? unread : undefined,
                }))}
                onChange={(v) => onFilter(v as LibraryFilter)}
              />
            </div>
            <SearchBox value={query} onChange={onQuery} label="Search notes" />
          </div>
          <div className="min-h-0 flex-1 lg:overflow-y-auto">
            <NoteList
              businessId={business._id}
              timezone={business.timezone}
              filter={folder}
              query={query}
              selectedId={noteId}
              onSelect={onOpen}
              onNew={() => create.mutate()}
              newDisabled={!hydrated || create.isPending}
            />
          </div>
        </div>

        <div
          className={`${noteId ? 'flex min-h-dvh' : 'hidden'} min-w-0 flex-1 flex-col lg:flex lg:min-h-0`}
        >
          {editor || (
            <div className="flex flex-1 items-center justify-center p-8 text-center">
              <p className="max-w-xs text-body text-muted">
                Pick a note, or press + for a blank page. New notes are your
                own: {isOwner ? 'nobody else can see them' : 'only you and the owner can see them'}.
                What you type is saved as you go.
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
  isOwner,
  autoFocus,
  onAutoFocused,
  onBack,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  noteId: Id<'notes'>
  members: Array<{ id: string; label: string; colour: string; role: Role }>
  isOwner: boolean
  autoFocus: boolean
  onAutoFocused: () => void
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
      <ChevronLeft size={22} strokeWidth={2} />
      Notes
    </button>
  )

  if (note === undefined) {
    return (
      <div className="px-3 pt-[calc(8px+env(safe-area-inset-top))]">
        {back}
        <TextPending />
      </div>
    )
  }
  if (note === null) {
    return (
      <div className="px-3 pt-[calc(8px+env(safe-area-inset-top))]">
        {back}
        <div className="px-1 py-8 text-center">
          <p className="text-row-title text-ink">This note isn't available</p>
          <button type="button" onClick={onBack} className="relative tap-target mt-2 text-body font-semibold text-blue">
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
        isOwner={isOwner}
        onBack={onBack}
        onGone={onBack}
      />
      <NoteEditor
        businessId={businessId}
        noteId={noteId}
        members={members}
        editable={note.canEdit}
        // A personal note tags nobody: whoever is tagged could not open it.
        mentions={!note.private}
        autoFocus={autoFocus}
        onAutoFocused={onAutoFocused}
      />
    </>
  )
}
