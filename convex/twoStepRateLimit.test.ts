/// <reference types="vite/client" />
import { afterAll, describe, expect, test, vi } from 'vitest'
import { testApp } from '../test/harness'
import { AuthBrowser, totp } from '../test/authBrowser'
import type { TestApp } from '../test/harness'

/**
 * The rate limit a person meets while typing six-digit codes (the
 * `/two-factor/verify-totp` rule in convex/auth.ts has the why).
 *
 * A file of its own because the switch is read once, when convex/auth.ts is
 * first loaded (`AUTH_RATE_LIMIT`), and every other flow test depends on it
 * being off: they call get-totp-uri and enable back to back far faster than
 * three per ten seconds. Each test file loads its modules afresh, so setting
 * it here — before anything has loaded the auth config — turns it on for
 * this file alone. Every test builds its own deployment, so each starts with
 * empty buckets; every request comes from one test "IP", as it would from
 * one phone.
 */
vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT = 'on'
  // A live HTTPS call to Have I Been Pwned per password is not a unit test.
  process.env.AUTH_BREACH_CHECK = 'off'
})
afterAll(() => {
  delete process.env.AUTH_RATE_LIMIT
  delete process.env.AUTH_BREACH_CHECK
})

const PASSWORD = 'correct horse battery staple'

function browserOn(t: TestApp) {
  return new AuthBrowser((path, init) => t.fetch(`/api/auth${path}`, init))
}

async function signUp(t: TestApp, email: string) {
  const browser = browserOn(t)
  const res = await browser.post('/sign-up/email', {
    name: 'Kevin',
    email,
    password: PASSWORD,
  })
  expect(res.status).toBe(200)
  return browser
}

/** A code that is certainly wrong: none of the three the server accepts
 * around now (the ±30 s window), so no run can flake on a lucky guess. */
async function wrongCodeFor(uri: string): Promise<string> {
  const now = Date.now()
  const live = new Set(
    await Promise.all([-30_000, 0, 30_000].map((d) => totp(uri, now + d))),
  )
  return ['000000', '111111', '222222', '333333'].find((c) => !live.has(c))!
}

describe('the rate limit on six-digit codes', () => {
  test('a slipping thumb at set-up gets ten tries, not three', async () => {
    const t = testApp()
    const browser = await signUp(t, 'thumbs@example.test')
    const enabled = await browser.post('/two-factor/enable', {
      password: PASSWORD,
    })
    expect(enabled.status).toBe(200)
    const uri = enabled.json.totpURI as string
    const wrong = await wrongCodeFor(uri)

    // Typed one after another, each within seconds of the last: the
    // plugin's own rule answered the fourth with "Too many tries".
    for (let i = 0; i < 10; i++) {
      const res = await browser.post('/two-factor/verify-totp', {
        code: wrong,
      })
      expect(res.status).toBe(401)
      expect(res.json.code).toBe('INVALID_CODE')
    }

    // The eleventh is the limit — even a right one.
    const limited = await browser.post('/two-factor/verify-totp', {
      code: await totp(uri),
    })
    expect(limited.status).toBe(429)

    // A minute on, it goes through. Moved rather than waited for.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 61_000)
      const right = await browser.post('/two-factor/verify-totp', {
        code: await totp(uri),
      })
      expect(right.status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  test("at sign-in, the app's own worded limit speaks first", async () => {
    const t = testApp()
    const email = 'signin@example.test'
    const owner = await signUp(t, email)
    const uri = (await owner.post('/two-factor/enable', { password: PASSWORD }))
      .json.totpURI as string
    expect(
      (await owner.post('/two-factor/verify-totp', { code: await totp(uri) }))
        .status,
    ).toBe(200)
    const wrong = await wrongCodeFor(uri)

    const phone = browserOn(t)
    const challenge = await phone.post('/sign-in/email', {
      email,
      password: PASSWORD,
    })
    expect(challenge.json.twoFactorRedirect).toBe(true)
    for (let i = 0; i < 5; i++) {
      const res = await phone.post('/two-factor/verify-totp', { code: wrong })
      expect(res.status).toBe(401)
    }
    // Five per password sign-in (the plugin's per-challenge count), and the
    // screen says to enter the password again — not "Too many tries".
    const sixth = await phone.post('/two-factor/verify-totp', { code: wrong })
    expect(sixth.status).not.toBe(429)
    expect(sixth.json.code).toBe('TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE')
  })

  test("the other two-step endpoints keep the plugin's own limit", async () => {
    // The custom rule is for this one path, not a wildcard over
    // `/two-factor/*`: the key is still only given out three times in ten
    // seconds.
    const t = testApp()
    const browser = await signUp(t, 'key@example.test')
    expect(
      (await browser.post('/two-factor/enable', { password: PASSWORD })).status,
    ).toBe(200)
    for (let i = 0; i < 3; i++) {
      const res = await browser.post('/two-factor/get-totp-uri', {
        password: PASSWORD,
      })
      expect(res.status).toBe(200)
    }
    const fourth = await browser.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    expect(fourth.status).toBe(429)
  })
})
