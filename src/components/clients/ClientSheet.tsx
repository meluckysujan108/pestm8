import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Link } from '@tanstack/react-router'
import { Drawer } from 'vaul'
import { AlertDialog } from 'radix-ui'
import { Pencil, Plus, Star, Trash2, X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { ClientNotesSection } from '#/components/notes/ClientNotesSection'
import { ContactButtons } from '#/components/primitives/ContactButtons'
import { StatusPill } from '#/components/primitives/StatusPill'
import { Segmented } from '#/components/primitives/Segmented'
import { AU_STATES } from '#/lib/au'
import { formatMoney } from '#/lib/format'
import { useHydrated } from '#/lib/useHydrated'
import { dayKeyOf } from '../../../convex/lib/dates'
import type { Id } from '../../../convex/_generated/dataModel'

type ClientKind = 'person' | 'business'

export function ClientSheet({
  businessId,
  timezone,
  businessSlug,
  isOwner,
  clientId,
  onClose,
}: {
  businessId: Id<'businesses'>
  timezone: string
  businessSlug: string
  isOwner: boolean
  clientId: string | null
  onClose: () => void
}) {
  return (
    <Drawer.Root
      open={clientId !== null}
      onOpenChange={(o) => !o && onClose()}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />
          {clientId !== null && (
            <ClientBody
              key={clientId}
              businessId={businessId}
              timezone={timezone}
              businessSlug={businessSlug}
              isOwner={isOwner}
              clientId={clientId as Id<'clients'>}
              onClose={onClose}
            />
          )}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

function ClientBody({
  businessId,
  timezone,
  businessSlug,
  isOwner,
  clientId,
  onClose,
}: {
  businessId: Id<'businesses'>
  timezone: string
  businessSlug: string
  isOwner: boolean
  clientId: Id<'clients'>
  onClose: () => void
}) {
  const { data: client } = useQuery(
    convexQuery(api.clients.get, { businessId, clientId }),
  )
  const [editing, setEditing] = useState(false)
  const [confirmArchiveOpen, setConfirmArchiveOpen] = useState(false)

  const convexArchive = useConvexMutation(api.clients.archive)
  const archive = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; clientId: Id<'clients'> }) =>
      convexArchive(args),
    onSuccess: onClose,
  })

  if (client === undefined) {
    return (
      <div className="px-4 py-10">
        <Drawer.Title className="sr-only">Client</Drawer.Title>
        <p className="text-body text-muted">Loading…</p>
      </div>
    )
  }

  if (client === null) {
    return (
      <div className="px-4 py-10">
        <Drawer.Title className="text-sheet-title text-ink">
          Not found
        </Drawer.Title>
        <p className="mt-1 text-body text-muted">
          This client does not exist, or you do not have access to it.
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3">
      <div className="flex items-center justify-between gap-2">
        <Drawer.Title className="text-sheet-title text-ink">
          {client.name}
        </Drawer.Title>
        {!editing && (
          <button
            type="button"
            aria-label="Edit client details"
            onClick={() => setEditing(true)}
            className="mr-8 flex items-center gap-1 text-caption font-semibold text-blue"
          >
            <Pencil size={13} strokeWidth={2} />
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <ClientEditForm
          businessId={businessId}
          client={client}
          onDone={() => setEditing(false)}
        />
      ) : (
        <>
          <p className="mt-0.5 text-caption text-muted">
            {client.kind === 'business' ? 'Business' : 'Person'}
          </p>

          <div className="mt-3">
            <ContactButtons name={client.name} phone={client.phone} email={client.email} />
          </div>

          {client.kind === 'business' && (client.addressLine || client.suburb) && (
            <div className="mt-3">
              <p className="section-label mb-1">Business address</p>
              <p className="text-body text-ink-2">{client.addressLine}</p>
              <p className="text-caption text-muted">
                {client.suburb} {client.state} {client.postcode}
              </p>
            </div>
          )}
        </>
      )}

      {/* A business needs named people because "ACME Pest Control" can't
          answer a phone; a person client already is their own one contact. */}
      {client.kind === 'business' && (
        <ClientContacts businessId={businessId} clientId={clientId} />
      )}

      <ClientProperties businessId={businessId} clientId={clientId} />

      <ClientNotesSection
        businessId={businessId}
        businessSlug={businessSlug}
        timezone={timezone}
        clientId={clientId}
        clientName={client.name}
      />

      <ClientJobHistory
        businessId={businessId}
        businessSlug={businessSlug}
        clientId={clientId}
        timezone={timezone}
      />

      <ClientReports
        businessId={businessId}
        businessSlug={businessSlug}
        clientId={clientId}
        timezone={timezone}
      />

      {isOwner && (
        <button
          type="button"
          onClick={() => setConfirmArchiveOpen(true)}
          className="mt-6 h-11 w-full rounded-xl bg-surface-2 text-[15px] font-semibold text-amber-ink transition active:scale-[.975]"
        >
          Archive client
        </button>
      )}

      <AlertDialog.Root open={confirmArchiveOpen} onOpenChange={setConfirmArchiveOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/30" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[70] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-canvas p-4 shadow-elevation outline-none">
            <AlertDialog.Title className="text-row-title text-ink">
              Archive {client.name}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1.5 text-body text-ink-2">
              This removes them from pickers for new jobs, properties and
              reports. Nothing is deleted — every existing property, job and
              report stays exactly as it is, and you can unarchive them later.
            </AlertDialog.Description>
            <div className="mt-4 flex gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="h-11 flex-1 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.975]"
                >
                  Keep client
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  disabled={archive.isPending}
                  onClick={() => archive.mutate({ businessId, clientId })}
                  className="h-11 flex-1 rounded-xl bg-red text-[15px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
                >
                  {archive.isPending ? 'Archiving…' : 'Archive'}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

function ClientEditForm({
  businessId,
  client,
  onDone,
}: {
  businessId: Id<'businesses'>
  client: {
    _id: Id<'clients'>
    kind: ClientKind
    name: string
    phone?: string
    email?: string
    addressLine?: string
    suburb?: string
    state?: string
    postcode?: string
  }
  onDone: () => void
}) {
  const [kind, setKind] = useState<ClientKind>(client.kind)
  const [name, setName] = useState(client.name)
  const [phone, setPhone] = useState(client.phone ?? '')
  const [email, setEmail] = useState(client.email ?? '')
  const [addressLine, setAddressLine] = useState(client.addressLine ?? '')
  const [suburb, setSuburb] = useState(client.suburb ?? '')
  const [state, setState] = useState(client.state ?? AU_STATES[0].code)
  const [postcode, setPostcode] = useState(client.postcode ?? '')

  const hydrated = useHydrated()

  const convexUpdate = useConvexMutation(api.clients.update)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      clientId: Id<'clients'>
      kind: ClientKind
      name: string
      phone?: string
      email?: string
      addressLine?: string
      suburb?: string
      state?: string
      postcode?: string
    }) => convexUpdate(args),
    onSuccess: onDone,
  })

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({
          businessId,
          clientId: client._id,
          kind,
          name,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          // Omitted (not cleared) when kind isn't business: `clients.update`
          // skips undefined args, so toggling to person just stops showing
          // the address rather than wiping it — same "hidden, not deleted"
          // treatment as clientContacts when kind flips away from business.
          ...(kind === 'business' && {
            addressLine: addressLine.trim() || undefined,
            suburb: suburb.trim() || undefined,
            state: state || undefined,
            postcode: postcode.trim() || undefined,
          }),
        })
      }}
    >
      <FormField label="Client type">
        <Segmented
          label="Client type"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'person', label: 'Person' },
            { value: 'business', label: 'Business' },
          ]}
        />
      </FormField>
      <FormField label={kind === 'business' ? 'Business name' : 'Client name'}>
        <TextInput value={name} onChange={setName} required />
      </FormField>
      <FormField label={kind === 'business' ? 'Main phone (optional)' : 'Phone (optional)'}>
        <TextInput value={phone} onChange={setPhone} type="tel" />
      </FormField>
      <FormField label={kind === 'business' ? 'Main email (optional)' : 'Email (optional)'}>
        <TextInput value={email} onChange={setEmail} type="email" />
      </FormField>
      {kind === 'business' && (
        <>
          <FormField label="Business address (optional)">
            <TextInput value={addressLine} onChange={setAddressLine} placeholder="Street address" />
          </FormField>
          <FormField label="Suburb">
            <TextInput value={suburb} onChange={setSuburb} placeholder="Suburb" />
          </FormField>
          <div className="grid grid-cols-2 gap-2.5">
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
            >
              {AU_STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code}
                </option>
              ))}
            </select>
            <TextInput
              value={postcode}
              onChange={setPostcode}
              inputMode="numeric"
              placeholder="Postcode"
            />
          </div>
        </>
      )}
      {save.isError && (
        <p
          role="alert"
          className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
        >
          Could not save these changes.
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDone}
          className="h-11 flex-1 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.975]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={save.isPending || !hydrated}
          className="h-11 flex-1 rounded-xl bg-red text-[15px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

/** Named people at a business-kind client — office manager, site contact,
 * accounts payable. A person client has no need for this: they already are
 * the one contact point via their own phone/email above. */
function ClientContacts({
  businessId,
  clientId,
}: {
  businessId: Id<'businesses'>
  clientId: Id<'clients'>
}) {
  const { data: contacts } = useQuery(
    convexQuery(api.clientContacts.list, { businessId, clientId }),
  )
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const convexRemove = useConvexMutation(api.clientContacts.remove)
  const remove = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; contactId: Id<'clientContacts'> }) =>
      convexRemove(args),
  })
  const convexSetPrimary = useConvexMutation(api.clientContacts.setPrimary)
  const setPrimary = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; contactId: Id<'clientContacts'> }) =>
      convexSetPrimary(args),
  })

  // Primary contact first; otherwise the order the list already comes in.
  const ordered = contacts
    ? [...contacts].sort((a, b) => Number(b.isPrimary ?? false) - Number(a.isPrimary ?? false))
    : contacts

  return (
    <Section label="Contacts">
      {ordered && ordered.length > 0 && (
        <div className="mb-3 flex flex-col divide-y divide-hairline">
          {ordered.map((contact) =>
            editingId === contact._id ? (
              <div key={contact._id} className="py-2.5 first:pt-0 last:pb-0">
                <ContactEditForm
                  businessId={businessId}
                  contact={contact}
                  onDone={() => setEditingId(null)}
                />
              </div>
            ) : (
              <div key={contact._id} className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body text-ink">
                      {contact.name}
                      {contact.isPrimary && (
                        <span className="ml-1.5 text-caption text-blue">★ Primary</span>
                      )}
                    </p>
                    <p className="truncate text-caption text-muted">
                      {[contact.role, contact.phone, contact.email]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Edit ${contact.name}`}
                    onClick={() => setEditingId(contact._id)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
                  >
                    <Pencil size={13} strokeWidth={2} />
                  </button>
                  {!contact.isPrimary && (
                    <button
                      type="button"
                      aria-label={`Make ${contact.name} primary`}
                      disabled={setPrimary.isPending}
                      onClick={() => setPrimary.mutate({ businessId, contactId: contact._id })}
                      className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-50"
                    >
                      <Star size={14} strokeWidth={1.7} />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${contact.name}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate({ businessId, contactId: contact._id })}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-50"
                  >
                    <Trash2 size={14} strokeWidth={1.7} />
                  </button>
                </div>
                <ContactButtons name={contact.name} phone={contact.phone} email={contact.email} />
              </div>
            ),
          )}
        </div>
      )}

      {adding ? (
        <NewContactForm
          businessId={businessId}
          clientId={clientId}
          onDone={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-surface-2 text-[14px] font-semibold text-ink transition active:scale-[.98]"
        >
          <Plus size={16} strokeWidth={1.8} />
          Add contact
        </button>
      )}
    </Section>
  )
}

function NewContactForm({
  businessId,
  clientId,
  onDone,
}: {
  businessId: Id<'businesses'>
  clientId: Id<'clients'>
  onDone: () => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const hydrated = useHydrated()

  const convexCreate = useConvexMutation(api.clientContacts.create)
  const create = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      clientId: Id<'clients'>
      name: string
      role?: string
      phone?: string
      email?: string
    }) => convexCreate(args),
    onSuccess: onDone,
  })

  return (
    <form
      className="flex flex-col gap-2.5 rounded-2xl border border-hairline bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate({
          businessId,
          clientId,
          name,
          role: role.trim() || undefined,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
        })
      }}
    >
      <TextInput value={name} onChange={setName} placeholder="Name" required />
      <TextInput value={role} onChange={setRole} placeholder="Position (optional)" />
      <TextInput value={phone} onChange={setPhone} type="tel" placeholder="Phone (optional)" />
      <TextInput value={email} onChange={setEmail} type="email" placeholder="Email (optional)" />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDone}
          className="h-10 flex-1 rounded-xl bg-surface-2 text-[14px] font-semibold text-ink transition active:scale-[.975]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={create.isPending || !hydrated}
          className="h-10 flex-1 rounded-xl bg-blue text-[14px] font-semibold text-white transition active:scale-[.975] disabled:opacity-50"
        >
          {create.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
    </form>
  )
}

function ContactEditForm({
  businessId,
  contact,
  onDone,
}: {
  businessId: Id<'businesses'>
  contact: {
    _id: Id<'clientContacts'>
    name: string
    role?: string
    phone?: string
    email?: string
  }
  onDone: () => void
}) {
  const [name, setName] = useState(contact.name)
  const [role, setRole] = useState(contact.role ?? '')
  const [phone, setPhone] = useState(contact.phone ?? '')
  const [email, setEmail] = useState(contact.email ?? '')
  const hydrated = useHydrated()

  const convexUpdate = useConvexMutation(api.clientContacts.update)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      contactId: Id<'clientContacts'>
      name: string
      role?: string
      phone?: string
      email?: string
    }) => convexUpdate(args),
    onSuccess: onDone,
  })

  return (
    <form
      className="flex flex-col gap-2.5 rounded-2xl border border-hairline bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({
          businessId,
          contactId: contact._id,
          name,
          role: role.trim() || undefined,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
        })
      }}
    >
      <TextInput value={name} onChange={setName} placeholder="Name" required />
      <TextInput value={role} onChange={setRole} placeholder="Position (optional)" />
      <TextInput value={phone} onChange={setPhone} type="tel" placeholder="Phone (optional)" />
      <TextInput value={email} onChange={setEmail} type="email" placeholder="Email (optional)" />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDone}
          className="h-10 flex-1 rounded-xl bg-surface-2 text-[14px] font-semibold text-ink transition active:scale-[.975]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={save.isPending || !hydrated}
          className="h-10 flex-1 rounded-xl bg-blue text-[14px] font-semibold text-white transition active:scale-[.975] disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

/** Every property this client owns, each individually editable, plus adding
 * another one — the reason this whole model exists over the old 1:1 shape. */
function ClientProperties({
  businessId,
  clientId,
}: {
  businessId: Id<'businesses'>
  clientId: Id<'clients'>
}) {
  const { data: properties } = useQuery(
    convexQuery(api.properties.listByClient, { businessId, clientId }),
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  return (
    <Section label="Properties">
      {properties && properties.length > 0 && (
        <div className="mb-3 flex flex-col gap-2.5">
          {properties.map((property) =>
            editingId === property._id ? (
              <PropertyEditForm
                key={property._id}
                businessId={businessId}
                property={property}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <div
                key={property._id}
                className="rounded-2xl border border-hairline bg-surface p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-body text-ink-2">{property.addressLine}</p>
                    <p className="text-caption text-muted">
                      {property.suburb} {property.state} {property.postcode}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Edit ${property.addressLine}`}
                    onClick={() => setEditingId(property._id)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
                  >
                    <Pencil size={13} strokeWidth={2} />
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {adding ? (
        <NewPropertyForClientForm
          businessId={businessId}
          clientId={clientId}
          onDone={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-surface-2 text-[14px] font-semibold text-ink transition active:scale-[.98]"
        >
          <Plus size={16} strokeWidth={1.8} />
          Add another property
        </button>
      )}
    </Section>
  )
}

function PropertyEditForm({
  businessId,
  property,
  onDone,
}: {
  businessId: Id<'businesses'>
  property: {
    _id: Id<'properties'>
    addressLine: string
    suburb: string
    state: string
    postcode: string
  }
  onDone: () => void
}) {
  const [addressLine, setAddressLine] = useState(property.addressLine)
  const [suburb, setSuburb] = useState(property.suburb)
  const [state, setState] = useState(property.state)
  const [postcode, setPostcode] = useState(property.postcode)
  const hydrated = useHydrated()

  const convexUpdate = useConvexMutation(api.properties.update)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      propertyId: Id<'properties'>
      addressLine: string
      suburb: string
      state: string
      postcode: string
    }) => convexUpdate(args),
    onSuccess: onDone,
  })

  return (
    <form
      className="flex flex-col gap-2.5 rounded-2xl border border-hairline bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({
          businessId,
          propertyId: property._id,
          addressLine,
          suburb,
          state,
          postcode,
        })
      }}
    >
      <TextInput value={addressLine} onChange={setAddressLine} placeholder="Street address" required />
      <TextInput value={suburb} onChange={setSuburb} placeholder="Suburb" required />
      <div className="grid grid-cols-2 gap-2.5">
        <select
          value={state}
          onChange={(e) => setState(e.target.value)}
          className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
        >
          {AU_STATES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.code}
            </option>
          ))}
        </select>
        <TextInput value={postcode} onChange={setPostcode} inputMode="numeric" placeholder="Postcode" required />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDone}
          className="h-10 flex-1 rounded-xl bg-surface-2 text-[14px] font-semibold text-ink transition active:scale-[.975]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={save.isPending || !hydrated}
          className="h-10 flex-1 rounded-xl bg-blue text-[14px] font-semibold text-white transition active:scale-[.975] disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function NewPropertyForClientForm({
  businessId,
  clientId,
  onDone,
}: {
  businessId: Id<'businesses'>
  clientId: Id<'clients'>
  onDone: () => void
}) {
  const [addressLine, setAddressLine] = useState('')
  const [suburb, setSuburb] = useState('')
  const [state, setState] = useState('WA')
  const [postcode, setPostcode] = useState('')
  const hydrated = useHydrated()

  const convexCreate = useConvexMutation(api.properties.createForClient)
  const create = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      clientId: Id<'clients'>
      addressLine: string
      suburb: string
      state: string
      postcode: string
    }) => convexCreate(args),
    onSuccess: onDone,
  })

  return (
    <form
      className="flex flex-col gap-2.5 rounded-2xl border border-hairline bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate({ businessId, clientId, addressLine, suburb, state, postcode })
      }}
    >
      <TextInput value={addressLine} onChange={setAddressLine} placeholder="Street address" required />
      <TextInput value={suburb} onChange={setSuburb} placeholder="Suburb" required />
      <div className="grid grid-cols-2 gap-2.5">
        <select
          value={state}
          onChange={(e) => setState(e.target.value)}
          className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
        >
          {AU_STATES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.code}
            </option>
          ))}
        </select>
        <TextInput value={postcode} onChange={setPostcode} inputMode="numeric" placeholder="Postcode" required />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDone}
          className="h-10 flex-1 rounded-xl bg-surface-2 text-[14px] font-semibold text-ink transition active:scale-[.975]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={create.isPending || !hydrated}
          className="h-10 flex-1 rounded-xl bg-blue text-[14px] font-semibold text-white transition active:scale-[.975] disabled:opacity-50"
        >
          {create.isPending ? 'Adding…' : 'Add property'}
        </button>
      </div>
    </form>
  )
}

