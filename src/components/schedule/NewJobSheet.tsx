import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { flushSync } from 'react-dom'
import { Drawer } from 'vaul'
import { X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { JOB_TYPES } from '#/lib/format'
import {
  DEFAULT_INTERVAL,
  RecurrenceFields,
  intervalFromDraft,
} from './RecurrenceFields'
import { Combobox } from '#/components/primitives/Combobox'
import { Segmented } from '#/components/primitives/Segmented'
import {
  EMPTY_NEW_CLIENT,
  EMPTY_NEW_SITE,
  NEW_CLIENT_ERROR_COPY,
  NewClientFields,
  SiteAddressFields,
  SiteContactFields,
  newClientArgs,
  newSiteArgs,
} from '#/components/clients/NewClientFields'
import { FormAlert } from '#/components/forms/FormAlert'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import type { ErrorCopy } from '#/components/forms/describeError'
import type {
  NewClientArgs,
  NewClientFieldsValue,
  NewSiteArgs,
  NewSiteValue,
} from '#/components/clients/NewClientFields'
import type { Id } from '../../../convex/_generated/dataModel'
import type { IntervalUnit } from '../../../convex/lib/recurrence'
import { useHydrated } from '#/lib/useHydrated'
import { clientOptions, propertyOptions } from '#/lib/propertyOptions'
import { personLabel, useAssigneeOptions } from '#/lib/assignees'
import { OffViewNote } from './OffViewNote'
import { SheetPending } from '#/components/shell/Pending'
import { zonedDateTimeToUtc } from '../../../convex/lib/dates'
import { MAX_WORK_ORDER_LENGTH } from '../../../convex/lib/workOrder'

/** 'site' is a new site for an existing client (Prompt 6.3). */
type ClientMode = 'existing' | 'new' | 'site'

const PROPERTY_ERROR_ID = 'new-job-property-error'
const CLIENT_ERROR_ID = 'new-job-client-error'

/**
 * Why a booking failed, in FormAlert. This used to say "You may not have
 * access to that calendar" whatever had happened — for no signal, and for an
 * email the server refused, too — so the person went looking at permissions
 * for a typo. Access is named only when access is what was refused.
 */
const BOOKING_ERROR_COPY: ErrorCopy = {
  ...NEW_CLIENT_ERROR_COPY,
  NO_ACCESS:
    'Could not book this job: your access does not cover that calendar. Ask the business owner.',
  INVALID_ASSIGNEE:
    'Could not book this job: that person is no longer on the team. Choose someone else under Assigned to.',
  default: 'Could not book this job. Check your connection and try again.',
}

export function NewJobSheet({
  businessId,
  dayKey,
  timezone,
  open,
  onClose,
  assignTo,
  onBooked,
}: {
  businessId: Id<'businesses'>
  dayKey: string
  timezone: string
  open: boolean
  onClose: () => void
  /** Who the job starts out for — "give Kevin a job" from his join notice.
   * Anyone the form would not offer falls back to its usual choice. */
  assignTo?: Id<'memberships'>
  /** Once the job is booked — before the sheet closes. */
  onBooked?: () => void
}) {
  return (
    <Drawer.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />
          {/* The form suspends on the property and team lists. Its own
              boundary lets the sheet slide up at once; without one, the first
              open blanked the whole app until both had loaded. */}
          {open && (
            <Suspense
              fallback={
                <SheetPending
                  title={
                    <Drawer.Title className="text-sheet-title text-ink">
                      New job
                    </Drawer.Title>
                  }
                />
              }
            >
              <NewJobForm
                businessId={businessId}
                dayKey={dayKey}
                timezone={timezone}
                onClose={onClose}
                assignTo={assignTo}
                onBooked={onBooked}
              />
            </Suspense>
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

function NewJobForm({
  businessId,
  dayKey,
  timezone,
  onClose,
  assignTo,
  onBooked,
}: {
  businessId: Id<'businesses'>
  dayKey: string
  timezone: string
  onClose: () => void
  assignTo?: Id<'memberships'>
  onBooked?: () => void
}) {
  const { data: properties } = useSuspenseQuery(
    convexQuery(api.properties.list, { businessId }),
  )
  const { data: members } = useSuspenseQuery(
    convexQuery(api.memberships.listForBusiness, { businessId }),
  )

  // A business with no properties yet has nothing to pick from, so it starts
  // straight in "new client" mode rather than hitting a dead end.
  const [mode, setMode] = useState<ClientMode>(
    properties.length > 0 ? 'existing' : 'new',
  )
  const [propertyId, setPropertyId] = useState('')
  const businessState = useRouteContext({
    from: '/$businessSlug',
    select: (context) => context.business.state,
  })
  // A new address starts in the business's own state, not WA for everyone:
  // most of a Darwin business's clients are in the NT, and a Darwin address
  // typed by hand and left on WA is how prod came to hold "Fannybay WA".
  const [newClient, setNewClient] = useState<NewClientFieldsValue>(() => ({
    ...EMPTY_NEW_CLIENT,
    state: businessState || EMPTY_NEW_CLIENT.state,
  }))
  const [siteClientId, setSiteClientId] = useState('')
  const [newSite, setNewSite] = useState<NewSiteValue>(() => ({
    ...EMPTY_NEW_SITE,
    state: businessState || EMPTY_NEW_SITE.state,
  }))
  const [assignee, setAssignee] = useState<string>(assignTo ?? '')
  const [jobType, setJobType] = useState<string>(JOB_TYPES[0])
  const [time, setTime] = useState('09:00')
  const [price, setPrice] = useState('')
  const [duration, setDuration] = useState('60')
  const [workOrder, setWorkOrder] = useState('')
  const [addingWorkOrder, setAddingWorkOrder] = useState(false)
  const workOrderInput = useRef<HTMLInputElement>(null)
  // "Does it repeat" and "how often" are two questions, so they are two
  // controls: the interval fields stay mounted but disabled when it does not,
  // rather than appearing and reflowing the form under the person's thumb.
  const [repeats, setRepeats] = useState(false)
  const [interval, setInterval] = useState(DEFAULT_INTERVAL)
  /**
   * Null while "Recurring Job" is chosen but the interval does not describe
   * one — an emptied count field, say, which native validation lets through
   * because the input is not `required`.
   *
   * Without this the submit handler passed `null` down the SAME branch a
   * one-off takes, so "Book job" quietly created a plain job, closed the
   * sheet and reported success. The person asked for a repeating job and got
   * one job, with nothing to say so.
   */
  const chosenInterval = repeats ? intervalFromDraft(interval) : null
  const intervalIncomplete = repeats && chosenInterval === null

  // No client is chosen until the person chooses one. This used to fill in
  // the business's oldest property on open, so a job booked in a hurry went
  // to whoever happened to be first in the list — and nothing on the form
  // said so.
  const propertyOptionList = useMemo(
    () => propertyOptions(properties),
    [properties],
  )
  const [propertyMissing, setPropertyMissing] = useState(false)

  // One per client, from the sites already loaded — archived clients
  // included, and each saying where its sites are (see `clientOptions`).
  const clientOptionList = useMemo(
    () => clientOptions(properties),
    [properties],
  )
  const siteClient = properties.find((p) => p.clientId === siteClientId)?.client
  const [clientMissing, setClientMissing] = useState(false)
  const clientTrigger = useRef<HTMLButtonElement>(null)

  // A work order is mostly a business client's — a facilities company, an
  // agency — so for them the field is simply there. Anyone else can still
  // add one; a landlord's managing agent issues them too.
  const clientKind =
    mode === 'existing'
      ? properties.find((p) => p._id === propertyId)?.client?.kind
      : mode === 'site'
        ? siteClient?.kind
        : newClient.kind
  // Kept open while it holds anything, so a value typed for one client is
  // never sent unseen after switching to another.
  const showWorkOrder =
    clientKind === 'business' || addingWorkOrder || workOrder !== ''
  const propertyTrigger = useRef<HTMLButtonElement>(null)
  // A choice the list stops offering while the sheet is open is dropped
  // rather than submitted as an id nobody can see. Nothing removes a property
  // today, but the list is scoped to the client directory (clientScope.ts),
  // and a narrower scope would take rows away mid-booking.
  useEffect(() => {
    if (propertyId && !properties.some((p) => p._id === propertyId))
      setPropertyId('')
  }, [properties, propertyId])
  // The same for the new site's client.
  useEffect(() => {
    if (siteClientId && !properties.some((p) => p.clientId === siteClientId))
      setSiteClientId('')
  }, [properties, siteClientId])
  // Held to the options, not just seeded once: a switch starting or ending
  // while the sheet is open changes who may be booked, and a stale id would
  // be submitted as-is and refused.
  const { options: assignees, preferred } = useAssigneeOptions(members)
  useEffect(() => {
    if (!assignees.some((m) => m._id === assignee)) setAssignee(preferred)
  }, [assignees, assignee, preferred])

  const hydrated = useHydrated()
  // The new client's or new site's address, email and phone, checked at Book:
  // what may be wrong is listed above the button, and a second press books it
  // as it is. An existing property has nothing to check.
  const saveWarnings = useSaveWarnings()

  const convexCreate = useConvexMutation(api.jobs.create)
  const convexCreateRecurrence = useConvexMutation(api.recurrences.create)

  // A repeating booking is a recurrence, not a job: creating it materialises
  // the first occurrence and every one after it, so the two paths are distinct
  // rather than "a job plus some extra rows". Either can be booked against an
  // existing property, a new site for an existing client, or a brand-new
  // client created in the same submit — both mutations accept any one of the
  // three and insert what is new in the same transaction, so a failure never
  // leaves an orphaned client or site behind.
  const create = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      // Already in the server's shape (newClientArgs, newSiteArgs), and handed
      // to either mutation whole: mapped field by field here, once per
      // branch, a new field reached one and was silently dropped by the other.
      property:
        | { propertyId: Id<'properties'> }
        | { newProperty: NewSiteArgs }
        | { newClient: NewClientArgs }
      assignedMembershipId: Id<'memberships'>
      jobType: string
      price: number
      scheduledAt: number
      durationMinutes: number
      workOrder: string | undefined
      repeat: { count: number; unit: IntervalUnit } | null
      // Returns a job id or a recurrence id depending on the branch, and the
      // caller needs neither — void keeps them from being conflated.
    }): Promise<void> => {
      const { repeat: recurrence, property, ...job } = args
      return recurrence === null
        ? convexCreate({ ...job, ...property }).then(() => undefined)
        : convexCreateRecurrence({
            businessId: job.businessId,
            ...property,
            assignedMembershipId: job.assignedMembershipId,
            intervalCount: recurrence.count,
            intervalUnit: recurrence.unit,
            jobType: job.jobType,
            price: job.price,
            anchorDate: job.scheduledAt,
            durationMinutes: job.durationMinutes,
            // Listed by hand, like everything in this branch: a field left
            // off here is silently dropped from every visit of the series.
            workOrder: job.workOrder,
          }).then(() => undefined)
    },
    onSuccess: () => {
      onBooked?.()
      onClose()
    },
  })

  /**
   * Whose site it is comes first. Asked on the Book button's click as well as
   * on submit: the click runs before the browser checks the required address
   * fields below, which would otherwise send the person down to Street
   * address first, then back up to the client once that was filled.
   */
  function clientNeeded(): boolean {
    if (mode !== 'site' || siteClient) return false
    setClientMissing(true)
    clientTrigger.current?.focus()
    return true
  }
  // Only while it is still true: a client carried over from the Property
  // picker afterwards answers it.
  const showClientMissing = clientMissing && !siteClient

  /**
   * The booking as the form holds it now. Read when the save runs, which can
   * be up to 3 seconds after the press while the checks at Book answer: what
   * was typed meanwhile is what gets booked.
   */
  function bookingArgs() {
    const [hh, mm] = time.split(':').map(Number)
    // The picker gives a wall-clock time on the selected day, in the
    // tenant's own timezone — not the viewer's browser zone, which may
    // differ (a technician travelling, or simply a differently-configured
    // device) and would otherwise silently book the wrong instant.
    const scheduledAt = zonedDateTimeToUtc(dayKey, hh, mm, timezone)
    return {
      businessId,
      property:
        mode === 'existing'
          ? { propertyId: propertyId as Id<'properties'> }
          : mode === 'site'
            ? {
                newProperty: newSiteArgs(
                  siteClientId as Id<'clients'>,
                  clientKind,
                  newSite,
                ),
              }
            : { newClient: newClientArgs(newClient) },
      assignedMembershipId: assignee as Id<'memberships'>,
      jobType,
      price: Math.round(Number(price || '0') * 100),
      scheduledAt,
      durationMinutes: Number(duration),
      workOrder: workOrder.trim() || undefined,
      repeat: chosenInterval,
    }
  }
  const latestBooking = useLatest(bookingArgs)

  /**
   * What must be settled before anything is booked, each saying what is
   * missing and moving to it. Checked at the press, and again when a booking
   * that waited on its checks at Book finally goes: a client or property
   * changed in a picker meanwhile does not type into the form, so nothing
   * else would notice it.
   */
  function readyToBook(): boolean {
    if (intervalIncomplete) return false
    // Checked here rather than by disabling "Book job": the button sits at
    // the foot of a long sheet, and a greyed-out button tells someone on the
    // phone to a customer nothing about what is missing.
    if (mode === 'existing' && !properties.some((p) => p._id === propertyId)) {
      setPropertyMissing(true)
      propertyTrigger.current?.focus()
      return false
    }
    return !clientNeeded()
  }
  const latestReady = useLatest(readyToBook)

  /** Another client mode is another set of fields: warnings about the one
   * left are not about anything on screen. */
  function switchMode(next: (current: ClientMode) => ClientMode) {
    saveWarnings.reset()
    setMode(next)
  }

  const bookLabel = create.isPending
    ? 'Booking…'
    : saveWarnings.checking
      ? 'Checking…'
      : saveWarnings.warnings.length > 0
        ? 'Book anyway'
        : 'Book job'

  return (
    <SaveWarningsProvider value={saveWarnings}>
      <form
        className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!readyToBook()) return
          // Only then the warnings: nothing is worth confirming on a booking
          // that is still missing its client. mutateAsync, so a booking that
          // fails keeps them confirmed and Retry does not ask again. The
          // event, so a booking that waits on its checks is held to the
          // browser's own checks again before it goes — and to this sheet's
          // own, which the browser knows nothing about.
          saveWarnings.guard(e, () =>
            latestReady.current()
              ? create.mutateAsync(latestBooking.current())
              : undefined,
          )
        }}
      >
        <Drawer.Title className="text-sheet-title text-ink">
          New job
        </Drawer.Title>

        {properties.length > 0 && (
          <Field label="Client">
            <Segmented
              label="Client"
              // A new site is still an existing client's, so that tab stays
              // chosen; tapping it again leaves the site being added alone.
              value={mode === 'new' ? 'new' : 'existing'}
              onChange={(next) =>
                switchMode((m) =>
                  m === 'site' && next === 'existing' ? m : next,
                )
              }
              options={[
                { value: 'existing', label: 'Existing client' },
                { value: 'new', label: 'New client' },
              ]}
            />
          </Field>
        )}

        {mode === 'existing' ? (
          <>
            <Field label="Property">
              <Combobox
                value={propertyId}
                onChange={(next) => {
                  setPropertyId(next)
                  setPropertyMissing(false)
                }}
                options={propertyOptionList}
                placeholder="Search by name or address"
                emptyLabel="Choose a client and address"
                noMatchLabel="No client or address matches. Use New client above, or New site below for another address of an existing client."
                ariaLabel="Property"
                invalid={propertyMissing}
                errorId={PROPERTY_ERROR_ID}
                triggerRef={propertyTrigger}
              />
            </Field>
            {/* Outside the <label>: inside it, this sentence would become part
              of the field's name. */}
            {propertyMissing && (
              <p
                id={PROPERTY_ERROR_ID}
                role="alert"
                className="mt-1.5 text-caption text-red-ink"
              >
                Choose the client and address for this job.
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                // The client already found in the picker is most likely the
                // one with the new address, so it comes along.
                const picked = properties.find((p) => p._id === propertyId)
                flushSync(() => {
                  if (picked) setSiteClientId(picked.clientId)
                  switchMode(() => 'site')
                })
                clientTrigger.current?.focus()
              }}
              className="mt-3 text-[15px] font-semibold text-blue"
            >
              + New site for an existing client
            </button>
          </>
        ) : mode === 'site' ? (
          <>
            <Field label="New site for">
              <Combobox
                value={siteClientId}
                onChange={(next) => {
                  setSiteClientId(next)
                  setClientMissing(false)
                }}
                options={clientOptionList}
                placeholder="Search by name, phone or suburb"
                emptyLabel="Choose a client"
                noMatchLabel="No client matches. Use New client above to add them."
                ariaLabel="New site for"
                invalid={showClientMissing}
                errorId={CLIENT_ERROR_ID}
                triggerRef={clientTrigger}
              />
            </Field>
            {showClientMissing && (
              <p
                id={CLIENT_ERROR_ID}
                role="alert"
                className="mt-1.5 text-caption text-red-ink"
              >
                Choose the client this site belongs to.
              </p>
            )}
            <SiteAddressFields
              value={newSite}
              onChange={(patch) => setNewSite((v) => ({ ...v, ...patch }))}
              businessState={businessState}
            />
            {siteClient?.kind === 'business' && (
              <SiteContactFields
                value={newSite}
                onChange={(patch) => setNewSite((v) => ({ ...v, ...patch }))}
                businessState={businessState}
              />
            )}
            <button
              type="button"
              onClick={() => {
                // Focus goes where the person is going, as it does the other
                // way; left alone it falls back to the top of the sheet.
                flushSync(() => switchMode(() => 'existing'))
                propertyTrigger.current?.focus()
              }}
              className="mt-3 text-[15px] font-semibold text-blue"
            >
              Choose an existing site instead
            </button>
          </>
        ) : (
          <NewClientFields
            value={newClient}
            onChange={(patch) => setNewClient((v) => ({ ...v, ...patch }))}
            businessState={businessState}
          />
        )}

        {showWorkOrder ? (
          <Field label="Work Order (Optional)">
            <input
              ref={workOrderInput}
              value={workOrder}
              onChange={(e) => setWorkOrder(e.target.value)}
              maxLength={MAX_WORK_ORDER_LENGTH}
              // Work-order numbers are codes, not words: capitals on the phone
              // keyboard, and nothing "corrected" into a dictionary word.
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. WO-448120"
              className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
            />
          </Field>
        ) : (
          // A button, not a Field: inside a <label> it would take the label's
          // name. type="button" so it can never be the form's submit.
          <button
            type="button"
            onClick={() => {
              // Rendered now, and focused while the tap is still being handled:
              // iOS opens the keyboard only for a focus inside the tap, so a
              // focus deferred to the next frame leaves a ring and no keyboard.
              flushSync(() => setAddingWorkOrder(true))
              workOrderInput.current?.focus()
            }}
            className="mt-3 text-[15px] font-semibold text-blue"
          >
            + Add work order
          </button>
        )}

        <Field label="Job type">
          <Combobox
            value={jobType}
            onChange={setJobType}
            options={JOB_TYPES.map((t) => ({ value: t, label: t }))}
            allowCustom
            customLabel={(q) => `Add "${q}" as a new job type`}
            placeholder="Search or add a job type"
            ariaLabel="Job type"
          />
        </Field>

        <Field label="Assigned to">
          {assignees.length > 1 ? (
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
            >
              {assignees.map((m) => (
                <option key={m._id} value={m._id}>
                  {personLabel(m)}
                </option>
              ))}
            </select>
          ) : (
            // Someone who can only book themselves has nothing to choose, and a
            // one-option select reads as a choice they are being denied.
            <p className="flex h-12 w-full items-center rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink">
              Assigned to you
            </p>
          )}
          <OffViewNote assignee={assignee} people={assignees} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Start">
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
            />
          </Field>
          <Field label="Minutes">
            <input
              type="number"
              min="15"
              step="15"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
            />
          </Field>
        </div>

        <FieldGroup label="Repeat">
          <Segmented
            label="Repeat"
            value={repeats ? 'repeats' : 'once'}
            onChange={(v) => setRepeats(v === 'repeats')}
            disabled={!hydrated}
            options={[
              { value: 'once', label: 'One-off' },
              { value: 'repeats', label: 'Recurring Job' },
            ]}
          />
          {repeats && (
            <div className="mt-2">
              <RecurrenceFields
                value={interval}
                onChange={setInterval}
                idPrefix="new-job-repeat"
              />
            </div>
          )}
        </FieldGroup>

        <Field label="Price (AUD)">
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </Field>

        <FormAlert
          error={create.isError ? create.error : null}
          copy={BOOKING_ERROR_COPY}
          className="mt-3"
        />
        <SaveWarningsPanel className="mt-3" anywayLabel="Book anyway" />

        <button
          type="submit"
          onClick={(e) => {
            if (clientNeeded()) e.preventDefault()
          }}
          disabled={create.isPending || !hydrated || intervalIncomplete}
          className="mt-5 h-12 w-full rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
        >
          {bookLabel}
        </button>
      </form>
    </SaveWarningsProvider>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="mt-4 flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      {children}
    </label>
  )
}
/**
 * Like `Field`, but for a composite control rather than a single input.
 *
 * A `<label>` names exactly ONE control. Wrapping a group of them — a
 * segmented toggle, a number box, a unit select and a line of help text —
 * makes every descendant inherit the group's entire text as its accessible
 * name: the "One-off" tab came out called "Repeat Repeat Every 3 weeks,
 * starting from this job's date", which is both wrong for a screen reader and
 * ambiguous for anything matching controls by name. A labelled group is what
 * this shape actually is.
 */
function FieldGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div role="group" aria-label={label} className="mt-4 flex flex-col gap-1.5">
      {/* Already announced by the group's own name. */}
      <span className="section-label" aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  )
}
