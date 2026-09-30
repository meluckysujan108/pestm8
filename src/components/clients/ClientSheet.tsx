import { Suspense, lazy, useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Drawer } from 'vaul'
import {
  SHEET_BODY,
  SHEET_BODY_ABOVE_FOOTER,
  SHEET_FOOTER,
  SheetShell,
  useSheetLock,
} from '#/components/primitives/Sheet'
import {
  StatusPicker,
  StatusPillButton,
} from '#/components/primitives/StatusPicker'
import { CLIENT_STATUS } from '#/lib/statusColours'
import { Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import {
  ALL_SITES,
  ClientAtAGlance,
  ClientJobsTab,
} from '#/components/clients/ClientJobsTab'
import { DetailRow, DetailRows } from '#/components/primitives/DetailRow'
import { ClientNotesSection } from '#/components/notes/ClientNotesSection'
import { AbnInput } from '#/components/clients/AbnInput'
import { EmailInput } from '#/components/forms/EmailInput'
import { FieldMessage } from '#/components/forms/FieldMessage'
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
import { Segmented } from '#/components/primitives/Segmented'
import { loadLocalities } from '#/lib/addressVerify'
import { todayKey } from '#/lib/format'
import { useHydrated } from '#/lib/useHydrated'
import { SheetPending } from '#/components/shell/Pending'
import { abnDigits, formatAbn } from '../../../convex/lib/abn'
import {
  isNameCorrection,
  sameName,
} from '../../../convex/lib/contactNames'
import { siteContactOf } from '../../../convex/lib/siteContact'
import type { Id } from '../../../convex/_generated/dataModel'
import type { AddressCheck } from '#/components/forms/VerifiedAddressFields'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { AddressValue } from '#/lib/addressVerify'
import { PRIMARY_BUTTON_COMPACT, SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { DeleteButton } from '#/components/primitives/DeleteButton'
import {
  ClientStatusPill,
  TagChips,
  TagInput,
  clientNumberLabel,
  tagsInUse,
} from '#/components/clients/ClientRecordBits'
import {
  CLIENT_STATUSES,
  clientNumberFromText,
} from '../../../convex/lib/clientRecord'
import type { ClientStatus } from '../../../convex/lib/clientRecord'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { KIND_CHOICES, KIND_LABELS } from '#/lib/clientFilters'

type ClientKind = 'person' | 'business'

type ClientTab = 'jobs' | 'notes' | 'details'

const TAB_LABELS: Record<ClientTab, string> = {
  jobs: 'Jobs',
  notes: 'Notes',
  details: 'Details',
}

/**
 * Loaded when "Book a job" is pressed, as the job sheet loads Make recurring:
 * New Job brings its pickers, the interval model and the save checks, which
 * a client sheet opened to read never needs.
 */
const NewJobSheet = lazy(() =>
  import('#/components/schedule/NewJobSheet').then((m) => ({
    default: m.NewJobSheet,
  })),
)

/** What a failed archive, remove or make-primary says: these are not saves,
 * so describeError's "Could not save" words would name the wrong thing. */
/** A delete's refusals, in words: `actionCopy`, and the one it adds. */
function deleteCopy(thing: string): ErrorCopy {
  return {
    ...actionCopy(`delete ${thing}`),
    TOO_MUCH_TO_DELETE: `Could not delete ${thing}: it has too many records to move to the Recycle bin at once. Delete its properties one at a time first.`,
  }
}

function actionCopy(action: string): ErrorCopy {
  return {
    offline: `Could not ${action}: this device is offline. Try again when you have signal.`,
    NOT_FOUND: `Could not ${action}: it has changed since you opened this. Close it and look again.`,
    NO_ACCESS: `Could not ${action}: your access does not cover this. Ask the business owner.`,
    default: `Could not ${action}. Check your signal and try again.`,
  }
}

export function ClientSheet({
  businessId,
  timezone,
  businessSlug,
  businessState,
  canManageClients,
  canRenumber = false,
  clientId,
  onClose,
}: {
  businessId: Id<'businesses'>
  timezone: string
  businessSlug: string
  /** Where address suggestions lean, and a new property's starting state. */
  businessState: string
  /** `clients.manage`: the owner and contractors. Offers Delete. */
  canManageClients: boolean
  /** `business.manage`: the owner. Client numbers are given automatically;
   * only the owner changes one, to match an old system. */
  canRenumber?: boolean
  clientId: string | null
  onClose: () => void
}) {
  return (
    <SheetShell open={clientId !== null} onClose={onClose}>
      {clientId !== null && (
        <ClientBody
          key={clientId}
          businessId={businessId}
          timezone={timezone}
          businessSlug={businessSlug}
          businessState={businessState}
          canManageClients={canManageClients}
          canRenumber={canRenumber}
          clientId={clientId as Id<'clients'>}
          onClose={onClose}
        />
      )}
    </SheetShell>
  )
}

function ClientBody({
  businessId,
  timezone,
  businessSlug,
  businessState,
  canManageClients,
  canRenumber,
  clientId,
  onClose,
}: {
  businessId: Id<'businesses'>
  timezone: string
  businessSlug: string
  businessState: string
  /** `clients.manage`: the owner and contractors. Offers Delete. */
  canManageClients: boolean
  canRenumber: boolean
  clientId: Id<'clients'>
  onClose: () => void
}) {
  const clientQuery = useQuery(
    convexQuery(api.clients.get, { businessId, clientId }),
  )
  const client = clientQuery.data
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
  // A contact or site being added or edited below. The client's Edit hides
  // meanwhile: it swaps the whole sheet for the edit form, and would take
  // the half-typed contact or address with it.
  const [contactFormOpen, setContactFormOpen] = useState(false)
  const [propertyFormOpen, setPropertyFormOpen] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  // Which part of the client is shown. Kept here, above the edit form, so
  // Edit → Save comes back to the same tab.
  const [tab, setTab] = useState<ClientTab>('jobs')
  // The Jobs tab's site, kept across tabs, and where "Book a job" starts.
  const [site, setSite] = useState<string>(ALL_SITES)
  const [bookOpen, setBookOpen] = useState(false)
  const { data: properties } = useQuery(
    convexQuery(api.properties.listByClient, { businessId, clientId }),
  )
  const hydrated = useHydrated()

  const convexDelete = useConvexMutation(api.bin.deleteClient)
  const remove = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; clientId: Id<'clients'> }) =>
      convexDelete(args),
    onSuccess: onClose,
  })

  // The state's suburb table, fetched as the sheet opens while there is
  // signal, so an address edited at a door with none is still checked.
  useEffect(() => {
    void loadLocalities(businessState)
  }, [businessState])

  if (client === undefined && clientQuery.isError) {
    return (
      <div className="px-4 py-10">
        <Drawer.Title className="text-sheet-title text-ink">Client</Drawer.Title>
        <LoadFailed
          className="mt-3"
          what="this client"
          onRetry={() => void clientQuery.refetch()}
        />
      </div>
    )
  }

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

  // A client's number heads their sheet, as a job's does: "CLIENT #1916".
  const kicker =
    client.clientNumber !== undefined
      ? `Client ${clientNumberLabel(client.clientNumber)}`
      : 'Client'

  if (editing) {
    // Edit mode is the form and nothing else, its Save and Cancel pinned
    // below it, and the sheet locked against a swipe (useSheetLock).
    return (
      <ClientEditForm
        businessId={businessId}
        businessState={businessState}
        client={client}
        contactPerson={contactPerson ?? ''}
        canRenumber={canRenumber}
        onDone={() => setEditing(false)}
        header={
          <>
            <p className="section-label mb-0.5 mr-10 tabular-nums">
              {client.clientNumber !== undefined
                ? `Editing client ${clientNumberLabel(client.clientNumber)}`
                : 'Editing client'}
            </p>
            <Drawer.Title className="mr-10 text-sheet-title text-ink">
              {client.name}
            </Drawer.Title>
          </>
        }
      />
    )
  }

  // A contact or site half-typed in Details holds the tabs still: leaving
  // would unmount the form and lose it without a word.
  const formOpen = contactFormOpen || propertyFormOpen
  // Their site is chosen for New Job only when which one is plain: their
  // only one, or the one the Jobs tab is showing. Otherwise New Job asks, as
  // it always does — a hurried booking must not go to whichever came first.
  const bookFor =
    properties?.find((p) => p._id === site)?._id ??
    (properties?.length === 1 ? properties[0]._id : undefined)

  return (
    <div className={`${SHEET_BODY} pt-3`}>
      <div className="flex items-center justify-between gap-2">
        <p className="section-label mb-0.5 tabular-nums">{kicker}</p>
        {!formOpen && (
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
      <Drawer.Title className="text-sheet-title text-ink">
        {client.name}
      </Drawer.Title>

      <ClientStatusRow
        businessId={businessId}
        clientId={clientId}
        clientName={client.name}
        status={client.status}
        kindLabel={KIND_LABELS[client.kind]}
      />
      {client.tags && client.tags.length > 0 && (
        <div className="mt-2">
          <TagChips tags={client.tags} />
        </div>
      )}

      <div className="mt-3">
        <ContactButtons
          name={client.name}
          phone={client.phone}
          email={client.email}
        />
      </div>

      <ClientAtAGlance
        businessId={businessId}
        clientId={clientId}
        timezone={timezone}
      />

      {/* Booked from here, over this sheet — no trip to the Schedule and
          back. A client with no property yet has nowhere to book to: Details
          adds one. Held while a contact or site is half-typed, as Edit is:
          a booking switches to Jobs, which would take it away. */}
      {properties && properties.length > 0 && (
        <button
          type="button"
          disabled={!hydrated || formOpen}
          onClick={() => setBookOpen(true)}
          className={`${SECONDARY_BUTTON_COMPACT} mt-3 flex w-full items-center justify-center gap-2`}
        >
          <Plus size={16} strokeWidth={2.2} />
          Book a job for this client
        </button>
      )}

      <div className="mt-5">
        <Segmented
          label="Client"
          value={tab}
          onChange={setTab}
          disabled={!hydrated || formOpen}
          options={[
            { value: 'jobs', label: 'Jobs' },
            { value: 'notes', label: 'Notes' },
            { value: 'details', label: 'Details' },
          ]}
        />
      </div>

      <div role="tabpanel" aria-label={TAB_LABELS[tab]}>
        {tab === 'jobs' && (
          <ClientJobsTab
            businessId={businessId}
            businessSlug={businessSlug}
            timezone={timezone}
            clientId={clientId}
            clientName={client.name}
            site={site}
            onSite={setSite}
          />
        )}

        {tab === 'notes' && (
          <ClientNotesSection
            businessId={businessId}
            businessSlug={businessSlug}
            timezone={timezone}
            clientId={clientId}
            clientName={client.name}
          />
        )}

        {tab === 'details' && (
          <>
            <Section label="Details" card>
              <DetailRows>
                <DetailRow
                  label="Client number"
                  value={
                    client.clientNumber !== undefined
                      ? clientNumberLabel(client.clientNumber)
                      : 'None'
                  }
                  sub="Given automatically"
                />
                {client.kind === 'business' && client.abn && (
                  <DetailRow
                    label="ABN"
                    value={
                      <span className="select-text tabular-nums">
                        {formatAbn(client.abn)}
                      </span>
                    }
                  />
                )}
                {client.kind === 'business' && contactPerson && (
                  <DetailRow label="Contact person" value={contactPerson} />
                )}
                {client.phone && (
                  <DetailRow
                    label="Phone"
                    value={<span className="select-text">{client.phone}</span>}
                  />
                )}
                {client.email && (
                  <DetailRow
                    label="Email"
                    value={<span className="select-text">{client.email}</span>}
                  />
                )}
                {client.kind === 'business' &&
                  (client.addressLine || client.suburb) && (
                    <DetailRow
                      label="Company address"
                      value={client.addressLine || client.suburb}
                      sub={
                        client.addressLine
                          ? `${client.suburb ?? ''} ${client.state ?? ''} ${client.postcode ?? ''}`.trim()
                          : undefined
                      }
                    />
                  )}
              </DetailRows>
            </Section>

            {/* A business needs named people because "ACME Pest Control"
                can't answer a phone; a person client already is their own
                one contact. */}
            {client.kind === 'business' && (
              <ClientContacts
                businessId={businessId}
                businessState={businessState}
                clientId={clientId}
                canRemove={canManageClients}
                onFormOpenChange={setContactFormOpen}
              />
            )}

            <ClientProperties
              businessId={businessId}
              businessState={businessState}
              clientId={clientId}
              clientKind={client.kind}
              canDelete={canManageClients}
              onFormOpenChange={setPropertyFormOpen}
            />

            {canManageClients && (
              <DeleteButton
                disabled={!hydrated}
                onClick={() => setConfirmDeleteOpen(true)}
              >
                Delete client
              </DeleteButton>
            )}
            {/* Here, not in the dialog: the dialog closes as Delete is
                pressed. */}
            <FormAlert
              className="mt-2"
              error={remove.isError ? remove.error : null}
              copy={deleteCopy('this client')}
            />
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={`Delete ${client.name}?`}
        body={
          <>
            They go to the Recycle bin with their properties, jobs,
            recurring services, notes and draft reports. The business owner
            can restore them from Settings → Recycle bin for 30 days.
            Finalised reports are kept in Reports.
          </>
        }
        cancel="Keep client"
        confirm="Delete"
        pending={remove.isPending}
        pendingLabel="Deleting…"
        onConfirm={() => remove.mutate({ businessId, clientId })}
      />

      {/* Loaded when asked for: New Job brings the pickers and the
          interval model, which a client sheet opened to read never needs. */}
      <Suspense fallback={null}>
        {bookOpen && (
          <NewJobSheet
            open
            businessId={businessId}
            dayKey={todayKey(timezone)}
            timezone={timezone}
            onClose={() => setBookOpen(false)}
            forProperty={bookFor}
            pickDate
            onBooked={() => setTab('jobs')}
          />
        )}
      </Suspense>
    </div>
  )
}

/**
 * The client's status as a pill that can be tapped, as a job's is: it opens
 * the status sheet, and a choice is saved at once. A client made Inactive
 * whose recurring services are still running is told so, with a way to stop
 * them — two separate acts, the second asked about first.
 */
function ClientStatusRow({
  businessId,
  clientId,
  clientName,
  status,
  kindLabel,
}: {
  businessId: Id<'businesses'>
  clientId: Id<'clients'>
  clientName: string
  status?: ClientStatus
  kindLabel: string
}) {
  const current = status ?? 'active'
  const [open, setOpen] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const pillButton = useRef<HTMLButtonElement>(null)
  const hydrated = useHydrated()

  const convexUpdate = useConvexMutation(api.clients.update)
  const save = useMutation({
    mutationFn: (next: ClientStatus) =>
      convexUpdate({ businessId, clientId, status: next }),
  })

  // Asked only of an Inactive client: what is still running for them.
  const running = useQuery(
    convexQuery(
      api.recurrences.runningForClient,
      current === 'inactive' ? { businessId, clientId } : 'skip',
    ),
  ).data
  const convexStop = useConvexMutation(api.recurrences.stopForClient)
  const stop = useMutation({
    mutationFn: () => convexStop({ businessId, clientId }),
    onSuccess: () => setConfirmStop(false),
  })
  const services = (n: number) =>
    n === 1 ? '1 recurring service' : `${n} recurring services`

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPillButton
          pill={<ClientStatusPill status={status} />}
          ariaLabel="Change client status"
          // Not disabled while a choice saves: the status sheet hands focus
          // back to it as it closes, and a disabled button cannot take it.
          disabled={!hydrated}
          buttonRef={pillButton}
          onClick={() => {
            // A second open would reset the save still running, and its
            // error would never show.
            if (save.isPending) return
            save.reset()
            setOpen(true)
          }}
        />
        <span className="text-body text-muted">{kindLabel}</span>
      </div>
      <FormAlert
        className="mt-2"
        error={save.isError ? save.error : null}
        copy={actionCopy('change their status')}
      />

      {current === 'inactive' && running && running.running > 0 && (
        <div className="mt-2 rounded-xl bg-surface-2 px-3 py-2.5">
          <p className="text-caption text-ink-2">
            {services(running.running)} still{' '}
            {running.running === 1 ? 'runs' : 'run'} for {clientName}, booking
            visits.
          </p>
          {running.stoppable > 0 && (
            <button
              type="button"
              disabled={!hydrated}
              onClick={() => {
                stop.reset()
                setConfirmStop(true)
              }}
              className="relative tap-target mt-1 text-caption font-semibold text-red disabled:opacity-50"
            >
              {running.stoppable === running.running
                ? 'Stop them'
                : `Stop the ${running.stoppable} you can`}
            </button>
          )}
        </div>
      )}
      {current === 'inactive' && stop.data && stop.data.skipped > 0 && (
        <p role="status" className="mt-2 text-caption text-ink-2">
          {services(stop.data.skipped)} left running: stopping{' '}
          {stop.data.skipped === 1 ? 'it is' : 'them is'} up to whoever does
          that work.
        </p>
      )}

      <StatusPicker
        open={open}
        onClose={() => setOpen(false)}
        title="Client status"
        description={clientName}
        choices={CLIENT_STATUSES.map((value) => ({
          value,
          pill: <ClientStatusPill status={value} />,
          meaning: CLIENT_STATUS[value].meaning,
        }))}
        value={current}
        onChoose={(next) => {
          setOpen(false)
          if (next === current) return
          stop.reset()
          save.mutate(next)
        }}
        returnFocusRef={pillButton}
      />

      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={`Stop ${clientName}’s recurring services?`}
        body="No more visits are booked, and the ones still to come are cancelled. They stay on the schedule marked cancelled; past and completed visits are not touched."
        cancel="Keep them running"
        confirm="Stop services"
        pending={stop.isPending}
        pendingLabel="Stopping…"
        closeOnConfirm={false}
        error={
          stop.isError
            ? 'Could not stop them. Check your signal and try again.'
            : null
        }
        onConfirm={() => stop.mutate()}
      />
    </>
  )
}

function ClientEditForm({
  businessId,
  businessState,
  client,
  contactPerson: prefilledContactPerson,
  canRenumber,
  onDone,
  header,
}: {
  /** The owner, who alone may change the client number. */
  canRenumber: boolean
  /** The sheet's own heading, drawn above the fields. */
  header: React.ReactNode
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
    clientNumber?: number
    status?: ClientStatus
    tags?: Array<string>
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
  const [numberText, setNumberText] = useState(
    client.clientNumber === undefined ? '' : String(client.clientNumber),
  )
  const [tags, setTags] = useState<Array<string>>(client.tags ?? [])
  // The business's tags, offered as one is typed: the list the Clients page
  // already has.
  const { data: allClients } = useQuery(
    convexQuery(api.clients.list, { businessId }),
  )
  const suggestions = tagsInUse(allClients ?? []).map((t) => t.tag)
  const wantedNumber = clientNumberFromText(numberText)
  const numberProblem =
    numberText.trim() !== '' && wantedNumber === null
      ? 'A client number is a whole number, like 1916.'
      : null

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
      tags?: Array<string>
      clientNumber?: number
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
      ...(tags.join('\n') !== (client.tags ?? []).join('\n') && { tags }),
      // The owner's alone to change (clients.update refuses anyone else).
      ...(canRenumber &&
        wantedNumber !== null &&
        wantedNumber !== client.clientNumber && {
          clientNumber: wantedNumber,
        }),
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
  const formId = `${id}-form`

  // Anything changed? The sheet then asks before a close throws it away; it
  // is locked against a swipe while the form is open either way.
  const pending = args()
  const [openedNumber] = useState(numberText)
  // Judged by what the person changed, not by what a save would write: a
  // lone saved state ("ACT" with no street) is mended by any save, and
  // opening the form must not count as changing it.
  const hasChanges =
    kind !== client.kind ||
    name.trim() !== client.name.trim() ||
    numberText !== openedNumber ||
    (kind === 'business' && changed(address.state, savedAddress.state)) ||
    Object.keys(pending).some(
      (key) =>
        !['businessId', 'clientId', 'kind', 'name', 'state'].includes(key),
    )
  useSheetLock(hasChanges)

  return (
    <SaveWarningsProvider value={warnings}>
      <div className={`${SHEET_BODY_ABOVE_FOOTER} pt-3`}>
      {header}
      <form
        id={formId}
        className="mt-3 flex flex-col gap-3 pb-2"
        onSubmit={(e) => {
          if (numberProblem) {
            e.preventDefault()
            return
          }
          return warnings.guard(e, () => save.mutateAsync(latestArgs.current()))
        }}
      >
        <WrappedField label="Client type">
          <Segmented
            kind="choice"
            label="Client type"
            value={kind}
            onChange={setKind}
            options={KIND_CHOICES}
          />
        </WrappedField>
        <WrappedField
          label={kind === 'business' ? 'Company name' : 'Client name'}
        >
          <TextInput value={name} onChange={setName} required />
        </WrappedField>
        {/* Given automatically. Only the owner changes one, to match the
            number an old system gave the client; everyone else sees it. */}
        {canRenumber ? (
          <>
            <WrappedField label="Client number">
              <TextInput
                value={numberText}
                onChange={setNumberText}
                inputMode="numeric"
              />
            </WrappedField>
            {numberProblem ? (
              <FieldMessage tone="error" className="-mt-1.5">
                {numberProblem}
              </FieldMessage>
            ) : (
              <p className="-mt-1.5 text-caption text-muted">
                Given automatically. Change it only to match another system.
              </p>
            )}
          </>
        ) : (
          client.clientNumber !== undefined && (
            <div className="flex flex-col gap-1.5">
              <span className="section-label">Client number</span>
              <p className="flex h-11 items-center rounded-xl bg-surface-3 px-3.5 text-[16px] tabular-nums text-ink">
                {clientNumberLabel(client.clientNumber)}
              </p>
            </div>
          )
        )}
        <div className="flex flex-col gap-1.5">
          <span className="section-label">Tags (optional)</span>
          <TagInput
            value={tags}
            onChange={setTags}
            suggestions={suggestions}
            label="Tags"
          />
        </div>
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
              Company address (optional)
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
        <SaveWarningsPanel />
      </form>
      </div>

      {/* Pinned below the fields, so Save is in reach with the keyboard up,
          and a failed save says why just above it, where it is seen. */}
      <div className={`${SHEET_FOOTER} flex flex-col gap-2`}>
        <FormAlert
          error={save.isError ? save.error : null}
          copy={CLIENT_RECORD_COPY}
        />
        <div className="flex gap-2">
        <button
          type="button"
          disabled={save.isPending}
          onClick={onDone}
          className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
        >
          Cancel
        </button>
        <button
          type="submit"
          form={formId}
          disabled={save.isPending || !hydrated}
          className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
        >
          {save.isPending ? 'Saving…' : warnings.saveLabel('Save')}
        </button>
        </div>
      </div>
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
  canRemove,
  onFormOpenChange,
}: {
  businessId: Id<'businesses'>
  businessState: string
  clientId: Id<'clients'>
  /** `clients.manage`: removing a contact puts it in the Recycle bin. */
  canRemove: boolean
  /** Told when a contact is being added or edited, and when not. */
  onFormOpenChange: (open: boolean) => void
}) {
  const { data: contacts } = useQuery(
    convexQuery(api.clientContacts.list, { businessId, clientId }),
  )
  const [adding, setAdding] = useState(false)
  // Where focus goes once a contact is removed: its row, and the button
  // that opened the dialog, go with it.
  const addButton = useRef<HTMLButtonElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const formOpen = adding || editingId !== null
  useEffect(() => {
    onFormOpenChange(formOpen)
  }, [formOpen, onFormOpenChange])
  useEffect(() => () => onFormOpenChange(false), [onFormOpenChange])
  // Every removal asks first: a contact goes to the Recycle bin with their
  // number and email, and the confirm says where to get them back. The
  // primary contact's also says they are the client's contact person.
  const [confirmRemove, setConfirmRemove] = useState<{
    _id: Id<'clientContacts'>
    name: string
    isPrimary?: boolean
  } | null>(null)

  const convexRemove = useConvexMutation(api.bin.deleteContact)
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
                      <Star size={14} strokeWidth={2} />
                    </button>
                  )}
                  {canRemove && (
                    <button
                      type="button"
                      aria-label={`Remove ${contact.name}`}
                      disabled={remove.isPending}
                      onClick={() => setConfirmRemove(contact)}
                      className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-50"
                    >
                      <Trash2 size={14} strokeWidth={2} />
                    </button>
                  )}
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
          ref={addButton}
          type="button"
          onClick={() => setAdding(true)}
          className={`${SECONDARY_BUTTON_COMPACT} flex w-full items-center justify-center gap-2`}
        >
          <Plus size={16} strokeWidth={2.2} />
          Add contact
        </button>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => !open && setConfirmRemove(null)}
        title={`Remove ${confirmRemove?.name ?? ''}?`}
        body={`${confirmRemove?.isPrimary ? 'They’re this client’s contact person. ' : ''}They go to the Recycle bin with their number and email, and stop getting this client’s reports. The business owner can restore them from Settings → Recycle bin for 30 days.`}
        cancel="Keep contact"
        confirm="Remove"
        pending={remove.isPending}
        returnFocus={(confirmed) => (confirmed ? addButton.current : null)}
        onConfirm={() => confirmRemove && removeContact(confirmRemove._id)}
      />
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
  // Open, it locks the sheet; typed in, a close asks first.
  useSheetLock([name, role, phone, email].some((field) => field.trim() !== ''))

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
  useSheetLock(
    changed(name, contact.name) ||
      changed(role, contact.role) ||
      changed(phone, contact.phone) ||
      changed(email, contact.email),
  )

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
  canDelete,
  onFormOpenChange,
}: {
  businessId: Id<'businesses'>
  businessState: string
  clientId: Id<'clients'>
  clientKind: ClientKind
  canDelete: boolean
  /** Told when a site is being added or edited, and when not. */
  onFormOpenChange: (open: boolean) => void
}) {
  const { data: properties } = useQuery(
    convexQuery(api.properties.listByClient, { businessId, clientId }),
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const formOpen = adding || editingId !== null
  useEffect(() => {
    onFormOpenChange(formOpen)
  }, [formOpen, onFormOpenChange])
  useEffect(() => () => onFormOpenChange(false), [onFormOpenChange])

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
                canDelete={canDelete}
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
          <Plus size={16} strokeWidth={2.2} />
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
      <h4 className="section-label mb-1">Site contact</h4>
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
  canDelete,
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
  canDelete: boolean
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
  useSheetLock(
    (Object.keys(saved) as Array<keyof PropertyFieldsValue>).some((key) =>
      changed(value[key], saved[key]),
    ),
  )

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const convexDelete = useConvexMutation(api.bin.deleteProperty)
  const remove = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      propertyId: Id<'properties'>
    }) => convexDelete(args),
    onSuccess: onDone,
  })

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
        {canDelete && (
          <>
            <DeleteButton
              className="mt-1"
              disabled={!hydrated || save.isPending}
              onClick={() => setConfirmDeleteOpen(true)}
            >
              Delete this property
            </DeleteButton>
            <FormAlert
              error={remove.isError ? remove.error : null}
              copy={deleteCopy('this property')}
            />
            <ConfirmDialog
              open={confirmDeleteOpen}
              onOpenChange={setConfirmDeleteOpen}
              title={`Delete ${property.addressLine}?`}
              body={
                <>
                  It goes to the Recycle bin with its jobs, recurring
                  services, notes and draft reports. The business owner can
                  restore it from Settings → Recycle bin for 30 days.
                  Finalised reports are kept in Reports.
                </>
              }
              cancel="Keep property"
              confirm="Delete"
              pending={remove.isPending}
              pendingLabel="Deleting…"
              onConfirm={() =>
                remove.mutate({ businessId, propertyId: property._id })
              }
            />
          </>
        )}
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
  const [opened] = useState(value)
  useSheetLock(
    (Object.keys(opened) as Array<keyof PropertyFieldsValue>).some((key) =>
      changed(value[key], opened[key]),
    ),
  )

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

const CLIENT_RECORD_COPY: ErrorCopy = {
  NO_ACCESS:
    'Could not save: only the business owner can change a client number.',
  CLIENT_NUMBER_TAKEN:
    'Could not save: another client already has that number. Choose another.',
  INVALID_CLIENT_NUMBER:
    'Could not save: a client number is a whole number, like 1916.',
  TOO_MANY_TAGS: 'Could not save: a client can have up to 20 tags.',
  TAG_TOO_LONG: 'Could not save: a tag can be up to 40 letters.',
}

function Section({
  label,
  children,
  card = false,
}: {
  label: string
  children: React.ReactNode
  /** In a card of its own: rows that each pad themselves (`DetailRows`). */
  card?: boolean
}) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">{label}</h3>
      {card ? (
        <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
          {children}
        </div>
      ) : (
        children
      )}
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
