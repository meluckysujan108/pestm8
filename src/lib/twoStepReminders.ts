/**
 * What the set-up screen (routes/two-step.tsx) has to remember across a
 * reload, which on an iPhone home-screen app is not rare: switching to the
 * authenticator app or to Notes is exactly when iOS evicts a web app, and the
 * person comes back to a fresh page.
 *
 * That recovery codes were SHOWN — or were due to be and could not be made —
 * but "I've saved these" was never pressed. Checking the code turns two-step
 * sign-in on before the codes are shown, so a reload there lands in the app
 * with the codes gone. Profile's two-step card then asks for new ones until
 * they are confirmed saved.
 *
 * Switched on as the set-up code is SENT, not once it is accepted: an
 * acceptance lost on the way back (one bar of signal, iOS suspending the app
 * mid-request) leaves two-step sign-in on with no codes ever shown, and
 * nothing else would say so. It is only read once two-step sign-in is on, so
 * a code that changed nothing costs nothing; the set-up screen puts it back
 * when the answer proves that (`remindAfterRefusedCode` in lib/twoStep.ts).
 *
 * (This used to remember that a set-up had been STARTED here too, to warn
 * that starting again made a new key. The server says that now, for every
 * device — `auth.twoFactorStatus().setup` — and set-up carries on with the
 * same key instead of starting again. See lib/twoStep.ts.)
 *
 * A flag only — never the codes themselves, which would sit in the browser's
 * storage for whoever uses the device next. Keyed by the account, so another
 * person signing in on a shared tablet is not told about someone else's
 * set-up. Browser storage can be missing or refuse (a private window, a
 * preview); every read and write here survives that, and the worst case is
 * only a reminder not shown.
 */

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

export function recoveryCodesUnsaved(userId: string): boolean {
  return read(UNSAVED + userId)
}

export function markRecoveryCodesUnsaved(
  userId: string,
  unsaved: boolean,
): void {
  write(UNSAVED + userId, unsaved)
}
