/**
 * Two things the set-up screen (routes/two-step.tsx) has to remember across a
 * reload, which on an iPhone home-screen app is not rare: switching to the
 * authenticator app or to Notes is exactly when iOS evicts a web app, and the
 * person comes back to a fresh page.
 *
 * 1. That a set-up was STARTED here. Starting again makes a new secret, and
 *    the entry already added to the authenticator app from the first try
 *    will never give a right code again — two identical "PestM8" entries, one
 *    of them dead, and a wrong code at every sign-in from the dead one. The
 *    set-up screen says so when it starts again.
 * 2. That recovery codes were SHOWN but "I've saved these" was never pressed.
 *    Checking the code turns two-step sign-in on before the codes are shown,
 *    so a reload there lands in the app with the codes gone. Settings →
 *    Two-step sign-in then asks for new ones until they are confirmed saved.
 *
 * Flags only — never the secret or the codes themselves, which would sit in
 * the browser's storage for whoever uses the device next. Keyed by the
 * account, so another person signing in on a shared tablet is not told about
 * someone else's set-up. Browser storage can be missing or refuse (a private
 * window, a preview); every read and write here survives that, and the worst
 * case is only a reminder not shown.
 */

const STARTED = 'pestm8-two-step-started:'
const UNSAVED = 'pestm8-recovery-codes-unsaved:'

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function write(key: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key, '1')
    else window.localStorage.removeItem(key)
  } catch {
    // Nowhere to keep it: the reminder is lost, nothing else.
  }
}

export function setUpStartedBefore(userId: string): boolean {
  return read(STARTED + userId)
}

export function markSetUpStarted(userId: string, started: boolean): void {
  write(STARTED + userId, started)
}

export function recoveryCodesUnsaved(userId: string): boolean {
  return read(UNSAVED + userId)
}

export function markRecoveryCodesUnsaved(
  userId: string,
  unsaved: boolean,
): void {
  write(UNSAVED + userId, unsaved)
}
