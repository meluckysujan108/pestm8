/**
 * Client half of two-step sign-in. Where a deployment makes it compulsory
 * (`AUTH_MFA_REQUIRED=on`), the server refuses an account that has not set
 * it up (convex/lib/access.ts, `requireAuthUser`) with
 * MFA_ENROLMENT_REQUIRED; everything here is about turning that refusal into
 * the set-up screen instead of an error, and back to where the person was
 * going once they are done.
 *
 * Kept free of React and of anything heavy: the route guards import it, and
 * guards run before a route's chunk loads.
 */

import {
  NEW_KEY_HEADER,
  NEW_KEY_HEADER_VALUE,
} from '../../convex/lib/twoFactorSetup'
import type { TwoFactorSetupState } from '../../convex/lib/twoFactorSetup'

export type { TwoFactorSetupState }

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

/** A refusal from the auth client, or `unreachable()` standing in for one
 * that never arrived — as much of either as the words below need. */
export type TwoFactorRefusal = {
  code?: string
  message?: string
  status?: number
}

/**
 * Better Auth's two-factor codes, in words for someone on a phone in a
 * driveway. Unknown codes fall back to the message the server sent.
 */
export function describeTwoFactorError(error: TwoFactorRefusal): {
  message: string
  restart: boolean
} {
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
    // Set-up only (convex/auth.ts): enable refused to replace a key nobody
    // asked to replace, and get-totp-uri refused a key this session did not
    // make. Either way the live set-up state has moved on, and the password
    // step follows it.
    //
    // "Already started" may well be THIS page's doing: a Start whose answer
    // was lost on one bar of signal still made the key, and the live status
    // saying so can be as slow to arrive as the answer was. So it blames
    // nobody, and says the one thing that is certain — nothing changed.
    case 'MFA_SETUP_STARTED':
      return {
        message:
          'Setting up had already started — perhaps from this page, if the signal dropped, or from another tab or device. Nothing has been changed. Give this page a moment to catch up, then carry on.',
        restart: false,
      }
    case 'MFA_SETUP_KEY_UNAVAILABLE':
      return {
        message:
          'That key is only shown where setting up started — before you last signed in, or on another device or browser. Start again here with a new key.',
        restart: false,
      }
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
      // The IP rate limit (convex/auth.ts, when AUTH_RATE_LIMIT is on). A
      // minute, not "a few seconds": the six-digit code's window is 60 s,
      // and it restarts from the last try that got through.
      if (error.status === 429) {
        return {
          message: 'Too many tries in a row. Wait a minute, then try again.',
          restart: false,
        }
      }
      // A server-side failure or a dropped connection arrives with no code,
      // and its "message" is the fetch library's own class name — a
      // technician was shown "HTTPError" when the backend was unreachable.
      // Only a coded refusal carries words written for a person.
      if (!answered(error)) {
        return {
          message:
            'Could not reach PestM8. Check your signal, then try again with the code showing now.',
          restart: false,
        }
      }
      return {
        message:
          error.message ??
          'Could not check that code. Try again with the code showing now.',
        restart: false,
      }
  }
}

/**
 * Whether the server answered — a coded refusal, or the rate limit's bare
 * 429 — as opposed to an answer that never came: a dropped connection, a
 * 5xx, a response lost on the way back. After one of those the request may
 * or may not have done its work, and nothing about it can be assumed.
 */
export function answered(error: TwoFactorRefusal): boolean {
  if (error.status === 429) return true
  return !!error.code && !(error.status !== undefined && error.status >= 500)
}

/**
 * The request went out on a sign-in that no longer exists: set-up's own code
 * check with no session and no sign-in challenge (INVALID_TWO_FACTOR_COOKIE),
 * or any endpoint that needs a session (UNAUTHORIZED). The session this page
 * holds has been deleted since it loaded — by a code that turned two-step
 * sign-in on (this page's own, whose answer was lost, or another device's),
 * by the owner's reset, by signing out in another tab — so the page's cookie
 * names nothing, and every request after this one gets the same answer.
 */
export function isSignInLost(error: TwoFactorRefusal): boolean {
  return (
    error.code === 'INVALID_TWO_FACTOR_COOKIE' || error.code === 'UNAUTHORIZED'
  )
}

/*
 * Setting up: carrying on with the same key rather than making a new one.
 *
 * Every `/two-factor/enable` makes a new secret and replaces the old one, so
 * a set-up screen that called it every time it showed the password step
 * killed the entry the person had just added to their authenticator whenever
 * that step came round again — an iPhone home-screen app reloaded on the way
 * back from the authenticator, a second tap on Start, going back. Their code
 * then never matched. The server now says how far set-up has got, as seen
 * from this session (`auth.twoFactorStatus().setup`,
 * convex/lib/twoFactorSetup.ts), and the screen decides from that, here,
 * where it can be tested.
 */

