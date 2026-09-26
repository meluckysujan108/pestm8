/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import {
  addSession,
  createActor,
  createBusiness,
  testApp,
} from '../test/harness'
import { hashInviteToken } from './lib/inviteTokens'
import { NO_GRANTS } from './lib/capabilities'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * Who an invitee answers to once they join, and how long a contractor's
 * invitations stay good.
 *
 * Nothing used to set a joiner's team. A contractor's invitee arrived
 * answering to the owner, so the contractor could not book, manage or even
 * see the person they had just recruited. And a rejoiner came back pointing at
 * whatever team they had left, whoever re-invited them. A contractor's links
 * also outlived their authority to send them.
 *
 * The business: Terence owns it. Jo and Sam are contractors; Kevin works under
 * Jo.
 */

type Role = 'subcontractor' | 'contractor'

async function send(
  sender: TestActor,
  businessId: Id<'businesses'>,
  email: string,
  role: Role = 'subcontractor',
) {
  const { invitationId, url } = await sender.as.action(api.invitations.create, {
    businessId,
    email,
    role,
  })
  return { invitationId, token: url.split('/join/')[1] }
}

async function membershipOf(
  t: TestApp,
  who: TestActor,
  businessId: Id<'businesses'>,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', who.userId).eq('businessId', businessId),
      )
      .unique(),
  )
}

async function business() {
  const t = testApp()
  const terence = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId } = await createBusiness(t, terence)

  const join = async (name: string, role: Role, by: TestActor = terence) => {
    const actor = await createActor(t, { email: `${name}@coastal.test` })
    const { token } = await send(by, businessId, actor.email, role)
    await actor.as.action(api.invitations.redeem, { token })
    return { actor, id: (await membershipOf(t, actor, businessId))!._id }
  }
  const jo = await join('jo', 'contractor')
  const sam = await join('sam', 'contractor')
  const kevin = await join('kevin', 'subcontractor')
  await terence.as.mutation(api.team.assignTo, {
    businessId,
    membershipId: kevin.id,
    parentMembershipId: jo.id,
  })

  return { t, businessId, terence, jo, sam, kevin, join }
}

type Business = Awaited<ReturnType<typeof business>>

async function invitation(s: Business, id: Id<'invitations'>) {
  return (await s.t.run(async (ctx) => ctx.db.get(id)))!
}

describe('who a joiner answers to', () => {
  test('a contractor’s invitee joins their team, and the contractor can work with them', async () => {
    const s = await business()
    const tom = await s.join('tom', 'subcontractor', s.jo.actor)

    expect(
      (await membershipOf(s.t, tom.actor, s.businessId))?.parentMembershipId,
    ).toBe(s.jo.id)

    // The point of it: Jo manages Tom, and can book work onto him.
    const roster = await s.jo.actor.as.query(api.team.roster, {
      businessId: s.businessId,
    })
    expect(roster.find((m) => m._id === tom.id)?.canManage).toBe(true)
    const people = await s.jo.actor.as.query(api.memberships.listForBusiness, {
      businessId: s.businessId,
    })
    expect(people.find((m) => m._id === tom.id)?.bookable).toBe(true)
  })

  test('the owner’s invitees answer to the owner, contractors included', async () => {
    const s = await business()
    const ann = await s.join('ann', 'subcontractor')
    const lee = await s.join('lee', 'contractor')

    expect(
      (await membershipOf(s.t, ann.actor, s.businessId))?.parentMembershipId,
    ).toBeUndefined()
    expect(
      (await membershipOf(s.t, lee.actor, s.businessId))?.parentMembershipId,
    ).toBeUndefined()
  })

  test('removing someone takes them off their team', async () => {
    const s = await business()
    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevin.id,
    })
    expect(
      (await membershipOf(s.t, s.kevin.actor, s.businessId))
        ?.parentMembershipId,
    ).toBeUndefined()
  })

  test('a rejoiner lands where the new invitation says, not on their old team', async () => {
    const s = await business()
    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevin.id,
    })
    // As a row removed before removal cleared the pointer: still under Jo,
    // and still holding what Jo once gave him.
    await s.t.run(async (ctx) =>
      ctx.db.patch(s.kevin.id, {
        parentMembershipId: s.jo.id,
        grants: { ...NO_GRANTS, prices: true },
      }),
    )

    // Re-invited by the owner: back answering to the owner, with nothing.
    // Removal signed him out everywhere; he signs in again to use the link.
    const kevin = await addSession(s.t, s.kevin.actor)
    const { token } = await send(s.terence, s.businessId, kevin.email)
    await kevin.as.action(api.invitations.redeem, { token })
    const back = await membershipOf(s.t, s.kevin.actor, s.businessId)
    expect(back?._id).toBe(s.kevin.id)
    expect(back?.parentMembershipId).toBeUndefined()
    expect(back?.grants).toEqual(NO_GRANTS)
  })

  test('a rejoiner re-invited by a contractor joins that contractor’s team', async () => {
    const s = await business()
    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevin.id,
    })

    const kevin = await addSession(s.t, s.kevin.actor)
    const { token } = await send(s.sam.actor, s.businessId, kevin.email)
    await kevin.as.action(api.invitations.redeem, { token })
    expect(
      (await membershipOf(s.t, s.kevin.actor, s.businessId))
        ?.parentMembershipId,
    ).toBe(s.sam.id)
  })
})

