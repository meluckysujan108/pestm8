import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
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
  NewClientFields,
} from '#/components/clients/NewClientFields'
import type { NewClientFieldsValue } from '#/components/clients/NewClientFields'
import type { Id } from '../../../convex/_generated/dataModel'
import type { IntervalUnit } from '../../../convex/lib/recurrence'
import { useHydrated } from '#/lib/useHydrated'
import { propertyOptions } from '#/lib/propertyOptions'
import { personLabel, useAssigneeOptions } from '#/lib/assignees'
import { OffViewNote } from './OffViewNote'
import { SheetPending } from '#/components/shell/Pending'
import { zonedDateTimeToUtc } from '../../../convex/lib/dates'
import { MAX_WORK_ORDER_LENGTH } from '../../../convex/lib/workOrder'

type ClientMode = 'existing' | 'new'

const PROPERTY_ERROR_ID = 'new-job-property-error'

export function NewJobSheet({
  businessId,
  dayKey,
  timezone,
  open,
  onClose,
}: {
  businessId: Id<'businesses'>
  dayKey: string
  timezone: string
  open: boolean
  onClose: () => void
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
}: {
  businessId: Id<'businesses'>
  dayKey: string
  timezone: string
  onClose: () => void
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
  const [newClient, setNewClient] =
    useState<NewClientFieldsValue>(EMPTY_NEW_CLIENT)
  const [assignee, setAssignee] = useState('')
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
  // A work order is mostly a business client's — a facilities company, an
  // agency — so for them the field is simply there. Anyone else can still
  // add one; a landlord's managing agent issues them too.
  const clientKind =
    mode === 'existing'
      ? properties.find((p) => p._id === propertyId)?.client?.kind
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
  // Held to the options, not just seeded once: a switch starting or ending
  // while the sheet is open changes who may be booked, and a stale id would
  // be submitted as-is and refused.
  const { options: assignees, preferred } = useAssigneeOptions(members)
  useEffect(() => {
    if (!assignees.some((m) => m._id === assignee)) setAssignee(preferred)
  }, [assignees, assignee, preferred])

  const hydrated = useHydrated()

  const convexCreate = useConvexMutation(api.jobs.create)
  const convexCreateRecurrence = useConvexMutation(api.recurrences.create)

  // A repeating booking is a recurrence, not a job: creating it materialises
  // the first occurrence and every one after it, so the two paths are distinct
  // rather than "a job plus some extra rows". Either can be booked against an
  // existing property or a brand-new client created in the same submit —
  // both mutations accept one or the other and insert the client+property in
  // the same transaction, so a failure never leaves an orphaned client behind.
  const create = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      property:
        { propertyId: Id<'properties'> } | { newClient: NewClientFieldsValue }
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
      const propertyArgs =
        'propertyId' in property
          ? { propertyId: property.propertyId }
          : {
              newClient: {
                clientName: property.newClient.clientName,
                kind: property.newClient.kind,
                addressLine: property.newClient.addressLine,
                suburb: property.newClient.suburb,
                state: property.newClient.state,
                postcode: property.newClient.postcode,
                phone: property.newClient.phone.trim() || undefined,
                email: property.newClient.email.trim() || undefined,
              },
            }
      return recurrence === null
        ? convexCreate({ ...job, ...propertyArgs }).then(() => undefined)
        : convexCreateRecurrence({
            businessId: job.businessId,
            ...propertyArgs,
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
    onSuccess: onClose,
  })

  return (
    <form
      className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (intervalIncomplete) return
        // Checked here rather than by disabling "Book job": the button sits at
        // the foot of a long sheet, and a greyed-out button tells someone on
        // the phone to a customer nothing about what is missing.
        if (
          mode === 'existing' &&
          !properties.some((p) => p._id === propertyId)
        ) {
          setPropertyMissing(true)
          propertyTrigger.current?.focus()
          return
        }
        const [hh, mm] = time.split(':').map(Number)
        // The picker gives a wall-clock time on the selected day, in the
        // tenant's own timezone — not the viewer's browser zone, which may
        // differ (a technician travelling, or simply a differently-configured
        // device) and would otherwise silently book the wrong instant.
        const scheduledAt = zonedDateTimeToUtc(dayKey, hh, mm, timezone)

        create.mutate({
          businessId,
          property:
            mode === 'existing'
              ? { propertyId: propertyId as Id<'properties'> }
              : { newClient },
          assignedMembershipId: assignee as Id<'memberships'>,
          jobType,
          price: Math.round(Number(price || '0') * 100),
          scheduledAt,
          durationMinutes: Number(duration),
          workOrder: workOrder.trim() || undefined,
          repeat: chosenInterval,
        })
      }}
    >
      <Drawer.Title className="text-sheet-title text-ink">New job</Drawer.Title>

      {properties.length > 0 && (
        <Field label="Client">
          <Segmented
            label="Client"
            value={mode}
            onChange={setMode}
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
              noMatchLabel="No client or address matches. Use New client above to add them."
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
        </>
      ) : (
        <NewClientFields
          value={newClient}
          onChange={(patch) => setNewClient((v) => ({ ...v, ...patch }))}
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
            setAddingWorkOrder(true)
            // Once the input exists, not before.
            requestAnimationFrame(() => workOrderInput.current?.focus())
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

      {create.isError && (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
        >
          Could not book this job. You may not have access to that calendar.
        </p>
      )}

      <button
        type="submit"
        disabled={create.isPending || !hydrated || intervalIncomplete}
        className="mt-5 h-12 w-full rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
      >
        {create.isPending ? 'Booking…' : 'Book job'}
      </button>
    </form>
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
