import type { Ref } from 'react'
import { Combobox } from '#/components/primitives/Combobox'
import { findJobType, normaliseJobTypes } from '../../../convex/lib/jobTypes'
import type { JobTypeEntry } from '../../../convex/lib/jobTypes'

/**
 * The services as the field holds them: tidied (`normaliseJobTypes`), and a
 * service the business's list has in the list's own spelling — "rodents"
 * typed or saved long ago is Rodents, ticked in the list and found by the
 * report rules, rather than a lookalike beside it that a tap on Rodents
 * cannot reach. A service renamed in Settings → Job types comes back under
 * its new name (`findJobType` knows its old ones).
 */
export function canonicalJobTypes(
  types: ReadonlyArray<string>,
  jobTypes: ReadonlyArray<Pick<JobTypeEntry, 'name' | 'formerNames'>>,
): Array<string> {
  return normaliseJobTypes(
    normaliseJobTypes(types).map(
      (type) => findJobType(jobTypes, type)?.name ?? type,
    ),
  )
}

/**
 * What a job is for — one service or several. "We do general pest with
 * termites and rodents, or clients mix and match" (the business that asked
 * for it, 29 Sept 2026): one visit, one price, a label that names them all
 * ("General Pest Control, Termite Inspection, Rodents"; `lib/jobTypes.ts`).
 *
 * The same field on New Job and on a job's edit form. It offers the
 * business's own list (Settings → Job types), A–Z. A service the list does
 * not have is typed in and used on this job only; the owner finds it under
 * "Typed into jobs" in Settings, to swap it or add it. A service the owner
 * has since deleted, on a job that already has it, still shows ticked.
 */
export function JobTypePicker({
  jobTypes,
  value,
  onChange,
  invalid,
  errorId,
  triggerRef,
}: {
  /** The business's list (`useJobTypes`). */
  jobTypes: ReadonlyArray<JobTypeEntry>
  value: ReadonlyArray<string>
  onChange: (value: Array<string>) => void
  invalid?: boolean
  errorId?: string
  triggerRef?: Ref<HTMLButtonElement>
}) {
  const options = jobTypes
    .filter((entry) => entry.offered)
    .map((entry) => ({ value: entry.name, label: entry.name }))
  return (
    <Combobox
      multiple
      value={value}
      // Tidied as it is chosen, so what the field shows is what is saved:
      // "Possums, rats" typed in is two services, and "rodents" is Rodents.
      onChange={(next) => onChange(canonicalJobTypes(next, jobTypes))}
      options={options}
      allowCustom
      customLabel={(q) => `Use “${q}” on this job only`}
      title="Job type"
      description="Tick every service on this job."
      placeholder="Search or type a job type"
      emptyLabel="Choose one or more"
      ariaLabel="Job type"
      invalid={invalid}
      errorId={errorId}
      triggerRef={triggerRef}
    />
  )
}
