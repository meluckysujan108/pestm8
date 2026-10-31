import { isOffline } from '#/lib/online'

/**
 * The server's refusals, in words for the person holding the phone, for the
 * box every form shows when a save fails (FormAlert).
 *
 * Every form used to hand-roll this: one knew INVALID_ABN, the rest said
 * "Could not save these changes." whatever had happened — which reads the
 * same for a typo the server refused as for no signal, and sends the person
 * to retry something that will never work.
 */
export type SaveErrorCode =
  | 'INVALID_EMAIL'
  | 'INVALID_PHONE'
  | 'INVALID_ABN'
  | 'NOT_FOUND'
  | 'NO_ACCESS'
  | 'UNAUTHENTICATED'
  | 'MFA_ENROLMENT_REQUIRED'
  | 'JOB_INVOICED'

/**
 * A form's own words, by code: any of the codes above, 'offline', 'default',
 * or a code only that form meets (REPORT_INCOMPLETE, SLOT_TAKEN), which then
 * gets words instead of the default.
 */
export type ErrorCopy = Partial<
  Record<SaveErrorCode | 'offline' | 'default', string>
> &
  Record<string, string | undefined>

export const ERROR_COPY: Readonly<
  Record<SaveErrorCode | 'offline' | 'default', string>
> = {
  INVALID_EMAIL:
    'Could not save: an email address is not a real address. Check it and try again.',
  INVALID_PHONE:
    'Could not save: a phone number is too short to dial. Check it and try again.',
  INVALID_ABN:
    'Could not save: the ABN does not pass the ATO check. Check its 11 digits.',
  NOT_FOUND:
    'Could not save: this has been deleted, or moved, since you opened it. Close it and look again.',
  NO_ACCESS:
    'Could not save: your access does not cover this. Ask the business owner.',
  UNAUTHENTICATED:
    'Could not save: you have been signed out. Sign in again, then try again.',
  // The query client also puts up the "Set up two-step sign-in" card
  // (components/auth/TwoStepPrompt) the moment this comes back; this is the
  // form's own line, which says the save did not happen and that nothing
  // typed has been lost.
  MFA_ENROLMENT_REQUIRED:
    'Could not save: set up two-step sign-in first (the button at the bottom of the screen). What you typed is still here.',
  JOB_INVOICED:
    'Could not save: this job has been invoiced, so it can no longer be changed. Book a new job for any further work.',
  offline:
    'Could not save: this device is offline. What you typed is still here — try again when you have signal.',
  default: 'Could not save. Check your signal and try again.',
}

const CODES = Object.keys(ERROR_COPY).filter(
  (k) => k !== 'offline' && k !== 'default',
) as Array<SaveErrorCode>

/** What a failed fetch, or a dropped socket, says in the browsers we meet. */
const NETWORK =
  /failed to fetch|networkerror|network request failed|load failed|connection (?:lost|closed)|offline|timed? ?out/i

/**
 * A refusal's code, read from its `data` alone: a ConvexError's string, or
 * the `code` of the object a refusal that brings details carries
 * (MATCHED_CLIENT, SITE_BOOKED, SITE_REPEATS, whose rows a form shows).
 * Null for anything else. Never the message: a code named in an error's
 * text (a plain Error, a log line, a validator's complaint quoting an
 * argument) is not the server saying it, and a form that acts on one, by
 * putting rows on screen or sending again, must only ever act on the
 * server's own answer.
 */
export function convexCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const data = (error as { data?: unknown }).data
  if (typeof data === 'string') return data
  if (typeof data === 'object' && data !== null) {
    const code = (data as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

/**
 * The code behind an error, for the words a form shows, or null: the
 * refusal's own (`convexCode`), or, failing that, one of the codes above
 * named in a plain Error's message ("… Uncaught Error: NOT_FOUND at
 * handler …"). Only for words: anything that acts on a code reads
 * `convexCode`.
 */
export function errorCode(error: unknown): string | null {
  const code = convexCode(error)
  if (code !== null) return code
  if (typeof error !== 'object' || error === null) return null
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return null
  return CODES.find((c) => new RegExp(`\\b${c}\\b`).test(message)) ?? null
}

/**
 * Plain words for why a save failed: the form's `copy` for its code when it
 * has some, else the default words for that code, else "offline" when the
 * browser says so or the error reads like a dropped connection, else the
 * generic default.
 */
export function describeError(error: unknown, copy: ErrorCopy = {}): string {
  const code = errorCode(error)
  if (code !== null) {
    const words =
      copy[code] ??
      ((CODES as Array<string>).includes(code)
        ? ERROR_COPY[code as SaveErrorCode]
        : undefined)
    if (words !== undefined) return words
  }
  const message =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : undefined
  if (isOffline() || (typeof message === 'string' && NETWORK.test(message))) {
    return copy.offline ?? ERROR_COPY.offline
  }
  return copy.default ?? ERROR_COPY.default
}
