import { authComponent } from '../auth'
import { oursFor } from './clientMatch'
import type { OursSource } from './clientMatch'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { ActorEnvelope } from './actor'

/**
 * The business's own numbers and emails, and its team's, as the server's
 * check leaves them out when a booking saves (lib/findSame.ts): what an
 * office puts on a client who has none, so never evidence of who a caller is
 * (lib/clientMatch.ts).
 *
 * Worked out for the person saving, exactly as their own phone works it out
 * (src/lib/useMatchIndex.ts, through the same `oursFor`): the business's
 * phone and email, which every member reads; their own phone and sign-in
 * email; and every active member's only for someone who manages the team
 * (`team.manage`, the test the roster gives everyone's details by). Not
 * every member's for everyone: for a subcontractor, leaving another
 * member's number out would make a refusal, or a booking moved onto a
 * client, say whether a number they typed is a team member's, which is the
 * very thing the roster keeps from them. So for them another member's
 * number on a client counts as that client's, on the server as on their
 * phone, and the two judge the same book the same way.
 *
 * Not the report copy address either: the phone doesn't hold it
 * (`businesses.getBySlug` leaves it out), and only `business.manage` may
 * read it.
 *
 * Never called by `clients.directory`, and never to be. It reads the
 * business row, which also holds the job and report numbers
 * (`nextJobNumber`, `nextReportNumber`): every booking, Recurring Job visit
 * and numbered report patches it. A query reading it re-runs on each of
 * those, so the directory, the whole client book, would be re-sent to every
 * member with it open, unchanged, all day. A mutation reads these once, and
 * is never re-run.
 */

/** More members than any business has; the read stays bounded. */
const TEAM_LIMIT = 500

/**
 * What to leave out for the person `env` names (`actor.real`, the human at
 * the keyboard: the phone passes its own holder's details whoever's account
 * is open), with the business row the caller has already read.
 *
 * `seesTeam` is theirs (`team.manage`) unless said otherwise. Only what
 * nobody without it is ever shown is worked out as if they had it: the
 * possible duplicates a booking notes for the office (lib/findSame.ts), read
 * by those who see the team alone.
 */
export async function oursOfCaller(
  ctx: QueryCtx,
  env: ActorEnvelope,
  business: Pick<Doc<'businesses'>, '_id' | 'phone' | 'email'>,
  seesTeam: boolean = env.caps['team.manage'],
): Promise<OursSource> {
  const [self, members] = await Promise.all([
    ctx.db.get('memberships', env.actor.real._id),
    seesTeam
      ? ctx.db
          .query('memberships')
          .withIndex('by_business', (q) => q.eq('businessId', business._id))
          .take(TEAM_LIMIT)
      : null,
  ])
  const active = (members ?? []).filter((m) => m.status === 'active')
  const [selfUser, users] = await Promise.all([
    self ? authComponent.getAnyUserById(ctx, self.userId) : null,
    Promise.all(active.map((m) => authComponent.getAnyUserById(ctx, m.userId))),
  ])
  return oursFor({
    business: { phone: business.phone, email: business.email },
    self: { phone: self?.phone, email: selfUser?.email },
    seesTeam,
    team: seesTeam
      ? active.map((m, i) => ({
          phone: m.phone,
          email: users[i]?.email,
          status: m.status,
        }))
      : null,
  })
}
