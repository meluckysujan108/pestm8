import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Link } from '@tanstack/react-router'
import { AlertDialog, DropdownMenu, Popover } from 'radix-ui'
import {
  Briefcase,
  ChevronLeft,
  Link2,
  MapPin,
  MoreHorizontal,
  Pin,
  PinOff,
  RotateCcw,
  Search,
  Trash2,
  User,
} from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { editedLabel } from '#/lib/noteDates'
import { useHydrated } from '#/lib/useHydrated'
import type { Id } from '../../../convex/_generated/dataModel'
import type { ReactNode } from 'react'

type NoteMeta = {
  _id: Id<'notes'>
  kind: 'job' | 'site' | 'client' | 'team'
  jobId?: Id<'jobs'>
  propertyId?: Id<'properties'>
  job: { jobNumber?: number; jobType: string; scheduledAt: number } | null
  clientName: string
  addressLine: string
  suburb: string
  editorName: string
  updatedAt: number
  pinnedAt?: number
  deletedAt?: number
  canEdit: boolean
  canDelete: boolean
}

/**
 * What a note is about, and what you can do to it. Links are chips (a job
 * chip opens that job); pinning and deleting live in the overflow, as they
 * do on the phone. A note in Recently Deleted swaps the overflow for
 * Restore / Delete permanently and the body below is read-only.
 */
