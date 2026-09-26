import { useId } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import { ReportSwitchRow } from './ReportSwitchRow'
import { SettingsGroup } from './ui'
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
  const hydrated = useHydrated()
  const headingId = useId()
  const { data: settings } = useQuery(rq.reportSettings(businessId))
  const convexUpdate = useConvexMutation(api.businesses.update)
  const update = useMutation({
    mutationFn: (requireReportToComplete: boolean) =>
      convexUpdate({ businessId, requireReportToComplete }),
  })

  // `undefined` while the query is out, which is neither on nor off: a
  // switch that can be flipped before the answer arrives is a switch that
  // tells an owner their policy is off when it is on — so it stays locked
  // until then.
  const on = settings?.requireReportToComplete

  return (
    <SettingsGroup
      id={headingId}
      title="Completing jobs"
      footer="Jobs with no form — a quote, a callback — are never held up."
    >
      {/* No line of its own under it: the heading says when it bites
          (completing a job) and the footer says when it never does. */}
      <ReportSwitchRow
        title="Require a finalised report"
        checked={on}
        disabled={!hydrated || update.isPending}
        failed={update.isError}
        onCheckedChange={(checked) => update.mutate(checked)}
      />
    </SettingsGroup>
  )
}
