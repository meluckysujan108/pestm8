/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * A contractor manages their own team, and nobody else.
 *
 * `team.manage` is `'always'` for a contractor because they run a team; which
 * people it reaches is `canManageMember`'s question. `setRole` and `remove`
 * used to ask only the first, so a contractor could promote, demote or remove
 * anyone in the business but the owner. Each test here is one of those
 * attempts, or a neighbour of it found by the same audit.
 *
 * The business: Terence owns it. Jo and Sam are contractors; Kevin works under
 * Jo, Priya under Sam, and Ali answers to Terence directly.
 */

async function join(
  t: TestApp,
  owner: TestActor,
  invitee: TestActor,
  businessId: Id<'businesses'>,
  role: 'subcontractor' | 'contractor',
) {
  const { url } = await owner.as.action(api.invitations.create, {
    businessId,
    email: invitee.email,
    role,
  })
  await invitee.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })
  const membership = await t.run(async (ctx) =>
    ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', invitee.userId).eq('businessId', businessId),
      )
      .unique(),
  )
  return membership!._id
}

async function business() {
  const t = testApp()
  const terence = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, terence)

  const person = async (name: string, role: 'subcontractor' | 'contractor') => {
    const actor = await createActor(t, { email: `${name}@coastal.test` })
    const membershipId = await join(t, terence, actor, businessId, role)
    return { actor, membershipId }
  }
  const jo = await person('jo', 'contractor')
  const sam = await person('sam', 'contractor')
  const kevin = await person('kevin', 'subcontractor')
  const priya = await person('priya', 'subcontractor')
  const ali = await person('ali', 'subcontractor')

  await terence.as.mutation(api.team.assignTo, {
    businessId,
    membershipId: kevin.membershipId,
    parentMembershipId: jo.membershipId,
  })
  await terence.as.mutation(api.team.assignTo, {
    businessId,
    membershipId: priya.membershipId,
    parentMembershipId: sam.membershipId,
  })

  return {
    t,
    businessId,
    terence,
    ownerMembershipId,
    jo: jo.actor,
    joId: jo.membershipId,
    samId: sam.membershipId,
    kevinId: kevin.membershipId,
    priyaId: priya.membershipId,
    aliId: ali.membershipId,
  }
}

type Business = Awaited<ReturnType<typeof business>>

async function row(s: Business, membershipId: Id<'memberships'>) {
  return (await s.t.run(async (ctx) => ctx.db.get(membershipId)))!
}

/** A visit booked for next week, so removing its assignee needs a successor. */
async function bookFor(s: Business, membershipId: Id<'memberships'>) {
  return s.t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId: s.businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId: s.businessId,
      clientId,
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: now,
    })
    return ctx.db.insert('jobs', {
      businessId: s.businessId,
      propertyId,
      assignedMembershipId: membershipId,
      jobType: 'General Pest Control',
      price: 20000,
      scheduledAt: now + 7 * 24 * 60 * 60 * 1000,
      durationMinutes: 60,
      status: 'booked',
      createdAt: now,
    })
  })
}