describe('a contractor’s links end with their authority to send them', () => {
  test('demoting a contractor withdraws their unused links, and nobody else’s', async () => {
    const s = await business()
    const tom = await createActor(s.t, { email: 'tom@coastal.test' })
    const jos = [
      await send(s.jo.actor, s.businessId, tom.email),
      await send(s.jo.actor, s.businessId, 'uma@coastal.test'),
    ]
    const sams = await send(s.sam.actor, s.businessId, 'val@coastal.test')
    const owners = await send(s.terence, s.businessId, 'wes@coastal.test')
    // One of Jo's has already been used: the record of how Rae joined is
    // not withdrawn after the fact.
    const rae = await s.join('rae', 'subcontractor', s.jo.actor)
    const raes = (await s.t.run(async (ctx) =>
      (await ctx.db.query('invitations').collect()).find(
        (i) => i.claimedMembershipId === rae.id,
      ),
    ))!

    await s.terence.as.mutation(api.memberships.setRole, {
      businessId: s.businessId,
      membershipId: s.jo.id,
      role: 'subcontractor',
    })

    for (const { invitationId } of jos) {
      expect((await invitation(s, invitationId)).revokedAt).toBeTypeOf('number')
    }
    expect((await invitation(s, sams.invitationId)).revokedAt).toBeUndefined()
    expect((await invitation(s, owners.invitationId)).revokedAt).toBeUndefined()
    expect((await invitation(s, raes._id)).revokedAt).toBeUndefined()

    // What Tom sees when he opens Jo's link now.
    await expect(
      tom.as.action(api.invitations.redeem, { token: jos[0].token }),
    ).rejects.toThrow(/INVITE_REVOKED/)

    const audits = await s.t.run(async (ctx) =>
      ctx.db.query('auditLog').collect(),
    )
    expect(
      audits.filter(
        (a) =>
          a.action === 'invitation.revoke' &&
          (a.meta as { reason?: string }).reason === 'sender.demoted',
      ),
    ).toHaveLength(2)
    expect(
      audits.find((a) => a.action === 'membership.setRole')?.meta,
    ).toMatchObject({
      revokedInvitations: 2,
    })
  })

  test('removing a contractor withdraws them, and so does one leaving', async () => {
    const s = await business()
    const fromJo = await send(s.jo.actor, s.businessId, 'uma@coastal.test')
    const fromSam = await send(s.sam.actor, s.businessId, 'val@coastal.test')

    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.jo.id,
    })
    await s.sam.actor.as.mutation(api.team.leave, { businessId: s.businessId })

    expect((await invitation(s, fromJo.invitationId)).revokedAt).toBeTypeOf(
      'number',
    )
    expect((await invitation(s, fromSam.invitationId)).revokedAt).toBeTypeOf(
      'number',
    )
  })

  test('a link the withdrawal never reached is refused everywhere it is read', async () => {
    const s = await business()
    const tom = await createActor(s.t, { email: 'tom@coastal.test' })
    const { token } = await send(s.jo.actor, s.businessId, tom.email)
    // Jo stopped being a contractor by a path that did not withdraw her
    // links — a demotion from before this rule, say.
    await s.t.run(async (ctx) =>
      ctx.db.patch(s.jo.id, { role: 'subcontractor' }),
    )

    const preview = await s.t.action(api.invitations.preview, { token })
    expect(preview.state).toBe('revoked')
    expect(preview.businessName).toBeNull()

    const signUp = await s.t.query(internal.invitations.checkForSignUp, {
      tokenHash: await hashInviteToken(token),
      email: tom.email,
    })
    expect(signUp).toEqual({ ok: false, code: 'INVITE_REVOKED' })

    await expect(
      tom.as.action(api.invitations.redeem, { token }),
    ).rejects.toThrow(/INVITE_REVOKED/)
    expect(await membershipOf(s.t, tom, s.businessId)).toBeNull()
  })
})
