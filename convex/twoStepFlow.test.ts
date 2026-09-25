/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, components } from './_generated/api'
import {
  NEW_KEY_HEADER,
  NEW_KEY_HEADER_VALUE,
  otpauthCarriesSecret,
  twoFactorSetupState,
} from './lib/twoFactorSetup'
import { MAX_TWO_STEP_ATTEMPTS } from './twoStepAttempts'
import { isSignInLost } from '../src/lib/twoStep'
import { testApp } from '../test/harness'
import { AuthBrowser, secretOf, totp } from '../test/authBrowser'
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
 * A browser behind the app's auth proxy, and the authenticator app's codes
 * (test/authBrowser.ts — shared with Playwright, so the two can never
 * disagree about what a code is or which cookie gets through the proxy),
 * talking to this test deployment.
 */
function browserOn(t: TestApp) {
  return new AuthBrowser((path, init) => t.fetch(`/api/auth${path}`, init))
}

const PASSWORD = 'correct horse battery staple'

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

/**
 * "Replace the key this account already has." Only the set-up screen's
 * new-key paths send it, and only with the amber warning to delete every
 * PestM8 entry on screen (`NEW_KEY_HEADER` in convex/lib/twoFactorSetup.ts).
 */
const NEW_KEY = { [NEW_KEY_HEADER]: NEW_KEY_HEADER_VALUE }