export function NoteEditorHeader({
  businessId,
  businessSlug,
  timezone,
  note,
  initialPickerOpen = false,
  onBack,
  onGone,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  note: NoteMeta
  initialPickerOpen?: boolean
  onBack: () => void
  onGone: () => void
}) {
  const hydrated = useHydrated()
  const [pickerOpen, setPickerOpen] = useState(initialPickerOpen)
  const [confirmPurgeOpen, setConfirmPurgeOpen] = useState(false)

  const togglePin = useNoteMutation(api.notes.togglePin)
  const softDelete = useNoteMutation(api.notes.softDelete, onGone)
  const restore = useNoteMutation(api.notes.restore)
  const remove = useNoteMutation(api.notes.remove, onGone)
  const convexSetLinks = useConvexMutation(api.notes.setLinks)
  const setLinks = useMutation({
    mutationFn: (
      link:
        | { kind: 'job'; jobId: Id<'jobs'> }
        | { kind: 'property'; propertyId: Id<'properties'> }
        | { kind: 'none' },
    ) => convexSetLinks({ businessId, noteId: note._id, link }),
  })
  // Detaching from a job keeps the site: a visit note becomes site
  // knowledge again rather than an unlinked memo nobody will find.
  const detachFromJob = () =>
    setLinks.mutate(
      note.propertyId ? { kind: 'property', propertyId: note.propertyId } : { kind: 'none' },
    )

  const args = { businessId, noteId: note._id }
  const inTrash = note.deletedAt !== undefined

  return (
    <div className="border-b border-hairline px-3 pb-2 pt-[calc(8px+env(safe-area-inset-top))] lg:px-2 lg:pt-2">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 flex h-9 items-center gap-0.5 pr-2 text-[17px] text-blue lg:hidden"
        >
          <ChevronLeft size={22} strokeWidth={2.2} />
          Notes
        </button>

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {note.job && note.jobId && (
            <Link
              to="/$businessSlug/schedule"
              params={{ businessSlug }}
              search={{ jobId: note.jobId }}
              className="flex max-w-56 items-center gap-1 rounded-full border border-blue/30 bg-blue/12 px-2.5 py-1 text-[13px] font-semibold text-blue"
            >
              <Briefcase size={13} strokeWidth={2.2} className="shrink-0" />
              <span className="truncate">
                {note.job.jobNumber ? `#${note.job.jobNumber} · ` : ''}
                {note.job.jobType}
              </span>
            </Link>
          )}
          {note.kind !== 'team' && (note.addressLine || note.clientName) && (
            <Chip icon={note.kind === 'client' ? <User size={13} strokeWidth={2.2} /> : <MapPin size={13} strokeWidth={2.2} />}>
              {note.kind === 'client'
                ? note.clientName
                : [note.addressLine, note.suburb].filter(Boolean).join(', ')}
            </Chip>
          )}
          {!inTrash && note.canEdit && !note.job && (
            <button
              type="button"
              disabled={!hydrated}
              onClick={() => setPickerOpen(true)}
              className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-hairline px-2.5 py-1 text-[13px] font-semibold text-muted transition hover:bg-surface-2 disabled:opacity-50"
            >
              <Link2 size={13} strokeWidth={2.2} />
              Attach to job
            </button>
          )}
        </div>

        {inTrash ? (
          note.canDelete && (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                disabled={!hydrated || restore.isPending}
                onClick={() => restore.mutate(args)}
                className="flex h-9 items-center gap-1 rounded-full bg-blue/12 px-3 text-[13px] font-semibold text-blue disabled:opacity-50"
              >
                <RotateCcw size={13} strokeWidth={2.2} />
                Restore
              </button>
              <button
                type="button"
                disabled={!hydrated || remove.isPending}
                onClick={() => setConfirmPurgeOpen(true)}
                className="flex h-9 items-center gap-1 rounded-full px-3 text-[13px] font-semibold text-red disabled:opacity-50"
              >
                <Trash2 size={14} strokeWidth={2.2} />
                Delete now
              </button>
            </div>
          )
        ) : (
          <div className="flex shrink-0 items-center">
            {note.canEdit && (
              <button
                type="button"
                aria-label={note.pinnedAt ? 'Unpin note' : 'Pin note'}
                aria-pressed={note.pinnedAt !== undefined}
                disabled={!hydrated}
                onClick={() => togglePin.mutate(args)}
                className={`flex size-9 items-center justify-center rounded-full transition ${
                  note.pinnedAt ? 'text-amber-ink' : 'text-muted hover:bg-surface-2'
                } disabled:opacity-50`}
              >
                {note.pinnedAt ? <Pin size={17} strokeWidth={2.2} fill="currentColor" /> : <Pin size={17} strokeWidth={2} />}
              </button>
            )}
            {(note.canEdit || note.canDelete) && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  aria-label="More"
                  disabled={!hydrated}
                  className="flex size-9 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 disabled:opacity-50"
                >
                  <MoreHorizontal size={19} strokeWidth={2} />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={6}
                    className="z-50 w-56 rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
                  >
                    {note.canEdit && (
                      <>
                        <MenuItem
                          icon={note.pinnedAt ? <PinOff size={16} strokeWidth={2} /> : <Pin size={16} strokeWidth={2} />}
                          onSelect={() => togglePin.mutate(args)}
                        >
                          {note.pinnedAt ? 'Unpin' : 'Pin'}
                        </MenuItem>
                        <MenuItem icon={<Link2 size={16} strokeWidth={2} />} onSelect={() => setPickerOpen(true)}>
                          {note.job ? 'Change job…' : 'Attach to job…'}
                        </MenuItem>
                        {note.kind === 'job' && (
                          <MenuItem icon={<Link2 size={16} strokeWidth={2} />} onSelect={detachFromJob}>
                            Detach from job
                          </MenuItem>
                        )}
                      </>
                    )}
                    {note.canDelete && (
                      <MenuItem
                        icon={<Trash2 size={16} strokeWidth={2} />}
                        onSelect={() => softDelete.mutate(args)}
                        destructive
                      >
                        Delete
                      </MenuItem>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </div>
        )}
      </div>

      <p className="mt-1 truncate px-1 text-caption text-muted">
        {inTrash
          ? 'In Recently Deleted · gone for good after 30 days'
          : `Edited ${note.editorName ? `by ${note.editorName} · ` : ''}${editedLabel(note.updatedAt, timezone, Date.now())}`}
      </p>

      <JobPicker
        businessId={businessId}
        timezone={timezone}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        current={note.jobId}
        onPick={(jobId) => {
          if (jobId) setLinks.mutate({ kind: 'job', jobId })
          else detachFromJob()
          setPickerOpen(false)
        }}
      />

      <AlertDialog.Root open={confirmPurgeOpen} onOpenChange={setConfirmPurgeOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/30" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[70] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-canvas p-4 shadow-elevation outline-none">
            <AlertDialog.Title className="text-row-title text-ink">
              Delete this note for good?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1.5 text-body text-ink-2">
              It is removed everywhere, along with its photos and edit history. This cannot be
              undone.
            </AlertDialog.Description>
            <div className="mt-4 flex gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="h-11 flex-1 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.975]"
                >
                  Keep it
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(args)}
                  className="h-11 flex-1 rounded-xl bg-red text-[15px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
                >
                  {remove.isPending ? 'Deleting…' : 'Delete'}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

function useNoteMutation(
  ref: typeof api.notes.togglePin,
  onSuccess?: () => void,
) {
  const fn = useConvexMutation(ref)
  return useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; noteId: Id<'notes'> }) => fn(args),
    onSuccess,
  })
}

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex max-w-56 shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[13px] font-semibold text-ink-2">
      {icon}
      <span className="truncate">{children}</span>
    </span>
  )
}

