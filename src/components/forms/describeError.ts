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
    'Could not save: this job has been invoiced, so it can no longer be changed.',
  offline:
    'Could not save: this device is offline. What you typed is still here — try again when you have signal.',
  default: 'Could not save. Check your connection and try again.',
}

const CODES = Object.keys(ERROR_COPY).filter(
  (k) => k !== 'offline' && k !== 'default',
) as Array<SaveErrorCode>

/** What a failed fetch, or a dropped socket, says in the browsers we meet. */
const NETWORK =
  /failed to fetch|networkerror|network request failed|load failed|connection (?:lost|closed)|offline|timed? ?out/i

/**
 * The code behind an error, or null. A ConvexError carries it as `data` —
 * a string, or `{ code }` for the refusals that bring details. Anything else
 * arrives as a plain Error whose message may still name it
 * ("… Uncaught Error: NOT_FOUND at handler …").
 */
export function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const data = (error as { data?: unknown }).data
  if (typeof data === 'string') return data
  if (typeof data === 'object' && data !== null) {
    const code = (data as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
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
