import { maskEmail } from '../../convex/lib/inviteTokens'

/**
 * Whether an address could be the one an invitation was sent to, judged by
 * the masked hint (`a****@jospest.com.au`) — the only form of the address
 * that ever leaves the server (`maskEmail`).
 *
 * The mask is worked out from the address alone, so an address whose mask
 * differs cannot be the invited one: the server would refuse it, at sign-up
 * (`INVITE_EMAIL_MISMATCH`, convex/auth.ts) and at accepting alike. Asking
 * here means the invite pages can say so before anything is sent — the
 * usual cause is an autofilled everyday address, or a browser still signed
 * in to another account. A match proves nothing, and nothing here relies on
 * it; the server's check is the one that counts.
 *
 * No hint (a used business link names no address) is no evidence either way.
 */
export function couldBeInvitee(email: string, emailHint: string): boolean {
  if (!emailHint) return true
  return maskEmail(email.trim().toLowerCase()) === emailHint
}