/** Job history aggregated across every property this client owns — not just
 * one, unlike the old per-property view. */
function ClientJobHistory({
  businessId,
  businessSlug,
  clientId,
  timezone,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  clientId: Id<'clients'>
  timezone: string
}) {
  const { data: jobs } = useQuery(
    convexQuery(api.clients.jobHistory, { businessId, clientId }),
  )

  return (
    <Section label="Job history">
      {!jobs || jobs.length === 0 ? (
        <p className="rounded-2xl border border-hairline bg-surface px-3.5 py-6 text-center text-body text-muted shadow-elevation">
          No visits recorded yet.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-hairline">
          {jobs.map((job) => (
            <Link
              key={job._id}
              to="/$businessSlug/schedule"
              params={{ businessSlug }}
              search={{ date: dayKeyOf(job.scheduledAt, timezone), jobId: job._id }}
              className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
            >
              <span className="min-w-0">
                <span className="block truncate text-body text-ink">
                  {job.jobType}
                </span>
                <span className="text-caption text-muted">
                  {new Intl.DateTimeFormat('en-AU', {
                    timeZone: timezone,
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  }).format(new Date(job.scheduledAt))}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-body text-ink">{formatMoney(job.price)}</span>
                <StatusPill status={job.status} />
              </span>
            </Link>
          ))}
        </div>
      )}
    </Section>
  )
}

