import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/**
 * What the reports search box matches against.
 *
 * None of it lives on the report: the client's name, the suburb and the
 * form's name are resolved at read time from three other documents, and a
 * search index can only see fields the row itself holds. So it is
 * denormalised into one string, written when a report is created and
 * refreshed when something that changes its identity happens — it gains a
 * job, or it is locked and its wording and records freeze.
 *
 * A client renamed halfway through a draft therefore stays findable under the
 * name they had until that report is finalised. That is the trade for not
 * rewriting every open draft of a client the moment someone fixes a typo in
 * their surname, and it is the same trade the list rows already make: a
 * finalised report is listed as it was signed.
 */
export async function reportSearchText(
  ctx: MutationCtx,
  report: Doc<'reports'>,
  templateName: string,
): Promise<string> {
  const frozen = report.status === 'finalised' ? report.contextSnapshot : undefined

  const property = await ctx.db.get(report.propertyId)
  const client = property ? await ctx.db.get(property.clientId) : null

  return [
    frozen?.client?.name ?? client?.name,
    frozen?.property?.addressLine ?? property?.addressLine,
    frozen?.property?.suburb ?? property?.suburb,
    templateName,
    // The number a client quotes on the phone is the fastest way to find a
    // report, and the only one they are likely to have.
    report.reportNumber !== undefined ? `#${report.reportNumber}` : undefined,
  ]
    .filter((part): part is string => Boolean(part && part.trim() !== ''))
    .join(' ')
}
