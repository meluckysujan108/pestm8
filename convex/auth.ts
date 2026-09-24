import { betterAuth } from 'better-auth/minimal'
import { createClient } from '@convex-dev/better-auth'
import { convex } from '@convex-dev/better-auth/plugins'
import { haveIBeenPwned } from 'better-auth/plugins/haveibeenpwned'
import { twoFactor } from 'better-auth/plugins/two-factor'
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from 'better-auth/api'
import authConfig from './auth.config'
import { components, internal } from './_generated/api'
import { query } from './_generated/server'
import { hashInviteToken } from './lib/inviteTokens'
import { isMfaRequired } from './lib/mfa'
import type { GenericCtx } from '@convex-dev/better-auth'
import type { DataModel } from './_generated/dataModel'

/**
 * Named rather than asserted with `!`, because the assertion turns a missing
 * env var into a module-analysis TypeError — "Cannot read properties of
 * undefined (reading 'startsWith')", pointing at whatever line the bundler
 * blames, which is not this one. That is the first thing you hit on a
 * deployment nobody has configured yet, and it reads like a code defect
 * rather than a setting you have not made. Fail with the name of the thing
 * that is missing.
 */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set on this Convex deployment. ` +
        `Set it with: npx convex env set ${name} <value>`,
    )
  }
  return value
}

const siteUrl = requireEnv('SITE_URL')

/**
 * Better Auth validates the request Origin against `baseURL`, so anything not
 * served from exactly `SITE_URL` is rejected with INVALID_ORIGIN. That is the
 * behaviour we want in production — it is CSRF protection — but locally the
 * dev server lands on a different port whenever 3000 is taken (a second dev
 * server, a preview), and sign-in then fails with an error that looks nothing
 * like a port problem.
 *
 * So: trust any localhost port, but only on a deployment whose own SITE_URL is
 * already localhost. A production deployment's SITE_URL is an https origin, so
 * this list is empty there and the check is untouched.
 */
const isLocalDeployment = siteUrl.startsWith('http://localhost')
const trustedOrigins = isLocalDeployment ? ['http://localhost:*'] : []

/**
 * Rate limiting is off by default in this runtime, and its default storage is
 * per-isolate memory, so guessing a password was unlimited. Turning it on needs
 * two deliberate choices:
 *
 * 1. `storage: 'database'` — the component already has the table. Memory
 *    counters in a serverless isolate protect nothing.
 * 2. An env switch, so dev and e2e deployments (which sign up hundreds of
 *    accounts per run) are not throttled into failing.
 *
 * The limits are deliberately generous. The client IP that reaches Convex
 * behind the Vercel proxy has not been measured yet, and if it resolves to
 * nothing every request shares one bucket — at which point a tight limit locks
 * out the whole business at 7am rather than stopping an attacker. Measure
 * first, tighten after; per-account throttling is the layer that does not
 * depend on IPs at all.
 */
const rateLimitEnabled = process.env.AUTH_RATE_LIMIT === 'on'

/**
 * Refuses passwords that appear in known breaches, via k-anonymity — the single
 * highest-value check for a crew who reuse passwords.
 *
 * Wrapped rather than used directly, to tell an outage apart from a verdict.
 * The upstream plugin turns ANY failure of api.pwnedpasswords.com into a 500,
 * and it guards `/change-password` and `/reset-password` as well as sign-up —
 * so a third party being unreachable takes out the password recovery paths,
 * which are exactly what you need working when something else has already gone
 * wrong. It is also not theoretical: an outage mid-session failed 54 of 127 e2e
 * tests, every one of them on sign-up returning 500.
 *
 * So: a verdict is honoured and an outage is not a verdict. If the service says
 * the password is breached, that refusal stands. If we cannot reach the service
 * at all, the password is hashed unchecked and the request continues. A breach
 * check is advice; being unable to fetch the advice is not grounds to lock
 * someone out of their own account.
 *
 * `enabled` is the plugin's own switch, off only where an outbound call per
 * password would be wrong: the e2e suite signs up ~120 accounts per run, and
 * each one is a live HTTPS request to a third party. Defaults ON, and stays on
 * unless a deployment says otherwise — a security check must not disappear
 * because an environment variable went missing.
 */
const breachCheckEnabled = process.env.AUTH_BREACH_CHECK !== 'off'

export function isBreachVerdict(error: unknown): boolean {
  return (
    isAPIError(error) &&
    (error as { body?: { code?: string } }).body?.code ===
      'PASSWORD_COMPROMISED'
  )
}

function breachCheck() {
  const plugin = haveIBeenPwned({ enabled: breachCheckEnabled })
  const init = plugin.init

  return {
    ...plugin,
    init(ctx: Parameters<typeof init>[0]) {
      const patched = init(ctx)
      const checkedHash = patched.context.password.hash

      return {
        ...patched,
        context: {
          ...patched.context,
          password: {
            ...patched.context.password,
            async hash(password: string) {
              try {
                return await checkedHash(password)
              } catch (error) {
                if (isBreachVerdict(error)) throw error
                // Unreachable service: hash it unchecked rather than refuse.
                return ctx.password.hash(password)
              }
            },
          },
        },
      }
    },
  }
}

/**
 * Invite-only sign-up.
 *
 * PestM8 serves one business. Nobody should be able to create an account here
 * except someone holding a live invitation, and `disableSignUp` is no use — it
 * refuses every caller, including the invited one.
 *
 * Off by default, and on via env on the deployments that want it, because the
 * e2e suite signs up ~150 accounts per run and would otherwise need a token for
 * every one. The door that actually matters is already shut regardless: an
 * account with no redeemed invitation is a member of nothing and can read
 * nothing.
 */
const inviteOnly = process.env.AUTH_INVITE_ONLY === 'on'

const SIGN_UP_PATH = '/sign-up/email'

/**
 * Compulsory two-step sign-in: `AUTH_MFA_REQUIRED`, read through
 * `isMfaRequired()` in `lib/mfa.ts` so this file and the server-side gate
 * (`requireAuthUser`) can never disagree. Defaults ON; only `off` turns it off,
 * and only the e2e deployment should say that.
 *
 * The method is an authenticator app (TOTP) plus ten single-use recovery
 * codes. Not email codes: report email only reaches the account owner's own
 * inbox today, so a technician could not receive one — and a code sent to the
 * same phone that was lost is no second factor anyway.
 */
const TWO_FACTOR_PREFIX = '/two-factor/'

/**
 * What the two-factor endpoints may and may not be asked to do here, as a
 * plain function so it can be tested without an HTTP round trip.
 *
 * - `trustDevice` is refused on every verify path. "Require MFA on every
 *   subsequent login" means exactly that: the plugin would otherwise let the
 *   client opt a device out of the code for 30 days, and a phone left on a
 *   ute's dashboard is the device that matters.
 * - `/two-factor/disable` is refused while two-step sign-in is compulsory.
 *   Compulsory means the account holder cannot switch it off; the business
 *   owner's reset (`team.resetTwoFactor`) is the only way to clear it, and it
 *   leaves the account unable to use the app until it is set up again.
 *
 * Before-hooks run ahead of the endpoint's own validation, so nothing here may
 * assume a shape.
 */
export function twoFactorPolicy(
  path: string | undefined,
  body: unknown,
  mfaRequired: boolean,
): void {
  if (!path?.startsWith(TWO_FACTOR_PREFIX)) return

  if (path.startsWith(`${TWO_FACTOR_PREFIX}verify-`)) {
    const trustDevice =
      typeof body === 'object' && body !== null
        ? (body as { trustDevice?: unknown }).trustDevice
        : undefined
    if (trustDevice !== undefined && trustDevice !== false) {
      throw new APIError('BAD_REQUEST', {
        message: 'PestM8 asks for a code at every sign-in, on every device.',
        code: 'TRUST_DEVICE_NOT_ALLOWED',
      })
    }
  }

  if (path === `${TWO_FACTOR_PREFIX}disable` && mfaRequired) {
    throw new APIError('FORBIDDEN', {
      message:
        'Two-step sign-in is required for every PestM8 account. Ask the business owner if you have lost your phone and your recovery codes.',
      code: 'MFA_REQUIRED',
    })
  }
}

/**
 * Recovery codes a person can read off a scrap of paper in a roof void and
 * type with a thumb: lowercase, and no 0/o, 1/l/i to confuse. Ten characters
 * from 31 is ~49 bits each — plenty for a single-use code that the plugin
 * lets you try five times per password sign-in. `xxxxx-xxxxx`, the plugin's
 * own shape; the sign-in screen lowercases what is typed and puts the hyphen
 * back if it was left out, so the exact-match check still passes.
 *
 * Rejection sampling rather than `byte % 31`, which would make the first
 * eight letters of the alphabet slightly likelier than the rest.
 */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
export const RECOVERY_CODE_COUNT = 10

export function generateRecoveryCodes(): Array<string> {
  const limit = 256 - (256 % RECOVERY_ALPHABET.length)
  const codes: Array<string> = []
  while (codes.length < RECOVERY_CODE_COUNT) {
    let raw = ''
    while (raw.length < 10) {
      const bytes = crypto.getRandomValues(new Uint8Array(16))
      for (const byte of bytes) {
        if (raw.length === 10) break
        if (byte < limit)
          raw += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]
      }
    }
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`)
  }
  return codes
}