/** What the set-up screen reads from `auth.twoFactorStatus`. `setup` is
 * missing from a backend older than this client. */
export type SetupStatus = { signedIn: boolean; setup?: TwoFactorSetupState }

/**
 * What the password step does with the password.
 *
 * - `resume` — an unfinished set-up this session started: fetch the key it
 *   already made (`/two-factor/get-totp-uri`) and show that same key. Never
 *   enable.
 * - `start` — nothing started: enable, for a first key.
 * - `restart` — a key exists that cannot be carried on with here: started
 *   in another browser or on another device (`elsewhere`, whose key the
 *   server will not show this session), the half-off state (`stale`, whose
 *   row has to be replaced for its first code to count), or one this page
 *   already knows has gone (`hadKey`: cleared from under it, or a "new key"
 *   that may or may not have been made). Enable, asking to replace it, with
 *   the warning to delete every PestM8 entry on the next step.
 * - `leave` — already on (finished in another tab): nothing to do here.
 * - `wait` — the status has not arrived yet.
 * - `signed-out` — the live status says this page is no longer signed in (a
 *   token that could not be renewed, say). Its "nothing started" is not to
 *   be believed, so it offers no Start — only a reload, which either finds
 *   the session again or goes to sign-in.
 *
 * A signed-in status with no `setup` is a backend older than this client:
 * `start`, which is what set-up always did there.
 */
export type PasswordStepAction =
  'wait' | 'signed-out' | 'leave' | 'resume' | 'start' | 'restart'

export function passwordStepAction(
  status: SetupStatus | undefined,
  hadKey: boolean,
): PasswordStepAction {
  if (status === undefined) return 'wait'
  if (!status.signedIn) return 'signed-out'
  switch (status.setup) {
    case 'on':
      return 'leave'
    case 'unfinished':
      return 'resume'
    case 'elsewhere':
    case 'stale':
      return 'restart'
    case 'none':
      return hadKey ? 'restart' : 'start'
    case undefined:
      return 'start'
  }
}

/**
 * How the key on the scan step came to be, which decides what it warns
 * about.
 *
 * - `fresh` — a new key where there was none.
 * - `replaced` — a new key over one that already existed: whatever PestM8
 *   entry the person added from the old one is dead from now on.
 * - `resumed` — the same key as before, fetched again.
 * - `current` — the key there is now, fetched after this page lost track of
 *   the one it was showing (a "new key" that failed half-way, say): maybe
 *   the same, maybe not.
 */
export type SetupFlow = 'fresh' | 'replaced' | 'resumed' | 'current'

export function resumeFlow(
  hadKey: boolean,
): Extract<SetupFlow, 'resumed' | 'current'> {
  return hadKey ? 'current' : 'resumed'
}

/**
 * A request for a new key: whether it asks the server to replace one that is
 * there, and the flow it shows. They are one decision — a key is only ever
 * replaced (`NEW_KEY_HEADER`) with the amber warning to delete every PestM8
 * entry as the next thing on screen, and the server refuses a replacement
 * that did not ask (convex/auth.ts). So a first key never warns, and a page
 * that wrongly believes nothing was started can never rotate a key silently.
 */
export function newKeyRequest(action: 'start' | 'restart'): {
  flow: Extract<SetupFlow, 'fresh' | 'replaced'>
  headers: Record<string, string> | undefined
} {
  return action === 'restart'
    ? { flow: 'replaced', headers: { [NEW_KEY_HEADER]: NEW_KEY_HEADER_VALUE } }
    : { flow: 'fresh', headers: undefined }
}

export function passwordStepCopy(
  action: Extract<PasswordStepAction, 'wait' | 'resume' | 'start' | 'restart'>,
  setup: TwoFactorSetupState | undefined,
): { submit: string; hint: string } {
  switch (action) {
    case 'resume':
      return {
        submit: 'Continue setting up',
        hint: 'You started setting this up before. Enter your password to carry on with the same key.',
      }
    case 'restart':
      return {
        submit: 'Start again with a new key',
        // "Before you last signed in" first, because it is the likeliest:
        // a claim belongs to a session (convex/lib/twoFactorSetup.ts), and
        // signing out and back in on this same phone — the compulsory set-up
        // screen's own Sign out, say — makes a new one.
        hint:
          setup === 'elsewhere'
            ? 'Setting this up was started somewhere this page cannot carry on from — before you last signed in, on another device or in another browser, or in an older version of PestM8 — so its key is not shown here. This makes a new key — the next step says what to delete first. If none of those was you, change your password once this is done.'
            : setup === 'stale'
              ? 'Two-step sign-in was only partly switched off. Setting it up again makes a new key — the next step says what to delete first.'
              : 'Your earlier key has gone, so this makes a new one — the next step says what to delete first.',
      }
    case 'start':
    case 'wait':
      return {
        submit: action === 'wait' ? 'Just a moment…' : 'Start',
        hint: 'To confirm it is you before changing how you sign in.',
      }
  }
}

