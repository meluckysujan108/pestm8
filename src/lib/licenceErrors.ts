import {
  MAX_LICENCE_IMAGE_BYTES,
  MAX_LICENCE_PDF_BYTES,
} from '../../convex/lib/licences'
import {
  MAX_LICENCES,
  MAX_LICENCE_FILES,
  MAX_LICENCE_NAME_LENGTH,
  MAX_LICENCE_NUMBER_LENGTH,
} from '../../convex/lib/memberLicences'
import { SWITCH_ENDED } from './productErrors'
import type { ErrorCopy } from '#/components/forms/describeError'

/**
 * What went wrong with a licence, in the words a technician reads — for
 * FormAlert's `copy`, which falls back to its own words for the codes every
 * form shares and to "offline" when the phone is.
 *
 * `convex/memberLicences.ts` refuses with a bare code; the page turns each
 * into a sentence that says what happened and what to do. The same codes
 * come from the page's own checks before anything is sent (a file of the
 * wrong type, a name left empty), so one set of words covers both.
 *
 * The limits are read from the rules both ends share, so a sentence cannot
 * quote a number the rule no longer uses.
 */

/** What was being done when it failed: it decides the fallback sentence. */
export type LicenceAction =
  'add' | 'save' | 'delete' | 'upload' | 'removeFile' | 'load'

/** Megabytes as the limits were written — `20 * 1024 * 1024` is "20 MB". */
const mb = (bytes: number) => Math.round(bytes / (1024 * 1024))

const WORDS: Record<string, string> = {
  INVALID_NAME: `Give the licence a name, up to ${MAX_LICENCE_NAME_LENGTH} characters.`,
  INVALID_NUMBER: `That number is too long. It can be up to ${MAX_LICENCE_NUMBER_LENGTH} characters.`,
  INVALID_DATE:
    'That expiry date doesn’t exist. Pick it again from the calendar.',
  TOO_MANY_LICENCES: `You can keep up to ${MAX_LICENCES} licences. Delete one you no longer hold, then add this one.`,
  TOO_MANY_FILES: `A licence can hold up to ${MAX_LICENCE_FILES} files. Remove one, then add this.`,
  WRONG_FILE_TYPE: 'That file isn’t a PDF, PNG or JPG. Choose one of those.',
  FILE_TOO_LARGE: `That file is too big: a PDF can be up to ${mb(MAX_LICENCE_PDF_BYTES)} MB, a photo up to ${mb(MAX_LICENCE_IMAGE_BYTES)} MB.`,
  FILE_NOT_FOUND: 'The upload took too long to finish. Try again.',
  ALREADY_ATTACHED: 'That file is already used elsewhere. Choose another.',
  NOT_FOUND: 'This licence has been deleted, perhaps on another phone.',
  NO_ACCESS: 'Only the person who holds a licence can change it.',
  SWITCH_EXPIRED: SWITCH_ENDED,
  SWITCH_REVOKED: SWITCH_ENDED,
  SWITCH_NOT_PERMITTED: SWITCH_ENDED,
  SWITCH_TARGET_INACTIVE: SWITCH_ENDED,
  SWITCH_TEAM_CHANGED: SWITCH_ENDED,
}

const FALLBACK: Record<LicenceAction, string> = {
  add: 'Could not add this licence. Check your signal and try again.',
  save: 'Could not save this licence. Check your signal and try again.',
  delete: 'Could not delete this licence. Check your signal and try again.',
  upload: 'Could not add the file. Check your signal and try again.',
  removeFile: 'Could not remove the file. Check your signal and try again.',
  load: 'Could not load the licences. Try again later.',
}

/** Said when the phone knows it has no signal: nothing was sent. */
const OFFLINE =
  'This phone is offline. Nothing was changed — try again when you have signal.'

/** The words for a licence's failures while doing `action`. */
export function licenceErrorCopy(action: LicenceAction): ErrorCopy {
  return {
    ...WORDS,
    // Deleting what is already gone is not a failure the server makes, but
    // a file removed twice (two phones) reads better this way than as
    // "deleted".
    ...(action === 'removeFile'
      ? { NOT_FOUND: 'That file has already been removed.' }
      : {}),
    offline: OFFLINE,
    default: FALLBACK[action],
  }
}

/**
 * An error in the shape the server's refusals take (`data` is the code), for
 * a check the page makes before sending, so FormAlert words it the same.
 */
export function licenceRefusal(code: string): Error & { data: string } {
  return Object.assign(new Error(code), { data: code })
}