describe('changing someone’s role', () => {
  test('a contractor cannot promote someone outside their team', async () => {
    const s = await business()

    for (const membershipId of [s.aliId, s.priyaId]) {
      await expect(
        s.jo.as.mutation(api.memberships.setRole, {
          businessId: s.businessId,
          membershipId,
          role: 'contractor',
        }),
      ).rejects.toThrow(/NO_ACCESS/)
      expect((await row(s, membershipId)).role).toBe('subcontractor')
    }
  })

  test('a contractor cannot demote another contractor', async () => {
    const s = await business()

    await expect(
      s.jo.as.mutation(api.memberships.setRole, {
        businessId: s.businessId,
        membershipId: s.samId,
        role: 'subcontractor',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    expect((await row(s, s.samId)).role).toBe('contractor')
    expect((await row(s, s.priyaId)).parentMembershipId).toBe(s.samId)
  })

  test('nor promote their own people: roles are the owner’s to hand out', async () => {
    const s = await business()

    // Kevin is Jo's to manage, but making him a contractor takes him off her
    // team and gives him one of his own.
    await expect(
      s.jo.as.mutation(api.memberships.setRole, {
        businessId: s.businessId,
        membershipId: s.kevinId,
        role: 'contractor',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    const kevin = await row(s, s.kevinId)
    expect(kevin.role).toBe('subcontractor')
    expect(kevin.parentMembershipId).toBe(s.joId)
  })

  test('the owner still can, contractors included', async () => {
    const s = await business()

    await s.terence.as.mutation(api.memberships.setRole, {
      businessId: s.businessId,
      membershipId: s.aliId,
      role: 'contractor',
    })
    await s.terence.as.mutation(api.memberships.setRole, {
      businessId: s.businessId,
      membershipId: s.samId,
      role: 'subcontractor',
    })
    expect((await row(s, s.aliId)).role).toBe('contractor')
    expect((await row(s, s.samId)).role).toBe('subcontractor')
  })

  test('not while the owner is working in someone else’s account', async () => {
    const s = await business()
    await s.terence.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: s.kevinId,
    })

    await expect(
      s.terence.as.mutation(api.memberships.setRole, {
        businessId: s.businessId,
        membershipId: s.aliId,
        role: 'contractor',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })
})

describe('removing someone', () => {
  test('a contractor cannot remove someone outside their team', async () => {
    const s = await business()

    for (const membershipId of [s.aliId, s.priyaId]) {
      await expect(
        s.jo.as.mutation(api.team.remove, {
          businessId: s.businessId,
          membershipId,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
      expect((await row(s, membershipId)).status).toBe('active')
    }
  })

  test('a contractor cannot remove another contractor', async () => {
    const s = await business()

    await expect(
      s.jo.as.mutation(api.team.remove, {
        businessId: s.businessId,
        membershipId: s.samId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    expect((await row(s, s.samId)).status).toBe('active')
  })

  test('nor read what someone outside their team has on first', async () => {
    const s = await business()

    for (const membershipId of [s.samId, s.aliId, s.priyaId]) {
      await expect(
        s.jo.as.query(api.team.removalPreview, {
          businessId: s.businessId,
          membershipId,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
    }
    await expect(
      s.jo.as.query(api.team.removalPreview, {
        businessId: s.businessId,
        membershipId: s.kevinId,
      }),
    ).resolves.toMatchObject({ futureJobs: 0 })
  })

  test('a contractor removes their own people, and keeps the work in the team', async () => {
    const s = await business()
    const jobId = await bookFor(s, s.kevinId)

    // Not onto another contractor's calendar, nor the owner's: the same
    // people Jo could have booked it onto (`canDispatchTo`).
    for (const reassignTo of [s.priyaId, s.samId, s.ownerMembershipId]) {
      await expect(
        s.jo.as.mutation(api.team.remove, {
          businessId: s.businessId,
          membershipId: s.kevinId,
          reassignTo,
        }),
      ).rejects.toThrow(/INVALID_ASSIGNEE/)
    }
    expect((await row(s, s.kevinId)).status).toBe('active')

    await s.jo.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      reassignTo: s.joId,
    })
    expect((await row(s, s.kevinId)).status).toBe('removed')
    const job = await s.t.run(async (ctx) => ctx.db.get(jobId))
    expect(job?.assignedMembershipId).toBe(s.joId)
  })

  test('the owner still removes anyone but themselves, handing work to anyone', async () => {
    const s = await business()
    const jobId = await bookFor(s, s.aliId)

    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.aliId,
      reassignTo: s.priyaId,
    })
    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.samId,
    })
    expect((await row(s, s.aliId)).status).toBe('removed')
    expect((await row(s, s.samId)).status).toBe('removed')
    const job = await s.t.run(async (ctx) => ctx.db.get(jobId))
    expect(job?.assignedMembershipId).toBe(s.priyaId)
  })
})

describe('moving someone between teams', () => {
  test('a contractor cannot pull someone onto their team', async () => {
    const s = await business()

    for (const membershipId of [s.aliId, s.priyaId]) {
      await expect(
        s.jo.as.mutation(api.team.assignTo, {
          businessId: s.businessId,
          membershipId,
          parentMembershipId: s.joId,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
    }
    expect((await row(s, s.priyaId)).parentMembershipId).toBe(s.samId)
    expect((await row(s, s.aliId)).parentMembershipId).toBeUndefined()
  })

  test('nor hand their own people to another contractor', async () => {
    const s = await business()

    await expect(
      s.jo.as.mutation(api.team.assignTo, {
        businessId: s.businessId,
        membershipId: s.kevinId,
        parentMembershipId: s.samId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    expect((await row(s, s.kevinId)).parentMembershipId).toBe(s.joId)
  })

  test('but may let them go back to answering to the owner', async () => {
    const s = await business()

    await s.jo.as.mutation(api.team.assignTo, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      parentMembershipId: null,
    })
    expect((await row(s, s.kevinId)).parentMembershipId).toBeUndefined()
  })

  test('the owner moves anyone onto any contractor’s team', async () => {
    const s = await business()

    await s.terence.as.mutation(api.team.assignTo, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      parentMembershipId: s.samId,
    })
    expect((await row(s, s.kevinId)).parentMembershipId).toBe(s.samId)
  })
})

describe('access toggles', () => {
  test('a contractor sets them on their own team and nobody else', async () => {
    const s = await business()
    const grants = {
      switchInto: null,
      clientDirectory: true,
      prices: false,
      otherSchedules: false,
    }

    for (const membershipId of [s.samId, s.priyaId, s.aliId]) {
      await expect(
        s.jo.as.mutation(api.memberships.setGrants, {
          businessId: s.businessId,
          membershipId,
          grants,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
      await expect(
        s.jo.as.mutation(api.memberships.setCanViewOtherAccounts, {
          businessId: s.businessId,
          membershipId,
          canViewOtherAccounts: true,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
      await expect(
        s.jo.as.mutation(api.memberships.setCanViewAllJobs, {
          businessId: s.businessId,
          membershipId,
          canViewAllJobs: true,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
    }

    await expect(
      s.jo.as.mutation(api.memberships.setGrants, {
        businessId: s.businessId,
        membershipId: s.kevinId,
        grants,
      }),
    ).resolves.toMatchObject({ prices: false })
  })

  test('two-step reset is the owner’s alone, even for a contractor’s own team', async () => {
    const s = await business()

    await expect(
      s.jo.as.mutation(api.team.resetTwoFactor, {
        businessId: s.businessId,
        membershipId: s.kevinId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })
})

describe('invitations', () => {
  test('a contractor invites subcontractors, never contractors', async () => {
    const s = await business()

    await expect(
      s.jo.as.action(api.invitations.create, {
        businessId: s.businessId,
        email: 'newhire@coastal.test',
        role: 'contractor',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      s.jo.as.action(api.invitations.create, {
        businessId: s.businessId,
        email: 'newhire@coastal.test',
        role: 'subcontractor',
      }),
    ).resolves.toMatchObject({ url: expect.stringContaining('/join/') })

    // The legacy invite path, which a stale Team screen may still reach.
    const stranger = await createActor(s.t, { email: 'stranger@else.test' })
    await expect(
      s.jo.as.mutation(api.memberships.invite, {
        businessId: s.businessId,
        userId: stranger.userId,
        role: 'contractor',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('a contractor cannot withdraw or reissue the owner’s invitation', async () => {
    const s = await business()
    const { invitationId } = await s.terence.as.action(api.invitations.create, {
      businessId: s.businessId,
      email: 'newhire@coastal.test',
      role: 'contractor',
    })
    const before = await s.t.run(async (ctx) => ctx.db.get(invitationId))

    await expect(
      s.jo.as.action(api.invitations.regenerate, {
        businessId: s.businessId,
        invitationId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      s.jo.as.mutation(api.invitations.revoke, {
        businessId: s.businessId,
        invitationId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      s.jo.as.mutation(api.memberships.revokeInvitation, {
        businessId: s.businessId,
        invitationId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)

    const after = await s.t.run(async (ctx) => ctx.db.get(invitationId))
    expect(after?.revokedAt).toBeUndefined()
    expect(after?.tokenHash).toBe(before?.tokenHash)
  })

  test('a contractor manages their own invitations; the owner manages any', async () => {
    const s = await business()
    const { invitationId } = await s.jo.as.action(api.invitations.create, {
      businessId: s.businessId,
      email: 'newhire@coastal.test',
      role: 'subcontractor',
    })

    await s.jo.as.action(api.invitations.regenerate, {
      businessId: s.businessId,
      invitationId,
    })
    await s.terence.as.action(api.invitations.regenerate, {
      businessId: s.businessId,
      invitationId,
    })
    await s.jo.as.mutation(api.invitations.revoke, {
      businessId: s.businessId,
      invitationId,
    })
    const revoked = await s.t.run(async (ctx) => ctx.db.get(invitationId))
    expect(revoked?.revokedAt).toBeTypeOf('number')
  })

  test('an owner invitation from before the rules is not reissued, even by the owner', async () => {
    const s = await business()
    const invitationId = await s.t.run(async (ctx) =>
      ctx.db.insert('invitations', {
        businessId: s.businessId,
        email: 'second-owner@coastal.test',
        role: 'owner',
        invitedByMembershipId: s.ownerMembershipId,
        createdAt: Date.now(),
        tokenHash: 'legacy-hash',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
    )

    await expect(
      s.terence.as.action(api.invitations.regenerate, {
        businessId: s.businessId,
        invitationId,
      }),
    ).rejects.toThrow(/OWNER_INVITE_FORBIDDEN/)
  })
})

/**
 * The Team screen offers a control only where its row says the server will
 * accept it, so each flag must be computed by the function the mutation
 * enforces. These pin the flags against the same business the refusals above
 * are tested on.
 */
describe('what the Team screen is told', () => {
  test('the owner may change every role but their own, and hand work to anyone', async () => {
    const s = await business()
    const roster = await s.terence.as.query(api.team.roster, {
      businessId: s.businessId,
    })
    const byId = new Map(roster.map((m) => [m._id, m]))

    expect(byId.get(s.ownerMembershipId)).toMatchObject({
      canManage: false,
      canSetRole: false,
      bookable: true,
    })
    for (const id of [s.joId, s.samId, s.kevinId, s.priyaId, s.aliId]) {
      expect(byId.get(id)).toMatchObject({
        canManage: true,
        canSetRole: true,
        bookable: true,
      })
    }
  })

  test('a contractor manages only their own team, sets no roles, and hands work only within it', async () => {
    const s = await business()
    const roster = await s.jo.as.query(api.team.roster, {
      businessId: s.businessId,
    })
    const flags = Object.fromEntries(
      roster.map((m) => [m._id, [m.canManage, m.canSetRole, m.bookable]]),
    )

    expect(flags).toEqual({
      [s.ownerMembershipId]: [false, false, false],
      [s.joId]: [false, false, true],
      [s.samId]: [false, false, false],
      [s.kevinId]: [true, false, true],
      [s.priyaId]: [false, false, false],
      [s.aliId]: [false, false, false],
    })
  })

  test('invitations say who may withdraw and reissue them', async () => {
    const s = await business()
    const { invitationId: joSent } = await s.jo.as.action(
      api.invitations.create,
      {
        businessId: s.businessId,
        email: 'jo-hire@coastal.test',
        role: 'subcontractor',
      },
    )
    const { invitationId: ownerSent } = await s.terence.as.action(
      api.invitations.create,
      {
        businessId: s.businessId,
        email: 'owner-hire@coastal.test',
        role: 'contractor',
      },
    )
    // From before the rules: nobody may reissue an owner invitation, the owner
    // included, though the owner may still withdraw it.
    const legacyOwner = await s.t.run(async (ctx) =>
      ctx.db.insert('invitations', {
        businessId: s.businessId,
        email: 'second-owner@coastal.test',
        role: 'owner',
        invitedByMembershipId: s.ownerMembershipId,
        createdAt: Date.now(),
        tokenHash: 'legacy-hash',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
    )

    const flagsFor = async (who: TestActor) =>
      Object.fromEntries(
        (
          await who.as.query(api.invitations.listForBusiness, {
            businessId: s.businessId,
          })
        ).map((i) => [i._id, [i.canManage, i.canReissue]]),
      )

    expect(await flagsFor(s.terence)).toEqual({
      [joSent]: [true, true],
      [ownerSent]: [true, true],
      [legacyOwner]: [true, false],
    })
    expect(await flagsFor(s.jo)).toEqual({
      [joSent]: [true, true],
      [ownerSent]: [false, false],
      [legacyOwner]: [false, false],
    })
  })
})