function MenuItem({
  icon,
  children,
  onSelect,
  destructive,
}: {
  icon: ReactNode
  children: ReactNode
  onSelect: () => void
  destructive?: boolean
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={`flex cursor-default items-center gap-2.5 rounded-xl px-2.5 py-2 text-row-title outline-none data-[highlighted]:bg-surface-2 ${
        destructive ? 'text-red' : 'text-ink'
      }`}
    >
      {icon}
      {children}
    </DropdownMenu.Item>
  )
}

/**
 * "Attach to job": the caller's visible jobs from the last three months to
 * two months ahead, nearest today first, searchable. Anchored to nothing
 * visible on purpose — it is opened from a chip or the overflow, so it
 * floats from the header like the phone's action sheet would.
 */
function JobPicker({
  businessId,
  timezone,
  open,
  onOpenChange,
  current,
  onPick,
}: {
  businessId: Id<'businesses'>
  timezone: string
  open: boolean
  onOpenChange: (open: boolean) => void
  current?: Id<'jobs'>
  onPick: (jobId: Id<'jobs'> | null) => void
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor className="block h-0" />
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[min(92vw,380px)] rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
        >
          {open && (
            <JobPickerList
              businessId={businessId}
              timezone={timezone}
              current={current}
              onPick={onPick}
            />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function JobPickerList({
  businessId,
  timezone,
  current,
  onPick,
}: {
  businessId: Id<'businesses'>
  timezone: string
  current?: Id<'jobs'>
  onPick: (jobId: Id<'jobs'> | null) => void
}) {
  const [now] = useState(() => Date.now())
  const [query, setQuery] = useState('')
  const { data: jobs } = useQuery(convexQuery(api.notes.jobOptions, { businessId, now }))

  const q = query.trim().toLowerCase()
  const shown = (jobs ?? []).filter(
    (j) =>
      !q ||
      `#${j.jobNumber ?? ''} ${j.jobType} ${j.clientName} ${j.suburb}`.toLowerCase().includes(q),
  )
  const when = (ts: number) =>
    new Intl.DateTimeFormat('en-AU', { timeZone: timezone, day: 'numeric', month: 'short' }).format(
      new Date(ts),
    )

  return (
    <>
      <label className="flex items-center gap-2 rounded-xl bg-surface-3 px-3">
        <Search size={17} strokeWidth={1.7} className="text-muted" />
        <span className="sr-only">Search jobs</span>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search jobs"
          className="h-11 flex-1 bg-transparent text-[16px] text-ink outline-none"
        />
      </label>
      <div className="mt-1 max-h-72 overflow-y-auto">
        {current && (
          <button
            type="button"
            onClick={() => onPick(null)}
            className="flex w-full items-center rounded-xl px-2.5 py-2 text-left text-row-title text-red transition hover:bg-surface-2"
          >
            Detach from job
          </button>
        )}
        {jobs === undefined ? (
          <p className="px-2.5 py-3 text-center text-caption text-muted">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="px-2.5 py-3 text-center text-caption text-muted">No jobs match</p>
        ) : (
          shown.map((j) => (
            <button
              key={j._id}
              type="button"
              onClick={() => onPick(j._id)}
              className={`flex w-full flex-col rounded-xl px-2.5 py-2 text-left transition hover:bg-surface-2 ${
                j._id === current ? 'bg-surface-2' : ''
              }`}
            >
              <span className="text-row-title text-ink">
                {j.jobNumber ? `#${j.jobNumber} · ` : ''}
                {j.jobType}
              </span>
              <span className="text-caption text-muted">
                {[j.clientName, j.suburb, when(j.scheduledAt)].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))
        )}
      </div>
    </>
  )
}
