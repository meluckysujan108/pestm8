import type { Ref } from 'react'
import { Combobox } from '#/components/primitives/Combobox'
import { JOB_TYPES } from '#/lib/format'
import { normaliseJobTypes } from '../../../convex/lib/jobTypes'

const OPTIONS = JOB_TYPES.map((type) => ({ value: type, label: type }))

/**
 * The services as the field holds them: tidied (`normaliseJobTypes`), and a
 * service the list has in the list's own spelling — "rodents" typed or saved
 * long ago is Rodents, ticked in the list and found by the report rules,
 * rather than a lookalike beside it that a tap on Rodents cannot reach.
 */
export function canonicalJobTypes(types: ReadonlyArray<string>): Array<string> {
  return normaliseJobTypes(
    normaliseJobTypes(types).map(
      (type) =>
        JOB_TYPES.find((known) => known.toLowerCase() === type.toLowerCase()) ??
        type,
    ),
  )
}

/**
 * What a job is for — one service or several. "We do general pest with
 * termites and rodents, or clients mix and match" (the business that asked
 * for it, 29 Sept 2026): one visit, one price, a label that names them all
 * ("General Pest Control, Termite Inspection, Rodents"; `lib/jobTypes.ts`).
 *
 * The same field on New Job and on a job's edit form. A service the list
 * does not have is typed in and added, as before.
 */
export function JobTypePicker({
  value,
  onChange,
  invalid,
  errorId,
  triggerRef,
}: {
  value: ReadonlyArray<string>
  onChange: (value: Array<string>) => void
  invalid?: boolean
  errorId?: string
  triggerRef?: Ref<HTMLButtonElement>
}) {
  return (
    <Combobox
      multiple
      value={value}
      // Tidied as it is chosen, so what the field shows is what is saved:
      // "Possums, rats" typed in is two services, and "rodents" is Rodents.
      onChange={(next) => onChange(canonicalJobTypes(next))}
      options={OPTIONS}
      allowCustom
      customLabel={(q) => `Add “${q}” as a new job type`}
      title="Job type"
      description="Tick every service on this job."
      placeholder="Search or add a job type"
      emptyLabel="Choose one or more"
      ariaLabel="Job type"
      invalid={invalid}
      errorId={errorId}
      triggerRef={triggerRef}
    />
  )
}
