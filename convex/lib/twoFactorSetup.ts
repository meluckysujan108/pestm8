/**
 * How far an account's two-step set-up has got, as the set-up screen needs
 * to know it (src/routes/two-step.tsx) — answered by `auth.twoFactorStatus`
 * as `setup`, never with the secret or the recovery codes themselves.
 *
 * Why the screen needs it: every `/two-factor/enable` makes a NEW secret and
 * replaces the account's twoFactor row. The set-up screen used to call it
 * whenever it showed the password step, so anything that showed that step
 * again after the person had already added PestM8 to their authenticator —
 * an iPhone home-screen app reloaded on the way back from the authenticator,
 * a second tap on Start, going back, the Passwords app keeping the first key
 * it was handed — left them with an entry whose codes could never match. In
 * production that was every attempt: "That code did not match", every time.
 * Knowing the row is there, and unproven, lets the screen carry on with the
 * SAME key (`/two-factor/get-totp-uri`) instead of making another.
 *
 * But only the session that made the key may carry on with it. A key nobody
 * has proven yet is just a row with the account's id on it: anyone who
 * signed in with the password alone — a password that got out before the
 * account had two-step sign-in, which is exactly when it matters — can make
 * one. If the real person's screen then carried on with whatever key it
 * found, it would hand them the stranger's key, they would add it and turn
 * it on, and the stranger would hold a working second factor for the
 * account. So every set-up is claimed by the session that made it
 * (`twoStepSetups` in schema.ts, written as `/two-factor/enable` finishes),
 * and only that session is offered it back. An iPhone home-screen app
 * reloaded on the way back from the authenticator keeps its cookie, so it is
 * still the same session; another browser or device is not, and starts again
 * with a new key and a warning to delete the old entry.
 *
 * - `none` — no row. Set-up starts with `/two-factor/enable`.
 * - `unfinished` — a row whose key has never been proven with a code, the
 *   account's flag off, and THIS session made it. Set-up carries on with that
 *   key; making a new one is the person's explicit choice ("Start over with a
 *   new key"), with a warning to delete what they already added.
 * - `elsewhere` — the same, but made by another session (another device,
 *   another browser, or someone else holding the password), or by nobody
 *   the app can name (a row from before claims were kept). Its key is never
 *   shown here; set-up starts again with a new key, warned.
 * - `stale` — a row already marked verified while the flag is off: a turn-off
 *   that failed between its two writes (see `startFromNothing` in
 *   convex/auth.ts). Its codes would never turn the flag on, so it must go
 *   through enable again, which clears it first. Carrying on with it would be
 *   exactly the bug this exists to prevent, the other way round: a right code
 *   that changes nothing.
 * - `on` — the flag is on. The row is not read.
 *
 * `verified === true` is the plugin's own test in `/two-factor/verify-totp`:
 * a row whose `verified` is anything else — false, or missing on a very old
 * row — has the flag turned on by its first right code, so it is
 * `unfinished` (or `elsewhere`). (Sign-in uses `verified !== false`, which
 * only matters once the flag is on, and then the row is not read here.)
 *
 * No imports: the client imports the type and the header, and the tests
 * import the functions.
 */
export type TwoFactorSetupState =
  'none' | 'unfinished' | 'elsewhere' | 'stale' | 'on'

/** Which session made an account's current key, and which row it made. */
export type SetupClaim = { sessionId: string; twoFactorId: string }

/**
 * `row.id` is the twoFactor row's id — `_id` in the component, `id` through
 * Better Auth's adapter; the same string. A claim only counts for the row it
 * was made for: once enable has replaced that row, the old claim names a row
 * that no longer exists and nobody can carry on with the new one on its
 * strength.
 */
export function twoFactorSetupState(
  enabled: boolean,
  row: { id: string; verified?: boolean | null } | null,
  claim: SetupClaim | null,
  sessionId: string | null,
): TwoFactorSetupState {
  if (enabled) return 'on'
  if (row === null) return 'none'
  if (row.verified === true) return 'stale'
  const mine =
    claim !== null &&
    sessionId !== null &&
    claim.sessionId === sessionId &&
    claim.twoFactorId === row.id
  return mine ? 'unfinished' : 'elsewhere'
}

/**
 * The request header that says "replace the key this account already has".
 * `/two-factor/enable` refuses to replace one without it (`startFromNothing`
 * in convex/auth.ts), and the set-up screen only sends it when the amber
 * warning to delete every PestM8 entry is the next thing on screen. So a
 * page that thinks nothing was started — a live query that lost its sign-in
 * and dropped to "none", a phone still running last week's build — cannot
 * rotate a key the person has already added.
 */
export const NEW_KEY_HEADER = 'x-pestm8-new-key'
export const NEW_KEY_HEADER_VALUE = 'replace'

/**
 * Whether an otpauth:// URI carries this raw secret. The plugin stores the
 * raw secret (encrypted) and puts it in the URI base32-encoded, unpadded
 * (RFC 4648, as `@better-auth/utils/otp` does), so the two are compared in
 * that form. Used to be sure the row found after `/two-factor/enable` is the
 * one this request made, and not one a concurrent enable put in its place.
 */
export function otpauthCarriesSecret(
  totpURI: string,
  rawSecret: string,
): boolean {
  let param: string | null
  try {
    param = new URL(totpURI).searchParams.get('secret')
  } catch {
    return false
  }
  if (!param || !rawSecret) return false
  return param.toUpperCase() === base32(new TextEncoder().encode(rawSecret))
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}