async function enrol(browser: AuthBrowser, headers?: Record<string, string>) {
  const enabled = await browser.post(
    '/two-factor/enable',
    { password: PASSWORD },
    headers,
  )
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
    const phone = browserOn(t)
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

    const first = browserOn(t)
    await first.post('/sign-in/email', {
      email: 'priya@example.test',
      password: PASSWORD,
    })
    const used = await first.post('/two-factor/verify-backup-code', {
      code: backupCodes[0],
    })
    expect(used.status).toBe(200)
    expect(first.has('session_token')).toBe(true)

    const second = browserOn(t)
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

    const phone = browserOn(t)
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
    const phone = browserOn(t)
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

  test('a turn-off that failed half-way does not stop it being turned on again', async () => {
    const t = testApp()
    const browser = await signUp(t, 'half-off@example.test')
    await enrol(browser)
    // What a disable that died between its two writes leaves: the flag off,
    // the verified row still there.
    const userId = await userIdOf(t, 'half-off@example.test')
    await t.run(async (ctx) => {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: 'user',
          where: [{ field: '_id', value: userId }],
          update: { twoFactorEnabled: false },
        },
      })
    })

    // Setting up again must take: the new code turns it on. (Over a key
    // that is already there, enable is only ever asked on purpose.)
    const phone = browserOn(t)
    await phone.post('/sign-in/email', {
      email: 'half-off@example.test',
      password: PASSWORD,
    })
    await enrol(phone, NEW_KEY)
    const user = await t.run(
      async (ctx): Promise<{ twoFactorEnabled?: boolean | null } | null> =>
        ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'user',
          where: [{ field: '_id', value: userId }],
        }),
    )
    expect(user?.twoFactorEnabled).toBe(true)
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

    const phone = browserOn(t)
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

  test('an account that never finished setting up signs in with its password alone', async () => {
    const t = testApp()
    const browser = await signUp(t, 'half@example.test')
    // Started, never verified: twoFactorEnabled must still be false.
    await browser.post('/two-factor/enable', { password: PASSWORD })

    const phone = browserOn(t)
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
    const phone = browserOn(t)
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
    const phone = browserOn(t)
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

  test('a cold open renews it where the browser keeps the cookie', async () => {
    const t = testApp()
    await signUp(t, 'renew@example.test')
    const phone = browserOn(t)
    await phone.post('/sign-in/email', {
      email: 'renew@example.test',
      password: PASSWORD,
    })
    const before = await expiryOf(t, 'renew@example.test')

    // Two days on: renewal is due (updateAge is one day).
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 2 * DAY)

      // Server rendering fetches a token first, and its Set-Cookie is thrown
      // away (src/lib/initialState.ts). It must not renew the session — if it
      // did, the browser's own request below would find nothing due, and the
      // cookie would still run out 400 days after sign-in.
      const ssr = await phone.serverSide('/convex/token')
      expect(ssr.some((c) => c.includes('session_token'))).toBe(false)
      expect(await expiryOf(t, 'renew@example.test')).toBe(before)

      // The browser's session check, through the proxy, renews it — row and
      // cookie together.
      const checked = await phone.get('/get-session')
      expect(checked.status).toBe(200)
      const renewed = phone.sent.find((c) => c.includes('session_token'))
      expect(renewed).toMatch(/max-age=34560000/i)
      expect(await expiryOf(t, 'renew@example.test')).toBeGreaterThan(
        before + DAY,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  test('signing out still ends it', async () => {
    const t = testApp()
    await signUp(t, 'out@example.test')
    const phone = browserOn(t)
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
    const stranger = browserOn(t)
    const theirs = await stranger.post('/sign-in/email', {
      email,
      password: PASSWORD,
    })
    expect(theirs.json.twoFactorRedirect).toBeUndefined()
    expect(stranger.has('session_token')).toBe(true)
    const userId = await userIdOf(t, email)
    expect(await sessionTokensOf(t, userId)).toHaveLength(2)

    // The real person sets it up on their phone.
    const phone = browserOn(t)
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
    const { totpURI } = await enrol(browser)
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

    // And a set-up code sent that way, once it is on.
    const code = await t.fetch('/api/auth/two-factor/verify-totp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code: await totp(totpURI) }),
    })
    expect(code.status).toBe(400)
    expect(((await code.json()) as { code?: string }).code).toBe(
      'MFA_ALREADY_ENABLED',
    )
  })
})

describe('the per-account cap on codes', () => {
  async function wrongCodes(t: TestApp, email: string, count: number) {
    const browser = browserOn(t)
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

    const phone = browserOn(t)
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
    const later = browserOn(t)
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
    const phone = browserOn(t)
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

/**
 * The query the set-up screen routes on, asked as whoever this browser's
 * session cookie belongs to — the same session the HTTP endpoints above act
 * on, so the two can be checked against each other. Signed out when the jar
 * holds no live session.
 */
async function statusOf(t: TestApp, browser: AuthBrowser) {
  const token = decodeURIComponent(browser.value('session_token') ?? '').split(
    '.',
  )[0]
  const session = await t.run(
    async (ctx): Promise<{ _id: string; userId: string } | null> =>
      ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'session',
        where: [{ field: 'token', value: token }],
      }),
  )
  const as = session
    ? t.withIdentity({ subject: session.userId, sessionId: session._id })
    : t
  return as.query(api.auth.twoFactorStatus, {})
}

/** Flip the account's flag directly: what a turn-off that died between its
 * two writes leaves (see `startFromNothing` in convex/auth.ts). */
async function halfTurnOff(t: TestApp, email: string) {
  const userId = await userIdOf(t, email)
  await t.run(async (ctx) => {
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'user',
        where: [{ field: '_id', value: userId }],
        update: { twoFactorEnabled: false },
      },
    })
  })
}

/**
 * The production bug: the owner entered the code their authenticator showed
 * and got "That code did not match", every time. Every `/two-factor/enable`
 * makes a new secret, and the set-up screen called it whenever its password
 * step came round again — an iPhone home-screen app reloaded on the way back
 * from the authenticator, a second tap on Start — so the entry already added
 * was dead before its first code was typed. The screen now asks how far
 * set-up has got and carries on with the same key (src/routes/two-step.tsx),
 * and the server refuses to replace a key nobody asked to replace.
 */
