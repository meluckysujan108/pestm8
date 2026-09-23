import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { Sheet } from '#/components/primitives/Sheet'
import {
  DEFAULT_INTERVAL,
  RecurrenceFields,
  intervalFromDraft,
} from './RecurrenceFields'
import type { IntervalDraft } from './RecurrenceFields'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Turning an existing job into a Recurring Job.
 *
 * The job in hand becomes the series' first visit and keeps its own id, notes,
 * photos, reports and job number — `convertJobToRecurring` patches it onto the
 * new series rather than replacing it. Everything after it is projected by the
 * engine as a `recurring` visit, which is why the copy below talks about
 * "future visits" rather than about this one changing.
 */
export function MakeRecurringSheet({
  open,
  onClose,
  businessId,
  jobId,
}: {
  open: boolean
  onClose: () => void
  businessId: Id<'businesses'>
  jobId: Id<'jobs'>
}) {
  const [interval, setInterval] = useState<IntervalDraft>(DEFAULT_INTERVAL)
  const convert = useConvexMutation(api.recurrences.convertJobToRecurring)

  const save = useMutation({
    mutationFn: (args: { count: number; unit: IntervalDraft['unit'] }) =>
      convert({
        businessId,
        jobId,
        intervalCount: args.count,
        intervalUnit: args.unit,
      }),
    onSuccess: onClose,
  })

  const parsed = intervalFromDraft(interval)

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Make recurring"
      description="This job becomes the first visit. Future visits are booked automatically."
    >
      <form
        className="px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-1"
        onSubmit={(e) => {
          e.preventDefault()
          if (parsed) save.mutate(parsed)
        }}
      >
        <RecurrenceFields
          value={interval}
          onChange={setInterval}
          disabled={save.isPending}
          idPrefix="make-recurring"
        />

        {save.isError && (
          <p
            role="alert"
            className="mt-3 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
          >
            Could not make this job recurring.
          </p>
        )}

        <button
          type="submit"
          disabled={parsed === null || save.isPending}
          className="mt-4 h-12 w-full rounded-xl bg-blue text-[16px] font-semibold text-white transition active:scale-[.99] disabled:opacity-40"
        >
          {save.isPending ? 'Setting up…' : 'Make recurring'}
        </button>
      </form>
    </Sheet>
  )
}