/**
 * Better Auth's two-factor plugin, fitted to the component this app runs.
 *
 * better-auth 1.6.30's plugin declares two lockout columns on `twoFactor`
 * (`failedVerificationCount`, `lockedUntil`) that the default
 * @convex-dev/better-auth 0.12.5 component's schema does not have. The
 * component validates every write against its own schema, and the plugin
 * writes `failedVerificationCount: 0` into every row it creates — so, left as
 * it is, setting up two-step sign-in would fail for everyone with a validator
 * error. The columns are taken out of the plugin's schema and account-level
 * lockout is off, which is the only way to run this plugin against this
 * component without a schema the component would reject.
 *
 * What still stands between a stolen password and a guessed code: each
 * password sign-in allows five code attempts before the challenge dies and the
 * password has to be entered again (the plugin's per-challenge counter, which
 * lives in the `verification` table the component does have), the sign-in rate
 * limit when AUTH_RATE_LIMIT is on, and a 10-minute challenge. Bring lockout
 * back when the component's schema carries the two columns.
 */
function twoStep() {
  const plugin = twoFactor({
    issuer: 'PestM8',
    // twoFactorEnabled only flips once a code from the new authenticator has
    // been checked — set-up that was never finished must not lock anyone out.
    skipVerificationOnEnable: false,
    allowPasswordless: false,
    backupCodeOptions: {
      amount: RECOVERY_CODE_COUNT,
      customBackupCodesGenerate: generateRecoveryCodes,
    },
    accountLockout: { enabled: false },
    // No otpOptions: no email or SMS codes. See TWO_FACTOR_PREFIX above.
  })
  const {
    failedVerificationCount: _failedVerificationCount,
    lockedUntil: _lockedUntil,
    ...fields
  } = plugin.schema.twoFactor.fields
  return {
    ...plugin,
    schema: {
      ...plugin.schema,
      twoFactor: { ...plugin.schema.twoFactor, fields },
    },
  }
}