describe('carrying on with a set-up that was started', () => {
  test('the set-up state follows the account and the session, and never carries the key', async () => {
    const t = testApp()
    const email = 'state@example.test'
    const browser = await signUp(t, email)

    expect(await t.query(api.auth.twoFactorStatus, {})).toMatchObject({
      signedIn: false,
      setup: 'none',
    })
    expect((await statusOf(t, browser)).setup).toBe('none')

    const enabled = await browser.post('/two-factor/enable', {
      password: PASSWORD,
    })
    const totpURI = enabled.json.totpURI as string
    const backupCodes = enabled.json.backupCodes as Array<string>
    const unfinished = await statusOf(t, browser)
    expect(unfinished).toEqual({
      signedIn: true,
      required: false,
      enabled: false,
      setup: 'unfinished',
    })

    // The same account on another device: the set-up is not its to carry on
    // with, and it is told so without being told the key.
    const phone = browserOn(t)
    await phone.post('/sign-in/email', { email, password: PASSWORD })
    const elsewhere = await statusOf(t, phone)
    expect(elsewhere).toMatchObject({ signedIn: true, setup: 'elsewhere' })

    // Nothing of the row but the word: not the secret in either form, not a
    // recovery code, not the encrypted columns, not the claim's ids.
    for (const said of [unfinished, elsewhere].map((s) => JSON.stringify(s))) {
      expect(said).not.toContain(secretOf(totpURI))
      for (const code of backupCodes) expect(said).not.toContain(code)
      expect(said).not.toMatch(/secret|backupCodes|otpauth|sessionId/i)
    }

    await browser.post('/two-factor/verify-totp', { code: await totp(totpURI) })
    // The code replaced the session; asked with the new one, it is on.
    expect(await statusOf(t, browser)).toMatchObject({
      enabled: true,
      setup: 'on',
    })

    await halfTurnOff(t, email)
    const stale = await statusOf(t, browser)
    expect(stale).toMatchObject({ enabled: false, setup: 'stale' })
    expect(JSON.stringify(stale)).not.toContain(secretOf(totpURI))
  })

  test('the key is the same one, and its code turns two-step sign-in on', async () => {
    const t = testApp()
    const email = 'resume@example.test'
    const browser = await signUp(t, email)
    const started = await browser.post('/two-factor/enable', {
      password: PASSWORD,
    })
    const first = started.json.totpURI as string
    const unseen = started.json.backupCodes as Array<string>

    // The page reloads; the person comes back with PestM8 already in their
    // authenticator. The password is still what unlocks the key.
    const wrong = await browser.post('/two-factor/get-totp-uri', {
      password: 'not-the-password',
    })
    expect(wrong.status).toBe(400)
    expect(wrong.json.code).toBe('INVALID_PASSWORD')

    const again = await browser.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    expect(again.status).toBe(200)
    const resumed = again.json.totpURI as string
    expect(secretOf(resumed)).toBe(secretOf(first))
    expect(resumed).toBe(first)
    expect((await statusOf(t, browser)).setup).toBe('unfinished')

    // The code their existing entry shows — computed from the key as shown
    // the SECOND time — is right, at set-up.
    const verified = await browser.post('/two-factor/verify-totp', {
      code: await totp(resumed),
    })
    expect(verified.status).toBe(200)
    expect(await statusOf(t, browser)).toMatchObject({ setup: 'on' })

    // The screen makes the recovery codes after the code, whichever way the
    // key came (enable's are never shown) — on the session the code just
    // replaced, which is the cookie the browser now holds.
    const made = await browser.post('/two-factor/generate-backup-codes', {
      password: PASSWORD,
    })
    expect(made.status).toBe(200)
    const codes = made.json.backupCodes as Array<string>
    expect(codes).toHaveLength(10)

    // Those are the codes that sign in; the unseen ones from enable are not.
    const phone = browserOn(t)
    await phone.post('/sign-in/email', { email, password: PASSWORD })
    expect(
      (await phone.post('/two-factor/verify-backup-code', { code: unseen[0] }))
        .status,
    ).toBe(401)
    const recovered = await phone.post('/two-factor/verify-backup-code', {
      code: codes[0],
    })
    expect(recovered.status).toBe(200)
    expect(phone.has('session_token')).toBe(true)

    // And the authenticator entry added from the first showing signs in.
    const laptop = browserOn(t)
    await laptop.post('/sign-in/email', { email, password: PASSWORD })
    const coded = await laptop.post('/two-factor/verify-totp', {
      code: await totp(first),
    })
    expect(coded.status).toBe(200)
  })

  test('a second enable is refused, unless it asks for a new key', async () => {
    // What the owner's phone was left holding: a second enable made a new
    // key, and the entry from the first never matched. The screen no longer
    // calls enable to carry on — and the server no longer lets anything
    // replace a key by accident (a page whose live state dropped to "none",
    // a phone still running an older build).
    const t = testApp()
    const browser = await signUp(t, 'twice@example.test')
    const first = (
      await browser.post('/two-factor/enable', { password: PASSWORD })
    ).json.totpURI as string

    const bare = await browser.post('/two-factor/enable', {
      password: PASSWORD,
    })
    expect(bare.status).toBe(409)
    expect(bare.json.code).toBe('MFA_SETUP_STARTED')
    expect(bare.json.totpURI).toBeUndefined()
    const kept = await browser.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    expect(secretOf(kept.json.totpURI as string)).toBe(secretOf(first))

    // Asked for on purpose: a new key, still this session's to carry on
    // with, and the first one's codes are dead.
    const second = (
      await browser.post('/two-factor/enable', { password: PASSWORD }, NEW_KEY)
    ).json.totpURI as string
    expect(secretOf(second)).not.toBe(secretOf(first))
    expect((await statusOf(t, browser)).setup).toBe('unfinished')

    const dead = await browser.post('/two-factor/verify-totp', {
      code: await totp(first),
    })
    expect(dead.status).toBe(401)
    expect(dead.json.code).toBe('INVALID_CODE')

    // Carrying on from here shows the LIVE key — the one to add again.
    const shown = (
      await browser.post('/two-factor/get-totp-uri', { password: PASSWORD })
    ).json.totpURI as string
    expect(secretOf(shown)).toBe(secretOf(second))
    const live = await browser.post('/two-factor/verify-totp', {
      code: await totp(shown),
    })
    expect(live.status).toBe(200)
    expect((await statusOf(t, browser)).setup).toBe('on')
  })

  test('the set-up screen already live, which knows none of this, is told what to do in words that hold for it', async () => {
    // The screen on main before this change: Start is a bare enable (no
    // new-key header), it never reads `setup`, and it shows a coded
    // refusal's own message (describeTwoFactorError's default branch — a
    // code, a status under 500). That is what someone who already started
    // sees in the minutes between this backend deploying and the new screen
    // being served, or on a phone still holding the old build. It cannot
    // carry on with a key — its only move is Start, which lands here again —
    // so the words must not promise that, and pressing it again must change
    // nothing.
    const t = testApp()
    const browser = await signUp(t, 'old-screen@example.test')
    const first = (
      await browser.post('/two-factor/enable', { password: PASSWORD })
    ).json.totpURI as string

    for (let i = 0; i < 2; i++) {
      const refused = await browser.post('/two-factor/enable', {
        password: PASSWORD,
      })
      expect(refused.status).toBe(409)
      expect(refused.json.code).toBe('MFA_SETUP_STARTED')
      const words = refused.json.message as string
      expect(words).not.toMatch(/MFA_|TOTP|CONFLICT/)
      expect(words).toMatch(/nothing has been changed/)
      expect(words).toMatch(/Reload this page/)
      expect(words).not.toMatch(/same key/)
    }

    // The entry added from the first key still works, once a screen that
    // can carry on with it is served.
    const kept = await browser.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    expect(secretOf(kept.json.totpURI as string)).toBe(secretOf(first))
    const on = await browser.post('/two-factor/verify-totp', {
      code: await totp(first),
    })
    expect(on.status).toBe(200)
  })

  test('a wrong password to enable leaves the key where it was', async () => {
    // Enable used to clear the old row before the plugin checked the
    // password, so a session cookie and any string wiped a set-up.
    const t = testApp()
    const browser = await signUp(t, 'typo@example.test')
    const first = (
      await browser.post('/two-factor/enable', { password: PASSWORD })
    ).json.totpURI as string

    for (const headers of [undefined, NEW_KEY]) {
      const typo = await browser.post(
        '/two-factor/enable',
        { password: 'not-the-password' },
        headers,
      )
      expect(typo.status).toBe(400)
      expect(typo.json.code).toBe('INVALID_PASSWORD')
      expect((await statusOf(t, browser)).setup).toBe('unfinished')
      const kept = await browser.post('/two-factor/get-totp-uri', {
        password: PASSWORD,
      })
      expect(secretOf(kept.json.totpURI as string)).toBe(secretOf(first))
    }

    const code = await browser.post('/two-factor/verify-totp', {
      code: await totp(first),
    })
    expect(code.status).toBe(200)
  })

  test('the half-off state is not carried on with: it heals through enable, on purpose', async () => {
    const t = testApp()
    const email = 'stale@example.test'
    const browser = await signUp(t, email)
    const { totpURI: old } = await enrol(browser)
    await halfTurnOff(t, email)
    expect((await statusOf(t, browser)).setup).toBe('stale')

    // Carrying on would hand back the old key, whose right code is accepted
    // and turns nothing on — the row is already marked verified. A person
    // told "done" who is not protected. So its key is not shown at all, and
    // `stale` starts again (`passwordStepAction` in src/lib/twoStep.ts).
    const shown = await browser.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    expect(shown.status).toBe(403)
    expect(shown.json.code).toBe('MFA_SETUP_KEY_UNAVAILABLE')
    expect(JSON.stringify(shown.json)).not.toContain(secretOf(old))

    // A slip of the password clears nothing; a bare enable replaces nothing.
    const typo = await browser.post(
      '/two-factor/enable',
      { password: 'not-the-password' },
      NEW_KEY,
    )
    expect(typo.status).toBe(400)
    expect((await statusOf(t, browser)).setup).toBe('stale')
    const bare = await browser.post('/two-factor/enable', {
      password: PASSWORD,
    })
    expect(bare.status).toBe(409)
    expect((await statusOf(t, browser)).setup).toBe('stale')

    // Enable asked for a new key clears it first (`startFromNothing`), and
    // the new key's code takes.
    const fresh = await browser.post(
      '/two-factor/enable',
      { password: PASSWORD },
      NEW_KEY,
    )
    expect(fresh.status).toBe(200)
    expect((await statusOf(t, browser)).setup).toBe('unfinished')
    const code = await browser.post('/two-factor/verify-totp', {
      code: await totp(fresh.json.totpURI as string),
    })
    expect(code.status).toBe(200)
    expect(await statusOf(t, browser)).toMatchObject({
      enabled: true,
      setup: 'on',
    })
  })

  test('once on, the key is not shown again and a second code changes nothing', async () => {
    // Two tabs of one browser share its cookie. Tab A started set-up and
    // holds enable's recovery codes; tab B carried on with the same key,
    // turned two-step sign-in on and made the codes that count. Tab A's
    // code must not then succeed as if it had turned it on — it would show
    // enable's codes, which no longer work, as the ones to save.
    const t = testApp()
    const email = 'tabs@example.test'
    const browser = await signUp(t, email)
    const started = await browser.post('/two-factor/enable', {
      password: PASSWORD,
    })
    const enableCodes = started.json.backupCodes as Array<string>
    const resumed = await browser.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    expect(secretOf(resumed.json.totpURI as string)).toBe(
      secretOf(started.json.totpURI as string),
    )
    const onInB = await browser.post('/two-factor/verify-totp', {
      code: await totp(resumed.json.totpURI as string),
    })
    expect(onInB.status).toBe(200)
    const made = await browser.post('/two-factor/generate-backup-codes', {
      password: PASSWORD,
    })
    const codes = made.json.backupCodes as Array<string>

    const inA = await browser.post('/two-factor/verify-totp', {
      code: await totp(started.json.totpURI as string),
    })
    expect(inA.status).toBe(400)
    expect(inA.json.code).toBe('MFA_ALREADY_ENABLED')

    const after = await browser.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    expect(after.status).toBe(400)
    expect(after.json.code).toBe('MFA_ALREADY_ENABLED')

    // The codes tab B showed are the ones that sign in.
    const phone = browserOn(t)
    await phone.post('/sign-in/email', { email, password: PASSWORD })
    expect(
      (
        await phone.post('/two-factor/verify-backup-code', {
          code: enableCodes[0],
        })
      ).status,
    ).toBe(401)
    expect(
      (await phone.post('/two-factor/verify-backup-code', { code: codes[0] }))
        .status,
    ).toBe(200)
  })
})

