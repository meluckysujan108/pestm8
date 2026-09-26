/**
 * Whether this deployment is invitation-only (README: `AUTH_INVITE_ONLY`).
 *
 * The same switch `convex/auth.ts` reads for sign-up, read here at call time
 * for the app's side of it: with it on, only an account holding a claimed
 * "start a business" link may create a business (`businessInvites`). With it
 * off — dev and e2e, whose suites create businesses by the hundred — anyone
 * signed in may, as before.
 */
export function isInviteOnly(): boolean {
  return process.env.AUTH_INVITE_ONLY === 'on'
}
