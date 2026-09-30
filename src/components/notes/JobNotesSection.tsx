import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { ChevronDown, Plus } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { InlineNote, useMentionRoster } from './InlineNotes'
import { useHydrated } from '#/lib/useHydrated'
import { RowPending } from '#/components/shell/Pending'
import { LoadFailed } from '#/components/primitives/EmptyState'
import type { ReactNode, Ref } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'
import type { DecoratedNote } from '../../../convex/notes'

/**
 * Every note a visit needs, in one card near the top of the job: what the
 * team knows about the site and the client ("Before you arrive", pinned
 * first), then this visit's own notes, then — a tap away — what was written
 * on the site's other visits.
 *
 * All of them are notes in Notes, written in the same editor and shown on the
 * client's sheet, in Notes → Jobs and in search. The job used to carry a
 * plain-text note of its own beside this (29 Sept 2026), in another place
 * and another box, found nowhere else; the business asked for one place
 * (30 Sept 2026), and `insertJobNote` now turns a note typed in New Job into
 * one of these.
 */
export function JobNotesSection({
  businessId,
  businessSlug,
  timezone,
  jobId,
  propertyId,
  addressLine,
  canWriteVisitNote,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  jobId: Id<'jobs'>
  propertyId: Id<'properties'>
  addressLine: string
  /** Whoever may edit the job: a visit note is linked to it, and linking is
   * refused to anyone else (notes.create). A site note is anyone's. */
  canWriteVisitNote: boolean
}) {
  const [openId, setOpenId] = useState<Id<'notes'> | null>(null)
  // The note just made, whose first line takes the caret as it opens.
  const [createdId, setCreatedId] = useState<Id<'notes'> | null>(null)
  const [showOthers, setShowOthers] = useState(false)
  // Notes made here, this time: closed with nothing in them, they are
  // cleared away (InlineNote `discardIfEmpty`).
  const [made, setMade] = useState<ReadonlySet<Id<'notes'>>>(new Set())
  const siteButton = useRef<HTMLButtonElement>(null)
  const members = useMentionRoster(businessId)
  const hydrated = useHydrated()

  const siteQuery = useQuery(
    convexQuery(api.notes.listForProperty, { businessId, propertyId }),
  )
  // This visit's own, by the job itself: never cut off by the site's window
  // of recent visit notes, and never lost to a site the job has moved from.
  const jobQuery = useQuery(
    convexQuery(api.notes.listForJob, { businessId, jobId }),
  )
  const standing = siteQuery.data?.site
  const thisVisit = jobQuery.data
  const others = siteQuery.data?.visits.filter((note) => note.jobId !== jobId)
  const failed = siteQuery.isError || jobQuery.isError

  const convexCreate = useConvexMutation(api.notes.create)
  const create = useMutation({
    mutationFn: (link: 'visit' | 'site') =>
      link === 'visit'
        ? convexCreate({ businessId, template: 'blank', title: '', jobId })
        : convexCreate({
            businessId,
            template: 'siteAccess',
            title: addressLine,
            propertyId,
          }),
    // Opened as it is made. A visit note starts empty, so the caret goes
    // to its first line and the first thing typed is its title; a site
    // note starts headed by the address, which a keystroke would run into.
    onSuccess: (id, link) => {
      setCreatedId(link === 'visit' ? id : null)
      setOpenId(id)
      setMade((ids) => new Set(ids).add(id))
    },
  })

  const row = (note: DecoratedNote, showJob: boolean) => (
    <InlineNote
      key={note._id}
      businessId={businessId}
      businessSlug={businessSlug}
      timezone={timezone}
      note={note}
      members={members}
      showJob={showJob}
      autoFocus={createdId === note._id}
      discardIfEmpty={made.has(note._id)}
      deleteFocus={() => siteButton.current}
      open={openId === note._id}
      onToggle={() => {
        // Opened again later, a note keeps the caret where the person puts it.
        setCreatedId(null)
        setOpenId(openId === note._id ? null : note._id)
      }}
    />
  )

  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">Notes</h3>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {(standing === undefined || thisVisit === undefined) && failed ? (
          <div className="p-2">
            <LoadFailed
              what="the notes"
              onRetry={() => {
                void siteQuery.refetch()
                void jobQuery.refetch()
              }}
            />
          </div>
        ) : standing === undefined ||
          thisVisit === undefined ||
          others === undefined ? (
          <RowPending label="Loading notes" />
        ) : (
          <>
            <Group label="Before you arrive · every visit here">
              {standing.length > 0 ? (
                standing.map((note) => row(note, true))
              ) : (
                <Empty>
                  Nothing on file for this site yet — gate code, dog, where the
                  key lives.
                </Empty>
              )}
            </Group>

            <Group label="This visit">
              {thisVisit.length > 0 ? (
                thisVisit.map((note) => row(note, false))
              ) : (
                <Empty>
                  Anything about this visit — when the tenant is home, what to
                  bring.
                </Empty>
              )}
            </Group>

            {others.length > 0 && (
              <div className="border-t border-hairline-2">
                {/* One button that stays, so focus has somewhere to be. */}
                <button
                  type="button"
                  aria-expanded={showOthers}
                  onClick={() => setShowOthers((shown) => !shown)}
                  className="flex min-h-11 w-full items-center justify-between px-3.5 text-left text-body font-semibold text-blue"
                >
                  Other visits here · {others.length}
                  <ChevronDown
                    aria-hidden
                    size={16}
                    strokeWidth={2.2}
                    className={`text-muted-2 transition-transform ${showOthers ? 'rotate-180' : ''}`}
                  />
                </button>
                {showOthers && (
                  <div className="divide-y divide-hairline-2 border-t border-hairline-2">
                    {others.map((note) => row(note, true))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <div
          className={`grid border-t border-hairline ${canWriteVisitNote ? 'grid-cols-2' : 'grid-cols-1'}`}
        >
          {canWriteVisitNote && (
            <AddButton
              label="Add a visit note"
              disabled={!hydrated || create.isPending}
              onClick={() => create.mutate('visit')}
              divider
            >
              Visit note
            </AddButton>
          )}
          <AddButton
            label="Add a site note"
            buttonRef={siteButton}
            disabled={!hydrated || create.isPending}
            onClick={() => create.mutate('site')}
          >
            Site note
          </AddButton>
        </div>
      </div>
      {create.isError && (
        <p role="alert" className="mt-2 text-caption text-amber-ink">
          Could not add the note. Check your signal and try again.
        </p>
      )}
    </section>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-hairline-2 first:border-t-0">
      <h4 className="section-label px-3.5 pb-1 pt-3">{label}</h4>
      <div className="divide-y divide-hairline-2">{children}</div>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3.5 pb-3 text-body text-muted">{children}</p>
}

function AddButton({
  label,
  children,
  onClick,
  disabled,
  divider = false,
  buttonRef,
}: {
  label: string
  children: ReactNode
  onClick: () => void
  disabled: boolean
  divider?: boolean
  buttonRef?: Ref<HTMLButtonElement>
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-11 items-center justify-center gap-1 text-body font-semibold text-blue disabled:opacity-50 ${divider ? 'border-r border-hairline' : ''}`}
    >
      <Plus aria-hidden size={16} strokeWidth={2.2} />
      {children}
    </button>
  )
}
