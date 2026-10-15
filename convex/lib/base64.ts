/**
 * Bytes to base64 and back, in both alphabets.
 *
 * Plain `btoa`/`atob` over a binary string, because that is what every
 * runtime PestM8's Convex code meets has (the default Convex runtime, the
 * edge-runtime the tests run in) — `Buffer` is Node's, and no file here is
 * `"use node"`. Pure, so it runs in queries, mutations and actions alike.
 *
 * The URL-safe alphabet is what goes in a cipher string or a JWT
 * (lib/xeroCrypto.ts, lib/xeroHttp.ts); the standard one is what
 * `openssl rand -base64 32` prints for a key and what HTTP Basic auth takes.
 *
 * The decoders return `Uint8Array<ArrayBuffer>` rather than the wider
 * `Uint8Array`: Web Crypto only takes a view over a plain `ArrayBuffer`, and
 * every decoded key, IV and ciphertext goes straight into it.
 */

/** Standard base64, `=`-padded. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** URL-safe base64 (`-` and `_`), unpadded: safe in a URL, a cookie, or a
 * dot-separated string without escaping. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Standard base64 to bytes. Throws on anything that is not base64. */
export function base64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const binary = atob(s)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * URL-safe base64 to bytes. Also takes the standard alphabet and `=` padding,
 * so one reader serves a JWT segment and a key pasted from `openssl` alike.
 * Throws on anything that is not base64 in either alphabet.
 */
export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const standard = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (standard.length % 4 === 1) throw new Error('Not base64')
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4)
  return base64ToBytes(padded)
}