export const authComponent = createClient<DataModel>(components.betterAuth)

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: siteUrl,
    trustedOrigins,
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      // NIST SP 800-63B favours length over composition rules. 10 is a floor,
      // not advice; the breach check below does the work that matters.
      minPasswordLength: 10,
    },
    rateLimit: {
      enabled: rateLimitEnabled,
      storage: 'database',
      customRules: {
        '/sign-in/email': { window: 60, max: 30 },
        '/sign-up/email': { window: 3600, max: 20 },
        '/request-password-reset': { window: 3600, max: 10 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (h) => {
        twoFactorPolicy(h.path, h.body, isMfaRequired())

        // Setting up again over a working set-up would swap the secret
        // without checking a code from the new one — the plugin marks the
        // replacement verified at once — so a double tap, or a back button
        // into the set-up screen, would leave the authenticator on the phone
        // out of step and the person locked out at their next sign-in. A
        // lost phone is the owner's reset, which clears it properly first.
        if (h.path === `${TWO_FACTOR_PREFIX}enable`) {
          const session = await getSessionFromCtx(h)
          if (session?.user.twoFactorEnabled === true) {
            throw new APIError('BAD_REQUEST', {
              message: 'Two-step sign-in is already set up on this account.',
              code: 'MFA_ALREADY_ENABLED',
            })
          }
        }

        if (!inviteOnly || h.path !== SIGN_UP_PATH) return
        // Before-hooks run ahead of the endpoint's own validation, so nothing
        // here may assume a shape.
        const body = h.body as { inviteToken?: unknown; email?: unknown }
        const token =
          typeof body.inviteToken === 'string' && body.inviteToken.length <= 128
            ? body.inviteToken
            : null

        if (!token || !('runQuery' in ctx)) {
          throw new APIError('FORBIDDEN', {
            message: 'You need an invitation link to create an account.',
            code: 'INVITE_REQUIRED',
          })
        }

        const result = await ctx.runQuery(internal.invitations.checkForSignUp, {
          tokenHash: await hashInviteToken(token),
          email: String(body.email ?? ''),
        })
        if (!result.ok) {
          throw new APIError('FORBIDDEN', {
            message: 'That invitation link is not valid any more.',
            code: result.code,
          })
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Backstop for any future path that creates users (social sign-in,
          // email OTP, the admin plugin): the gate above only covers the one
          // endpoint it names.
          before: async (_user, endpointCtx) => {
            if (!inviteOnly) return
            if (endpointCtx?.path !== SIGN_UP_PATH) return false
          },
        },
      },
    },
    /**
     * Order matters. After-hooks run in plugin order, and both of the last
     * two act on `/sign-in/email`: two-factor deletes the session a correct
     * password just created and answers with a challenge instead, and convex
     * mints a JWT for whatever session is left. Two-factor first means convex
     * finds none and mints nothing (its hook swallows that failure by design,
     * "eg., when redirecting to 2fa"). The other way round, a JWT would be
     * minted for a session about to be deleted — useless, because
     * `getAuthUser` re-reads the session row on every call, but a signed
     * credential for someone who has not finished signing in should not
     * exist at all.
     */
    plugins: [breachCheck(), twoStep(), convex({ authConfig })],
  })

/**
 * Part of the enrolment allow-list (see `requireAuthUser`): deliberately NOT
 * gated on two-step sign-in, because the set-up screen and the account menu
 * read it before there is anything set up.
 */
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => authComponent.getAuthUser(ctx),
})

/**
 * Whether this person still has to set up two-step sign-in — what the client
 * routes on. Part of the enrolment allow-list, so it answers an un-enrolled
 * account; and it answers a signed-out caller too (`signedIn: false`) rather
 * than throwing, because it is read on the way to the sign-in screen as well
 * as away from it.
 */
export const twoFactorStatus = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    return {
      signedIn: user !== undefined,
      required: isMfaRequired(),
      enabled: user?.twoFactorEnabled === true,
    }
  },
})