describe('a right code whose answer never arrives', () => {
  test('two-step sign-in is on, and every retry is told the sign-in has gone', async () => {
    // One bar of signal, or iOS suspending the home-screen app mid-request:
    // the code is right, the server turns two-step sign-in on and deletes
    // every session (convex/auth.ts, `user.update.before`), and the answer —
    // with the new cookie — never reaches the phone. The screen still holds
    // the old cookie, and whatever it sends next is answered as a sign-in
    // that no longer exists. Those are the answers the set-up screen words
    // as "two-step sign-in may already be on" (`isSignInLost`,
    // `SETUP_SIGN_IN_LOST` in src/lib/twoStep.ts) rather than "enter your
    // password again", which its scan step has no field for.
    const t = testApp()
    const email = 'lost-answer@example.test'
    const browser = await signUp(t, email)
    const totpURI = (
      await browser.post('/two-factor/enable', { password: PASSWORD })
    ).json.totpURI as string

    const lost = await t.fetch('/api/auth/two-factor/verify-totp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: browser.cookieHeader(),
      },
      body: JSON.stringify({ code: await totp(totpURI) }),
    })
    expect(lost.status).toBe(200)

    const retried = await browser.post('/two-factor/verify-totp', {
      code: await totp(totpURI),
    })
    expect(retried.status).toBe(401)
    expect(isSignInLost({ code: retried.json.code as string })).toBe(true)
    const codes = await browser.post('/two-factor/generate-backup-codes', {
      password: PASSWORD,
    })
    expect(codes.status).toBe(401)
    expect(isSignInLost({ code: codes.json.code as string })).toBe(true)

    // And it is on: the next sign-in asks for a code, and the entry just
    // added gives it.
    const user = await t.run(
      async (ctx): Promise<{ twoFactorEnabled?: boolean | null } | null> =>
        ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'user',
          where: [{ field: 'email', value: email }],
        }),
    )
    expect(user?.twoFactorEnabled).toBe(true)
    const again = browserOn(t)
    const challenge = await again.post('/sign-in/email', {
      email,
      password: PASSWORD,
    })
    expect(challenge.json.twoFactorRedirect).toBe(true)
    const coded = await again.post('/two-factor/verify-totp', {
      code: await totp(totpURI),
    })
    expect(coded.status).toBe(200)
  })
})

