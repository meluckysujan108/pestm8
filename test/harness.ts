/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import betterAuthTest from '@convex-dev/better-auth/test'
import prosemirrorSyncTest from '@convex-dev/prosemirror-sync/test'
import schema from '../convex/schema'
import { MEMBER_COLOURS } from '../convex/lib/colours'
import { components } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'

/**
 * A test deployment with the Better Auth and prosemirror-sync components
 * registered, plus the two seeding helpers every access test needs.
 *
 * Lives outside `convex/` on purpose: anything in that directory is analysed
 * and pushed as a Convex module, and `@convex-dev/better-auth/test` uses
 * `import.meta.glob`, which the Convex runtime rejects. Keeping it here means
 * `npx convex dev` never sees it.
 *
 * Why this exists: the Playwright suite asserts access control by signing up
 * real users over HTTP, which costs a running dev server, a live deployment
 * and about two seconds per actor. That is the right tool for a handful of
 * journeys and the wrong one for a permission matrix, so the matrix lives here
 * and runs in milliseconds.
 *
 * Identity is what `authComponent.getAuthUser` actually resolves: it looks the
 * session up by `identity.sessionId` (rejecting expired ones) and the user by
 * `identity.subject`, so a test actor needs both rows to exist.
 */

const modules = import.meta.glob('../convex/**/*.ts')

// Inferred from a call rather than written out: convexTest's generic is
// constrained to GenericSchema, which our concrete SchemaDefinition does not
// structurally satisfy, so naming the type by hand loses every table.
function makeTestApp() {
  const t = convexTest(schema, modules)
  betterAuthTest.register(t)
  // Note bodies live in this component, so creating or sharing a note can
  // only be tested with it registered.
  prosemirrorSyncTest.register(t)
  return t
}

export type TestApp = ReturnType<typeof makeTestApp>
/** The app scoped to one signed-in person. */
export type TestAs = ReturnType<TestApp['withIdentity']>

export function testApp(): TestApp {
  return makeTestApp()
}

export type TestActor = {
  userId: string
  sessionId: string
  email: string
  /** The app, acting as this person. */
  as: TestAs
}

/**
 * Creates a Better Auth user and a live session, and returns the app scoped to
 * that identity. `emailVerified` defaults to false because that is what a real
 * sign-up produces today — tests that care about verification should say so.
 *
 * `twoFactorEnabled` defaults to TRUE, so that the same tests hold where a
 * deployment makes two-step sign-in compulsory (`AUTH_MFA_REQUIRED=on`,
 * convex/lib/mfa.ts) and `requireAuthUser` refuses anyone without it. The
 * tests about the gate itself, and about optional two-step, pass `false`.
 */
export async function createActor(
  t: TestApp,
  opts: {
    email: string
    name?: string
    emailVerified?: boolean
    twoFactorEnabled?: boolean
  },
): Promise<TestActor> {
  const now = Date.now()

  const userId = await t
    .run(async (ctx) =>
      ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'user',
          data: {
            name: opts.name ?? opts.email,
            email: opts.email.toLowerCase(),
            emailVerified: opts.emailVerified ?? false,
            twoFactorEnabled: opts.twoFactorEnabled ?? true,
            createdAt: now,
            updatedAt: now,
          },
        },
      }),
    )
    .then((user: { _id: string }) => user._id)

  const sessionId = await t
    .run(async (ctx) =>
      ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'session',
          data: {
            userId,
            token: `test-session-${userId}`,
            // Well clear of the `expiresAt > now` check inside getAuthUser.
            expiresAt: now + 60 * 60 * 1000,
            createdAt: now,
            updatedAt: now,
          },
        },
      }),
    )
    .then((session: { _id: string }) => session._id)

  return {
    userId,
    sessionId,
    email: opts.email.toLowerCase(),
    as: t.withIdentity({ subject: userId, sessionId }),
  }
}

/**
 * A SECOND live session for someone who is already signed in — the office iPad
 * next to the phone in their pocket.
 *
 * Switching is keyed by session rather than by person precisely so these two
 * behave independently, and that is only testable with two of them.
 */
export async function addSession(
  t: TestApp,
  actor: TestActor,
): Promise<TestActor> {
  const now = Date.now()
  const sessionId = await t
    .run(async (ctx) =>
      ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'session',
          data: {
            userId: actor.userId,
            token: `test-session-${actor.userId}-${now}`,
            expiresAt: now + 60 * 60 * 1000,
            createdAt: now,
            updatedAt: now,
          },
        },
      }),
    )
    .then((session: { _id: string }) => session._id)

  return {
    ...actor,
    sessionId,
    as: t.withIdentity({ subject: actor.userId, sessionId }),
  }
}

/**
 * A business owned by `owner`, matching what `businesses.create` produces —
 * including `canViewAllJobs: true` on the owner's own membership.
 */
export async function createBusiness(
  t: TestApp,
  owner: TestActor,
  name = 'Coastal Pest',
): Promise<{
  businessId: Id<'businesses'>
  ownerMembershipId: Id<'memberships'>
}> {
  return t.run(async (ctx) => {
    const now = Date.now()
    const businessId = await ctx.db.insert('businesses', {
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      state: 'WA',
      timezone: 'Australia/Perth',
      subscriptionStatus: 'trialing',
      createdAt: now,
    })
    const ownerMembershipId = await ctx.db.insert('memberships', {
      userId: owner.userId,
      businessId,
      role: 'owner',
      canViewAllJobs: true,
      // What businesses.create deals the owner, so tests stand on the same
      // colour a real business starts with.
      colour: MEMBER_COLOURS[0],
      status: 'active',
      createdAt: now,
    })
    return { businessId, ownerMembershipId }
  })
}
