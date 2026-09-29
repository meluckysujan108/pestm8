import { ConvexError } from 'convex/values'
import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/**
 * How much one person may email in an hour, from the Send sheet and from a
 * lock alike.
 *
 * Generous for a technician finishing a day's jobs, and far below what a
 * runaway retry loop or a compromised session would manage. A compliance
 * document is an attachment with a client's address on it: the cost of
 * sending a thousand of them is not the bandwidth. And since 29 Sept 2026
 * nothing waits for an owner's approval, so this is what stops a loop of
 * locks — each asking for a copy to dozens of typed addresses — from mailing
 * whoever it likes from the sending domain every business here shares.
 *
 * Two budgets, both per person per hour: the emails, and the addresses on
 * them. The Send sheet sends one email per person, so for it they are the
 * same; a form's "Email Report To" can put several on one. The business's own
 * blind copy is not counted: it goes to the business.
 *
 * Counted from the delivery rows rather than a rate-limiter component,
 * because those rows already ARE the record of every send, exactly and
 * auditably — a separate token bucket would be a second, less accurate
 * account of the same events, and a dependency to keep them in step. Each
 * check runs in the mutation that writes the row, so two at once conflict
 * on the same index range and one is retried, rather than both slipping in.
 */
export const SEND_LIMIT = 20
export const ADDRESS_LIMIT = 50
const SEND_WINDOW_MS = 60 * 60 * 1000

/** What a lock's email says, not sent, when its sender is over the limit. */
export const SEND_LIMIT_REACHED =
  'Not sent: that is a lot of report emails in an hour. Send it again from the Email tab shortly.'

/** Whether `membershipId` may send one more email, to `addresses` people. */
export async function withinSendLimit(
  ctx: MutationCtx,
  membershipId: Id<'memberships'>,
  addresses: number,
): Promise<boolean> {
  const since = Date.now() - SEND_WINDOW_MS
  const recent = await ctx.db
    .query('reportDeliveries')
    .withIndex('by_sender', (q) =>
      q.eq('sentByMembershipId', membershipId).gt('createdAt', since),
    )
    .take(SEND_LIMIT)

  // `>=`, because this call is the one after the ones counted: twenty already
  // in the window means this would be the twenty-first.
  if (recent.length >= SEND_LIMIT) return false
  // Fewer than twenty came back, so that is every one in the window.
  const addressed = recent.reduce(
    (sum, row) => sum + row.to.length + row.cc.length,
    0,
  )
  return addressed + addresses <= ADDRESS_LIMIT
}

/** `withinSendLimit`, as a refusal: for someone pressing Send, who is told. */
export async function assertWithinSendLimit(
  ctx: MutationCtx,
  membershipId: Id<'memberships'>,
  addresses: number,
): Promise<void> {
  if (!(await withinSendLimit(ctx, membershipId, addresses))) {
    throw new ConvexError('SEND_RATE_LIMITED')
  }
}
