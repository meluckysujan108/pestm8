import { ChevronRight } from 'lucide-react'
import { NEUTRAL_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { Sheet } from '#/components/primitives/Sheet'
import type { RefObject } from 'react'
import type { JobEditChoice, JobEditTarget } from '#/lib/jobEditChoices'

/**
 * The job sheet's Edit, when there is more than the job to edit: a sheet of
 * row-cards — Job details, Client details, Property details — each saying
 * what it changes and where. A row closes it and opens that form in the job
 * sheet; Done goes back to Edit.
 *
 * A sheet, not a menu: a menu floating inside the job sheet failed to scroll
 * on Android, and its rows were under 44px (StatusPicker).
 */
export function JobEditChooser({
  open,
  onClose,
  description,
  choices,
  onChoose,
  returnFocusRef,
}: {
  open: boolean
  onClose: () => void
  /** Which job: "Job #2320 · General Pest Control". */
  description: string
  choices: ReadonlyArray<JobEditChoice>
  onChoose: (target: JobEditTarget) => void
  /** Where focus goes as it shuts: the chosen form's title, or Edit. */
  returnFocusRef: RefObject<HTMLElement | null>
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Edit"
      description={description}
      returnFocusRef={returnFocusRef}
      footer={
        <button
          type="button"
          onClick={onClose}
          className={`${NEUTRAL_BUTTON_COMPACT} w-full`}
        >
          Done
        </button>
      }
    >
      <ul className="flex flex-col gap-1.5">
        {choices.map((choice) => (
          <li key={choice.target}>
            {/* The row-card of the Same customer sheet (xero/
                SameCustomerSheet.tsx `Option`), copied rather than imported,
                which would bring Xero into the Schedule's first load. */}
            <button
              type="button"
              onClick={() => onChoose(choice.target)}
              className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-hairline bg-surface px-3 py-2.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.99]"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-body font-semibold text-ink [overflow-wrap:anywhere]">
                  {choice.title}
                </span>
                <span className="mt-0.5 block text-caption text-ink-2">
                  {choice.line}
                </span>
              </span>
              <ChevronRight
                aria-hidden
                size={17}
                strokeWidth={2.2}
                className="shrink-0 text-muted-2"
              />
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
