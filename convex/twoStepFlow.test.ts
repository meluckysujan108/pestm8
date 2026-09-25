/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { components } from './_generated/api'
import { MAX_TWO_STEP_ATTEMPTS } from './twoStepAttempts'
import { testApp } from '../test/harness'
import { pickAuthCookie } from '../src/lib/authCookies'
import type { TestApp } from '../test/harness'

/**
 * Two-step sign-in end to end, through Better Auth's real HTTP endpoints on
 * this app's real auth config — the plugin, its hooks, the Convex component
 * behind them — rather than through a mock of any of it.
 *
 * This is the test that would have caught the plugin writing columns the
 * component's schema does not have (see `twoStep()` in convex/auth.ts): every
 * set-up failed on a validator error, and nothing short of creating a real
 * twoFactor row notices.
 */

const ORIGIN = 'http://localhost:3000'

beforeEach(() => {
  // A live HTTPS call to Have I Been Pwned per password is not a unit test.
  process.env.AUTH_BREACH_CHECK = 'off'
})
afterEach(() => {
  delete process.env.AUTH_BREACH_CHECK
  delete process.env.AUTH_MFA_REQUIRED
})

/**
 * A browser's cookie jar, as much of one as these endpoints need — behind the
 * app's auth proxy, which passes on ONE Set-Cookie per response
 * (src/routes/api/auth/$.ts). Applying only the cookie the proxy would choose
 * is the point: two-step sign-in writes several per response, and the flow
 * has to work with the one that gets through.
 */
class Browser {
  private jar = new Map<string, string>()
  /** Every Set-Cookie the last response carried, before the proxy chose. */
  sent: Array<string> = []
  private t: TestApp
  constructor(t: TestApp) {
    this.t = t
  }

