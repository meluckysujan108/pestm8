import { useEffect, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Drawer } from 'vaul'
import { X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { JOB_TYPES } from '#/lib/format'
import type { Id } from '../../../convex/_generated/dataModel'

export function NewJobSheet({
  businessId,
  dayKey,
  open,
  onClose,
}: {
  businessId: Id<'businesses'>
  dayKey: string
  open: boolean
  onClose: () => void
}) {
  return (
    <Drawer.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />
          {open && (
            <NewJobForm
              businessId={businessId}
              dayKey={dayKey}
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

function NewJobForm({
  businessId,
  dayKey,
  onClose,
}: {
  businessId: Id<'businesses'>
  dayKey: string
  onClose: () => void
}) {
  const { data: properties } = useSuspenseQuery(
    convexQuery(api.properties.list, { businessId }),
  )
  const { data: members } = useSuspenseQuery(
    convexQuery(api.memberships.listForBusiness, { businessId }),
  )

  const [propertyId, setPropertyId] = useState('')
  const [assignee, setAssignee] = useState('')
  const [jobType, setJobType] = useState<string>(JOB_TYPES[0])
  const [time, setTime] = useState('09:00')
  const [price, setPrice] = useState('')
  const [duration, setDuration] = useState('60')

  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  useEffect(() => {
    if (!propertyId && properties.length > 0) setPropertyId(properties[0]._id)
  }, [properties, propertyId])
  useEffect(() => {
    const active = members.filter((m) => m.status === 'active')
    if (!assignee && active.length > 0) setAssignee(active[0]._id)
  }, [members, assignee])

  const convexCreate = useConvexMutation(api.jobs.create)
  const create = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      propertyId: Id<'properties'>
      assignedMembershipId: Id<'memberships'>
      jobType: string
      price: number
      scheduledAt: number
      durationMinutes: number
    }) => convexCreate(args),
    onSuccess: onClose,
  })

  if (properties.length === 0) {
    return (
      <div className="px-4 pb-8 pt-3">
        <Drawer.Title className="text-sheet-title text-ink">
          No properties yet
        </Drawer.Title>
        <p className="mt-1 text-body text-muted">
          Add a client property first, then book work against it.
        </p>
      </div>
    )
  }

  return (
    <form
      className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3"
      onSubmit={(e) => {
        e.preventDefault()
        const [hh, mm] = time.split(':').map(Number)
        // The picker gives a wall-clock time on the selected day; build the
        // instant from the day key so it lands on the right date.
        const [y, m, d] = dayKey.split('-').map(Number)
        const scheduledAt = new Date(y, m - 1, d, hh, mm, 0, 0).getTime()

        create.mutate({
          businessId,
          propertyId: propertyId as Id<'properties'>,
          assignedMembershipId: assignee as Id<'memberships'>,
          jobType,
          price: Math.round(Number(price || '0') * 100),
          scheduledAt,
          durationMinutes: Number(duration),
        })
      }}
    >
      <Drawer.Title className="text-sheet-title text-ink">New job</Drawer.Title>

      <Field label="Property">
        <select
          value={propertyId}
          onChange={(e) => setPropertyId(e.target.value)}
          className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
        >
          {properties.map((p) => (
            <option key={p._id} value={p._id}>
              {p.clientName} — {p.addressLine}, {p.suburb}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Job type">
        <select
          value={jobType}
          onChange={(e) => setJobType(e.target.value)}
          className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
        >
          {JOB_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Assigned to">
        <select
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
        >
          {members
            .filter((m) => m.status === 'active')
            .map((m) => (
              <option key={m._id} value={m._id}>
                {m.role === 'owner' ? 'Owner' : 'Subcontractor'} · {m.colour}
              </option>
            ))}
        </select>
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
          className="mt-3 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-secondary text-amber-ink"
        >
          Could not book this job. You may not have access to that calendar.
        </p>
      )}

      <button
        type="submit"
        disabled={create.isPending || !hydrated}
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
