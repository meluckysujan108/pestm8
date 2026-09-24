/**
 * Compulsory two-step sign-in, as one switch both halves of the app read.
 *
 * Two places have to agree on it: `convex/auth.ts`, which stops anyone
 * switching two-step sign-in off, and `requireAuthUser` in `lib/access.ts`,
 * which refuses every app function to a signed-in account that has not set it
 * up yet. If they disagreed, one of two things would happen: an account could
 * turn it off and then be locked out of the app with no way back in, or the
 * app would let un-enrolled accounts read everything while the sign-in screen
 * claimed the opposite. Hence one function, here, with no imports — both of
 * those modules load it, and so do the tests.
 *
 * Defaults ON, like the breach check: a security control must not disappear
 * because an environment variable went missing on a deployment. The only
 * spelling that turns it off is `AUTH_MFA_REQUIRED=off`, and that belongs on
 * the e2e deployment alone, whose suite signs up ~150 accounts per run and
 * cannot read an authenticator app.
 *
 * Read on every call rather than captured at import, so a test can flip it
 * and so nothing depends on the order modules happened to load in.
 */
export function isMfaRequired(): boolean {
  return process.env.AUTH_MFA_REQUIRED !== 'off'
}

/**
 * What a signed-in account that has not set up two-step sign-in gets back
 * from every app function outside the enrolment allow-list. The client routes
 * on it (to /two-step) rather than showing it, so it is a code, not a
 * sentence.
 */
export const MFA_ENROLMENT_REQUIRED = 'MFA_ENROLMENT_REQUIRED'
