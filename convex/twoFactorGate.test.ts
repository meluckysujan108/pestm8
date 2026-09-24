/// <reference types="vite/client" />
import { afterEach, describe, expect, test } from 'vitest'
import { APIError } from 'better-auth/api'
import { api, components, internal } from './_generated/api'
import { twoFactorPolicy } from './auth'
import { createActor, createBusiness, testApp } from '../test/harness'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * Compulsory two-step sign-in, where it is actually enforced: on the server,
 * in every function that resolves the caller (`requireAuthUser`), and in the
 * owner's reset for someone who has lost their phone and their codes.
 *
 * The sign-in screen asking for a code is not the control — a session opened
 * before release never saw one — so these are the tests that matter.
 */

afterEach(() => {
  delete process.env.AUTH_MFA_REQUIRED
})

async function member(
  t: TestApp,
  owner: TestActor,
  businessId: Id<'businesses'>,
  email: string,
) {
  const person = await createActor(t, { email, name: email.split('@')[0] })
  const { url } = await owner.as.action(api.invitations.create, {
    businessId,
    email,
    role: 'subcontractor',
  })
  await person.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })
  const membershipId = await t.run(async (ctx) => {
    const row = await ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', person.userId).eq('businessId', businessId),
      )
      .unique()
    return row!._id
  })
  return { person, membershipId }
}

/** Flip the account's flag directly, as a release would find it. */
async function setEnrolled(t: TestApp, userId: string, enabled: boolean) {
  await t.run(async (ctx) => {
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'user',
        where: [{ field: '_id', value: userId }],
        update: { twoFactorEnabled: enabled },
      },
    })
  })
}

