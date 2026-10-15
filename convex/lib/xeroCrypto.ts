/**
 * Xero token encryption: AES-256-GCM over Web Crypto.
 *
 * ACTIONS ONLY, like lib/inviteTokens.ts. Convex mutations run
 * deterministically (their randomness is seeded so a retried transaction
 * replays identically), and GCM under one key must never see the same IV
 * twice: a repeated IV gives away the XOR of the two tokens and the key that
 * authenticates them. Keeping both directions in actions also means no query
 * can ever hold a plaintext token to return by mistake — the ciphertexts sit
 * on `xeroGrants`, and only an action that is about to call Xero opens one.
 *
 * Xero's developer terms ask for exactly this: refresh tokens encrypted at
 * rest, with the key kept apart from the data. `XERO_TOKEN_KEYS` is its own
 * variable rather than derived from `BETTER_AUTH_SECRET`, so rotating one
 * never strands the other. Lose it and every Xero connection has to be made
 * again (the connections themselves survive); docs/xero.md says to keep a
 * copy in a password manager.
 *
 * A cipher string is `x1.<keyVersion>.<iv>.<ciphertext+tag>`, base64url. The
 * version names the key that sealed it, so `XERO_TOKEN_KEYS="2:<new>,1:<old>"`
 * can introduce a key without breaking what the old one sealed: the first
 * entry seals everything new, and an old token is re-sealed under it on its
 * next refresh: within half an hour for a grant in use, within 31 days for an
 * idle one (convex/xeroTokens.ts `keepAlive` refreshes anything untouched for
 * 30). Drop the old key only once that has passed.
 *
 * The AAD ties a cipher to its slot: an access token's cannot be passed off
 * as the refresh token, or as another Xero user's, even by someone who can
 * write to the table.
 */
import { ConvexError } from 'convex/values'
import { base64UrlToBytes, bytesToBase64Url } from './base64'

const FORMAT = 'x1'
const IV_BYTES = 12
const KEY_BYTES = 32

type TokenKey = { version: number; raw: Uint8Array<ArrayBuffer> }

/** AAD for an access token held for this Xero user. */
export const accessAad = (xeroUserId: string) => `access:${xeroUserId}`
/** AAD for a refresh token held for this Xero user. */
export const refreshAad = (xeroUserId: string) => `refresh:${xeroUserId}`

/**
 * The key versions `XERO_TOKEN_KEYS` holds, in the order it lists them (the
 * first seals new tokens). Read on every call rather than at module load, so
 * a deployment without Xero still loads (lib/xeroConfig.ts).
 */
export function tokenKeyVersions(): number[] {
  return tokenKeys().map((key) => key.version)
}

/**
 * `XERO_TOKEN_KEYS` parsed: `<version>:<base64 of 32 bytes>`, comma-separated.
 *
 * Anything else is XERO_KEYS_INVALID, and the error never carries the value:
 * it is a secret, and error text reaches logs.
 */
function tokenKeys(): TokenKey[] {
  const invalid = () => new ConvexError('XERO_KEYS_INVALID')
  const entries = (process.env.XERO_TOKEN_KEYS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (entries.length === 0) throw invalid()

  const seen = new Set<number>()
  return entries.map((entry) => {
    const colon = entry.indexOf(':')
    const versionText = entry.slice(0, colon).trim()
    if (colon < 1 || !/^[1-9]\d{0,8}$/.test(versionText)) throw invalid()
    const version = Number(versionText)
    if (seen.has(version)) throw invalid()
    seen.add(version)

    let raw: Uint8Array<ArrayBuffer>
    try {
      raw = base64UrlToBytes(entry.slice(colon + 1).trim())
    } catch {
      throw invalid()
    }
    if (raw.length !== KEY_BYTES) throw invalid()
    return { version, raw }
  })
}

function importKey(key: TokenKey, use: 'encrypt' | 'decrypt') {
  return crypto.subtle.importKey('raw', key.raw, 'AES-GCM', false, [use])
}

/** Seals a token under the newest key, with a fresh random IV. */
export async function encryptToken(
  plain: string,
  aad: string,
): Promise<string> {
  const [key] = tokenKeys()
  const iv = new Uint8Array(IV_BYTES)
  crypto.getRandomValues(iv)
  const sealed = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(aad),
      tagLength: 128,
    },
    await importKey(key, 'encrypt'),
    new TextEncoder().encode(plain),
  )
  return [
    FORMAT,
    key.version,
    bytesToBase64Url(iv),
    bytesToBase64Url(new Uint8Array(sealed)),
  ].join('.')
}

/**
 * Opens a token sealed by `encryptToken` under the same AAD.
 *
 * Every way it can fail to open — altered, cut short, sealed for another slot
 * or user, under a key no longer listed — is one code, XERO_TOKEN_UNREADABLE:
 * the caller cannot do anything different about any of them, and saying which
 * would only help someone probing. A malformed `XERO_TOKEN_KEYS` is the
 * exception (XERO_KEYS_INVALID), because that one is ours to fix.
 */
export async function decryptToken(
  cipher: string,
  aad: string,
): Promise<string> {
  const keys = tokenKeys()
  const unreadable = () => new ConvexError('XERO_TOKEN_UNREADABLE')

  const parts = cipher.split('.')
  if (parts.length !== 4 || parts[0] !== FORMAT) throw unreadable()
  const [, versionText, ivText, sealedText] = parts
  const key = /^\d+$/.test(versionText)
    ? keys.find((k) => k.version === Number(versionText))
    : undefined
  if (!key) throw unreadable()

  try {
    const iv = base64UrlToBytes(ivText)
    if (iv.length !== IV_BYTES) throw unreadable()
    const opened = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(aad),
        tagLength: 128,
      },
      await importKey(key, 'decrypt'),
      base64UrlToBytes(sealedText),
    )
    return new TextDecoder('utf-8', { fatal: true }).decode(opened)
  } catch {
    throw unreadable()
  }
}