/**
 * What the scan step says about the key it shows, and how loudly:
 *
 * - `warn` — the amber box at the top, read before anything else: a new key
 *   has just made an existing one dead.
 * - `info` — a plain box at the top: this is the key they may already have.
 *   Said of a key fetched again (`resumed`), it also says what to do with
 *   more than one PestM8 entry, and how: the page cannot know what came
 *   before a reload. "Start again with a new key" warns in amber on its new
 *   key — and adding that key is the very app switch that reloads an iPhone
 *   home-screen app, after which the same key comes back as `resumed` with
 *   the warning gone and a dead entry beside the new one. The server cannot
 *   tell that apart from a first key fetched again, so this says it either
 *   way; with one entry it asks nothing of them.
 * - `quiet` — a line under the key, for the one case the server cannot see
 *   (an entry left from before two-step sign-in was turned off, or reset by
 *   the owner — both delete the row, so the account looks like it never
 *   started).
 */
export function scanStepNotice(flow: SetupFlow): {
  text: string
  tone: 'warn' | 'info' | 'quiet'
  /** Follow the text with `deleteEntryHow`: the old entry must go now. */
  howToDelete: boolean
} {
  switch (flow) {
    case 'resumed':
      return {
        text: 'This is the same key as before. If PestM8 is already in your authenticator app, enter the code it shows below. If it is not there, add it now. More than one PestM8 entry? Only one added from this key works — delete them all, then add this key again.',
        tone: 'info',
        howToDelete: true,
      }
    case 'current':
      return {
        text: 'This is the key that works now. If the codes from the PestM8 entry in your authenticator app do not match below, delete that entry and add this key.',
        tone: 'info',
        howToDelete: false,
      }
    case 'replaced':
      return {
        text: 'This is a new key. Delete every PestM8 entry already in your authenticator app first — only the one you add now will work.',
        tone: 'warn',
        howToDelete: true,
      }
    case 'fresh':
      return {
        text: 'Had PestM8 in your authenticator app before? Delete that old entry — only the one you add now will work.',
        tone: 'quiet',
        howToDelete: false,
      }
  }
}

/**
 * Where the old entry is, and how to delete it — said wherever a new key is
 * about to make, or has just made, the old one dead ("Make a new key", and
 * the scan step after "Start again with a new key").
 *
 * "Delete every PestM8 entry" on its own was not enough on an iPhone: its
 * Passwords app keeps the code on the site's saved login — listed by its
 * address, not as "PestM8" — as that login's Verification Code, and removing
 * it is an Edit away on that login. Someone looking for "PestM8" finds
 * nothing, the dead code stays, and the new key's codes are typed from the
 * wrong place. Google and Microsoft Authenticator do list a PestM8 entry.
 *
 * Also on a key fetched again, for the case where it came after a new key
 * (`scanStepNotice`).
 *
 * `host` is this page's own (`location.hostname`, pestm8.vercel.app in
 * production), so the words name the login the person will actually see on
 * any deployment. Empty — no page to ask, which the set-up screen never is,
 * since its keys only exist after a tap — falls back to a description.
 */
export function deleteEntryHow(host: string): string {
  const login = host ? `the ${host} login` : 'the PestM8 website login'
  return `On an iPhone: Passwords app → ${login} → Edit → Delete Verification Code. In Google or Microsoft Authenticator: delete the PestM8 entry.`
}

/**
 * A code refused while setting up. A wrong code gets the way out of the
 * trap this screen used to set: an entry left over from an earlier try gives
 * codes that never match, and adding PestM8 again from the live key is what
 * fixes it. The key on screen is the live one unless something replaced it
 * since — another tab or device making a new key, the owner resetting it —
 * which only a reload shows, so the reload comes first. The phone's clock is
 * the other thing that makes every code wrong.
 *
 * The key having gone from under the screen while this sign-in stayed
 * standing (another device's "new key" caught between its delete and its
 * create, say) arrives as the plugin's TOTP_NOT_ENABLED, whose own words are
 * "TOTP not enabled". The owner's or the operator's reset does not: it signs
 * the account out everywhere as well (`clearTwoFactor` in convex/team.ts),
 * so it arrives as the sign-in having gone (`isSignInLost`) — as does a
 * right code whose answer was lost, after which two-step sign-in is ON. The
 * words for that must not ask for a password this step has no field for,
 * and must not let someone whose two-step sign-in is on walk away thinking
 * it is not (`SETUP_SIGN_IN_LOST`).
 */
