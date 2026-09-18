// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { verifySvix } from './lib/svix'

/**
 * The webhook's only guard.
 *
 * This endpoint is unauthenticated and it writes — a forged bounce would mark
 * a delivered compliance report as never received. The signature is the whole
 * of the security, and it is hand-rolled rather than taken from a library, so
 * the parts that are easy to get wrong are the parts worth testing: the
 * timestamp window in both directions, every offered signature rather than
 * the first, and a wrong secret producing a refusal rather than a pass.
 */

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek'
const BODY = '{"type":"email.bounced","data":{"email_id":"abc"}}'

async function sign(body: string, timestamp: number, secret = SECRET) {
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) =>
      c.charCodeAt(0),
    ),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${ID}.${timestamp}.${body}`),
  )
  let binary = ''
  for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte)
  return `v1,${btoa(binary)}`
}

const now = 1_789_000_000_000
const stamp = Math.floor(now / 1000)

describe('a signed webhook', () => {
  test('is accepted when it is genuine and recent', async () => {
    expect(
      await verifySvix({
        secret: SECRET,
        headers: {
          id: ID,
          timestamp: String(stamp),
          signature: await sign(BODY, stamp),
        },
        body: BODY,
        now,
      }),
    ).toBe(true)
  })

  test('is refused when the body was changed after signing', async () => {
    // The whole attack: a real signature, over a different message.
    expect(
      await verifySvix({
        secret: SECRET,
        headers: {
          id: ID,
          timestamp: String(stamp),
          signature: await sign(BODY, stamp),
        },
        body: '{"type":"email.bounced","data":{"email_id":"someone-elses"}}',
        now,
      }),
    ).toBe(false)
  })

  test('is refused when signed with a different secret', async () => {
    const other = 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    expect(
      await verifySvix({
        secret: SECRET,
        headers: {
          id: ID,
          timestamp: String(stamp),
          signature: await sign(BODY, stamp, other),
        },
        body: BODY,
        now,
      }),
    ).toBe(false)
  })

  test('is refused when it is too old to be anything but a replay', async () => {
    const old = stamp - 600
    expect(
      await verifySvix({
        secret: SECRET,
        headers: {
          id: ID,
          timestamp: String(old),
          signature: await sign(BODY, old),
        },
        body: BODY,
        now,
      }),
    ).toBe(false)
  })

  test('is refused when it claims to be from the future', async () => {
    // Both directions, because a clock that can be pushed forward is a window
    // that can be held open.
    const ahead = stamp + 600
    expect(
      await verifySvix({
        secret: SECRET,
        headers: {
          id: ID,
          timestamp: String(ahead),
          signature: await sign(BODY, ahead),
        },
        body: BODY,
        now,
      }),
    ).toBe(false)
  })

  test('accepts the second signature during a secret rotation', async () => {
    // Svix sends every currently-valid signature, space separated. Checking
    // only the first would refuse half the messages mid-rotation.
    const stale = await sign(
      BODY,
      stamp,
      'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    )
    const good = await sign(BODY, stamp)
    expect(
      await verifySvix({
        secret: SECRET,
        headers: {
          id: ID,
          timestamp: String(stamp),
          signature: `${stale} ${good}`,
        },
        body: BODY,
        now,
      }),
    ).toBe(true)
  })

  test('is refused when a header is missing altogether', async () => {
    expect(
      await verifySvix({
        secret: SECRET,
        headers: { id: null, timestamp: String(stamp), signature: 'v1,x' },
        body: BODY,
        now,
      }),
    ).toBe(false)
  })
})
