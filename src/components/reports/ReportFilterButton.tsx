import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import {
  FilterButton,
  FilterChips,
  FilterPeople,
} from '#/components/primitives/FilterSheet'
import { useAccess, useViewMode } from '#/lib/access'
import { listsEverythingOf } from '#/lib/jobListView'
import {
  CREATABLE_TEMPLATES,
  RETIRED_TEMPLATES,
  getTemplate,
} from '#/lib/reportTemplates'
import { rq } from '#/lib/routeQueries'
import type { ReportNarrowing } from '#/lib/routeQueries'
import type { Id } from '../../../convex/_generated/dataModel'

const asChoice = (template: { id: string; name: string }) => ({
  value: template.id,
  label: template.name,
})

/** The built-in forms a report can be started on, then the business's own,
 * then the retired ones: their reports are still in the library. */
const BUILT_IN_FORMS = CREATABLE_TEMPLATES.map(asChoice)
const RETIRED_FORMS = [...RETIRED_TEMPLATES].map((id) =>
  asChoice(getTemplate(id)),
)

/**
 * The library's Form and Technician filters behind one icon beside the
 * search (`FilterButton`). No sort: the library is the one last touched
 * first, which is what it is for. The Draft / Finalised / Sent / Deleted
 * switch stays on the page — it is where you are, not a narrowing of it.
 *
 * No counts beside the choices: the library is read a page at a time, so
 * what is loaded is no count of what a choice would show.
 */
export function ReportFilterButton({
  businessId,
  narrow,
  onNarrow,
  disabled = false,
}: {
  businessId: Id<'businesses'>
  narrow: ReportNarrowing
  onNarrow: (next: ReportNarrowing) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const mode = useViewMode()
  const listsEverything = listsEverythingOf(useAccess())
  // The business's own forms, asked for while the sheet is open (or a form
  // is chosen, so it reads as chosen): they name nothing on the page itself.
  const { data: custom = [] } = useQuery(
    open || narrow.form !== undefined
      ? convexQuery(api.customTemplates.list, { businessId })
      : convexQuery(api.customTemplates.list, 'skip'),
  )
  const { data: members = [] } = useQuery(rq.roster(businessId))

  // Whose, only where the library is everyone's: a subcontractor's is their
  // own already, and so is the owner's in "Just my jobs".
  const showStaff =
    listsEverything === true && mode !== 'mine' && members.length >= 2
  const staffId = narrow.staffId ?? 'all'
  const on =
    Number(narrow.form !== undefined) +
    Number(showStaff && narrow.staffId !== undefined)

  const forms = [
    ...BUILT_IN_FORMS,
    ...custom.map((template) => ({
      value: template._id,
      label: template.name,
    })),
    ...RETIRED_FORMS,
  ]
  // A form from a link that is not among them (a template since deleted)
  // still reads as chosen, so Clear filters has something to clear.
  const chosenMissing =
    narrow.form !== undefined &&
    !forms.some((form) => form.value === narrow.form)

  return (
    <FilterButton
      title="Filters"
      on={on}
      disabled={disabled}
      onClear={() => onNarrow({})}
      onOpenChange={setOpen}
    >
      <FilterChips
        label="Form"
        value={narrow.form ?? 'all'}
        options={[
          { value: 'all', label: 'All' },
          ...forms,
          ...(chosenMissing
            ? [{ value: narrow.form as string, label: 'Another form' }]
            : []),
        ]}
        onChange={(next) =>
          onNarrow({ ...narrow, form: next === 'all' ? undefined : next })
        }
      />
      {showStaff && (
        <FilterPeople
          value={staffId}
          people={members.map((member) => ({
            membershipId: member._id,
            name: member.name,
            colour: member.colour,
          }))}
          onChange={(id) =>
            onNarrow({ ...narrow, staffId: id === 'all' ? undefined : id })
          }
        />
      )}
    </FilterButton>
  )
}