async function business() {
  const t = testApp()
  const owner = await createActor(t, {
    email: 'terence@coastalpest.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await member(t, owner, businessId, 'kevin@kevinspest.test')
  return { t, owner, businessId, ownerMembershipId, kevin }
}

describe('the server-side gate', () => {
  test('an account without two-step sign-in is refused everything', async () => {
    const { t, businessId, kevin } = await business()
    // Signed in before release: a live session, never enrolled.
    await setEnrolled(t, kevin.person.userId, false)
    const as = kevin.person.as

    // requireMembership
    await expect(
      as.query(api.memberships.listForBusiness, { businessId }),
    ).rejects.toThrow(/MFA_ENROLMENT_REQUIRED/)
    // requireActor
    await expect(as.query(api.access.me, { businessId })).rejects.toThrow(
      /MFA_ENROLMENT_REQUIRED/,
    )
    // getAuthUserId
    await expect(as.query(api.businesses.listForUser, {})).rejects.toThrow(
      /MFA_ENROLMENT_REQUIRED/,
    )
    // Not folded into "no such business", or the layout would say Not found.
    await expect(
      as.query(api.businesses.getBySlug, { slug: 'coastal-pest' }),
    ).rejects.toThrow(/MFA_ENROLMENT_REQUIRED/)
    // Writes too.
    await expect(
      as.mutation(api.businesses.create, {
        name: 'Side Hustle Pest',
        state: 'WA',
        timezone: 'Australia/Perth',
      }),
    ).rejects.toThrow(/MFA_ENROLMENT_REQUIRED/)
  })

  test('the licence document is behind the gate too', async () => {
    // Phase 8.1 landed alongside this, and a licence card carries a date of
    // birth and a home address — so it is pinned here rather than trusted to
    // `requireActor`/`requireWriteActor` staying the only way in.
    const { t, businessId, kevin } = await business()
    await setEnrolled(t, kevin.person.userId, false)
    const as = kevin.person.as
    const membershipId = kevin.membershipId

    await expect(
      as.query(api.licences.file, { businessId, membershipId }),
    ).rejects.toThrow(/MFA_ENROLMENT_REQUIRED/)
    await expect(
      as.mutation(api.licences.generateUploadUrl, { businessId }),
    ).rejects.toThrow(/MFA_ENROLMENT_REQUIRED/)
    await expect(
      as.mutation(api.licences.removeFile, { businessId, membershipId }),
    ).rejects.toThrow(/MFA_ENROLMENT_REQUIRED/)
  })

  test('the same account, once enrolled, gets its answers', async () => {
    const { t, businessId, kevin } = await business()
    await setEnrolled(t, kevin.person.userId, false)
    await setEnrolled(t, kevin.person.userId, true)

    const roster = await kevin.person.as.query(
      api.memberships.listForBusiness,
      { businessId },
    )
    expect(roster.length).toBeGreaterThan(0)
    const me = await kevin.person.as.query(api.access.me, { businessId })
    expect(me).toBeTruthy()
  })

  test('the enrolment allow-list answers an account that is not enrolled', async () => {
    const t = testApp()
    const fresh = await createActor(t, {
      email: 'new@example.test',
      twoFactorEnabled: false,
    })

    const user = await fresh.as.query(api.auth.getCurrentUser, {})
    expect(user.email).toBe('new@example.test')

    expect(await fresh.as.query(api.auth.twoFactorStatus, {})).toEqual({
      signedIn: true,
      required: true,
      enabled: false,
    })
  })

  test('the status query answers a signed-out caller without throwing', async () => {
    const t = testApp()
    expect(await t.query(api.auth.twoFactorStatus, {})).toEqual({
      signedIn: false,
      required: true,
      enabled: false,
    })
  })

  test('joining a business comes after enrolment, never before', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@coastalpest.test' })
    const { businessId } = await createBusiness(t, owner)
    const invitee = await createActor(t, {
      email: 'new@example.test',
      twoFactorEnabled: false,
    })
    const { url } = await owner.as.action(api.invitations.create, {
      businessId,
      email: invitee.email,
      role: 'subcontractor',
    })
    const token = url.split('/join/')[1]

    await expect(
      invitee.as.action(api.invitations.redeem, { token }),
    ).rejects.toThrow(/MFA_ENROLMENT_REQUIRED/)

    // The link is not spent by the refusal: enrol, and it still works.
    await setEnrolled(t, invitee.userId, true)
    const joined = await invitee.as.action(api.invitations.redeem, { token })
    expect(joined.businessId).toBe(businessId)
  })

  test('AUTH_MFA_REQUIRED=off turns the gate off', async () => {
    const { t, businessId, kevin } = await business()
    await setEnrolled(t, kevin.person.userId, false)
    process.env.AUTH_MFA_REQUIRED = 'off'

    const roster = await kevin.person.as.query(
      api.memberships.listForBusiness,
      { businessId },
    )
    expect(roster.length).toBeGreaterThan(0)
    expect(await kevin.person.as.query(api.auth.twoFactorStatus, {})).toEqual({
      signedIn: true,
      required: false,
      enabled: false,
    })
  })

  test('anything but exactly "off" leaves it on', async () => {
    const { t, businessId, kevin } = await business()
    await setEnrolled(t, kevin.person.userId, false)
    for (const value of ['', 'false', 'OFF', '0', 'no']) {
      process.env.AUTH_MFA_REQUIRED = value
      await expect(
        kevin.person.as.query(api.memberships.listForBusiness, { businessId }),
      ).rejects.toThrow(/MFA_ENROLMENT_REQUIRED/)
    }
  })
})

describe('the auth endpoint policy', () => {
  function refusal(fn: () => void): string | undefined {
    try {
      fn()
    } catch (error) {
      expect(error).toBeInstanceOf(APIError)
      return (error as { body?: { code?: string } }).body?.code
    }
    return undefined
  }

  test('no verify path may trust a device', () => {
    for (const path of [
      '/two-factor/verify-totp',
      '/two-factor/verify-backup-code',
      '/two-factor/verify-otp',
    ]) {
      for (const trustDevice of [true, 'true', 1, {}]) {
        expect(
          refusal(() =>
            twoFactorPolicy(path, { code: '1', trustDevice }, true),
          ),
        ).toBe('TRUST_DEVICE_NOT_ALLOWED')
      }
      // Absent or explicitly false is what a well-behaved client sends.
      expect(
        refusal(() => twoFactorPolicy(path, { code: '1' }, true)),
      ).toBeUndefined()
      expect(
        refusal(() =>
          twoFactorPolicy(path, { code: '1', trustDevice: false }, true),
        ),
      ).toBeUndefined()
    }
  })

  test('trusting a device is refused even when two-step is not compulsory', () => {
    expect(
      refusal(() =>
        twoFactorPolicy(
          '/two-factor/verify-totp',
          { code: '1', trustDevice: true },
          false,
        ),
      ),
    ).toBe('TRUST_DEVICE_NOT_ALLOWED')
  })

  test('switching it off is refused while it is compulsory, and only then', () => {
    expect(
      refusal(() =>
        twoFactorPolicy('/two-factor/disable', { password: 'x' }, true),
      ),
    ).toBe('MFA_REQUIRED')
    expect(
      refusal(() =>
        twoFactorPolicy('/two-factor/disable', { password: 'x' }, false),
      ),
    ).toBeUndefined()
  })

  test('a body of any shape, or none, does not throw anything else', () => {
    for (const body of [undefined, null, 'x', 42, []]) {
      expect(
        refusal(() => twoFactorPolicy('/two-factor/verify-totp', body, true)),
      ).toBeUndefined()
    }
    expect(
      refusal(() => twoFactorPolicy(undefined, undefined, true)),
    ).toBeUndefined()
    expect(
      refusal(() => twoFactorPolicy('/sign-in/email', {}, true)),
    ).toBeUndefined()
  })
})

describe("the owner's reset", () => {
  async function twoFactorRows(t: TestApp, userId: string) {
    return t.run(async (ctx): Promise<unknown> =>
      ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'twoFactor',
        where: [{ field: 'userId', value: userId }],
      }),
    )
  }

  async function seedSecret(t: TestApp, userId: string) {
    await t.run(async (ctx) => {
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'twoFactor',
          data: {
            userId,
            secret: 'encrypted-secret',
            backupCodes: 'encrypted-codes',
            verified: true,
          },
        },
      })
    })
  }

  test('clears the secret, the flag and every session, and is audited', async () => {
    const { t, owner, businessId, ownerMembershipId, kevin } = await business()
    await seedSecret(t, kevin.person.userId)

    await owner.as.mutation(api.team.resetTwoFactor, {
      businessId,
      membershipId: kevin.membershipId,
    })

    expect(await twoFactorRows(t, kevin.person.userId)).toBeNull()
    const user = await t.run(
      async (ctx): Promise<{ twoFactorEnabled?: boolean | null } | null> =>
        ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'user',
          where: [{ field: '_id', value: kevin.person.userId }],
        }),
    )
    expect(user?.twoFactorEnabled).toBe(false)

    // Signed out on the phone in their pocket.
    await expect(
      kevin.person.as.query(api.auth.getCurrentUser, {}),
    ).rejects.toThrow(/Unauthenticated/i)

    const audit = await t.run(async (ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .collect(),
    )
    const row = audit.find((a) => a.action === 'membership.twoFactorReset')
    expect(row?.actorMembershipId).toBe(ownerMembershipId)
    expect(row?.entityId).toBe(kevin.membershipId)

    // The owner's own sign-in is untouched.
    expect(await owner.as.query(api.auth.getCurrentUser, {})).toBeTruthy()
  })

  test('the roster says who has it on', async () => {
    const { owner, businessId, kevin } = await business()
    const before = await owner.as.query(api.team.roster, { businessId })
    expect(before.find((m) => m._id === kevin.membershipId)?.twoStepOn).toBe(
      true,
    )
    await owner.as.mutation(api.team.resetTwoFactor, {
      businessId,
      membershipId: kevin.membershipId,
    })
    const after = await owner.as.query(api.team.roster, { businessId })
    expect(after.find((m) => m._id === kevin.membershipId)?.twoStepOn).toBe(
      false,
    )
  })

  test('is refused to anyone but the owner', async () => {
    const { t, owner, businessId, kevin } = await business()
    const priya = await member(t, owner, businessId, 'priya@example.test')

    await expect(
      priya.person.as.mutation(api.team.resetTwoFactor, {
        businessId,
        membershipId: kevin.membershipId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('is refused on yourself', async () => {
    const { owner, businessId, ownerMembershipId } = await business()
    await expect(
      owner.as.mutation(api.team.resetTwoFactor, {
        businessId,
        membershipId: ownerMembershipId,
      }),
    ).rejects.toThrow(/CANNOT_RESET_SELF/)
  })

  test("is refused on another business's member", async () => {
    const { t, owner, businessId } = await business()
    const other = await createActor(t, { email: 'boss@otherpest.test' })
    const { businessId: otherBusinessId } = await createBusiness(
      t,
      other,
      'Other Pest',
    )
    const theirs = await member(t, other, otherBusinessId, 'sam@example.test')

    // Named against this business: not one of its members.
    await expect(
      owner.as.mutation(api.team.resetTwoFactor, {
        businessId,
        membershipId: theirs.membershipId,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
    // Named against theirs: not this owner's business.
    await expect(
      owner.as.mutation(api.team.resetTwoFactor, {
        businessId: otherBusinessId,
        membershipId: theirs.membershipId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('is refused on someone who also works for another business', async () => {
    const { t, owner, businessId, kevin } = await business()
    const other = await createActor(t, { email: 'boss@otherpest.test' })
    const { businessId: otherBusinessId } = await createBusiness(
      t,
      other,
      'Other Pest',
    )
    const { url } = await other.as.action(api.invitations.create, {
      businessId: otherBusinessId,
      email: kevin.person.email,
      role: 'subcontractor',
    })
    await kevin.person.as.action(api.invitations.redeem, {
      token: url.split('/join/')[1],
    })
    await seedSecret(t, kevin.person.userId)

    await expect(
      owner.as.mutation(api.team.resetTwoFactor, {
        businessId,
        membershipId: kevin.membershipId,
      }),
    ).rejects.toThrow(/MEMBER_OF_ANOTHER_BUSINESS/)
    // And nothing was touched.
    expect(await twoFactorRows(t, kevin.person.userId)).not.toBeNull()
    expect(
      await kevin.person.as.query(api.auth.getCurrentUser, {}),
    ).toBeTruthy()
  })

  test('is refused on someone who has been removed', async () => {
    const { t, owner, businessId, kevin } = await business()
    await t.run(async (ctx) => {
      await ctx.db.patch(kevin.membershipId, { status: 'removed' })
    })
    await expect(
      owner.as.mutation(api.team.resetTwoFactor, {
        businessId,
        membershipId: kevin.membershipId,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })

  test('is refused to an owner who has not set up two-step themselves', async () => {
    const { t, owner, businessId, kevin } = await business()
    await setEnrolled(t, owner.userId, false)
    await expect(
      owner.as.mutation(api.team.resetTwoFactor, {
        businessId,
        membershipId: kevin.membershipId,
      }),
    ).rejects.toThrow(/MFA_ENROLMENT_REQUIRED/)
  })

  test("the operator's reset clears any account by email, and audits it everywhere", async () => {
    const { t, businessId, kevin } = await business()
    await seedSecret(t, kevin.person.userId)

    await t.mutation(internal.team.resetTwoFactorForEmail, {
      email: ' Kevin@KevinsPest.test ',
    })

    expect(await twoFactorRows(t, kevin.person.userId)).toBeNull()
    const audit = await t.run(async (ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .collect(),
    )
    expect(
      audit.find(
        (a) =>
          a.action === 'membership.twoFactorReset' &&
          a.entityId === kevin.membershipId,
      )?.meta,
    ).toEqual({ by: 'operator' })
  })
})
