import { authComponent } from '../auth'
import { areaCodeOf } from './contactKeys'
import { oursFor } from './clientMatch'
import type { OursSource } from './clientMatch'
import type { Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

/**
 * The business's own numbers and emails, and its team's, read on the server
 * for its own check when a booking saves (the plan's `findSame`): what an
 * office puts on a client who has none, so never evidence of who a caller is
 * (lib/clientMatch.ts). The server leaves out every active member's, whoever
 * is booking; it shows nobody which numbers they are.
 *
 * Never called by `clients.directory`, and never to be. This reads the
 * business row, and the business row also holds the job and report numbers
 * (`nextJobNumber`, `nextReportNumber`): every booking, Recurring Job visit
 * and numbered report patches it. A query reading it re-runs on each of
 * those, so the directory, the whole client book, would be re-sent to every
 * member with it open, unchanged, all day. The phone works out its own from
 * what it already holds (`oursFor` in lib/clientMatch.ts); a mutation reads
 * these once, and is never re-run.
 */

/** More members than any business has; the read stays bounded. */
const TEAM_LIMIT = 500

export type BusinessOurs = {
  /** The business's area code, which local numbers are matched under. */
  areaCode: string
  ours: OursSource
}

/**
 * The business's phone, email and report copy address, with each active
 * member's phone and sign-in email. A removed member's are not: a former
 * employee may well be a customer now.
 */
export async function oursOf(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
): Promise<BusinessOurs> {
  const [business, members] = await Promise.all([
    ctx.db.get('businesses', businessId),
    ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .take(TEAM_LIMIT),
  ])
  const active = members.filter((m) => m.status === 'active')
  const users = await Promise.all(
    active.map((m) => authComponent.getAnyUserById(ctx, m.userId)),
  )
  return {
    areaCode: areaCodeOf(business?.state),
    ours: oursFor({
      business,
      seesTeam: true,
      team: active.map((m, i) => ({
        phone: m.phone,
        email: users[i]?.email,
        status: m.status,
      })),
    }),
  }
}