describe('a read already on its way when the code is checked', () => {
  test('its "no such session" does not sign out the session the code made', async () => {
    // The set-up screen's code goes out while the page's own reads may still
    // be going out on the cookie it had: the Convex token the provider
    // fetches again after each auth call, the session check on coming back
    // from the authenticator app. The right code deletes that session, so
    // each such read is answered "signed out", and Better Auth clears the
    // session cookie in the same answer. Landing after the code's answer,
    // that clearing wiped the NEW session's cookie: someone who had just
    // turned two-step sign-in on was signed out, and "Continue" after the
    // recovery codes went to the sign-in screen (e2e/twoStep.spec.ts, which
    // types the code the moment the key shows, caught it).
    const t = testApp()
    const email = 'late-read@example.test'
    const browser = await signUp(t, email)
    const totpURI = (
      await browser.post('/two-factor/enable', { password: PASSWORD })
    ).json.totpURI as string
    const before = browser.cookieHeader()

    const verified = await browser.post('/two-factor/verify-totp', {
      code: await totp(totpURI),
    })
    expect(verified.status).toBe(200)
    const session = browser.value('session_token')
    expect(session).toBeDefined()
    expect(before).not.toContain(session)

    for (const path of ['/convex/token', '/get-session']) {
      await browser.get(path, { stale: before })
      // The server did say to clear it…
      expect(browser.sent.some((c) => /session_token=;/.test(c))).toBe(true)
      // …and a read is not where a session cookie is cleared.
      expect(browser.value('session_token')).toBe(session)
    }

    // Still signed in, on the session the code made: its recovery codes
    // can be made, and the session check finds it.
    const codes = await browser.post('/two-factor/generate-backup-codes', {
      password: PASSWORD,
    })
    expect(codes.status).toBe(200)
    const checked = await browser.get('/get-session')
    expect(
      (checked.json as { user?: { email?: string } } | null)?.user,
    ).toEqual(expect.objectContaining({ email }))
  })

  test('signing out, which is not a read, still clears it', async () => {
    const t = testApp()
    const browser = await signUp(t, 'late-read-out@example.test')
    expect(browser.has('session_token')).toBe(true)
    await browser.post('/sign-out', {})
    expect(browser.has('session_token')).toBe(false)
  })
})

