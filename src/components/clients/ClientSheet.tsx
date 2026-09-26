import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Link } from '@tanstack/react-router'
import { Drawer } from 'vaul'
import { AlertDialog } from 'radix-ui'
import { Pencil, Plus, Star, Trash2, X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import {
  InlineReportsSection,
  SeeAllReports,
} from '#/components/reports/InlineReports'
import { ClientNotesSection } from '#/components/notes/ClientNotesSection'
import { AbnInput } from '#/components/clients/AbnInput'
import { EmailInput } from '#/components/forms/EmailInput'
import { FormAlert } from '#/components/forms/FormAlert'
import { FIELD_COMPACT, FormField } from '#/components/forms/FormField'
import { PhoneInput } from '#/components/forms/PhoneInput'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import {
  VerifiedAddressFields,
  addressCheckToSend,
} from '#/components/forms/VerifiedAddressFields'
import { ContactButtons } from '#/components/primitives/ContactButtons'
import { StatusPill } from '#/components/primitives/StatusPill'
import { Segmented } from '#/components/primitives/Segmented'
import { loadLocalities } from '#/lib/addressVerify'
import { formatJobMoney } from '#/lib/format'
import { useHydrated } from '#/lib/useHydrated'
import { SheetPending } from '#/components/shell/Pending'
import { abnDigits, formatAbn } from '../../../convex/lib/abn'
import {
  isNameCorrection,
  sameName,
} from '../../../convex/lib/contactNames'
import { dayKeyOf } from '../../../convex/lib/dates'
import { siteContactOf } from '../../../convex/lib/siteContact'
import type { Id } from '../../../convex/_generated/dataModel'
import type { AddressCheck } from '#/components/forms/VerifiedAddressFields'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { AddressValue } from '#/lib/addressVerify'
import { PRIMARY_BUTTON_COMPACT, SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'

type ClientKind = 'person' | 'business'

/** What a failed archive, remove or make-primary says: these are not saves,
 * so describeError's "Could not save" words would name the wrong thing. */
function actionCopy(action: string): ErrorCopy {
  return {
    offline: `Could not ${action}: this device is offline. Try again when you have signal.`,
    NOT_FOUND: `Could not ${action}: it has changed since you opened this. Close it and look again.`,
    NO_ACCESS: `Could not ${action}: your access does not cover this. Ask the business owner.`,
    default: `Could not ${action}. Check your connection and try again.`,
  }
}

export function ClientSheet({
  businessId,
  timezone,
  businessSlug,
  businessState,
  isOwner,
  clientId,
  onClose,
}: {
  businessId: Id<'businesses'>
  timezone: string
  businessSlug: string
  /** Where address suggestions lean, and a new property's starting state. */
  businessState: string
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
        <Drawer.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />
          {clientId !== null && (
            <ClientBody
              key={clientId}
              businessId={businessId}
              timezone={timezone}
              businessSlug={businessSlug}
              businessState={businessState}
              isOwner={isOwner}
              clientId={clientId as Id<'clients'>}
              onClose={onClose}
            />
          )}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="tap-target absolute right-3 top-3 flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted"
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
  businessState,
  isOwner,
  clientId,
  onClose,
}: {
  businessId: Id<'businesses'>
  timezone: string
  businessSlug: string
  businessState: string
  isOwner: boolean
  clientId: Id<'clients'>
  onClose: () => void
}) {
  const { data: client } = useQuery(
    convexQuery(api.clients.get, { businessId, clientId }),
  )
  // The contact person is the primary contact (Prompt 6.1), not a field of
  // its own. The same query the Contacts section runs, so no second fetch.
  // Read for a person client too: flipping one back to business in the edit
  // form brings back its hidden contact person, and the field should show
  // them rather than start empty.
  const { data: contacts } = useQuery(
    convexQuery(api.clientContacts.list, { businessId, clientId }),
  )
  const contactPerson = contacts?.find((c) => c.isPrimary)?.name
  const [editing, setEditing] = useState(false)
  const [confirmArchiveOpen, setConfirmArchiveOpen] = useState(false)

  const convexArchive = useConvexMutation(api.clients.archive)
  const archive = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; clientId: Id<'clients'> }) =>
      convexArchive(args),
    onSuccess: onClose,
  })

  // The state's suburb table, fetched as the sheet opens while there is
  // signal, so an address edited at a door with none is still checked.
  useEffect(() => {
    void loadLocalities(businessState)
  }, [businessState])

  if (client === undefined) {
    return (
      // The sheet's own shape while the client loads, so it opens at its
      // height instead of opening short and jumping up.
      <SheetPending
        title={<Drawer.Title className="sr-only">Client</Drawer.Title>}
      />
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
            className="relative tap-target mr-8 flex items-center gap-1 text-caption font-semibold text-blue"
          >
            <Pencil size={13} strokeWidth={2} />
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <ClientEditForm
          businessId={businessId}
          businessState={businessState}
          client={client}
          contactPerson={contactPerson ?? ''}
          onDone={() => setEditing(false)}
        />
      ) : (
        <>
          <p className="mt-0.5 text-caption text-muted">
            {client.kind === 'business' ? 'Business' : 'Person'}
          </p>
          {client.kind === 'business' && client.abn && (
            <p className="text-caption tabular-nums text-muted">
              ABN {formatAbn(client.abn)}
            </p>
          )}
          {client.kind === 'business' && contactPerson && (
            <p className="text-caption text-muted">
              Contact person: {contactPerson}
            </p>
          )}

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
        <ClientContacts
          businessId={businessId}
          businessState={businessState}
          clientId={clientId}
        />
      )}

      <ClientProperties
        businessId={businessId}
        businessState={businessState}
        clientId={clientId}
        clientKind={client.kind}
      />

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
        clientName={client.name}
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
      {/* Here, not in the dialog: the dialog closes as Archive is pressed. */}
      <FormAlert
        className="mt-2"
        error={archive.isError ? archive.error : null}
        copy={actionCopy('archive this client')}
      />

      <AlertDialog.Root open={confirmArchiveOpen} onOpenChange={setConfirmArchiveOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-scrim" />
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
                  className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
                >
                  Keep client
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  disabled={archive.isPending}
                  onClick={() => archive.mutate({ businessId, clientId })}
                  className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
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
  businessState,
  client,
  contactPerson: prefilledContactPerson,
  onDone,
}: {
  businessId: Id<'businesses'>
  /** Where the business works: suggestions lean there, an address elsewhere
   * is pointed out, and a number missing its area code gets this state's. */
  businessState: string
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
    abn?: string
  }
  /** The primary contact's name, or '' when there is none. */
  contactPerson: string
  onDone: () => void
}) {
  const [kind, setKind] = useState<ClientKind>(client.kind)
  const [name, setName] = useState(client.name)
  const [phone, setPhone] = useState(client.phone ?? '')
  const [email, setEmail] = useState(client.email ?? '')
  const [address, setAddress] = useState<AddressValue>({
    addressLine: client.addressLine ?? '',
    suburb: client.suburb ?? '',
    // Blank until chosen. It used to start on the first state in the list,
    // ACT, and was saved with every business edit, so reports printed "ACT"
    // as the address of clients that never had one.
    state: client.state ?? '',
    postcode: client.postcode ?? '',
  })
  const [abn, setAbn] = useState(client.abn ? formatAbn(client.abn) : '')
  const [contactPerson, setContactPerson] = useState(prefilledContactPerson)
  // What the field opened with, not the live primary: if the contacts arrive
  // after the form opened, the field starts blank, and comparing with the
  // live name would read that as clearing it and take the star off.
  const [contactPersonBefore] = useState(prefilledContactPerson)

  // What the record has saved, as the save below compares with: a value left
  // as it is is not sent, so it is never refused here either, however it
  // fails today's rules — only warned about.
  const savedAddress: AddressValue = {
    addressLine: client.addressLine ?? '',
    suburb: client.suburb ?? '',
    state: client.state ?? '',
    postcode: client.postcode ?? '',
  }

  const hydrated = useHydrated()
  const id = useId()
  const warnings = useSaveWarnings()

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
      abn?: string
      contactPerson?: string
    }) => convexUpdate(args),
    onSuccess: onDone,
  })

  const args = () => {
    const hasAddress = [
      address.addressLine,
      address.suburb,
      address.postcode,
    ].some((part) => part.trim() !== '')
    return {
      businessId,
      clientId: client._id,
      kind,
      name,
      // Each only when changed, and blank clears it (clients.update).
      // Untouched fields are left out, so a save that changes nothing
      // writes nothing.
      ...edited('phone', phone, client.phone),
      ...edited('email', email, client.email),
      // Omitted (not cleared) when kind isn't business: `clients.update`
      // skips undefined args, so toggling to person just stops showing
      // the address rather than wiping it — same "hidden, not deleted"
      // treatment as clientContacts when kind flips away from business.
      // The ABN and contact person are left alone the same way.
      ...(kind === 'business' && {
        ...edited('addressLine', address.addressLine, client.addressLine),
        ...edited('suburb', address.suburb, client.suburb),
        // A state on its own is not an address: with no street, suburb
        // or postcode it is cleared, which also mends a lone "ACT".
        ...edited('state', hasAddress ? address.state : '', client.state),
        ...edited('postcode', address.postcode, client.postcode),
        ...((abnDigits(abn) ?? abn.trim()) !== (client.abn ?? '') && {
          abn: abn.trim(),
        }),
        // The server makes the name the primary contact, and blank takes
        // the star off (nobody is deleted).
        ...edited('contactPerson', contactPerson, contactPersonBefore),
      }),
    }
  }
  // Read when the save goes, which can be after the checks at Save have
  // answered: what is in the fields then, not when Save was pressed.
  const latestArgs = useLatest(args)

  const phoneId = `${id}-phone`
  const emailId = `${id}-email`
  const abnId = `${id}-abn`
  const addressHeadingId = `${id}-address-heading`

  return (
    <SaveWarningsProvider value={warnings}>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) =>
          warnings.guard(e, () => save.mutateAsync(latestArgs.current()))
        }
      >
        <WrappedField label="Client type">
          <Segmented
            kind="choice"
            label="Client type"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'person', label: 'Person' },
              { value: 'business', label: 'Business' },
            ]}
          />
        </WrappedField>
        <WrappedField
          label={kind === 'business' ? 'Business name' : 'Client name'}
        >
          <TextInput value={name} onChange={setName} required />
        </WrappedField>
        {kind === 'business' && (
          <>
            <FormField id={abnId} label="ABN (optional)" size="md">
              <AbnInput
                id={abnId}
                value={abn}
                onChange={setAbn}
                initial={client.abn ? formatAbn(client.abn) : ''}
                size="md"
              />
            </FormField>
            <WrappedField label="Contact person (optional)">
              <TextInput value={contactPerson} onChange={setContactPerson} />
            </WrappedField>
            {/* Outside the label, which it would otherwise become part of. What
                saving will do to the person already in the field, when it is not
                simply correcting their name: they are never removed. */}
            {contactPersonBefore.trim() !== '' &&
              !sameName(contactPerson, contactPersonBefore) &&
              !isNameCorrection(contactPersonBefore, contactPerson) && (
                <p className="-mt-1.5 text-caption text-muted">
                  {contactPerson.trim() === ''
                    ? `${contactPersonBefore.trim()} stays in Contacts, no longer the contact person.`
                    : `${contactPerson.trim()} becomes the contact person. ${contactPersonBefore.trim()} stays in Contacts.`}
                </p>
              )}
          </>
        )}
        <FormField
          id={phoneId}
          label={
            kind === 'business' ? 'Main phone (optional)' : 'Phone (optional)'
          }
          size="md"
        >
          <PhoneInput
            id={phoneId}
            value={phone}
            onChange={setPhone}
            initial={client.phone ?? ''}
            businessState={businessState}
            size="md"
          />
        </FormField>
        <FormField
          id={emailId}
          label={
            kind === 'business' ? 'Main email (optional)' : 'Email (optional)'
          }
          size="md"
        >
          <EmailInput
            id={emailId}
            value={email}
            onChange={setEmail}
            initial={client.email ?? ''}
            size="md"
          />
        </FormField>
        {kind === 'business' && (
          // Named as a group, each field by its placeholder's word: the
          // four stacked labels of the new-client sheet would make this
          // small edit form mostly headings.
          <div
            role="group"
            aria-labelledby={addressHeadingId}
            className="flex flex-col gap-2.5"
          >
            <p id={addressHeadingId} className="section-label -mb-1">
              Business address (optional)
            </p>
            <VerifiedAddressFields
              idPrefix={`${id}-address`}
              value={address}
              onChange={(patch) => setAddress((a) => ({ ...a, ...patch }))}
              workState={businessState}
              initial={savedAddress}
              size="md"
              labels="placeholders"
              required={false}
            />
          </div>
        )}
        <FormAlert error={save.isError ? save.error : null} />
        <SaveWarningsPanel />

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onDone}
            className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={save.isPending || !hydrated}
            className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
          >
            {save.isPending ? 'Saving…' : warnings.saveLabel('Save')}
          </button>
        </div>
      </form>
    </SaveWarningsProvider>
  )
}

