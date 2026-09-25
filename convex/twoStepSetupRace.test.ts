/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, components } from './_generated/api'
import { NEW_KEY_HEADER, NEW_KEY_HEADER_VALUE } from './lib/twoFactorSetup'
import { testApp } from '../test/harness'
import { AuthBrowser, secretOf, totp } from '../test/authBrowser'
import type { TestApp } from '../test/harness'
import type * as ConvexBetterAuth from '@convex-dev/better-auth'

/**
 * `/two-factor/get-totp-uri` racing another request that makes a key.
 *
 * The auth routes run in an HTTP action, and every read Better Auth makes
 * there is its own transaction (`authComponent.adapter` sends each through
 * `ctx.runQuery`). So the set-up claim that `onlyWhereItStarted` checks
 * before the endpoint, and the twoFactor row the endpoint then reads and
 * decrypts, are two separate reads, and the row can change between them. A
 * session holding only a leaked password could time its request to straddle
 * the real person's `/two-factor/enable`: its check sees "nothing started"
 * (or its own key), its read finds the person's brand-new key, and it is
 * handed the second factor the person is about to turn on. Exactly what the
 * claims exist to stop (convex/lib/twoFactorSetup.ts).
 *
 * convex-test runs each transaction whole and one at a time, so real timing
 * never lands a request in that gap. This file makes it land there on
 * purpose: Better Auth's adapter is wrapped so that a test can run another
 * request just before the next twoFactor row is read, which is the moment
 * after the check and before the read. A file of its own so the wrapping
 * (`vi.mock`, file-wide) stays out of every other flow test; with nothing
 * armed it passes every call straight through.
 */

const race = vi.hoisted(() => ({
  /** Run once, just before the next twoFactor row is read through Better
   * Auth's adapter — then disarmed, so the request it runs reads normally. */
  beforeKeyRead: null as null | (() => Promise<void>),
}))

vi.mock('@convex-dev/better-auth', async (importOriginal) => {
  const original = await importOriginal<typeof ConvexBetterAuth>()
  type CreateClient = typeof original.createClient
  const createClient = ((...args: Parameters<CreateClient>) => {
    const client = original.createClient(...args)
    const adapter = client.adapter
    client.adapter = (ctx) => {
      const factory = adapter(ctx)
      return (options) => {
        const db = factory(options)
        return {
          ...db,
          findOne: async (query) => {
            const run = race.beforeKeyRead
            if (query.model === 'twoFactor' && run) {
              race.beforeKeyRead = null
              await run()
            }
            return db.findOne(query)
          },
        }
      }
    }
    return client
  }) as CreateClient
  return { ...original, createClient }
})

beforeEach(() => {
  // A live HTTPS call to Have I Been Pwned per password is not a unit test.
  process.env.AUTH_BREACH_CHECK = 'off'
  race.beforeKeyRead = null
})
afterEach(() => {
  delete process.env.AUTH_BREACH_CHECK
  race.beforeKeyRead = null
})

const PASSWORD = 'correct horse battery staple'
const NEW_KEY = { [NEW_KEY_HEADER]: NEW_KEY_HEADER_VALUE }

function browserOn(t: TestApp) {
  return new AuthBrowser((path, init) => t.fetch(`/api/auth${path}`, init))
}

/** The real person, signed up on their phone; and someone else signed in
 * to the same account with its password alone. */
async function victimAndStranger(t: TestApp, email: string) {
  const victim = browserOn(t)
  const signedUp = await victim.post('/sign-up/email', {
    name: 'Kevin',
    email,
    password: PASSWORD,
  })
  expect(signedUp.status).toBe(200)
  const stranger = browserOn(t)
  const signedIn = await stranger.post('/sign-in/email', {
    email,
    password: PASSWORD,
  })
  expect(signedIn.json.twoFactorRedirect).toBeUndefined()
  expect(stranger.has('session_token')).toBe(true)
  return { victim, stranger }
}

/** `auth.twoFactorStatus().setup` as this browser's session sees it. */
async function setupOf(t: TestApp, browser: AuthBrowser) {
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
  return (await as.query(api.auth.twoFactorStatus, {})).setup
}

describe('the set-up key, read while another request makes one', () => {
  test('a key made after the check is not handed out on the strength of it', async () => {
    const t = testApp()
    const { victim, stranger } = await victimAndStranger(
      t,
      'straddled@example.test',
    )
    // The stranger starts a set-up of their own, so the check before
    // get-totp-uri passes for them: the key there is theirs.
    const theirs = await stranger.post('/two-factor/enable', {
      password: PASSWORD,
    })
    expect(theirs.status).toBe(200)
    expect(await setupOf(t, stranger)).toBe('unfinished')
    // The real person's screen sees a set-up that is not theirs, and starts
    // again with a new key (on purpose, warned) — as it should.
    expect(await setupOf(t, victim)).toBe('elsewhere')

    // ...and does it in the gap between the stranger's check and read.
    let victimsKey: string | undefined
    race.beforeKeyRead = async () => {
      const made = await victim.post(
        '/two-factor/enable',
        { password: PASSWORD },
        NEW_KEY,
      )
      expect(made.status).toBe(200)
      victimsKey = made.json.totpURI as string
    }
    const read = await stranger.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    // The gap was hit: the person's key was made after the check.
    expect(race.beforeKeyRead).toBeNull()
    expect(victimsKey).toMatch(/^otpauth:/)

    expect(read.status).toBe(403)
    expect(read.json.code).toBe('MFA_SETUP_KEY_UNAVAILABLE')
    expect(JSON.stringify(read.json)).not.toContain(secretOf(victimsKey!))

    // The person carries on with their own key, and it turns two-step
    // sign-in on; nobody else ever saw it.
    const resumed = await victim.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    expect(resumed.status).toBe(200)
    expect(resumed.json.totpURI).toBe(victimsKey)
    const on = await victim.post('/two-factor/verify-totp', {
      code: await totp(victimsKey!),
    })
    expect(on.status).toBe(200)
  })

  test('"nothing started" is not a pass to read whatever key turns up', async () => {
    // The commoner shape: an account without two-step sign-in has no key at
    // all, which is every account until its owner sets it up. A request
    // that lands in the gap before the person's first key is created must
    // not come back with it.
    const t = testApp()
    const { victim, stranger } = await victimAndStranger(
      t,
      'first-key@example.test',
    )
    expect(await setupOf(t, stranger)).toBe('none')

    let victimsKey: string | undefined
    race.beforeKeyRead = async () => {
      const made = await victim.post('/two-factor/enable', {
        password: PASSWORD,
      })
      expect(made.status).toBe(200)
      victimsKey = made.json.totpURI as string
    }
    const read = await stranger.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    // Refused at the check, as the endpoint itself would refuse a missing
    // key — before it ever reads a row.
    expect(read.status).toBe(400)
    expect(read.json.code).toBe('TOTP_NOT_ENABLED')
    expect(read.json.totpURI).toBeUndefined()
    expect(race.beforeKeyRead).not.toBeNull()
    expect(victimsKey).toBeUndefined()
  })

  test('the session that made the key still gets it back', async () => {
    // The after-check must not refuse the one case it exists to allow.
    const t = testApp()
    const { victim } = await victimAndStranger(t, 'mine@example.test')
    const made = await victim.post('/two-factor/enable', {
      password: PASSWORD,
    })
    const shown = await victim.post('/two-factor/get-totp-uri', {
      password: PASSWORD,
    })
    expect(shown.status).toBe(200)
    expect(shown.json.totpURI).toBe(made.json.totpURI)
  })
})
