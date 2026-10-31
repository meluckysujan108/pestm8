import { NEW_CLIENT_ERROR_COPY } from '#/components/clients/NewClientFields'
import { MAX_JOB_NOTES_LENGTH } from '../../../convex/lib/jobNotes'
import { MAX_ALSO_GOING } from '../../../convex/lib/jobPeople'
import type { ErrorCopy } from '#/components/forms/describeError'
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
  default: 'Could not book this job. Check your signal and try again.',
}