/** Reports aggregated across every property this client owns. */
function ClientReports({
  businessId,
  businessSlug,
  clientId,
  timezone,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  clientId: Id<'clients'>
  timezone: string
}) {
  const { data: reports } = useQuery(
    convexQuery(api.clients.reports, { businessId, clientId }),
  )
  if (!reports || reports.length === 0) return null

  return (
    <Section label="Reports">
      <div className="flex flex-col divide-y divide-hairline">
        {reports.map((report) => (
          <Link
            key={report._id}
            to="/$businessSlug/reports/$reportId"
            params={{ businessSlug, reportId: report._id }}
            className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
          >
            <span className="min-w-0">
              <span className="block truncate text-body text-ink">
                {report.legalBasis}
              </span>
              <span className="text-caption text-muted">
                {new Intl.DateTimeFormat('en-AU', {
                  timeZone: timezone,
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                }).format(new Date(report.finalisedAt ?? report.createdAt))}
              </span>
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                report.status === 'finalised'
                  ? 'bg-green/12 text-green'
                  : 'border border-amber-line bg-amber-bg text-amber-ink'
              }`}
            >
              {report.status === 'finalised' ? 'Finalised' : 'Draft'}
            </span>
          </Link>
        ))}
      </div>
    </Section>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">{label}</h3>
      {children}
    </section>
  )
}

function FormField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      {children}
    </label>
  )
}

function TextInput({
  value,
  onChange,
  type = 'text',
  required,
  inputMode,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  required?: boolean
  inputMode?: 'numeric' | 'decimal' | 'tel'
  placeholder?: string
}) {
  return (
    <input
      type={type}
      value={value}
      required={required}
      inputMode={inputMode}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="h-11 w-full rounded-xl bg-surface-3 px-3.5 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
    />
  )
}
