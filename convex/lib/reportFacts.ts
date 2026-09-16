import { isRegulatedTemplate } from './capabilities'
import type { Doc } from '../_generated/dataModel'
import type { ReportFacts } from './capabilities'

/**
 * A stored report, as the access model sees it.
 *
 * The companion to `membershipFacts.ts`, and it exists for the same reason:
 * `capabilities.ts` takes structural facts so it can be tested against
 * hand-built objects, which leaves exactly one place that knows the column
 * names. This is it.
 *
 * `regulated` is derived, not stored. There is no column for it and there
 * should not be: a stored flag set at creation would be wrong the moment a
 * template changed, and it would be one more thing a client could send. The
 * template a report was written from is the fact; whether that constitutes
 * certification is a policy decision, and it lives in the policy module.
 */
export function reportFactsFrom(report: Doc<'reports'>): ReportFacts {
  return {
    _id: report._id,
    businessId: report.businessId,
    authorMembershipId: report.authorMembershipId,
    status: report.status,
    regulated: isRegulatedTemplate(report.template),
  }
}
