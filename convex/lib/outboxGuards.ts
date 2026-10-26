import { ConvexError, v } from 'convex/values'
import { isSwitched } from './capabilities'
import type { Id } from '../_generated/dataModel'
import type { WriteEnvelope } from './actor'

/**
 * What a booking kept on the phone carries when the phone sends it by itself
 * (the outbox, src/lib/outbox/), and what the server checks of it.
 *
 * The phone sends only while the person is in their own account, but an
 * account switch belongs to the sign-in session, not the tab: one started in
 * another tab, or in this one while the send is still queued, applies to it
 * just the same, and another tab's sign-in can hand the socket someone else's
 * token. So the send names whose it is, and is refused unless that is who is
 * writing, as themselves. The phone's own checks stay; this is the one that
 * holds when they can't see the race.
 *
 * Both of these, and `refuseBackfill`, are checked after the request id's
 * lookup (lib/clientRequest.ts): a repeat is answered with what it made,
 * whatever they would now say. And they are among the arguments that may
 * only ever be widened, since every booking a phone holds carries them
 * (convex/outboxArgs.test.ts).
 */

/** The sender's own membership, as the phone saved it. Never stored. */
export const asMembershipArg = v.optional(v.id('memberships'))

/**
 * On a Recurring Job sent by the outbox: refuse it (FIRST_VISIT_PAST) when
 * the first visit is already more than a day gone, rather than book the
 * series without it as an online booking does (recurrences.create). Sent
 * only when that visit was meant to be booked; the person then picks a new
 * start. Never stored.
 */
export const refuseBackfillArg = v.optional(v.literal(true))

/**
 * The kill switch: `OUTBOX_PAUSED=on` on a deployment refuses every booking
 * a phone sends by itself. A booking made with the sheet open still goes (the
 * phone sends it again without `asMembership`), and a repeat is still
 * answered. Read on every call, so a test can flip it.
 */
export function outboxPaused(): boolean {
  return process.env.OUTBOX_PAUSED === 'on'
}

/**
 * For a booking that names whose it is: refused NOT_OWN_ACCOUNT unless the
 * writer is exactly that membership and not working in someone else's
 * account, then OUTBOX_PAUSED while the kill switch is on. In that order, so
 * a paused phone never takes a refusal as leave to send again without the
 * name while it is switched. Nothing for a booking that names nobody: every
 * screen saves as before.
 *
 * It names a membership, not a stint of one: someone removed and invited
 * back has their old membership made active again (invitations.redeem), so a
 * booking their phone kept before the removal still passes here, and is held
 * only to what they may do now. Telling the two apart is the phone's to do.
 *
 * Called right after `requireWriteActor`, before anything is written.
 */
export function requireOutboxSender(
  env: WriteEnvelope,
  asMembership: Id<'memberships'> | undefined,
): void {
  if (asMembership === undefined) return
  if (env.actor.real._id !== asMembership || isSwitched(env.actor)) {
    throw new ConvexError('NOT_OWN_ACCOUNT')
  }
  if (outboxPaused()) throw new ConvexError('OUTBOX_PAUSED')
}
