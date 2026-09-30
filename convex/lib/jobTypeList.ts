import {
  DEFAULT_JOB_TYPES,
  MAX_JOB_TYPE_ROWS,
  canonicalJobTypeLabel,
  jobTypeKey,
} from './jobTypes'
import type { JobTypeEntry } from './jobTypes'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

/**
 * A business's job-type rows, A–Z (the index orders them by `key`). Bounded:
 * `convex/jobTypes.ts` refuses a row past MAX_JOB_TYPE_ROWS.
 */
export function jobTypeRows(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
): Promise<Array<Doc<'jobTypes'>>> {
  return ctx.db
    .query('jobTypes')
    .withIndex('by_business_key', (q) => q.eq('businessId', businessId))
    .take(MAX_JOB_TYPE_ROWS)
}

/**
 * The list as everything outside Settings reads it: the business's own rows,
 * or the built-in nine when it has never changed them. A–Z.
 */
export function entriesOf(
  rows: ReadonlyArray<Doc<'jobTypes'>>,
): Array<JobTypeEntry> {
  const entries =
    rows.length === 0
      ? DEFAULT_JOB_TYPES.map((entry) => ({ ...entry }))
      : rows.map((row) => ({
          name: row.name,
          report: row.report,
          offered: row.archivedAt === undefined,
          formerNames: row.formerNames,
        }))
  return entries.sort((a, b) =>
    jobTypeKey(a.name).localeCompare(jobTypeKey(b.name)),
  )
}

export async function loadJobTypes(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
): Promise<Array<JobTypeEntry>> {
  return entriesOf(await jobTypeRows(ctx, businessId))
}

/**
 * A label about to be saved on a job or a series, in the business's own
 * words (`canonicalJobTypeLabel`): a phone still on last week's build that
 * sends a service's old name saves the new one.
 */
export async function canonicalLabelFor(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  label: string,
): Promise<string> {
  return canonicalJobTypeLabel(label, await loadJobTypes(ctx, businessId))
}
