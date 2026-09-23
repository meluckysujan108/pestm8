/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import { addSession, createActor, testApp } from '../test/harness'
import type { TestActor } from '../test/harness'
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
  test('a business started by Terence, with Kevin joining, comes out Terence blue and Kevin red', async () => {
    const s = await setup()
    expect(await colourOf(s, s.ownerId)).toBe(MEMBER_COLOURS[0])
    expect(await colourOf(s, s.kevinId)).toBe(MEMBER_COLOURS[1])
    expect(MEMBER_COLOURS[0]).toBe('#0A84FF')
    expect(MEMBER_COLOURS[1]).toBe('#DC2626')
  })
})

async function joinAs(s: Setup, actor: TestActor) {
  const { url } = await s.owner.as.action(api.invitations.create, {
    businessId: s.businessId,
    email: actor.email,
    role: 'subcontractor',
  })
  await actor.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })
  return s.t.run(
    async (ctx) =>
      (
        await ctx.db
          .query('memberships')
          .withIndex('by_business', (q) => q.eq('businessId', s.businessId))
          .collect()
      ).find((m) => m.userId === actor.userId)!._id,
  )
}

function removeKevin(s: Setup) {
  return s.owner.as.mutation(api.team.remove, {
    businessId: s.businessId,
    membershipId: s.kevinId,
  })
}

/** Removal ends a person's sessions, so coming back starts with signing in. */
async function kevinRejoins(s: Setup) {
  await joinAs(s, await addSession(s.t, s.kevin))
}

describe('dealing colours as people leave and come back', () => {
  test('someone who left does not hold a colour back from the next person', async () => {
    const s = await setup()
    await removeKevin(s)
    const priya = await createActor(s.t, { email: 'priya@coastal.test' })
    const priyaId = await joinAs(s, priya)
    // Kevin's red is free again, so it is the next colour dealt.
    expect(await colourOf(s, priyaId)).toBe(MEMBER_COLOURS[1])
  })

  test('someone coming back gets their own colour, if it is still theirs to have', async () => {
    const s = await setup()
    await removeKevin(s)
    await kevinRejoins(s)
    expect(await colourOf(s, s.kevinId)).toBe(MEMBER_COLOURS[1])
  })

  test('…and a fresh one if it was dealt to someone else while they were away', async () => {
    const s = await setup()
    await removeKevin(s)
    const priya = await createActor(s.t, { email: 'priya@coastal.test' })
    const priyaId = await joinAs(s, priya)
    await kevinRejoins(s)
    expect(await colourOf(s, priyaId)).toBe(MEMBER_COLOURS[1])
    expect(await colourOf(s, s.kevinId)).toBe(MEMBER_COLOURS[2])
  })

  test('a colour from before the palette is replaced when they come back', async () => {
    const s = await setup()
    await s.t.run((ctx) => ctx.db.patch(s.kevinId, { colour: '#FF3B30' }))
    await removeKevin(s)
    await kevinRejoins(s)
    expect(MEMBER_COLOURS).toContain(await colourOf(s, s.kevinId))
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

describe('the one-off re-deal for businesses from before the palette (memberColoursV1)', () => {
  /** How a business started before Phase 4.2 was dealt: the owner the brand
   * red, and the first person to join, blue. */
  async function asBeforePhase42(s: Setup) {
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.ownerId, { colour: '#FF3B30' })
      await ctx.db.patch(s.kevinId, { colour: '#0A84FF' })
    })
  }
  const redeal = (s: Setup, dryRun?: boolean) =>
    s.t.mutation(internal.migrations.memberColoursV1.run, { dryRun })
  const remaining = (s: Setup) =>
    s.t.query(internal.migrations.memberColoursV1.remaining, {})

  test('Terence comes out blue and Kevin red, and the next person joining is dealt teal', async () => {
    const s = await setup()
    await asBeforePhase42(s)
    expect(await remaining(s)).toBe(1)

    const { changes, skipped } = await redeal(s)
    expect(changes).toEqual([
      expect.objectContaining({
        membershipId: s.ownerId,
        from: '#FF3B30',
        to: '#0A84FF',
      }),
      expect.objectContaining({
        membershipId: s.kevinId,
        from: '#0A84FF',
        to: '#DC2626',
      }),
    ])
    expect(skipped).toEqual([])
    expect(await colourOf(s, s.ownerId)).toBe('#0A84FF')
    expect(await colourOf(s, s.kevinId)).toBe('#DC2626')
    expect(await remaining(s)).toBe(0)

    const priya = await createActor(s.t, { email: 'priya@coastal.test' })
    expect(await colourOf(s, await joinAs(s, priya))).toBe(MEMBER_COLOURS[2])
  })

  test('a dry run says what it would change and writes nothing', async () => {
    const s = await setup()
    await asBeforePhase42(s)
    const { dryRun, changes } = await redeal(s, true)
    expect(dryRun).toBe(true)
    expect(changes).toHaveLength(2)
    expect(await colourOf(s, s.ownerId)).toBe('#FF3B30')
    expect(await colourOf(s, s.kevinId)).toBe('#0A84FF')
    expect(await remaining(s)).toBe(1)
  })

  test('a second run changes nothing', async () => {
    const s = await setup()
    await asBeforePhase42(s)
    await redeal(s)
    expect((await redeal(s)).changes).toEqual([])
  })

  test('someone who has left is neither re-dealt nor holding a colour back', async () => {
    const s = await setup()
    const priya = await createActor(s.t, { email: 'priya@coastal.test' })
    const priyaId = await joinAs(s, priya)
    await asBeforePhase42(s)
    await s.t.run((ctx) => ctx.db.patch(priyaId, { colour: '#34C759' }))
    await removeKevin(s)

    await redeal(s)
    expect(await colourOf(s, s.ownerId)).toBe('#0A84FF')
    expect(await colourOf(s, priyaId)).toBe('#DC2626')
    expect(await colourOf(s, s.kevinId)).toBe('#0A84FF')
  })

  test('a business whose owner has picked their own colour is left as they chose', async () => {
    const s = await setup()
    await s.t.run((ctx) => ctx.db.patch(s.kevinId, { colour: '#0A84FF' }))
    await s.t.run((ctx) => ctx.db.patch(s.ownerId, { colour: '#9333EA' }))
    expect(await remaining(s)).toBe(0)
    expect((await redeal(s)).changes).toEqual([])
    expect(await colourOf(s, s.kevinId)).toBe('#0A84FF')
  })

  test('…and so is one where anyone’s colour was set by hand, even if not the owner’s', async () => {
    const s = await setup()
    await asBeforePhase42(s)
    await s.owner.as.mutation(api.memberships.setColour, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      colour: '#16A34A',
    })

    const { changes, skipped } = await redeal(s)
    expect(changes).toEqual([])
    expect(skipped).toEqual([s.businessId])
    expect(await colourOf(s, s.ownerId)).toBe('#FF3B30')
    expect(await colourOf(s, s.kevinId)).toBe('#16A34A')
  })

  test('another business already on the new deal is not touched', async () => {
    const s = await setup()
    await asBeforePhase42(s)
    const other = await createActor(s.t, { email: 'other@elsewhere.test' })
    await other.as.mutation(api.businesses.create, {
      name: 'Elsewhere Pest',
      state: 'WA',
      timezone: 'Australia/Perth',
    })
    const { changes } = await redeal(s)
    expect(new Set(changes.map((c) => c.businessId))).toEqual(
      new Set([s.businessId]),
    )
  })
})
