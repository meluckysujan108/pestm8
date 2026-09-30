import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Plus } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { InlineNote, useMentionRoster } from './InlineNotes'
import { useHydrated } from '#/lib/useHydrated'
import { RowPending } from '#/components/shell/Pending'
import { LoadFailed } from '#/components/primitives/EmptyState'
import type { ReactNode, Ref } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'
import type { DecoratedNote } from '../../../convex/notes'

type Create =
  | { kind: 'site'; propertyId: Id<'properties'>; addressLine: string }
  | { kind: 'client' }

/**
 * Everything written about a client, sorted by what it is for: what to know
 * before arriving at each of their sites, what is true of the client
 * wherever the work is, and what was written on their visits.
 *
 * They were one list, site, client and visit notes mixed with nothing to
 * say which was which (30 Sept 2026). The groups are the ones a job's own
 * Notes card uses (`JobNotesSection`), from the one query that has all
 * three (`notes.listForClient`).
 */
export function ClientNotesSection({
  businessId,
  businessSlug,
  timezone,
  clientId,
  clientName,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  clientId: Id<'clients'>
  clientName: string
}) {
  const [openId, setOpenId] = useState<Id<'notes'> | null>(null)
  // The note just made, whose first line takes the caret as it opens.
  const [createdId, setCreatedId] = useState<Id<'notes'> | null>(null)
  // Notes made here, this time: closed with nothing in them, they are
  // cleared away (InlineNote `discardIfEmpty`).
  const [made, setMade] = useState<ReadonlySet<Id<'notes'>>>(new Set())
  const aboutButton = useRef<HTMLButtonElement>(null)
  const members = useMentionRoster(businessId)
  const hydrated = useHydrated()
  const notesQuery = useQuery(
    convexQuery(api.notes.listForClient, { businessId, clientId }),
  )
  const propertiesQuery = useQuery(
    convexQuery(api.properties.listByClient, { businessId, clientId }),
  )
  const notes = notesQuery.data
  const properties = propertiesQuery.data

  const convexCreate = useConvexMutation(api.notes.create)
  const create = useMutation({
    mutationFn: (what: Create) =>
      what.kind === 'site'
        ? convexCreate({
            businessId,
            template: 'siteAccess',
            title: what.addressLine,
            propertyId: what.propertyId,
          })
        : convexCreate({ businessId, clientId, template: 'blank', title: '' }),
    // Opened as it is made. A note about the client starts empty, so the
    // caret goes to its first line, the title; a site note starts headed by
    // the address, which a keystroke would run into.
    onSuccess: (id, what) => {
      setCreatedId(what.kind === 'client' ? id : null)
      setOpenId(id)
      setMade((ids) => new Set(ids).add(id))
    },
  })

  const row = (note: DecoratedNote, fromVisit = false) => (
    <InlineNote
      key={note._id}
      businessId={businessId}
      businessSlug={businessSlug}
      timezone={timezone}
      note={note}
      members={members}
      showJob={fromVisit}
      linkJob={fromVisit}
      autoFocus={createdId === note._id}
      discardIfEmpty={made.has(note._id)}
      deleteFocus={() => aboutButton.current}
      open={openId === note._id}
      onToggle={() => {
        setCreatedId(null)
        setOpenId(openId === note._id ? null : note._id)
      }}
    />
  )

  const failed = notesQuery.isError || propertiesQuery.isError
  if (notes === undefined || properties === undefined) {
    return (
      <Section label="Notes">
        {failed ? (
          <div className="p-2">
            <LoadFailed
              what="the notes"
              onRetry={() => {
                void notesQuery.refetch()
                void propertiesQuery.refetch()
              }}
            />
          </div>
        ) : (
          <RowPending label="Loading notes" />
        )}
      </Section>
    )
  }

  const site = notes.filter((n) => n.kind === 'site')
  const about = notes.filter((n) => n.kind === 'client')
  const visits = notes.filter((n) => n.kind === 'job')
  const known = new Set<string>(properties.map((p) => p._id))
  // A site note for a site no longer listed (in the Recycle bin with it,
  // say) is still the client's, and still shown.
  const elsewhere = site.filter(
    (n) => n.propertyId === undefined || !known.has(n.propertyId),
  )
  const many = properties.length > 1
  const busy = !hydrated || create.isPending
  // `notes.listForClient` brings the 50 newest of their site and client
  // notes. Those are shared with the whole business, so fewer than 50 back
  // means none were left out; 50 means some may have been, and an empty site
  // can't be said to have nothing on file.
  const cut = site.length + about.length >= 50
  // A failed add says so where it was tapped, not at the foot of the tab.
  const failedAdd = create.isError ? create.variables : undefined
  const addFailed = (
    <p role="alert" className="px-3.5 pb-3 text-caption text-amber-ink">
      Could not add the note. Check your signal and try again.
    </p>
  )

  const addSite = (property: {
    _id: Id<'properties'>
    addressLine: string
  }) => (
    <AddButton
      label={`Site note for ${property.addressLine}`}
      disabled={busy}
      onClick={() =>
        create.mutate({
          kind: 'site',
          propertyId: property._id,
          addressLine: property.addressLine,
        })
      }
    >
      Site note
    </AddButton>
  )

  return (
    <>
      <Section
        label="Before you arrive"
        action={properties.length === 1 && addSite(properties[0])}
      >
        {properties.length === 0 && elsewhere.length === 0 && (
          <Empty>Add a property to keep notes for its site.</Empty>
        )}
        {properties.map((property) => {
          const own = site.filter((n) => n.propertyId === property._id)
          return (
            <Group
              key={property._id}
              label={many ? property.addressLine : undefined}
              action={many && addSite(property)}
            >
              {own.length > 0 ? (
                own.map((note) => row(note))
              ) : cut ? (
                <Empty>
                  None among their newest notes. Older ones are in Notes.
                </Empty>
              ) : (
                <Empty>
                  Nothing on file for this site yet — gate code, dog, where the
                  key lives.
                </Empty>
              )}
              {failedAdd?.kind === 'site' &&
                failedAdd.propertyId === property._id &&
                addFailed}
            </Group>
          )
        })}
        {elsewhere.length > 0 && (
          <Group label="Other sites">
            {elsewhere.map((note) => row(note))}
          </Group>
        )}
      </Section>

      <Section
        label="About this client"
        action={
          <AddButton
            label={`Add note about ${clientName}`}
            buttonRef={aboutButton}
            disabled={busy}
            onClick={() => create.mutate({ kind: 'client' })}
          >
            Add note
          </AddButton>
        }
      >
        {about.length > 0 ? (
          about.map((note) => row(note))
        ) : (
          <Empty>
            Billing quirks, who to call, how they like to be contacted.
          </Empty>
        )}
        {failedAdd?.kind === 'client' && addFailed}
      </Section>

      {visits.length > 0 && (
        <Section label={`From visits · ${visits.length}`}>
          {visits.map((note) => row(note, true))}
        </Section>
      )}

      {cut && (
        <p className="mt-3 text-caption text-muted">
          Only their 50 newest notes are shown here. Notes has every one.
        </p>
      )}
    </>
  )
}

function Section({
  label,
  action,
  children,
}: {
  label: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex min-h-5 items-center justify-between gap-2">
        <h3 className="section-label">{label}</h3>
        {action}
      </div>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {children}
      </div>
    </section>
  )
}

function Group({
  label,
  action,
  children,
}: {
  label?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="border-t border-hairline-2 first:border-t-0">
      {label && (
        <div className="flex items-center justify-between gap-2 px-3.5 pb-1 pt-3">
          <h4 className="section-label truncate">{label}</h4>
          {action}
        </div>
      )}
      <div>{children}</div>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3.5 py-3 text-body text-muted">{children}</p>
}

function AddButton({
  label,
  children,
  onClick,
  disabled,
  buttonRef,
}: {
  label: string
  children: ReactNode
  onClick: () => void
  disabled: boolean
  buttonRef?: Ref<HTMLButtonElement>
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="relative tap-target flex shrink-0 items-center gap-1 text-caption font-semibold text-blue disabled:opacity-50"
    >
      <Plus aria-hidden size={13} strokeWidth={2.2} />
      {children}
    </button>
  )
}
