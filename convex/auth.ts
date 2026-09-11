import { betterAuth } from 'better-auth/minimal'
import { createClient } from '@convex-dev/better-auth'
import { convex } from '@convex-dev/better-auth/plugins'
import authConfig from './auth.config'
import { components } from './_generated/api'
import { query } from './_generated/server'
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

export const authComponent = createClient<DataModel>(components.betterAuth)

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: siteUrl,
    trustedOrigins,
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    plugins: [convex({ authConfig })],
  })

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => authComponent.getAuthUser(ctx),
})
