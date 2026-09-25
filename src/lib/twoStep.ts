/**
 * Client half of compulsory two-step sign-in. The server refuses an account
 * that has not set it up (convex/lib/access.ts, `requireAuthUser`) with
 * MFA_ENROLMENT_REQUIRED; everything here is about turning that refusal into
 * the set-up screen instead of an error, and back to where the person was
 * going once they are done.
 *
 * Kept free of React and of anything heavy: the route guards import it, and
 * guards run before a route's chunk loads.
 */

export const TWO_STEP_PATH = '/two-step'

export const MFA_ENROLMENT_REQUIRED = 'MFA_ENROLMENT_REQUIRED'

/**
 * A ConvexError carries the code as `data`; the same refusal reaching a
 * server-rendered guard, or wrapped by a library on the way, may only have it
 * in the message. Not `describeError`'s `errorCode`, which would pull the
 * address-lookup module into every guard that imports this one.
 */
export function isMfaEnrolmentError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as { data?: unknown }).data === MFA_ENROLMENT_REQUIRED) return true
  const message = (error as { message?: unknown }).message
  return (
    typeof message === 'string' &&
    new RegExp(`\\b${MFA_ENROLMENT_REQUIRED}\\b`).test(message)
  )
}

/**
 * Where to go after setting up, from a `next` search param — but only a path
 * on this site. Anything else (another origin, `//evil.example`, `javascript:`)
 * becomes `/`: a sign-in flow is exactly where an open redirect gets used for
 * phishing, and a standalone iPhone PWA sent off-site leaves the app for good.
 * Never back to /two-step itself, or /login, which would loop.
 */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string') return '/'
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return '/'
  }
  const path = next.split(/[?#]/)[0]
  if (path === TWO_STEP_PATH || path === '/login') return '/'
  return next
}

/*
 * "This session has been refused for want of two-step sign-in" — set by the
 * query client (integrations/tanstack-query) whenever a query or a save comes
 * back MFA_ENROLMENT_REQUIRED, read by the prompt that asks the person to set
 * it up (components/auth/TwoStepPrompt). A plain store rather than React
 * state because the query client lives outside React.
 *
 * Only ever turns on: the way out of it is the set-up screen, which is a full
 * page load, and that starts the module again.
 */
let twoStepNeededNow = false
const twoStepListeners = new Set<() => void>()

/** Turns the prompt on if `error` is the two-step refusal. */
export function flagIfTwoStepNeeded(error: unknown): void {
  if (twoStepNeededNow || !isMfaEnrolmentError(error)) return
  twoStepNeededNow = true
  for (const listener of twoStepListeners) listener()
}

export function isTwoStepNeeded(): boolean {
  return twoStepNeededNow
}

export function subscribeTwoStepNeeded(listener: () => void): () => void {
  twoStepListeners.add(listener)
  return () => twoStepListeners.delete(listener)
}

/**
 * Watches a query cache for the refusal arriving as a PUSH to a live query —
 * @convex-dev/react-query delivers those with `query.setState`, which never
 * reaches the cache's `onError` (that only runs inside a fetch). Only entries
 * something is showing: a guard's `ensureQueryData` has no observers, and
 * redirects on its own. Returns the unsubscribe.
 */
export function watchForTwoStepRefusals(queryClient: {
  getQueryCache: () => {
    subscribe: (
      listener: (event: {
        type: string
        query: {
          state: { error: unknown }
          getObserversCount: () => number
        }
      }) => void,
    ) => () => void
  }
}): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return
    const { error } = event.query.state
    if (error && event.query.getObserversCount() > 0) {
      flagIfTwoStepNeeded(error)
    }
  })
}

/** The set-up screen, coming back to `from` afterwards. */
export function twoStepHref(from: string): string {
  const next = safeNext(from)
  return next === '/'
    ? TWO_STEP_PATH
    : `${TWO_STEP_PATH}?next=${encodeURIComponent(next)}`
}

/**
 * What someone typed as a recovery code, in the form the server stores:
 * lowercase `xxxxx-xxxxx`. The codes are generated lowercase with no
 * look-alike characters (convex/auth.ts), so a code copied off paper as
 * "ABCDE FGHJK" or "abcdefghjk" still matches.
 */
export function normaliseRecoveryCode(input: string): string {
  const compact = input.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (compact.length === 10) return `${compact.slice(0, 5)}-${compact.slice(5)}`
  return input.trim().toLowerCase()
}

/** Six digits from whatever was pasted: "123 456", "123-456". */
export function normaliseTotpCode(input: string): string {
  return input.replace(/\D/g, '').slice(0, 6)
}

/** The setup key out of an otpauth:// URI, grouped in fours for reading. */
export function setupKeyOf(totpURI: string): string {
  try {
    const secret = new URL(totpURI).searchParams.get('secret') ?? ''
    return secret.replace(/(.{4})/g, '$1 ').trim()
  } catch {
    return ''
  }
}

/**
 * Better Auth's two-factor codes, in words for someone on a phone in a
 * driveway. Unknown codes fall back to the message the server sent.
 */
export function describeTwoFactorError(error: {
  code?: string
  message?: string
  status?: number
}): { message: string; restart: boolean } {
  switch (error.code) {
    case 'INVALID_CODE':
      return {
        message:
          'That code did not match. Codes change every 30 seconds — use the one showing now.',
        restart: false,
      }
    case 'INVALID_BACKUP_CODE':
      return {
        message:
          'That recovery code did not match, or it has already been used. Each one works once.',
        restart: false,
      }
    case 'INVALID_TWO_FACTOR_COOKIE':
      return {
        message:
          'That sign-in took too long, so it has expired. Enter your password again.',
        restart: true,
      }
    case 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE':
      return {
        message:
          'Too many wrong codes. Enter your password again to get another go.',
        restart: true,
      }
    case 'INVALID_PASSWORD':
      return { message: 'That password is not right.', restart: false }
    // The per-account cap (convex/twoStepAttempts.ts): ten wrong codes in a
    // row, over any number of sign-ins. Waiting is the only way through, so
    // back to the password — the next sign-in after the wait works.
    case 'TWO_STEP_LOCKED':
      return {
        message:
          'Too many wrong codes on this account. Wait 15 minutes, then sign in again. If you keep getting codes wrong, check the time on your phone is set automatically.',
        restart: true,
      }
    default:
      if (error.status === 429) {
        return {
          message:
            'Too many tries in a row. Wait a few seconds, then try again.',
          restart: false,
        }
      }
      // A server-side failure or a dropped connection arrives with no code,
      // and its "message" is the fetch library's own class name — a
      // technician was shown "HTTPError" when the backend was unreachable.
      // Only a coded refusal carries words written for a person.
      if (!error.code || (error.status !== undefined && error.status >= 500)) {
        return {
          message:
            "Couldn't reach PestM8. Check your signal, then try again with the code showing now.",
          restart: false,
        }
      }
      return {
        message: error.message ?? 'Something went wrong. Try again.',
        restart: false,
      }
  }
}
