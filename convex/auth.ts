import { betterAuth } from 'better-auth/minimal'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { createClient } from '@convex-dev/better-auth'
import { convex } from '@convex-dev/better-auth/plugins'
import { haveIBeenPwned } from 'better-auth/plugins/haveibeenpwned'
import authConfig from './auth.config'
import { components, internal } from './_generated/api'
import { query } from './_generated/server'
import { hashInviteToken } from './lib/inviteTokens'
import type { GenericCtx } from '@convex-dev/better-auth'
import type { DataModel } from './_generated/dataModel'

const siteUrl = process.env.SITE_URL!

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
    plugins: [
      // Refuses passwords that appear in known breaches, via k-anonymity — the
      // single highest-value check for a crew who reuse passwords. Fails closed
      // if the service is unreachable.
      haveIBeenPwned(),
      convex({ authConfig }),
    ],
  })

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => authComponent.getAuthUser(ctx),
})