  async post(path: string, body: unknown) {
    const response = await this.t.fetch(`/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: this.cookieHeader(),
      },
      body: JSON.stringify(body),
    })
    this.sent = response.headers.getSetCookie()
    const kept = pickAuthCookie(this.sent)
    for (const line of kept === null ? [] : [kept]) {
      const [pair, ...attributes] = line.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const expired =
        value === '' || attributes.some((a) => /^\s*max-age=0\s*$/i.test(a))
      if (expired) this.jar.delete(name)
      else this.jar.set(name, value)
    }
    const text = await response.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    return { status: response.status, json: json as Record<string, unknown> }
  }

  has(fragment: string) {
    return [...this.jar.keys()].some((k) => k.includes(fragment))
  }

  /** A cookie's value as the jar holds it (still URL-encoded). */
  value(fragment: string): string | undefined {
    for (const [k, v] of this.jar) if (k.includes(fragment)) return v
    return undefined
  }

  private cookieHeader() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

// RFC 4648 base32, for the secret in an otpauth:// URI.
function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = input.replace(/=+$/, '').toUpperCase()
  const bytes: Array<number> = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    value = (value << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(bytes)
}

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — what an authenticator app shows.
async function totp(uri: string, at = Date.now()): Promise<string> {
  const secret = new URL(uri).searchParams.get('secret') ?? ''
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const counter = Math.floor(at / 1000 / 30)
  const message = new ArrayBuffer(8)
  new DataView(message).setUint32(4, counter)
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  const offset = hmac[hmac.length - 1] & 0x0f
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3]) %
    1_000_000
  return String(code).padStart(6, '0')
}

const PASSWORD = 'correct horse battery staple'

async function signUp(t: TestApp, email: string) {
  const browser = new Browser(t)
  const res = await browser.post('/sign-up/email', {
    name: 'Kevin',
    email,
    password: PASSWORD,
  })
  expect(res.status).toBe(200)
  return browser
}

async function enrol(browser: Browser) {
  const enabled = await browser.post('/two-factor/enable', {
    password: PASSWORD,
  })
  expect(enabled.status).toBe(200)
  const totpURI = enabled.json.totpURI as string
  const backupCodes = enabled.json.backupCodes as Array<string>
  const verified = await browser.post('/two-factor/verify-totp', {
    code: await totp(totpURI),
  })
  expect(verified.status).toBe(200)
  return { totpURI, backupCodes }
}

describe('two-step sign-in, end to end', () => {
  test('set up, then every sign-in asks for a code', async () => {
    const t = testApp()
    const browser = await signUp(t, 'kevin@kevinspest.test')

    const { totpURI, backupCodes } = await enrol(browser)
    expect(totpURI).toMatch(/^otpauth:\/\/totp\/PestM8:/)
    expect(backupCodes).toHaveLength(10)
    for (const code of backupCodes) {
      expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/)
    }

    // A new device: the password alone gets a challenge, not a session.
    const phone = new Browser(t)
    const signIn = await phone.post('/sign-in/email', {
      email: 'kevin@kevinspest.test',
      password: PASSWORD,
    })
    expect(signIn.status).toBe(200)
    expect(signIn.json.twoFactorRedirect).toBe(true)
    expect(phone.has('session_token')).toBe(false)
    // No Convex JWT for a sign-in that has not finished: the two-factor
    // plugin's hook runs before convex's (plugin order in convex/auth.ts),
    // so there is no session left to mint one for. Checked on what the
    // server sent, not the jar — the proxy would drop a JWT cookie anyway.
    expect(phone.sent.some((c) => c.includes('convex_jwt='))).toBe(false)
    // And the session a correct password created is cleared, not handed out.
    expect(phone.sent.some((c) => /session_token=;/.test(c))).toBe(true)
    expect(phone.has('two_factor')).toBe(true)

    const wrong = await phone.post('/two-factor/verify-totp', {
      code: '000000',
    })
    expect(wrong.status).toBe(401)

    const right = await phone.post('/two-factor/verify-totp', {
      code: await totp(totpURI),
    })
    expect(right.status).toBe(200)
    expect(phone.has('session_token')).toBe(true)
  })

  test('a recovery code signs in once, and only once', async () => {
    const t = testApp()
    const browser = await signUp(t, 'priya@example.test')
    const { backupCodes } = await enrol(browser)

    const first = new Browser(t)
    await first.post('/sign-in/email', {
      email: 'priya@example.test',
      password: PASSWORD,
    })
    const used = await first.post('/two-factor/verify-backup-code', {
      code: backupCodes[0],
    })
    expect(used.status).toBe(200)
    expect(first.has('session_token')).toBe(true)

    const second = new Browser(t)
    await second.post('/sign-in/email', {
      email: 'priya@example.test',
      password: PASSWORD,
    })
    const reused = await second.post('/two-factor/verify-backup-code', {
      code: backupCodes[0],
    })
    expect(reused.status).toBe(401)
    expect(second.has('session_token')).toBe(false)
  })

  test('"trust this device" is refused, so no device skips the code', async () => {
    const t = testApp()
    const browser = await signUp(t, 'dev@example.test')
    const { totpURI } = await enrol(browser)

    const phone = new Browser(t)
    await phone.post('/sign-in/email', {
      email: 'dev@example.test',
      password: PASSWORD,
    })
    const trusted = await phone.post('/two-factor/verify-totp', {
      code: await totp(totpURI),
      trustDevice: true,
    })
    expect(trusted.status).toBe(400)
    expect(trusted.json.code).toBe('TRUST_DEVICE_NOT_ALLOWED')
    expect(phone.has('trust_device')).toBe(false)
    expect(phone.has('session_token')).toBe(false)
  })

  test('the account holder can switch it off with their password', async () => {
    const t = testApp()
    const browser = await signUp(t, 'ann@example.test')
    await enrol(browser)

    const wrong = await browser.post('/two-factor/disable', {
      password: 'not-the-password',
    })
    expect(wrong.status).not.toBe(200)

    const disabled = await browser.post('/two-factor/disable', {
      password: PASSWORD,
    })
    expect(disabled.status).toBe(200)

    // Off means off: the next sign-in is the password alone.
    const phone = new Browser(t)
    const signIn = await phone.post('/sign-in/email', {
      email: 'ann@example.test',
      password: PASSWORD,
    })
    expect(signIn.json.twoFactorRedirect).toBeUndefined()
    expect(phone.has('session_token')).toBe(true)
  })

  test('where it is compulsory, nobody can switch it off', async () => {
    process.env.AUTH_MFA_REQUIRED = 'on'
    const t = testApp()
    const browser = await signUp(t, 'ann@example.test')
    await enrol(browser)

    const disabled = await browser.post('/two-factor/disable', {
      password: PASSWORD,
    })
    expect(disabled.status).toBe(403)
    expect(disabled.json.code).toBe('MFA_REQUIRED')
  })

  test('nobody can set it up again over itself', async () => {
    const t = testApp()
    const browser = await signUp(t, 'ann@example.test')
    await enrol(browser)

    const again = await browser.post('/two-factor/enable', {
      password: PASSWORD,
    })
    expect(again.status).toBe(400)
    expect(again.json.code).toBe('MFA_ALREADY_ENABLED')
  })

  test('new recovery codes replace the old ones', async () => {
    const t = testApp()
    const browser = await signUp(t, 'sam@example.test')
    const { backupCodes: old } = await enrol(browser)

    const fresh = await browser.post('/two-factor/generate-backup-codes', {
      password: PASSWORD,
    })
    expect(fresh.status).toBe(200)
    const codes = fresh.json.backupCodes as Array<string>
    expect(codes).toHaveLength(10)

    const phone = new Browser(t)
    await phone.post('/sign-in/email', {
      email: 'sam@example.test',
      password: PASSWORD,
    })
    expect(
      (
        await phone.post('/two-factor/verify-backup-code', {
          code: old[0],
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await phone.post('/two-factor/verify-backup-code', {
          code: codes[0],
        })
      ).status,
    ).toBe(200)
  })

  test('an account that never finished setting up signs in with a password and is sent to set up', async () => {
    const t = testApp()
    const browser = await signUp(t, 'half@example.test')
    // Started, never verified: twoFactorEnabled must still be false.
    await browser.post('/two-factor/enable', { password: PASSWORD })

    const phone = new Browser(t)
    const signIn = await phone.post('/sign-in/email', {
      email: 'half@example.test',
      password: PASSWORD,
    })
    expect(signIn.json.twoFactorRedirect).toBeUndefined()
    expect(phone.has('session_token')).toBe(true)

    const user = await t.run(
      async (ctx): Promise<{ twoFactorEnabled?: boolean | null } | null> =>
        ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'user',
          where: [{ field: 'email', value: 'half@example.test' }],
        }),
    )
    // Not enrolled: where two-step sign-in is compulsory, `requireAuthUser`
    // refuses this session everything and the client sends it to /two-step.
    expect(user?.twoFactorEnabled).not.toBe(true)
  })
})

describe('how long a sign-in lasts', () => {
  const DAY = 24 * 60 * 60 * 1000

  async function expiryOf(t: TestApp, email: string): Promise<number> {
    const userId = await userIdOf(t, email)
    const page = await t.run(
      async (ctx): Promise<{ page: Array<{ expiresAt: number }> }> =>
        ctx.runQuery(components.betterAuth.adapter.findMany, {
          model: 'session',
          where: [{ field: 'userId', value: userId }],
          paginationOpts: { numItems: 10, cursor: null },
        }),
    )
    return Math.max(...page.page.map((s) => s.expiresAt))
  }

  test('a password sign-in lasts until sign-out, not seven days', async () => {
    const t = testApp()
    await signUp(t, 'long@example.test')
    const phone = new Browser(t)
    const signedInAt = Date.now()
    await phone.post('/sign-in/email', {
      email: 'long@example.test',
      password: PASSWORD,
    })
    const left = (await expiryOf(t, 'long@example.test')) - signedInAt
    // 400 days, the longest any browser keeps a cookie (convex/auth.ts).
    expect(left).toBeGreaterThan(399 * DAY)
    expect(left).toBeLessThanOrEqual(400 * DAY + 60_000)
  })

  test('so does a sign-in finished with a code', async () => {
    const t = testApp()
    const browser = await signUp(t, 'coded@example.test')
    const { totpURI } = await enrol(browser)
    const phone = new Browser(t)
    await phone.post('/sign-in/email', {
      email: 'coded@example.test',
      password: PASSWORD,
    })
    const signedInAt = Date.now()
    const verified = await phone.post('/two-factor/verify-totp', {
      code: await totp(totpURI),
    })
    expect(verified.status).toBe(200)
    const left = (await expiryOf(t, 'coded@example.test')) - signedInAt
    expect(left).toBeGreaterThan(399 * DAY)
  })

  test('signing out still ends it', async () => {
    const t = testApp()
    await signUp(t, 'out@example.test')
    const phone = new Browser(t)
    await phone.post('/sign-in/email', {
      email: 'out@example.test',
      password: PASSWORD,
    })
    expect(phone.has('session_token')).toBe(true)
    await phone.post('/sign-out', {})
    const userId = await userIdOf(t, 'out@example.test')
    const left = await sessionTokensOf(t, userId)
    // signUp's own browser is still signed in; the phone's session is gone.
    expect(left).toHaveLength(1)
  })
})

async function userIdOf(t: TestApp, email: string): Promise<string> {
  const user = await t.run(async (ctx): Promise<{ _id: string } | null> =>
    ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'email', value: email }],
    }),
  )
  return user!._id
}

async function sessionTokensOf(
  t: TestApp,
  userId: string,
): Promise<Array<string>> {
  const page = await t.run(
    async (ctx): Promise<{ page: Array<{ token: string }> }> =>
      ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: 'session',
        where: [{ field: 'userId', value: userId }],
        paginationOpts: { numItems: 100, cursor: null },
      }),
  )
  return page.page.map((s) => s.token)
}

describe('sessions that never saw a code', () => {
  test('setting up two-step sign-in signs the account out everywhere else', async () => {
    const t = testApp()
    const email = 'kevin@kevinspest.test'
    // The office PC, signed in with the password before release...
    const officePc = await signUp(t, email)
    // ...and someone else who has the password, signed in while the account
    // was not yet set up — no code was asked of either.
    const stranger = new Browser(t)
    const theirs = await stranger.post('/sign-in/email', {
      email,
      password: PASSWORD,
    })
    expect(theirs.json.twoFactorRedirect).toBeUndefined()
    expect(stranger.has('session_token')).toBe(true)
    const userId = await userIdOf(t, email)
    expect(await sessionTokensOf(t, userId)).toHaveLength(2)

    // The real person sets it up on their phone.
    const phone = new Browser(t)
    await phone.post('/sign-in/email', { email, password: PASSWORD })
    const { totpURI } = await enrol(phone)

    // Only the phone's fresh session is left. `requireAuthUser` reads the
    // session row on every call, so the other two are refused everything.
    const left = await sessionTokensOf(t, userId)
    expect(left).toHaveLength(1)
    expect(decodeURIComponent(phone.value('session_token') ?? '')).toContain(
      left[0],
    )

    // And with the password alone, the stranger cannot read the new secret
    // or mint recovery codes: they have no session left to ask with.
    for (const path of [
      '/two-factor/get-totp-uri',
      '/two-factor/generate-backup-codes',
    ]) {
      const res = await stranger.post(path, { password: PASSWORD })
      expect(res.status).toBe(401)
    }

    // The phone carries on, and a new sign-in on the office PC needs a code.
    const fresh = await phone.post('/two-factor/generate-backup-codes', {
      password: PASSWORD,
    })
    expect(fresh.status).toBe(200)
    const again = await officePc.post('/sign-in/email', {
      email,
      password: PASSWORD,
    })
    expect(again.json.twoFactorRedirect).toBe(true)
    const code = await officePc.post('/two-factor/verify-totp', {
      code: await totp(totpURI),
    })
    expect(code.status).toBe(200)
  })

  test('the set-up key is never shown again once set up', async () => {
    const t = testApp()
    const browser = await signUp(t, 'ann@example.test')
    await enrol(browser)

    const res = await browser.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    expect(res.status).toBe(400)
    expect(res.json.code).toBe('MFA_ALREADY_ENABLED')
  })

  test('the "already set up" check holds for a session sent as a Bearer token', async () => {
    const t = testApp()
    const browser = await signUp(t, 'bea@example.test')
    await enrol(browser)
    const token = browser.value('session_token')
    expect(token).toBeTruthy()

    const bearer = (path: string) =>
      t.fetch(`/api/auth${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ password: PASSWORD }),
      })

    // The control: a Bearer-only request IS signed in here, so the refusal
    // below is the check working, not the request being anonymous.
    expect((await bearer('/two-factor/generate-backup-codes')).status).toBe(200)

    for (const path of ['/two-factor/enable', '/two-factor/get-totp-uri']) {
      const res = await bearer(path)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code?: string }).code).toBe(
        'MFA_ALREADY_ENABLED',
      )
    }
  })
})