describe('a set-up belongs to the session that started it', () => {
  test('a key planted with a leaked password is never handed to the real person', async () => {
    const t = testApp()
    const email = 'victim@example.test'
    const victim = await signUp(t, email)

    // A password that got out before the account had two-step sign-in:
    // the password alone is a session, and a session can start set-up.
    const attacker = browserOn(t)
    await attacker.post('/sign-in/email', { email, password: PASSWORD })
    const planted = (
      await attacker.post('/two-factor/enable', { password: PASSWORD })
    ).json.totpURI as string
    expect(planted).toMatch(/^otpauth:/)

    // The real person's screen is told a set-up exists that is not theirs —
    // and is not given its key, with the password or without.
    expect((await statusOf(t, victim)).setup).toBe('elsewhere')
    const refused = await victim.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    expect(refused.status).toBe(403)
    expect(refused.json.code).toBe('MFA_SETUP_KEY_UNAVAILABLE')
    expect(JSON.stringify(refused.json)).not.toContain(secretOf(planted))

    // Nor does a plain Start quietly replace it; asking for a new key does.
    expect(
      (await victim.post('/two-factor/enable', { password: PASSWORD })).status,
    ).toBe(409)
    const own = (
      await victim.post('/two-factor/enable', { password: PASSWORD }, NEW_KEY)
    ).json.totpURI as string
    expect(secretOf(own)).not.toBe(secretOf(planted))
    expect((await statusOf(t, victim)).setup).toBe('unfinished')
    expect((await statusOf(t, attacker)).setup).toBe('elsewhere')
    expect(
      (await attacker.post('/two-factor/get-totp-uri', { password: PASSWORD }))
        .status,
    ).toBe(403)

    // The real person turns it on with their own key...
    const on = await victim.post('/two-factor/verify-totp', {
      code: await totp(own),
    })
    expect(on.status).toBe(200)

    // ...and the planted key opens nothing.
    const later = browserOn(t)
    const challenge = await later.post('/sign-in/email', {
      email,
      password: PASSWORD,
    })
    expect(challenge.json.twoFactorRedirect).toBe(true)
    const withPlanted = await later.post('/two-factor/verify-totp', {
      code: await totp(planted),
    })
    expect(withPlanted.status).toBe(401)
    expect(later.has('session_token')).toBe(false)
    const withOwn = await later.post('/two-factor/verify-totp', {
      code: await totp(own),
    })
    expect(withOwn.status).toBe(200)
  })

  test('the session that started it can still carry on after another has looked', async () => {
    // The laptop starts set-up; the phone opens the set-up screen. The phone
    // is refused the key; the laptop still has it.
    const t = testApp()
    const email = 'two-devices@example.test'
    const laptop = await signUp(t, email)
    const key = (
      await laptop.post('/two-factor/enable', { password: PASSWORD })
    ).json.totpURI as string
    const phone = browserOn(t)
    await phone.post('/sign-in/email', { email, password: PASSWORD })

    expect(
      (await phone.post('/two-factor/get-totp-uri', { password: PASSWORD }))
        .status,
    ).toBe(403)
    const again = await laptop.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    expect(again.status).toBe(200)
    expect(secretOf(again.json.totpURI as string)).toBe(secretOf(key))
    expect((await statusOf(t, laptop)).setup).toBe('unfinished')
  })

  test('a key from before claims were kept is nobody’s to carry on with', async () => {
    // Production has one such row: made by the old screen, never proven.
    const t = testApp()
    const email = 'legacy@example.test'
    const browser = await signUp(t, email)
    await browser.post('/two-factor/enable', { password: PASSWORD })
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('twoStepSetups').collect()) {
        await ctx.db.delete(row._id)
      }
    })

    expect((await statusOf(t, browser)).setup).toBe('elsewhere')
    expect(
      (await browser.post('/two-factor/get-totp-uri', { password: PASSWORD }))
        .status,
    ).toBe(403)
    const fresh = await browser.post(
      '/two-factor/enable',
      { password: PASSWORD },
      NEW_KEY,
    )
    expect(fresh.status).toBe(200)
    expect((await statusOf(t, browser)).setup).toBe('unfinished')
  })
})

