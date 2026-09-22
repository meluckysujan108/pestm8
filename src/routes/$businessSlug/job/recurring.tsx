import { createFileRoute } from '@tanstack/react-router'
import { EmptyState } from '#/components/primitives/EmptyState'

export const Route = createFileRoute('/$businessSlug/job/recurring')({
  component: RecurringJobPage,
})

/**
 * A stub on purpose: the section, its place in the switcher and its URL exist
 * now so the next phase fills a view in rather than rebuilding the shell
 * around it. Recurring work today is reached from a job's own detail sheet.
 */
function RecurringJobPage() {
  return (
    <section className="px-4 pt-3 pb-6">
      <EmptyState
        title="Recurring jobs are coming"
        body="This is where repeating work will be managed. For now, open a job and use its Recurrence section."
      />
    </section>
  )
}
