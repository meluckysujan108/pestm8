import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { WriteAttribution } from './capabilities'

/**
 * Writing down who did what.
 *
 * There was supposed to be one place already — `auditLog.log` says so in its
 * own docstring — but eighteen mutations across eight files insert the row by
 * hand instead, and only `email.send` goes through it. That was survivable
 * while every row meant the same thing: one person, acting as themselves.
 *
 * It stops being survivable the moment someone can work inside another
 * person's account. Then every row has two halves — the human who did it and
 * the account it was done in — and eighteen hand-written inserts are eighteen
 * chances to record a change as though the account holder made it themselves.
 * That is not a missing detail; it is the record saying the wrong person did
 * something, in the log a compliance dispute would be settled from.
 *
 * So: one writer, and the attribution is its own argument rather than two
 * fields buried among six. Today every caller passes `forSelf(...)`, which is
 * exactly what the rows already say. When switching lands, the same callers
 * pass `writeAttribution(actor)` — this type is a structural subset of what
 * that function returns, so the change is one line per site and the compiler
 * checks it.
 */
export type AuditAttribution = Pick<
  WriteAttribution,
  'actorMembershipId' | 'onBehalfOfMembershipId'
>

/**
 * Someone acting in their own account — every row written so far.
 *
 * Named rather than inlined so the audit trail reads as a deliberate claim.
 * `{ actorMembershipId: m._id }` would be the same object and would say
 * nothing; `forSelf(m._id)` is a caller stating that nobody was switched, which
 * is a thing a reviewer can disagree with.
 */
export function forSelf(membershipId: Id<'memberships'>): AuditAttribution {
  return { actorMembershipId: membershipId }
}

export type AuditEntry = {
  businessId: Id<'businesses'>
  action: string
  entityType: string
  entityId: string
  meta?: unknown
  /** Only when the row must share a timestamp with the write it describes. */
  at?: number
}

export async function recordAudit(
  ctx: MutationCtx,
  by: AuditAttribution,
  entry: AuditEntry,
): Promise<void> {
  await ctx.db.insert('auditLog', {
    businessId: entry.businessId,
    actorMembershipId: by.actorMembershipId,
    // Absent means "they were working as themselves", which is what every row
    // written before switching existed means. Never stored as a self-reference:
    // present has to mean something happened.
    onBehalfOfMembershipId: by.onBehalfOfMembershipId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    meta: entry.meta,
    at: entry.at ?? Date.now(),
  })
}