export function setupCodeError(error: TwoFactorRefusal): string {
  if (error.code === 'INVALID_CODE') {
    return "That code did not match. Codes change every 30 seconds — use the one showing now. Still not matching? Reload this page to be sure the key above is the current one, then delete every PestM8 entry in your authenticator app and add it again from that key. Check your phone's time is set automatically, too."
  }
  if (error.code === 'TOTP_NOT_ENABLED') {
    return 'This set-up was cleared in the meantime. Reload this page to start again.'
  }
  if (isSignInLost(error)) return SETUP_SIGN_IN_LOST
  return describeTwoFactorError(error).message
}

/**
 * The scan step's sign-in has gone (`isSignInLost`, or the live status
 * saying so before a code is typed). Two-step sign-in may be on — a right
 * code whose answer never arrived — so it says how to tell, and what to do
 * about the recovery codes that were never shown; Profile asks for them too
 * (`remindAfterRefusedCode`).
 */
export const SETUP_SIGN_IN_LOST =
  'This page has lost your sign-in, and two-step sign-in may already be on. Reload this page. If you are asked to sign in and then for a code, it is on: use the PestM8 entry you just added, then get new recovery codes in Settings → Profile.'

/**
 * The recovery-code reminder (lib/twoStepReminders), once a set-up code has
 * come back refused: whether Profile should go on asking for new codes.
 *
 * The set-up screen switches the reminder on BEFORE it sends a code, not
 * once the code is accepted: an acceptance can be lost on the way back (one
 * bar of signal, iOS suspending a home-screen app mid-request), and then two
 * step sign-in is on, no recovery codes were ever shown, and nothing else
 * would ever say so. The reminder is only read once two-step sign-in is on,
 * so leaving it on after a code that changed nothing costs nothing on its
 * own; it is put back as it was (`before`) only when the answer proves this
 * page turned nothing on — so that another tab which turned it on and whose
 * codes were saved is not nagged for new ones.
 *
 * Kept on when the answer never came (`answered`), when the sign-in has gone
 * (`isSignInLost` — this page's own right code, answered to nobody, deletes
 * every session), and after any earlier code from this page whose answer
 * never came — that one may be what turned it on, and a later "already on"
 * is its echo.
 */
export function remindAfterRefusedCode(
  error: TwoFactorRefusal,
  before: boolean,
  earlierUnanswered: boolean,
): boolean {
  if (earlierUnanswered || !answered(error) || isSignInLost(error)) return true
  return before
}

/**
 * A refusal on the password step, which has no code on it: never "the code
 * showing now". A lost answer here may have made a key all the same (Start
 * gets as far as the server before the signal drops) — the live status
 * catches up and the step becomes "Continue setting up", so trying again is
 * the right advice either way. A lost sign-in gets the reload the step's own
 * signed-out state offers.
 */
export function passwordStepError(error: TwoFactorRefusal): string {
  if (!answered(error)) {
    return 'Could not reach PestM8. Check your signal, then try again.'
  }
  if (isSignInLost(error)) return SIGNED_OUT_HERE
  return describeTwoFactorError(error).message
}

/**
 * "Make a new key" went wrong. The key on screen can no longer be trusted —
 * the server may have replaced it before the answer was lost, or another tab
 * may have — so the screen goes back to the password step, which follows the
 * live state and shows whichever key is there now. A wrong password (changed
 * on another device mid-set-up) is the one failure known to have changed
 * nothing: the server checks it before touching the key.
 */
export function startOverFailed(error: {
  code?: string
  message?: string
}): string {
  return error.code === 'INVALID_PASSWORD'
    ? 'That password is not right, so the key has not changed. Enter your password to carry on.'
    : 'We could not tell whether a new key was made. Enter your password to see the key that works now.'
}

/** Resuming found no set-up to resume: it was cleared in the meantime. */
export const SETUP_CLEARED =
  'Your earlier set-up has been cleared. Enter your password again to start with a new key.'

export const START_OVER_WARNING =
  'A new key stops the one you have now from working. Delete every PestM8 entry in your authenticator app first, then add the new one.'

/** The live status lost this page's sign-in (`signed-out` above). */
export const SIGNED_OUT_HERE =
  'This page has lost your sign-in. Reload it to carry on — if you have been signed out, you will be asked to sign in again.'

/**
 * Recovery codes are made after the code, whichever way the key came —
 * never enable's, which another tab's set-up may already have replaced — so
 * the codes on screen are always the ones stored. If that fails, two-step
 * sign-in is on all the same, and Profile keeps asking for codes
 * (lib/twoStepReminders) until some are saved.
 */
export const RECOVERY_CODES_NOT_MADE =
  'Two-step sign-in is on. Your recovery codes could not be made just now — make them in Settings → Profile → Get new recovery codes, before you need one.'