describe('the set-up state, as a rule', () => {
  const mine = { sessionId: 's1', twoFactorId: 'row1' }

  test('only a row marked verified is the half-off state', () => {
    expect(twoFactorSetupState(false, null, null, 's1')).toBe('none')
    expect(
      twoFactorSetupState(false, { id: 'row1', verified: false }, mine, 's1'),
    ).toBe('unfinished')
    // What verify-totp does with anything but `true`: turns the flag on at
    // the first right code. So it can be carried on with.
    expect(twoFactorSetupState(false, { id: 'row1' }, mine, 's1')).toBe(
      'unfinished',
    )
    expect(
      twoFactorSetupState(false, { id: 'row1', verified: null }, mine, 's1'),
    ).toBe('unfinished')
    expect(
      twoFactorSetupState(false, { id: 'row1', verified: true }, mine, 's1'),
    ).toBe('stale')
    // On is on, whatever the row says.
    expect(twoFactorSetupState(true, null, null, null)).toBe('on')
    expect(
      twoFactorSetupState(true, { id: 'row1', verified: false }, null, null),
    ).toBe('on')
  })

  test('an unfinished key is only the session that made it', () => {
    const row = { id: 'row1', verified: false }
    expect(twoFactorSetupState(false, row, mine, 's1')).toBe('unfinished')
    // Another session, no session, no claim, or a claim on a row that has
    // since been replaced.
    expect(twoFactorSetupState(false, row, mine, 's2')).toBe('elsewhere')
    expect(twoFactorSetupState(false, row, mine, null)).toBe('elsewhere')
    expect(twoFactorSetupState(false, row, null, 's1')).toBe('elsewhere')
    expect(
      twoFactorSetupState(false, { id: 'row2', verified: false }, mine, 's1'),
    ).toBe('elsewhere')
  })

  test('a key is matched to its otpauth URI in the form the URI carries it', () => {
    // RFC 4648 §10: BASE32("foobar") = "MZXW6YTBOI======", unpadded here.
    const uri =
      'otpauth://totp/PestM8:a%40b.test?secret=MZXW6YTBOI&issuer=PestM8'
    expect(otpauthCarriesSecret(uri, 'foobar')).toBe(true)
    expect(
      otpauthCarriesSecret(uri.replace('MZXW6YTBOI', 'mzxw6ytboi'), 'foobar'),
    ).toBe(true)
    expect(otpauthCarriesSecret(uri, 'foobaz')).toBe(false)
    expect(otpauthCarriesSecret(uri, 'fooba')).toBe(false)
    for (const [raw, encoded] of [
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
    ]) {
      expect(
        otpauthCarriesSecret(`otpauth://totp/x?secret=${encoded}`, raw),
      ).toBe(true)
    }
    expect(otpauthCarriesSecret('not a uri', 'foobar')).toBe(false)
    expect(otpauthCarriesSecret('otpauth://totp/x', 'foobar')).toBe(false)
    expect(otpauthCarriesSecret('otpauth://totp/x?secret=', '')).toBe(false)
  })
})

describe("the tests' own authenticator app", () => {
  // Shared with Playwright (test/authBrowser.ts), so it is checked against
  // the standard rather than only against the server it is testing: a code
  // helper that was quietly wrong would blame the server for "did not match".
  test('gives the RFC 6238 codes (SHA-1, six digits)', async () => {
    // Appendix B's secret, "12345678901234567890", base32-encoded; the
    // expected codes are the last six digits of its eight-digit table.
    const uri =
      'otpauth://totp/PestM8:rfc%40example.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=PestM8'
    for (const [seconds, code] of [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ] as const) {
      expect(await totp(uri, seconds * 1000)).toBe(code)
    }
  })
})
