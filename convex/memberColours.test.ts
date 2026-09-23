/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, testApp } from '../test/harness'
import { MEMBER_COLOURS } from './lib/colours'
import type { Id } from './_generated/dataModel'

/**
 * Technician colours (Phase 4.2), through the real mutations: how they are
 * dealt when a business starts and people join, who may change one, and what
 * a change leaves behind.
 */

async function setup() {
  const t = testApp()
  const owner = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
  const { businessId } = await owner.as.mutation(api.businesses.create, {
    name: 'Coastal Pest',
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  const kevin = await createActor(t, {
    email: 'kevin@coastal.test',
    name: 'Kevin',
  })
  const { url } = await owner.as.action(api.invitations.create, {
    businessId,
    email: kevin.email,
    role: 'subcontractor',
  })
  await kevin.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })

  const rows = await t.run((ctx) =>
    ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect(),
  )
  const ownerId = rows.find((m) => m.role === 'owner')!._id
  const kevinId = rows.find((m) => m.userId === kevin.userId)!._id
  return { t, owner, kevin, businessId, ownerId, kevinId }
}

type Setup = Awaited<ReturnType<typeof setup>>

const colourOf = (s: Setup, id: Id<'memberships'>) =>
  s.t.run(async (ctx) => (await ctx.db.get(id))!.colour)

const colourAudits = (s: Setup) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query('auditLog').collect()).filter(
      (row) => row.action === 'membership.setColour',
    ),
  )

describe('dealing colours', () => {
  test('a business started by Terence, with Kevin joining, comes out Terence blue and Kevin orange', async () => {
    const s = await setup()
    expect(await colourOf(s, s.ownerId)).toBe(MEMBER_COLOURS[0])
    expect(await colourOf(s, s.kevinId)).toBe(MEMBER_COLOURS[1])
    expect(MEMBER_COLOURS[0]).toBe('#0A84FF')
    expect(MEMBER_COLOURS[1]).toBe('#E35F00')
  })
})

describe('setting a colour', () => {
  test('the owner sets their own, and it is audited with where it came from', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.memberships.setColour, {
      businessId: s.businessId,
      membershipId: s.ownerId,
      colour: '#0F766E',
    })
    expect(await colourOf(s, s.ownerId)).toBe('#0F766E')

    const audits = await colourAudits(s)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      entityId: s.ownerId,
      meta: { from: MEMBER_COLOURS[0], to: '#0F766E' },
    })
  })

  test('the owner sets someone else’s, typed any case', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.memberships.setColour, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      colour: ' #db2777 ',
    })
    expect(await colourOf(s, s.kevinId)).toBe('#DB2777')
  })

  test('the same colour again writes nothing and records nothing', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.memberships.setColour, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      colour: MEMBER_COLOURS[1].toLowerCase(),
    })
    expect(await colourAudits(s)).toHaveLength(0)
  })

  test('two people may share a colour', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.memberships.setColour, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      colour: MEMBER_COLOURS[0],
    })
    expect(await colourOf(s, s.kevinId)).toBe(await colourOf(s, s.ownerId))
  })

  test('only the palette: not the brand red, and not anything else', async () => {
    const s = await setup()
    for (const colour of ['#FF3B30', '#123456', 'red', '#0A84FF; x']) {
      await expect(
        s.owner.as.mutation(api.memberships.setColour, {
          businessId: s.businessId,
          membershipId: s.kevinId,
          colour,
        }),
      ).rejects.toThrow(/INVALID_COLOUR/)
    }
    expect(await colourOf(s, s.kevinId)).toBe(MEMBER_COLOURS[1])
  })

  test('nobody but the owner — Kevin cannot set his own, or the owner’s', async () => {
    const s = await setup()
    for (const membershipId of [s.kevinId, s.ownerId]) {
      await expect(
        s.kevin.as.mutation(api.memberships.setColour, {
          businessId: s.businessId,
          membershipId,
          colour: MEMBER_COLOURS[3],
        }),
      ).rejects.toThrow(/NO_ACCESS/)
    }
  })

  test('someone in another business is not found', async () => {
    const s = await setup()
    const other = await createActor(s.t, { email: 'other@elsewhere.test' })
    const { businessId: otherBusiness } = await other.as.mutation(
      api.businesses.create,
      { name: 'Elsewhere Pest', state: 'WA', timezone: 'Australia/Perth' },
    )
    await expect(
      other.as.mutation(api.memberships.setColour, {
        businessId: otherBusiness,
        membershipId: s.kevinId,
        colour: MEMBER_COLOURS[2],
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })
})

describe('what the screens are told', () => {
  test('the Team roster says who may set whose colour', async () => {
    const s = await setup()
    const roster = await s.owner.as.query(api.team.roster, {
      businessId: s.businessId,
    })
    expect(roster.map((m) => m.canSetColour)).toEqual([true, true])
  })

  test('the sidebar’s business list carries your own current colour', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.memberships.setColour, {
      businessId: s.businessId,
      membershipId: s.ownerId,
      colour: '#9333EA',
    })
    const mine = await s.owner.as.query(api.businesses.listForUser, {})
    expect(mine.find((b) => b.businessId === s.businessId)?.colour).toBe(
      '#9333EA',
    )
  })
})
