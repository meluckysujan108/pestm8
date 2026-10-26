/**
 * The claims of a JWT, read without checking its signature, or null when it
 * cannot be read.
 *
 * Only for decisions the phone makes about its own copy of a token — whose
 * files to show, which of two tokens runs out later. The server checks every
 * token properly on every request.
 */
export function jwtClaims(jwt: string | null | undefined): {
  sub?: unknown
  exp?: unknown
  iat?: unknown
  /** The person's name, as Better Auth's Convex plugin puts the user in. */
  name?: unknown
  /** Their Better Auth session's id, which that plugin adds to every token. */
  sessionId?: unknown
} | null {
  const payload = jwt?.split('.')[1]
  if (!payload) return null
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const claims: unknown = JSON.parse(atob(padded))
    return typeof claims === 'object' && claims !== null ? claims : null
  } catch {
    return null
  }
}

/** When a JWT runs out, in seconds since the epoch, or null. */
export function expiryOfToken(jwt: string | null | undefined): number | null {
  return seconds(jwtClaims(jwt)?.exp)
}

/** When a JWT was issued, in seconds since the epoch, or null. */
export function issueOfToken(jwt: string | null | undefined): number | null {
  return seconds(jwtClaims(jwt)?.iat)
}

function seconds(claim: unknown): number | null {
  return typeof claim === 'number' && Number.isFinite(claim) ? claim : null
}
