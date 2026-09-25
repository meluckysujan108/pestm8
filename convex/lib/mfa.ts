/**
 * Whether two-step sign-in is compulsory, as one switch both halves of the app
 * read.
 *
 * Two places have to agree on it: `convex/auth.ts`, which stops anyone
 * switching two-step sign-in off while it is compulsory, and `requireAuthUser`
 * in `lib/access.ts`, which refuses every app function to a signed-in account
 * that has not set it up. If they disagreed, one of two things would happen:
 * an account could turn it off and then be locked out of the app with no way
 * back in, or the app would let un-enrolled accounts read everything while the
 * sign-in screen claimed the opposite. Hence one function, here, with no
 * imports — both of those modules load it, and so do the tests.
 *
 * OPTIONAL by default (the owner's call, 2026-09-25): each person chooses to
 * turn it on from Settings → Profile, and once on it is asked for at every
 * sign-in. `AUTH_MFA_REQUIRED=on` makes it compulsory for every account on
 * that deployment — the enrolment gate, the set-up redirect and the refusal
 * to switch it off all come back — without a code change. Any other value,
 * or none, is optional.
 *
 * Read on every call rather than captured at import, so a test can flip it
 * and so nothing depends on the order modules happened to load in.
 */
export function isMfaRequired(): boolean {
  return process.env.AUTH_MFA_REQUIRED === 'on'
}

/**
 * What a signed-in account that has not set up two-step sign-in gets back
 * from every app function outside the enrolment allow-list, while it is
 * compulsory. The client routes on it (to /two-step) rather than showing it,
 * so it is a code, not a sentence.
 */
export const MFA_ENROLMENT_REQUIRED = 'MFA_ENROLMENT_REQUIRED'