describe('the per-account cap on codes', () => {
  async function wrongCodes(t: TestApp, email: string, count: number) {
    const browser = new Browser(t)
    await browser.post('/sign-in/email', { email, password: PASSWORD })
    for (let i = 0; i < count; i++) {
      const res = await browser.post('/two-factor/verify-totp', {
        code: '000000',
      })
      expect(res.status).toBe(401)
    }
  }

  test('ten wrong codes over any number of sign-ins lock the code check', async () => {
    const t = testApp()
    const email = 'sam@example.test'
    const { totpURI } = await enrol(await signUp(t, email))
    expect(MAX_TWO_STEP_ATTEMPTS).toBe(10)

    // Five per sign-in is the plugin's own limit; a new sign-in is cheap.
    await wrongCodes(t, email, 5)
    await wrongCodes(t, email, 5)

    const phone = new Browser(t)
    await phone.post('/sign-in/email', { email, password: PASSWORD })
    const locked = await phone.post('/two-factor/verify-totp', {
      code: await totp(totpURI),
    })
    expect(locked.status).toBe(429)
    expect(locked.json.code).toBe('TWO_STEP_LOCKED')
    expect(phone.has('session_token')).toBe(false)
    // Recovery codes share the budget.
    const recovery = await phone.post('/two-factor/verify-backup-code', {
      code: 'aaaaa-aaaaa',
    })
    expect(recovery.status).toBe(429)

    // Fifteen minutes later — moved rather than waited for.
    const userId = await userIdOf(t, email)
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('twoStepAttempts')
        .withIndex('by_userId', (q) => q.eq('userId', userId))
        .unique()
      await ctx.db.patch(row!._id, { lockedUntil: Date.now() - 1 })
    })
    const later = new Browser(t)
    await later.post('/sign-in/email', { email, password: PASSWORD })
    const right = await later.post('/two-factor/verify-totp', {
      code: await totp(totpURI),
    })
    expect(right.status).toBe(200)
  })

  test('a right code starts the count again', async () => {
    const t = testApp()
    const email = 'priya@example.test'
    const { totpURI } = await enrol(await signUp(t, email))

    await wrongCodes(t, email, 5)
    await wrongCodes(t, email, 4)
    const phone = new Browser(t)
    await phone.post('/sign-in/email', { email, password: PASSWORD })
    expect(
      (
        await phone.post('/two-factor/verify-totp', {
          code: await totp(totpURI),
        })
      ).status,
    ).toBe(200)

    const userId = await userIdOf(t, email)
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('twoStepAttempts')
        .withIndex('by_userId', (q) => q.eq('userId', userId))
        .unique(),
    )
    expect(row).toBeNull()
  })
})
