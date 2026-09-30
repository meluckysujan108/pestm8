import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Link } from '@tanstack/react-router'
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ListChecks,
  Pin,
  Plus,
} from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { editedLabel } from '#/lib/noteDates'
import { formatJobDate, todayKey } from '#/lib/format'
import { dayKeyOf } from '../../../convex/lib/dates'
import { useHydrated } from '#/lib/useHydrated'
import { personLabel } from '#/lib/assignees'
import { NoteEditor } from './NoteEditor'
import type { Id } from '../../../convex/_generated/dataModel'
import type { DecoratedNote } from '../../../convex/notes'
import type { MentionItem } from './MentionList'
import { RowPending } from '#/components/shell/Pending'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { DeleteButton } from '#/components/primitives/DeleteButton'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { describeError } from '#/components/forms/describeError'
import type { ErrorCopy } from '#/components/forms/describeError'

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
  failed = false,
  onRetry,
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
  /** The query failed: say so, rather than loading for good. */
  failed?: boolean
  /** Asks again — the query's `refetch`. */
  onRetry?: () => void
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
            <Plus size={13} strokeWidth={2.2} />
            {addLabel}
          </button>
        )}
      </div>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {notes === undefined && failed ? (
          <div className="p-2">
            <LoadFailed what="the notes" onRetry={onRetry} />
          </div>
        ) : notes === undefined ? (
          <RowPending label="Loading notes" />
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

/**
 * One note as a row that opens in place into the synced editor. A note on a
 * job says which visit it was written on, unless it is shown on that visit's
 * own sheet (`showJob` false).
 */
export function InlineNote({
  businessId,
  businessSlug,
  timezone,
  note,
  members,
  open,
  onToggle,
  showJob = true,
  autoFocus = false,
  linkJob = false,
  discardIfEmpty = false,
  deleteFocus,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  note: DecoratedNote
  members: Array<MentionItem>
  open: boolean
  onToggle: () => void
  showJob?: boolean
  /** Just made by a tap on "+ … note": the caret goes to its first line,
   * the title, ready to type. */
  autoFocus?: boolean
  /** Away from its job (a client's sheet): open, it offers the job itself. */
  linkJob?: boolean
  /** Made here just now with "+ … note": closed with nothing in it, it is
   * cleared away rather than left as an empty "New note". */
  discardIfEmpty?: boolean
  /** Where focus goes once it is deleted and its row has gone. */
  deleteFocus?: () => HTMLElement | null
}) {
  const hydrated = useHydrated()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const convexDelete = useConvexMutation(api.notes.softDelete)
  // Focus follows a delete only once it has happened: a refusal leaves the
  // row, and focus with it.
  const deleted = useRef(false)
  const remove = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; noteId: Id<'notes'> }) =>
      convexDelete(args),
    onSuccess: () => {
      deleted.current = true
      setConfirmDelete(false)
    },
  })

  // Closed, or taken off screen, while still empty: cleared away. Read
  // through refs, as the unmount's cleanup sees only the first render.
  // Only the first close asks — after that it is a note like any other,
  // with Delete for when it is not wanted — and never once it has been
  // opened in Notes, where it is still being written. Closed before its
  // editor had loaded, nothing can have been typed here: the server, which
  // keeps anything with something in it, decides.
  const empty = useRef<boolean | undefined>(undefined)
  const settled = useRef(false)
  const closedSave = useRef<Promise<void> | undefined>(undefined)
  const row = useRef<HTMLDivElement>(null)
  const convexDiscard = useConvexMutation(api.notes.discardEmpty)
  const discard = useRef(() => {})
  discard.current = () => {
    if (settled.current || !discardIfEmpty) return
    settled.current = true
    if (empty.current === false) return
    const here = row.current
    const hadFocus = here?.contains(document.activeElement) ?? false
    // After the editor's own save as it closed — asked first, the server
    // would see edits without their saved copy, and keep the note. Its
    // report comes in the same commit, before or after this runs (a closed
    // sheet cleans up the row before the editor inside it), so it is read
    // once that commit is done.
    void Promise.resolve()
      .then(() => closedSave.current)
      // Never an error: the server keeps anything with something in it.
      .then(() => convexDiscard({ businessId, noteId: note._id }))
      .then((gone) => {
        // Its row goes from under the focus: on to what the section offers
        // next, unless focus has moved on of itself.
        const active = document.activeElement
        if (
          gone &&
          hadFocus &&
          (here?.contains(active) || !onAControl(active))
        ) {
          deleteFocus?.()?.focus({ preventScroll: true })
        }
      })
      .catch(() => {})
  }
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) discard.current()
    wasOpen.current = open
  }, [open])
  // Taken off screen open. Decided once the commit is done: in development
  // React unmounts and remounts every new row at once, to test it, and that
  // is not a close.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      queueMicrotask(() => {
        if (!mounted.current && wasOpen.current) discard.current()
      })
    }
  }, [])

  return (
    <div ref={row} className="border-b border-hairline-2 last:border-b-0">
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
                <ListChecks size={12} strokeWidth={2.4} />
                {note.checklistDone}/{note.checklistTotal}
              </span>
            ) : null}
          </span>
          {showJob && note.job && (
            <span className="mt-0.5 block truncate text-caption text-ink-2">
              {note.job.jobNumber !== undefined && `Job #${note.job.jobNumber} · `}
              {note.job.jobType} ·{' '}
              {formatJobDate(
                dayKeyOf(note.job.scheduledAt, timezone),
                todayKey(timezone),
              )}
            </span>
          )}
        </span>
        <ChevronDown
          size={16}
          strokeWidth={2.2}
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
            autoFocus={autoFocus}
            onEmptyChange={(isEmpty) => {
              empty.current = isEmpty
            }}
            onClosed={(saved) => {
              closedSave.current = saved
            }}
            inline
            trailingTools={
              <Link
                to="/$businessSlug/notes"
                params={{ businessSlug }}
                // All Notes: the library opens on My notes, which never
                // lists a note from a job or client sheet.
                search={{ noteId: note._id, filter: 'all' }}
                onClick={() => {
                  settled.current = true
                }}
                aria-label="Open in Notes"
                className="flex size-9 items-center justify-center rounded-lg text-blue"
              >
                <ArrowUpRight size={18} strokeWidth={1.7} />
              </Link>
            }
          />
          {note.canDelete && (
            <DeleteButton
              className="mt-2"
              disabled={!hydrated || remove.isPending}
              onClick={() => {
                remove.reset()
                setConfirmDelete(true)
              }}
            >
              Delete note
            </DeleteButton>
          )}
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title="Delete this note?"
            body="It goes to Recently deleted in Notes, and can be restored from there for 30 days."
            cancel="Keep note"
            confirm="Delete"
            closeOnConfirm={false}
            pending={remove.isPending}
            pendingLabel="Deleting…"
            error={
              remove.isError ? describeError(remove.error, DELETE_COPY) : null
            }
            // Its row goes with it: focus to what the section offers next.
            returnFocus={() =>
              deleted.current ? (deleteFocus?.() ?? null) : null
            }
            onConfirm={() =>
              remove.mutate({ businessId, noteId: note._id })
            }
          />
          {linkJob && note.jobId && note.job && (
            <Link
              to="/$businessSlug/schedule"
              params={{ businessSlug }}
              search={{
                date: dayKeyOf(note.job.scheduledAt, timezone),
                jobId: note.jobId,
              }}
              className="mt-1 flex min-h-11 items-center justify-between gap-2 rounded-lg px-1 text-body font-semibold text-blue"
            >
              {note.job.jobNumber !== undefined
                ? `Open job #${note.job.jobNumber}`
                : 'Open the job'}
              <ChevronRight
                aria-hidden
                size={16}
                strokeWidth={2.2}
                className="text-muted-2"
              />
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Whether focus sits on something a person moved it to. When the focused
 * element leaves the page, focus falls to the page itself — or, inside a
 * sheet, to the sheet, which keeps it from leaving — and neither is one.
 */
function onAControl(active: Element | null): boolean {
  return (
    active instanceof HTMLElement &&
    active !== document.body &&
    active.getAttribute('role') !== 'dialog' &&
    active.tabIndex >= 0
  )
}

/** Deleting a note, refused — in words. */
const DELETE_COPY: ErrorCopy = {
  NO_ACCESS:
    'Could not delete: only whoever wrote it, or the business owner, can delete this note.',
  IN_RECYCLE_BIN:
    'Could not delete: it is in the Recycle bin with its job or client, and goes or comes back with them.',
  NOT_FOUND: 'Could not delete: it has changed since you opened it.',
  default: 'Could not delete the note. Check your signal and try again.',
}

/** The mention roster for a sheet's editors. */
export function useMentionRoster(businessId: Id<'businesses'>): Array<MentionItem> {
  const { data } = useQuery(convexQuery(api.memberships.listForBusiness, { businessId }))
  return (data ?? [])
    .filter((m) => m.status === 'active')
    .map((m) => ({ id: m._id, label: personLabel(m), colour: m.colour, role: m.role }))
}
