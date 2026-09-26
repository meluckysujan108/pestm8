/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import {
  addSession,
  createActor,
  createBusiness,
  testApp,
} from '../test/harness'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'
import type { Grants } from './lib/capabilities'

/**
 * A contractor who stops being one — demoted, removed, or leaving — used to
 * leave their team pointing at them. Still capped by that person's toggles on
 * every read, still listed under them, and out of reach of the owner's "Works
 * under" picker, which only offers contractors. These pin the release that now
 * comes with it: the team answers to the owner, and each keeps exactly what
 * they could see a moment before.
 *
 * The business: Terence owns it. Jo is a contractor with Kevin and Mia on her
 * team; Sam is a contractor with Priya.
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
  const { businessId, ownerMembershipId: ownerId } = await createBusiness(
    t,
    terence,
  )

  const person = async (name: string, role: 'subcontractor' | 'contractor') => {
    const actor = await createActor(t, { email: `${name}@coastal.test` })
    return { actor, id: await join(t, terence, actor, businessId, role) }
  }
  const jo = await person('jo', 'contractor')
  const sam = await person('sam', 'contractor')
  const kevin = await person('kevin', 'subcontractor')
  const mia = await person('mia', 'subcontractor')
  const priya = await person('priya', 'subcontractor')

  for (const [member, parent] of [
    [kevin, jo],
    [mia, jo],
    [priya, sam],
  ] as const) {
    await terence.as.mutation(api.team.assignTo, {
      businessId,
      membershipId: member.id,
      parentMembershipId: parent.id,
    })
  }

  return { t, businessId, terence, ownerId, jo, sam, kevin, mia, priya }
}

type Business = Awaited<ReturnType<typeof business>>

async function row(s: Business, id: Id<'memberships'>) {
  return (await s.t.run(async (ctx) => ctx.db.get(id)))!
}

async function setGrants(s: Business, id: Id<'memberships'>, grants: Grants) {
  await s.t.run(async (ctx) => ctx.db.patch(id, { grants }))
}

async function caps(s: Business, who: TestActor) {
  return (await who.as.query(api.access.me, { businessId: s.businessId })).caps
}

async function releaseAudits(s: Business) {
  return s.t.run(async (ctx) =>
    (await ctx.db.query('auditLog').collect()).filter(
      (r) =>
        r.action === 'membership.assignTo' &&
        (r.meta as { reason?: string } | undefined)?.reason !== undefined,
    ),
  )
}

const ALL_ON: Grants = {
  switchInto: null,
  clientDirectory: true,
  prices: true,
  otherSchedules: true,
}

describe('demoting a contractor', () => {
  test('hands their team to the owner, and moves nobody else’s', async () => {
    const s = await business()

    await s.terence.as.mutation(api.memberships.setRole, {
      businessId: s.businessId,
      membershipId: s.jo.id,
      role: 'subcontractor',
    })

    expect((await row(s, s.kevin.id)).parentMembershipId).toBeUndefined()
    expect((await row(s, s.mia.id)).parentMembershipId).toBeUndefined()
    expect((await row(s, s.priya.id)).parentMembershipId).toBe(s.sam.id)

    // Answering to the owner is a place the "Works under" picker can move
    // them on from — pointing at a demoted contractor was not.
    await s.terence.as.mutation(api.team.assignTo, {
      businessId: s.businessId,
      membershipId: s.kevin.id,
      parentMembershipId: s.sam.id,
    })
    expect((await row(s, s.kevin.id)).parentMembershipId).toBe(s.sam.id)
  })

  test('each keeps exactly what they could see — never more, never less', async () => {
    const s = await business()
    // The owner turned Jo's own "see prices" off. Kevin's row still says on,
    // held off by her ceiling; his "see everyone's schedule" is really on.
    await setGrants(s, s.jo.id, { ...ALL_ON, prices: false })
    await setGrants(s, s.kevin.id, { ...ALL_ON, switchInto: s.jo.id })
    const before = await caps(s, s.kevin.actor)
    expect(before['prices.see']).toBe(false)
    expect(before['schedules.seeOthers']).toBe(true)

    await s.terence.as.mutation(api.memberships.setRole, {
      businessId: s.businessId,
      membershipId: s.jo.id,
      role: 'subcontractor',
    })

    const after = await caps(s, s.kevin.actor)
    expect(after['prices.see']).toBe(false)
    expect(after['schedules.seeOthers']).toBe(true)
    const kevin = await row(s, s.kevin.id)
    expect(kevin.grants).toEqual({ ...ALL_ON, prices: false })
    expect(kevin.canViewAllJobs).toBe(true)
  })

  test('ends switches between them, and leaves the owner’s alone', async () => {
    const s = await business()
    // Mia may work in Jo's account; Jo is in Kevin's; the owner, from his
    // office iPad, is in Mia's.
    await s.terence.as.mutation(api.memberships.setGrants, {
      businessId: s.businessId,
      membershipId: s.mia.id,
      grants: { ...ALL_ON, switchInto: s.jo.id },
    })
    await s.mia.actor.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: s.jo.id,
    })
    await s.jo.actor.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: s.kevin.id,
    })
    const ipad = await addSession(s.t, s.terence)
    await ipad.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: s.mia.id,
    })

    await s.terence.as.mutation(api.memberships.setRole, {
      businessId: s.businessId,
      membershipId: s.jo.id,
      role: 'subcontractor',
    })

    const switches = await s.t.run(async (ctx) =>
      ctx.db.query('accountSwitches').collect(),
    )
    expect(
      switches.map((r) => [r.realMembershipId, r.targetMembershipId]),
    ).toEqual([[s.ownerId, s.mia.id]])
  })

  test('is recorded against each person released, and on the demotion', async () => {
    const s = await business()
    await s.terence.as.mutation(api.memberships.setRole, {
      businessId: s.businessId,
      membershipId: s.jo.id,
      role: 'subcontractor',
    })

    const released = await releaseAudits(s)
    expect(released.map((r) => r.entityId).sort()).toEqual(
      [s.kevin.id, s.mia.id].sort(),
    )
    expect(released[0].meta).toMatchObject({
      parentMembershipId: null,
      reason: 'contractor.demoted',
      formerParentMembershipId: s.jo.id,
    })
    const setRole = await s.t.run(async (ctx) =>
      (await ctx.db.query('auditLog').collect()).find(
        (r) => r.action === 'membership.setRole',
      ),
    )
    expect(setRole?.meta).toEqual({ role: 'subcontractor', releasedTeam: 2 })
  })
})

describe('removing a contractor, or a contractor leaving', () => {
  test('their team keeps prices and the schedule, and answers to the owner', async () => {
    const s = await business()
    await setGrants(s, s.jo.id, ALL_ON)
    await setGrants(s, s.kevin.id, ALL_ON)
    expect(await caps(s, s.kevin.actor)).toMatchObject({
      'prices.see': true,
      'schedules.seeOthers': true,
    })

    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.jo.id,
    })

    // A removed contractor holds no grants. Left as Kevin's ceiling, that
    // took both of these away from him the moment Jo was removed.
    expect(await caps(s, s.kevin.actor)).toMatchObject({
      'prices.see': true,
      'schedules.seeOthers': true,
    })
    expect((await row(s, s.kevin.id)).parentMembershipId).toBeUndefined()
    expect((await releaseAudits(s))[0].meta).toMatchObject({
      reason: 'contractor.removed',
    })
  })

  test('a contractor who leaves releases their team the same way', async () => {
    const s = await business()
    await s.jo.actor.as.mutation(api.team.leave, { businessId: s.businessId })

    expect((await row(s, s.kevin.id)).parentMembershipId).toBeUndefined()
    expect((await row(s, s.mia.id)).parentMembershipId).toBeUndefined()
    expect((await releaseAudits(s))[0].meta).toMatchObject({
      reason: 'contractor.left',
    })
  })
})

describe('nothing else moves', () => {
  test('someone who already left loses the pointer, and nothing else', async () => {
    const s = await business()
    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.mia.id,
    })
    // Removal clears it now, but a row removed before that did not, and
    // still points at Jo. Rebuilt here as such a row.
    await s.t.run(async (ctx) =>
      ctx.db.patch(s.mia.id, { parentMembershipId: s.jo.id }),
    )
    const grantsBefore = (await row(s, s.mia.id)).grants

    await s.terence.as.mutation(api.memberships.setRole, {
      businessId: s.businessId,
      membershipId: s.jo.id,
      role: 'subcontractor',
    })

    const mia = await row(s, s.mia.id)
    expect(mia.parentMembershipId).toBeUndefined()
    expect(mia.grants).toEqual(grantsBefore)
    expect((await releaseAudits(s)).map((r) => r.entityId)).toEqual([
      s.kevin.id,
    ])
  })

  test('a role change that is not a demotion releases nobody', async () => {
    const s = await business()
    // Sam stays a contractor; Kevin is promoted out of Jo's team.
    await s.terence.as.mutation(api.memberships.setRole, {
      businessId: s.businessId,
      membershipId: s.sam.id,
      role: 'contractor',
    })
    await s.terence.as.mutation(api.memberships.setRole, {
      businessId: s.businessId,
      membershipId: s.kevin.id,
      role: 'contractor',
    })

    expect((await row(s, s.priya.id)).parentMembershipId).toBe(s.sam.id)
    expect((await row(s, s.mia.id)).parentMembershipId).toBe(s.jo.id)
    expect(await releaseAudits(s)).toEqual([])
  })
})
