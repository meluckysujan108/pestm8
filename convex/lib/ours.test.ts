/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../../test/harness'
import { requireActor } from './actor'
import { oursFor, oursKeys } from './clientMatch'
import { oursOfCaller } from './ours'
import type { OursSource } from './clientMatch'
import type { TestActor } from '../../test/harness'
import type { Id } from '../_generated/dataModel'

/**
 * The business's and the team's own numbers and emails, as the server's
 * check leaves them out when a booking saves (lib/ours.ts): for the person
 * saving, exactly as their own phone leaves them out. Every active member's
 * only for someone who manages the team; for anyone else the business's and
 * their own, so whether the server refuses never says whether a number is a
 * team member's. The directory never reads these (clientDirectory.test.ts
 * holds it to that).
 */

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, { email: 'kevin@coastal.test' })
  const kevinId = await joinBusiness(
    t,
    owner,
    kevin,
    businessId,
    'subcontractor',
  )
  const dana = await createActor(t, { email: 'dana@coastal.test' })
  const danaId = await joinBusiness(t, owner, dana, businessId, 'contractor')
  const former = await createActor(t, { email: 'former@coastal.test' })
  await t.run(async (ctx) => {
    await ctx.db.patch(businessId, {
      phone: '(08) 9272 0000',
      email: 'office@coastal.test',
      reportCopyEmail: 'copies@coastal.test',
    })
    await ctx.db.patch(ownerMembershipId, { phone: '0412 000 111' })
    await ctx.db.patch(kevinId, { phone: '0433 222 333' })
    await ctx.db.patch(danaId, { phone: '0455 444 555' })
    // Someone who has left: their number is nobody's in particular now.
    await ctx.db.insert('memberships', {
      userId: former.userId,
      businessId,
      role: 'subcontractor',
      canViewAllJobs: false,
      colour: '#000000',
      status: 'removed',
      phone: '0499 000 999',
      createdAt: Date.now(),
    })
  })
  return { t, owner, kevin, dana, businessId }
}

type Setup = Awaited<ReturnType<typeof setup>>

function serverOurs(s: Setup, actor: TestActor): Promise<OursSource> {
  return actor.as.run(async (ctx) => {
    const env = await requireActor(ctx, s.businessId)
    const business = await ctx.db.get(s.businessId)
    return oursOfCaller(ctx, env, business!)
  })
}

/** What their phone leaves out, built as src/lib/useMatchIndex.ts builds it
 * from what the phone holds: `businesses.getBySlug`, the roster and
 * `access.me`. */
async function phoneOurs(actor: TestActor, businessId: Id<'businesses'>) {
  const business = (await actor.as.query(api.businesses.getBySlug, {
    slug: 'coastal-pest',
  }))!
  const members = await actor.as.query(api.memberships.listForBusiness, {
    businessId,
  })
  const access = await actor.as.query(api.access.me, { businessId })
  const self = members.find((m) => m._id === access.membershipId)
  const seesTeam = access.caps['team.manage']
  return oursFor({
    business: { phone: business.phone, email: business.email },
    self: {
      phone: self?.phone ?? business.membership.phone,
      email: self?.email,
    },
    seesTeam,
    team: seesTeam ? members : null,
  })
}

const sorted = (ours: OursSource) => ({
  phones: [...ours.phones].sort(),
  emails: [...ours.emails].sort(),
})

describe('oursOfCaller', () => {
  test('for the owner: the business’s phone and email, and every active member’s phone and sign-in email', async () => {
    const s = await setup()
    expect(sorted(await serverOurs(s, s.owner))).toEqual({
      phones: [
        '(08) 9272 0000',
        '0412 000 111',
        '0412 000 111',
        '0433 222 333',
        '0455 444 555',
      ],
      emails: [
        'dana@coastal.test',
        'kevin@coastal.test',
        'office@coastal.test',
        'terence@coastal.test',
        'terence@coastal.test',
      ],
    })
  })

  test('for a subcontractor: the business’s, and only their own of the team’s', async () => {
    const s = await setup()
    expect(sorted(await serverOurs(s, s.kevin))).toEqual({
      phones: ['(08) 9272 0000', '0433 222 333'],
      emails: ['kevin@coastal.test', 'office@coastal.test'],
    })
  })

  test('for a contractor, who manages a team and reads the whole roster: everyone’s', async () => {
    const s = await setup()
    const ours = sorted(await serverOurs(s, s.dana))
    expect(ours.phones).toContain('0412 000 111')
    expect(ours.phones).toContain('0433 222 333')
    expect(ours.emails).toContain('terence@coastal.test')
  })

  test('never a removed member’s, nor the report copy address, which the phone doesn’t hold', async () => {
    const s = await setup()
    for (const actor of [s.owner, s.kevin, s.dana]) {
      const ours = await serverOurs(s, actor)
      expect(ours.phones).not.toContain('0499 000 999')
      expect(ours.emails).not.toContain('former@coastal.test')
      expect(ours.emails).not.toContain('copies@coastal.test')
    }
  })

  test('is what each person’s own phone leaves out, key for key', async () => {
    const s = await setup()
    for (const actor of [s.owner, s.kevin, s.dana]) {
      const server = oursKeys(await serverOurs(s, actor), '08')
      const phone = oursKeys(await phoneOurs(actor, s.businessId), '08')
      expect([...server.phones].sort()).toEqual([...phone.phones].sort())
      expect([...server.emails].sort()).toEqual([...phone.emails].sort())
    }
  })
})
