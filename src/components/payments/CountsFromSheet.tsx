import { useId, useState } from 'react'
import type { RefObject } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { FormField } from '#/components/forms/FormField'
import { Sheet, SheetLock } from '#/components/primitives/Sheet'
import {
  PRIMARY_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { formatJobDate } from '#/lib/format'
import { useHydrated } from '#/lib/useHydrated'
import { dayKeyOf } from '../../../convex/lib/dates'
import type { Id } from '../../../convex/_generated/dataModel'
import type { ErrorCopy } from '#/components/forms/describeError'

const SAVE_COPY: ErrorCopy = {
  INVALID_DAY: 'Choose a day up to today.',
  NO_ACCESS:
    'Could not save this: only the business owner can change where counting starts.',
  default: 'Could not save this. Check your signal and try again.',
}

/**
 * Where the Payments page starts counting. Older work was never asked how it
 * was paid, so it keeps its status and is left out until the owner says to
 * count it, by moving the day back. Nothing about any job changes.
 */
export function CountsFromSheet({
  open,
  onClose,
  returnFocusRef,
  business,
  countsFrom,
}: {
  open: boolean
  onClose: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  business: { _id: Id<'businesses'>; timezone: string }
  countsFrom: number | null
}) {
  const id = useId()
  const hydrated = useHydrated()
  const today = dayKeyOf(Date.now(), business.timezone)
  const saved =
    countsFrom === null ? today : dayKeyOf(countsFrom, business.timezone)
  const [day, setDay] = useState(saved)
  const [checked, setChecked] = useState(false)
  const convexSave = useConvexMutation(api.payments.setCountsFrom)
  const save = useMutation({
    mutationFn: (next: string | null) =>
      convexSave({ businessId: business._id, day: next }),
    onSuccess: onClose,
  })

  // Opened again, it starts from what is saved, not from what was left,
  // and without the last try's error.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setDay(saved)
      setChecked(false)
      save.reset()
    }
  }

  // The date field gives a whole day or nothing.
  const valid = day !== '' && day <= today
  const error = checked && !valid ? 'Choose a day up to today.' : null
  const busy = !hydrated || save.isPending

  const submit = () => {
    if (!valid) {
      setChecked(true)
      return
    }
    save.mutate(day)
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title="Count payments from"
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className={`${SECONDARY_BUTTON_COMPACT} shrink-0 px-5`}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className={`${PRIMARY_BUTTON_COMPACT} min-w-0 flex-1`}
          >
            {save.isPending && save.variables !== null
              ? 'Saving…'
              : valid
                ? `Count from ${formatJobDate(day, today)}`
                : 'Save'}
          </button>
        </div>
      }
    >
      <SheetLock
        changed={day !== saved && !save.isPending}
        whileUnchanged={false}
      />
      <p className="text-caption text-ink-2">
        Owing and To bill count work booked on or after this day. Older jobs
        keep their status, and nothing about them changes.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        <FormField id={`${id}-from`} label="From" error={error}>
          {(control) => (
            <input
              {...control}
              type="date"
              max={today}
              value={day}
              disabled={save.isPending}
              onChange={(event) => setDay(event.target.value)}
            />
          )}
        </FormField>
        <FormAlert error={save.isError ? save.error : null} copy={SAVE_COPY} />
        {countsFrom !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => save.mutate(null)}
            className={`${SECONDARY_BUTTON_COMPACT} w-full`}
          >
            {save.isPending && save.variables === null
              ? 'Saving…'
              : 'Count every job'}
          </button>
        )}
      </div>
    </Sheet>
  )
}
