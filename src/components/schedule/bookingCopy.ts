import { NEW_CLIENT_ERROR_COPY } from '#/components/clients/NewClientFields'
import { MAX_JOB_NOTES_LENGTH } from '../../../convex/lib/jobNotes'
import { MAX_ALSO_GOING } from '../../../convex/lib/jobPeople'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { BookingSite } from '#/lib/outbox/outboxItem'
import type { Id } from '../../../convex/_generated/dataModel'
import type { SwitchFailure } from '../../../convex/lib/capabilities'

/**
 * A booking made while switched into someone's account after that switch
 * had ended (`requireWriteActor` fails closed): nothing was booked, and the
 * app has put the person back in their own account, as the switch banner
 * says (`SWITCH_ENDED`, for a booking).
 */
const SWITCH_ENDED_BOOKING =
  'Could not book this job: that session ended, so you are back in your own account. Nothing was booked — try again.'

const SWITCH_ENDED_COPY: Record<SwitchFailure, string> = {
  SWITCH_EXPIRED: SWITCH_ENDED_BOOKING,
  SWITCH_REVOKED: SWITCH_ENDED_BOOKING,
  SWITCH_TEAM_CHANGED: SWITCH_ENDED_BOOKING,
  SWITCH_TARGET_INACTIVE: SWITCH_ENDED_BOOKING,
  SWITCH_NOT_PERMITTED: SWITCH_ENDED_BOOKING,
  SWITCH_CHAINED: SWITCH_ENDED_BOOKING,
}

/**
 * Why a booking failed, in FormAlert: New Job's, and a booking on the phone
 * that needs a look for the same refusal (lib/outbox/).
 *
 * This used to say "You may not have access to that calendar" whatever had
 * happened — for no signal, and for an email the server refused, too — so
 * the person went looking at permissions for a typo. Access is named only
 * when access is what was refused, and the signal only when nothing says
 * otherwise.
 */
export const BOOKING_ERROR_COPY: ErrorCopy = {
  ...NEW_CLIENT_ERROR_COPY,
  NO_ACCESS:
    'Could not book this job: your access does not cover that calendar. Ask the business owner.',
  INVALID_ASSIGNEE:
    'Could not book this job: someone on it is no longer on the team. Choose someone else under Assigned to or Also going.',
  TOO_MANY_PEOPLE: `Could not book this job: a job can have up to ${MAX_ALSO_GOING} people also going. Take someone off and try again.`,
  NOTES_TOO_LONG: `Could not book this job: the note is longer than ${MAX_JOB_NOTES_LENGTH} characters. Shorten it and try again.`,
  // Sent as the person's own (`asMembership`, once keeping it on the phone
  // took too long, or a press of it was discarded) after PestM8 had moved into someone else's account, from
  // another tab: the server books nothing as anyone but the account the
  // phone is working in.
  NOT_OWN_ACCOUNT:
    'Could not book this job: PestM8 is now working in someone else’s account. Switch back to your own, then book it again.',
  ...SWITCH_ENDED_COPY,
  // The server's own checks as the booking went (the matching plan's M7).
  // New Job shows them as rows of its panel, from what the server found
  // (lib/sheetChecks.ts), and no words here; these are for where none
  // could be shown: the form changed while it was booking, or a booking on
  // the phone that needs a look. Nothing was booked. They promise nothing
  // of the next press: it checks the form as it is now, which may find
  // nothing and book. "That site": the one it was booked at, which the
  // form may no longer show. A new site for a client chosen has its own
  // words (`bookingErrorCopy`).
  MATCHED_CLIENT:
    'Could not book this job: the caller may already be a client. Nothing was booked — book it again.',
  SITE_BOOKED:
    'Could not book this job: work is already booked at that site near that date. Nothing was booked — book it again.',
  SITE_REPEATS:
    'Could not book this job: a Recurring Job already runs at that site. Nothing was booked — book it again.',
  default: 'Could not book this job. Check your signal and try again.',
}

/**
 * New Job's words for the booking that failed (`property`, as it was sent):
 * BOOKING_ERROR_COPY, but for MATCHED_CLIENT of a new site for a client
 * chosen, said only where the panel couldn't show it, as the form changed
 * while it was booking: that client having the address already (the
 * server's check there is of their own sites, exactly), not another client
 * the caller may be; so of the address as it was then, not as the form may
 * show it now. No button is named: the one pressed may have read Book job
 * or Book anyway.
 */
export function bookingErrorCopy(
  property: BookingSite | undefined,
  nameOf: (clientId: Id<'clients'>) => string | undefined,
): ErrorCopy {
  if (property !== undefined && 'newProperty' in property) {
    const name = nameOf(property.newProperty.clientId) ?? 'the client chosen'
    return {
      ...BOOKING_ERROR_COPY,
      MATCHED_CLIENT: `Could not book this job: ${name} already has the address as it was before the form changed. Nothing was booked — check the address and book it again.`,
    }
  }
  return BOOKING_ERROR_COPY
}
