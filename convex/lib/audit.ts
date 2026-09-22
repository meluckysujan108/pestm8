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
 * fields buried among six. A caller that resolved a write actor passes
 * `writeAttribution(actor)` — this type is a structural subset of what that
 * function returns — and the rows say "Terence, in Kevin's account" whenever
 * that is what happened. `forSelf(...)` is what administration passes — a
 * switch drops it, so nobody administers on anyone's behalf — and what the
 * callers still on the older resolver pass until they move.
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

/**
 * A write made inside someone else's account, recorded — and nothing when the
 * writer was working as themselves.
 *
 * For the writes that have never been audited: booking, moving and closing
 * jobs, starting a repeating series, starting a report. Working as yourself,
 * a row would say nothing the job does not already say. Working in someone
 * else's account it is the only record there is — the job carries no author,
 * and without it the account holder finds a visit moved on their calendar and
 * nothing anywhere saying who moved it. `onBehalfOfMembershipId` on the row is
 * what `by_account` answers "what was done in my account, and by whom" from.
 *
 * Takes the whole `WriteAttribution`, which only `writeAttribution` produces,
 * so there is no way to ask this about a switch that was never validated.
 */
export async function recordOnBehalf(
  ctx: MutationCtx,
  by: WriteAttribution,
  entry: AuditEntry,
): Promise<void> {
  if (by.onBehalfOfMembershipId === undefined) return
  await recordAudit(ctx, by, entry)
}

/**
 * `recordAudit`, unless this person already has a row for this action on this
 * entity since `since`.
 *
 * For edits that arrive as a stream. A draft autosaves every couple of seconds
 * while someone types, and a row per save would bury the entity's history —
 * the finalise, the sends — under hundreds of lines saying the same thing.
 * One row per sitting says what the history needs: who else was in here.
 *
 * Walks the entity's rows newest first and stops at the first one older than
 * `since`, so it reads only what was written since then.
 */
export async function recordOnce(
  ctx: MutationCtx,
  by: AuditAttribution,
  entry: AuditEntry & { since: number },
): Promise<void> {
  const { since, ...rest } = entry
  const recent = ctx.db
    .query('auditLog')
    .withIndex('by_entity', (q) =>
      q.eq('entityType', entry.entityType).eq('entityId', entry.entityId),
    )
    .order('desc')

  for await (const row of recent) {
    if (row.at < since) break
    if (
      row.action === entry.action &&
      row.actorMembershipId === by.actorMembershipId &&
      row.onBehalfOfMembershipId === by.onBehalfOfMembershipId
    ) {
      return
    }
  }
  await recordAudit(ctx, by, rest)
}
