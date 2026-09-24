import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The one rule a business can put on top of the forms.
 *
 * WA's Pesticides Regulations want the record made within two business days,
 * and a report written next week from memory is a worse record than one
 * written in the driveway. A business that issues a report on every treatment
 * can say so here and stop relying on anyone remembering.
 *
 * Off by default, and it never applies to a job type with no form — a quote
 * visit blocked at "Complete" is how a business learns to turn a policy off.
 */
export function ReportPolicySection({
  businessId,
}: {
  businessId: Id<'businesses'>
}) {
  const { data: settings } = useQuery(
    convexQuery(api.businesses.reportSettings, { businessId }),
  )
  const convexUpdate = useConvexMutation(api.businesses.update)
  const update = useMutation({
    mutationFn: (requireReportToComplete: boolean) =>
      convexUpdate({ businessId, requireReportToComplete }),
  })

  // `undefined` while the query is out, which is neither on nor off: a
  // checkbox that renders unticked before the answer arrives is a checkbox
  // that tells an owner their policy is off when it is on.
  const on = settings?.requireReportToComplete

  return (
    <section>
      <h2 className="section-label mb-2">Before a job is complete</h2>
      <label className="flex items-center justify-between gap-3 rounded-2xl border border-hairline bg-surface px-3.5 py-3 shadow-elevation">
        <span className="min-w-0">
          <span className="block text-body text-ink">
            Require a finalised report
          </span>
          <span className="text-caption text-muted">
            A job whose type has a form cannot be marked complete until its
            report is signed. Jobs with no form — a quote, a callback — are
            never held up.
          </span>
        </span>
        <input
          type="checkbox"
          checked={on ?? false}
          disabled={on === undefined || update.isPending}
          onChange={(event) => update.mutate(event.target.checked)}
          className="size-5 shrink-0 accent-red"
        />
      </label>
      {update.isError && (
        <p role="alert" className="mt-2 text-caption text-amber-ink">
          Could not save that.
        </p>
      )}
    </section>
  )
}