/** Named people at a business-kind client — office manager, site contact,
 * accounts payable. A person client has no need for this: they already are
 * the one contact point via their own phone/email above. */
function ClientContacts({
  businessId,
  businessState,
  clientId,
}: {
  businessId: Id<'businesses'>
  businessState: string
  clientId: Id<'clients'>
}) {
  const { data: contacts } = useQuery(
    convexQuery(api.clientContacts.list, { businessId, clientId }),
  )
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  // The primary contact is the client's contact person (Prompt 6.1), shown
  // under its name and edited from the client form, so removing them asks
  // first. Anyone else goes on one tap, as before.
  const [confirmRemove, setConfirmRemove] = useState<{
    _id: Id<'clientContacts'>
    name: string
  } | null>(null)

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
  // One line for whichever was tapped last: each tap clears the other's, so
  // an old failure is not left standing beside a new one.
  const removeContact = (contactId: Id<'clientContacts'>) => {
    setPrimary.reset()
    remove.mutate({ businessId, contactId })
  }
  const makePrimary = (contactId: Id<'clientContacts'>) => {
    remove.reset()
    setPrimary.mutate({ businessId, contactId })
  }

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
                  businessState={businessState}
                  contact={contact}
                  onDone={() => setEditingId(null)}
                />
              </div>
            ) : (
              <div key={contact._id} className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0">
                {/* The row's icons are 44px targets side by side, with no gap:
                    a smaller button with a wider invisible hit area would
                    overlap its neighbour, and one of them is Remove. */}
                <div className="-my-1.5 -mr-2 flex items-center">
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
                    className="flex size-11 shrink-0 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
                  >
                    <Pencil size={13} strokeWidth={2} />
                  </button>
                  {!contact.isPrimary && (
                    <button
                      type="button"
                      aria-label={`Make ${contact.name} primary`}
                      disabled={setPrimary.isPending}
                      onClick={() => makePrimary(contact._id)}
                      className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-50"
                    >
                      <Star size={14} strokeWidth={1.7} />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${contact.name}`}
                    disabled={remove.isPending}
                    onClick={() =>
                      contact.isPrimary
                        ? setConfirmRemove(contact)
                        : removeContact(contact._id)
                    }
                    className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-50"
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

      {/* These used to fail without a word: the star or the row just stayed. */}
      <FormAlert
        className="mb-3"
        error={remove.isError ? remove.error : null}
        copy={actionCopy('remove that contact')}
      />
      <FormAlert
        className="mb-3"
        error={setPrimary.isError ? setPrimary.error : null}
        copy={actionCopy('make them the primary contact')}
      />

      {adding ? (
        <NewContactForm
          businessId={businessId}
          businessState={businessState}
          clientId={clientId}
          onDone={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`${SECONDARY_BUTTON_COMPACT} flex w-full items-center justify-center gap-2`}
        >
          <Plus size={16} strokeWidth={1.8} />
          Add contact
        </button>
      )}

      <AlertDialog.Root
        open={confirmRemove !== null}
        onOpenChange={(open) => !open && setConfirmRemove(null)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-scrim" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[70] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-canvas p-4 shadow-elevation outline-none">
            <AlertDialog.Title className="text-row-title text-ink">
              Remove {confirmRemove?.name}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1.5 text-body text-ink-2">
              They’re this client’s contact person.
            </AlertDialog.Description>
            <div className="mt-4 flex gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
                >
                  Keep contact
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() =>
                    confirmRemove && removeContact(confirmRemove._id)
                  }
                  className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
                >
                  Remove
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </Section>
  )
}

/**
 * A contact's phone and email, checked as the client's own are
 * (PhoneInput, EmailInput). Placeholders stand in for labels in this small
 * card, so each is named by `ariaLabel`, and by `name` in the list above Add.
 * `initial` is what the contact has saved, when editing one.
 */
function ContactDetailsFields({
  id,
  phone,
  onPhone,
  email,
  onEmail,
  initial,
  businessState,
}: {
  id: string
  phone: string
  onPhone: (phone: string) => void
  email: string
  onEmail: (email: string) => void
  initial?: { phone?: string; email?: string }
  businessState: string
}) {
  return (
    <>
      {/* Each in a box of its own, so its message lines sit under it rather
          than a card's gap away. */}
      <div>
        <PhoneInput
          id={`${id}-phone`}
          value={phone}
          onChange={onPhone}
          initial={initial && (initial.phone ?? '')}
          businessState={businessState}
          size="md"
          placeholder="Phone (optional)"
          ariaLabel="Phone (optional)"
          name="Phone"
        />
      </div>
      <div>
        <EmailInput
          id={`${id}-email`}
          value={email}
          onChange={onEmail}
          initial={initial && (initial.email ?? '')}
          size="md"
          placeholder="Email (optional)"
          ariaLabel="Email (optional)"
          name="Email"
        />
      </div>
    </>
  )
}

function NewContactForm({
  businessId,
  businessState,
  clientId,
  onDone,
}: {
  businessId: Id<'businesses'>
  businessState: string
  clientId: Id<'clients'>
  onDone: () => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const hydrated = useHydrated()
  const id = useId()
  const warnings = useSaveWarnings()

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

  // Read when the save goes, after any checks at Add have answered.
  const latestArgs = useLatest(() => ({
    businessId,
    clientId,
    name,
    role: role.trim() || undefined,
    phone: phone.trim() || undefined,
    email: email.trim() || undefined,
  }))

  return (
    <SaveWarningsProvider value={warnings}>
      <form
        className="flex flex-col gap-2.5 rounded-2xl border border-hairline bg-surface p-3"
        onSubmit={(e) =>
          warnings.guard(e, () => create.mutateAsync(latestArgs.current()))
        }
      >
        <TextInput
          value={name}
          onChange={setName}
          placeholder="Name"
          required
        />
        <TextInput
          value={role}
          onChange={setRole}
          placeholder="Position (optional)"
        />
        <ContactDetailsFields
          id={id}
          phone={phone}
          onPhone={setPhone}
          email={email}
          onEmail={setEmail}
          businessState={businessState}
        />
        <FormAlert error={create.isError ? create.error : null} />
        <SaveWarningsPanel />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onDone}
            className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending || !hydrated}
            className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
          >
            {create.isPending ? 'Adding…' : warnings.saveLabel('Add')}
          </button>
        </div>
      </form>
    </SaveWarningsProvider>
  )
}

function ContactEditForm({
  businessId,
  businessState,
  contact,
  onDone,
}: {
  businessId: Id<'businesses'>
  businessState: string
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
  const id = useId()
  const warnings = useSaveWarnings()

  const convexUpdate = useConvexMutation(api.clientContacts.update)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      contactId: Id<'clientContacts'>
      name?: string
      role?: string
      phone?: string
      email?: string
    }) => convexUpdate(args),
    onSuccess: onDone,
  })

  // Only what changed, and '' for a detail taken off, which clears it
  // (clientContacts.update). Sending every field, as this did, left a number
  // the person had deleted in place: a blank was sent as "leave it alone".
  const latestArgs = useLatest(() => ({
    businessId,
    contactId: contact._id,
    ...edited('name', name, contact.name),
    ...edited('role', role, contact.role),
    ...edited('phone', phone, contact.phone),
    ...edited('email', email, contact.email),
  }))

  return (
    <SaveWarningsProvider value={warnings}>
      <form
        className="flex flex-col gap-2.5 rounded-2xl border border-hairline bg-surface p-3"
        onSubmit={(e) =>
          warnings.guard(e, () => save.mutateAsync(latestArgs.current()))
        }
      >
        <TextInput
          value={name}
          onChange={setName}
          placeholder="Name"
          required
        />
        <TextInput
          value={role}
          onChange={setRole}
          placeholder="Position (optional)"
        />
        <ContactDetailsFields
          id={id}
          phone={phone}
          onPhone={setPhone}
          email={email}
          onEmail={setEmail}
          initial={contact}
          businessState={businessState}
        />
        <FormAlert error={save.isError ? save.error : null} />
        <SaveWarningsPanel />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onDone}
            className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={save.isPending || !hydrated}
            className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
          >
            {save.isPending ? 'Saving…' : warnings.saveLabel('Save')}
          </button>
        </div>
      </form>
    </SaveWarningsProvider>
  )
}

/** Every property this client owns, each individually editable, plus adding
 * another one — the reason this whole model exists over the old 1:1 shape. */
function ClientProperties({
  businessId,
  businessState,
  clientId,
  clientKind,
}: {
  businessId: Id<'businesses'>
  businessState: string
  clientId: Id<'clients'>
  clientKind: ClientKind
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
                businessState={businessState}
                clientKind={clientKind}
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
                    className="-mr-2 -mt-2.5 flex size-11 shrink-0 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
                  >
                    <Pencil size={13} strokeWidth={2} />
                  </button>
                </div>
                <PropertySiteContact
                  clientKind={clientKind}
                  property={property}
                />
              </div>
            ),
          )}
        </div>
      )}

      {adding ? (
        <NewPropertyForClientForm
          businessId={businessId}
          businessState={businessState}
          clientId={clientId}
          clientKind={clientKind}
          onDone={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`${SECONDARY_BUTTON_COMPACT} flex w-full items-center justify-center gap-2`}
        >
          <Plus size={16} strokeWidth={1.8} />
          Add another property
        </button>
      )}
    </Section>
  )
}

/**
 * Who to ask for at a business client's site — the store manager, the
 * caretaker (Prompt 6.3). Nothing for a person client, whose site contacts
 * are kept but hidden after a flip from business (convex/lib/siteContact.ts).
 * A name without a number is still shown: it is who to ask for at the door.
 */
function PropertySiteContact({
  clientKind,
  property,
}: {
  clientKind: ClientKind
  property: {
    addressLine: string
    siteContactName?: string
    siteContactPhone?: string
  }
}) {
  const contact = siteContactOf({
    clientKind,
    siteContactName: property.siteContactName,
    siteContactPhone: property.siteContactPhone,
  })
  if (!contact) return null
  return (
    <div className="mt-3 border-t border-hairline-2 pt-3">
      <p className="section-label mb-1">Site contact</p>
      {contact.name && <p className="text-body text-ink">{contact.name}</p>}
      {contact.phone && (
        <>
          <p className="text-caption text-muted">{contact.phone}</p>
          <div className="mt-2">
            {/* Named after the site when nobody is, so two properties'
                buttons are not both "Call site contact". */}
            <ContactButtons
              name={contact.name ?? `site contact at ${property.addressLine}`}
              phone={contact.phone}
              show={['call', 'text']}
            />
          </div>
        </>
      )}
    </div>
  )
}

type PropertyFieldsValue = {
  addressLine: string
  suburb: string
  state: string
  postcode: string
  siteContactName: string
  siteContactPhone: string
}

/**
 * One property's address, and its site contact for a business client — the
 * same fields for editing a property and adding another, so the two cannot
 * drift. Placeholders stand in for labels in this small card, so each field
 * is also named by an aria-label.
 *
 * The address is VerifiedAddressFields: checked as it goes in and again at
 * Save, against the business's own state. `initial` is what the property has
 * saved, when editing one: left as it is, nothing in it is refused or looked
 * up again. Must sit inside a SaveWarningsProvider for the checks at Save.
 */
function PropertyFields({
  value,
  onChange,
  initial,
  clientKind,
  businessState,
  onCheckChange,
}: {
  value: PropertyFieldsValue
  onChange: (patch: Partial<PropertyFieldsValue>) => void
  initial?: PropertyFieldsValue
  clientKind: ClientKind
  businessState: string
  /** How the address came to be, for the mutation's `addressCheck`. */
  onCheckChange: (check: AddressCheck) => void
}) {
  const id = useId()
  return (
    <>
      <VerifiedAddressFields
        idPrefix={id}
        value={value}
        onChange={onChange}
        workState={businessState}
        initial={initial}
        size="md"
        labels="placeholders"
        onCheckChange={onCheckChange}
      />
      {clientKind === 'business' && (
        <>
          <TextInput
            value={value.siteContactName}
            onChange={(siteContactName) => onChange({ siteContactName })}
            placeholder="Site contact name"
            ariaLabel="Site contact name"
          />
          {/* In a box of its own, so its message lines sit under it rather
              than a card's gap away. */}
          <div>
            <PhoneInput
              id={`${id}-site-phone`}
              value={value.siteContactPhone}
              onChange={(siteContactPhone) => onChange({ siteContactPhone })}
              initial={initial?.siteContactPhone}
              businessState={businessState}
              size="md"
              placeholder="Site contact number"
              ariaLabel="Site contact number"
              name="Site contact number"
            />
          </div>
        </>
      )}
    </>
  )
}

function PropertyEditForm({
  businessId,
  businessState,
  clientKind,
  property,
  onDone,
}: {
  businessId: Id<'businesses'>
  businessState: string
  clientKind: ClientKind
  property: {
    _id: Id<'properties'>
    addressLine: string
    suburb: string
    state: string
    postcode: string
    siteContactName?: string
    siteContactPhone?: string
  }
  onDone: () => void
}) {
  // What the property has saved, as the save below compares with.
  const saved: PropertyFieldsValue = {
    addressLine: property.addressLine,
    suburb: property.suburb,
    state: property.state,
    postcode: property.postcode,
    siteContactName: property.siteContactName ?? '',
    siteContactPhone: property.siteContactPhone ?? '',
  }
  const [value, setValue] = useState<PropertyFieldsValue>(saved)
  const [addressCheck, setAddressCheck] = useState<AddressCheck>('typed')
  const hydrated = useHydrated()
  const warnings = useSaveWarnings()

  const convexUpdate = useConvexMutation(api.properties.update)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      propertyId: Id<'properties'>
      addressLine: string
      suburb: string
      state: string
      postcode: string
      siteContactName?: string
      siteContactPhone?: string
      addressCheck?: AddressCheck
    }) => convexUpdate(args),
    onSuccess: onDone,
  })

  // Read when the save goes, after any checks at Save have answered.
  const latestArgs = useLatest(() => ({
    businessId,
    propertyId: property._id,
    addressLine: value.addressLine,
    suburb: value.suburb,
    state: value.state,
    postcode: value.postcode,
    // Left out when the address was not touched, so the property keeps how
    // it was last entered.
    addressCheck: addressCheckToSend(addressCheck, value, saved),
    // Only when changed, and blank clears one. Not sent for a person
    // client, whose fields are hidden, so saving the address must leave
    // them as they are.
    ...(clientKind === 'business' &&
      changed(value.siteContactName, property.siteContactName) && {
        siteContactName: value.siteContactName.trim(),
      }),
    ...(clientKind === 'business' &&
      changed(value.siteContactPhone, property.siteContactPhone) && {
        siteContactPhone: value.siteContactPhone.trim(),
      }),
  }))

  return (
    <SaveWarningsProvider value={warnings}>
      <form
        className="flex flex-col gap-2.5 rounded-2xl border border-hairline bg-surface p-3"
        onSubmit={(e) =>
          warnings.guard(e, () => save.mutateAsync(latestArgs.current()))
        }
      >
        <PropertyFields
          value={value}
          onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
          initial={saved}
          clientKind={clientKind}
          businessState={businessState}
          onCheckChange={setAddressCheck}
        />
        <FormAlert error={save.isError ? save.error : null} />
        <SaveWarningsPanel />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onDone}
            className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={save.isPending || !hydrated}
            className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
          >
            {save.isPending ? 'Saving…' : warnings.saveLabel('Save')}
          </button>
        </div>
      </form>
    </SaveWarningsProvider>
  )
}

function NewPropertyForClientForm({
  businessId,
  businessState,
  clientId,
  clientKind,
  onDone,
}: {
  businessId: Id<'businesses'>
  businessState: string
  clientId: Id<'clients'>
  clientKind: ClientKind
  onDone: () => void
}) {
  const [value, setValue] = useState<PropertyFieldsValue>({
    addressLine: '',
    suburb: '',
    // The business's own, not always WA: most of a Darwin business's
    // clients are in the NT.
    state: businessState,
    postcode: '',
    siteContactName: '',
    siteContactPhone: '',
  })
  const [addressCheck, setAddressCheck] = useState<AddressCheck>('typed')
  const hydrated = useHydrated()
  const warnings = useSaveWarnings()

  const convexCreate = useConvexMutation(api.properties.createForClient)
  const create = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      clientId: Id<'clients'>
      addressLine: string
      suburb: string
      state: string
      postcode: string
      siteContactName?: string
      siteContactPhone?: string
      addressCheck?: AddressCheck
    }) => convexCreate(args),
    onSuccess: onDone,
  })

  // Read when the save goes, after any checks at Add have answered.
  const latestArgs = useLatest(() => ({
    businessId,
    clientId,
    addressLine: value.addressLine,
    suburb: value.suburb,
    state: value.state,
    postcode: value.postcode,
    addressCheck: addressCheckToSend(addressCheck, value),
    ...(clientKind === 'business' && {
      siteContactName: value.siteContactName.trim() || undefined,
      siteContactPhone: value.siteContactPhone.trim() || undefined,
    }),
  }))

  return (
    <SaveWarningsProvider value={warnings}>
      <form
        className="flex flex-col gap-2.5 rounded-2xl border border-hairline bg-surface p-3"
        onSubmit={(e) =>
          warnings.guard(e, () => create.mutateAsync(latestArgs.current()))
        }
      >
        <PropertyFields
          value={value}
          onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
          clientKind={clientKind}
          businessState={businessState}
          onCheckChange={setAddressCheck}
        />
        <FormAlert error={create.isError ? create.error : null} />
        <SaveWarningsPanel />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onDone}
            className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending || !hydrated}
            className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
          >
            {create.isPending ? 'Adding…' : warnings.saveLabel('Add property')}
          </button>
        </div>
      </form>
    </SaveWarningsProvider>
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
                <span className="text-body text-ink">{formatJobMoney(job)}</span>
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
/**
 * Everything this client has ever been sent, newest first.
 *
 * It used to return `null` when there were none — so a client with no reports
 * got no heading, no sentence and no hint that reports are a thing that
 * happens. Now it says so, and says where they come from.
 */
function ClientReports({
  businessId,
  businessSlug,
  clientId,
  clientName,
  timezone,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  clientId: Id<'clients'>
  clientName: string
  timezone: string
}) {
  const { data: reports } = useQuery(
    convexQuery(api.clients.reports, { businessId, clientId }),
  )

  return (
    <InlineReportsSection
      businessSlug={businessSlug}
      timezone={timezone}
      label="Reports"
      reports={reports}
      empty="No reports yet. They are created from a job at one of their properties."
      // Bounded to the newest twenty, so a long-standing client's sheet does
      // not become their whole history.
      action={
        reports && reports.length > 0 ? (
          <SeeAllReports businessSlug={businessSlug} term={clientName} />
        ) : undefined
      }
    />
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

/** A control wrapped in its label, for one with no message lines of its own
 * (those take the forms FormField, whose label names it by `htmlFor`). */
function WrappedField({
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
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  required?: boolean
  inputMode?: 'numeric' | 'decimal' | 'tel'
  placeholder?: string
  /** A name for a field with no visible label: a placeholder is only a
   * fallback name, and not every screen reader reads it as one. */
  ariaLabel?: string
}) {
  return (
    <input
      type={type}
      value={value}
      required={required}
      inputMode={inputMode}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className={`${FIELD_COMPACT} w-full`}
    />
  )
}

/**
 * A text field for an update, only when it changed. Blank is sent as '',
 * which clears it on the server; an untouched field is left out, so a save
 * that changes nothing writes nothing — and a save made while the server is
 * still the previous version sends nothing it does not know.
 */
function edited<TKey extends string>(
  key: TKey,
  now: string,
  before: string | undefined,
): Partial<Record<TKey, string>> {
  return changed(now, before)
    ? ({ [key]: now.trim() } as Record<TKey, string>)
    : {}
}

function changed(now: string, before: string | undefined): boolean {
  return now.trim() !== (before ?? '').trim()
}
