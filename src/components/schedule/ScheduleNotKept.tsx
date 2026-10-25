import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The Schedule with the line down and nothing of this week on the phone:
 * no day, no week, or no team to draw them with. Said in the page's own
 * place, under its header, rather than a placeholder that would wait for
 * good. The page draws the schedule in its place by itself as soon as the
 * line is back (`SchedulePage`).
 */
export function ScheduleNotKept({
  businessId,
  businessSlug,
  kicker,
  title,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  /** The month, as the schedule's header says it. */
  kicker: string
  title: string
}) {
  return (
    <>
      <PageHeader
        businessId={businessId}
        businessSlug={businessSlug}
        kicker={kicker}
        title={title}
      />
      <section className="px-4 pt-4 pb-6">
        <EmptyState
          title="Not on this phone"
          body="This phone has no copy of this week yet. It shows when you have signal."
        />
      </section>
    </>
  )
}
