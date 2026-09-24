/**
 * Verifying a Svix-signed webhook, by hand.
 *
 * Resend signs its webhooks with Svix, whose scheme is small enough to
 * implement honestly: HMAC-SHA256 over `${id}.${timestamp}.${body}`, keyed by
 * the base64 secret after its `whsec_` prefix, compared against one or more
 * `v1,<base64>` entries in the `svix-signature` header.
 *
 * Hand-rolled rather than adding the `svix` package because this runs in
 * Convex's default runtime, where Web Crypto is already there and a dependency
 * would be ~200KB to compute one HMAC. The parts that are easy to get wrong —
 * the timestamp window, comparing every offered signature rather than the
 * first, a constant-time compare — are all here and commented, which is the
 * deal one makes by not taking the library.
 */

/** Svix's own tolerance. Outside it, a replayed message is refused. */
const TOLERANCE_MS = 5 * 60 * 1000

export type SvixHeaders = {
  id: string | null
  timestamp: string | null
  signature: string | null
}

export async function verifySvix({
  secret,
  headers,
  body,
  now = Date.now(),
}: {
  /** The `whsec_…` value from the provider's dashboard. */
  secret: string
  headers: SvixHeaders
  body: string
  now?: number
}): Promise<boolean> {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature) return false

  const sentAt = Number(timestamp) * 1000
  if (!Number.isFinite(sentAt)) return false
  // Both directions: a message from the future is as suspicious as an old one.
  if (Math.abs(now - sentAt) > TOLERANCE_MS) return false

  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(secret.replace(/^whsec_/, '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  )
  const expected = bytesToBase64(new Uint8Array(mac))

  // The header carries a space-separated list, because a secret being rotated
  // means two are valid at once. Checking only the first would reject half the
  // messages during a rotation.
  return signature
    .split(' ')
    .filter((entry) => entry.startsWith('v1,'))
    .some((entry) => timingSafeEqual(entry.slice(3), expected))
}

/** Compares in constant time: an early return leaks the signature a byte at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
