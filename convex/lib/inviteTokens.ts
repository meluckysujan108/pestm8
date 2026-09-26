/**
 * Invite-link tokens.
 *
 * Both functions use Web Crypto, which is why every caller is an ACTION.
 * Convex mutations run deterministically (`Math.random` is seeded so a retried
 * transaction replays identically), so a token minted in a mutation would not
 * be trustworthy randomness. Hashing is kept on the same side of the fence for
 * the same reason it is kept out of the database: nothing that reads a row
 * should be able to derive a working link.
 *
 * The atomic part — "this token has not been used before" — still happens in a
 * mutation. The action only turns a token into a hash before handing it over.
 */

/** 32 bytes, base64url. ~256 bits, so guessing is not a threat model. */
export function newInviteToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

/** SHA-256, hex. Only this value is ever stored. */
export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  )
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export type InviteState =
  'valid' | 'claimed' | 'revoked' | 'expired' | 'legacy' | 'invalid'

/**
 * One rule, used by preview, redeem and the owner's pending list, so a link
 * can never read as valid in one place and dead in another.
 *
 * `legacy` is a row created before token invites existed: it has no hash, so
 * there is no link that opens it. Those are retired by the migration rather
 * than left to look like live invitations.
 *
 * Used and withdrawn come first, before `legacy`. An old invitation someone
 * already joined through is `claimed`, like any other: asked the other way
 * round it read as `legacy`, so the pending list (which keeps `legacy` rows
 * for "create a new link") showed people who had joined, and "New link" on
 * them failed with ALREADY_MEMBER. Withdrawing one never took it off the list
 * either, for the same reason.
 */
export function inviteState(
  invitation:
    | {
        tokenHash?: string
        claimedAt?: number
        revokedAt?: number
        expiresAt?: number
      }
    | null
    | undefined,
  now: number,
): InviteState {
  if (!invitation) return 'invalid'
  if (invitation.claimedAt !== undefined) return 'claimed'
  if (invitation.revokedAt !== undefined) return 'revoked'
  if (!invitation.tokenHash) return 'legacy'
  if (invitation.expiresAt !== undefined && invitation.expiresAt <= now) {
    return 'expired'
  }
  return 'valid'
}

/** How long a link stays live. Long enough to reach someone on a job, short
 * enough that a forwarded text does not stay dangerous for a month. */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000

/** `k***@gmail.com` — enough for the invitee to recognise their own address
 * without publishing it to whoever opened the link. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!domain) return '***'
  const head = local.slice(0, 1)
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`
}
