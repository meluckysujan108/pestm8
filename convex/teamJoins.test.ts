/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import type { TestActor, TestApp } from '../test/harness'
import type { Id } from './_generated/dataModel'

/**
 * "Kevin joined your team": said to the owner, for people who joined through
 * a link in the last fortnight, until the owner puts it away.
 */

const DAY = 24 * 60 * 60 * 1000

async function joinVia(
  t: TestApp,
  owner: TestActor,
  businessId: Id<'businesses'>,
  email: string,
  role: 'subcontractor' | 'contractor' = 'subcontractor',
) {
  const { url } = await owner.as.action(api.invitations.create, {
    businessId,
    email,
    role,
  })
  const person = await createActor(t, { email, name: email.split('@')[0] })
  await person.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })
  return person
}

describe('join notices', () => {
  test('the owner hears who joined, newest first, until each is put away', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'jo@jospest.test' })
    const { businessId } = await createBusiness(t, owner)
    const since = Date.now() - 14 * DAY

    await joinVia(t, owner, businessId, 'kevin@kevpest.test')
    await joinVia(t, owner, businessId, 'dana@danapest.test', 'contractor')

    const joined = await owner.as.query(api.teamJoins.recent, {
      businessId,
      since,
    })
    expect(joined.map((j) => [j.name, j.role])).toEqual([
      ['dana', 'contractor'],
      ['kevin', 'subcontractor'],
    ])

    await owner.as.mutation(api.teamJoins.dismiss, {
      businessId,
      membershipId: joined[0].membershipId,
    })
    expect(
      (await owner.as.query(api.teamJoins.recent, { businessId, since })).map(
        (j) => j.name,
      ),
    ).toEqual(['kevin'])
  })

  test('an old join is not news, a removed member is not either, and three at most', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'jo@jospest.test' })
    const { businessId } = await createBusiness(t, owner)
    const since = Date.now() - DAY
    for (const name of ['a', 'b', 'c', 'd']) {
      await joinVia(t, owner, businessId, `${name}@pest.test`)
    }

    const joined = await owner.as.query(api.teamJoins.recent, {
      businessId,
      since,
    })
    // Newest three; never the owner.
    expect(joined.map((j) => j.name)).toEqual(['d', 'c', 'b'])

    await t.run(async (ctx) => {
      await ctx.db.patch(joined[0].membershipId, { status: 'removed' })
    })
    expect(
      (await owner.as.query(api.teamJoins.recent, { businessId, since })).map(
        (j) => j.name,
      ),
    ).toEqual(['c', 'b', 'a'])

    // Asked for joins from tomorrow onwards: none of them is that recent.
    expect(
      await owner.as.query(api.teamJoins.recent, {
        businessId,
        since: Date.now() + DAY,
      }),
    ).toEqual([])
  })

  test('a notice can only be put away for this business’s own people', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'jo@jospest.test' })
    const { businessId } = await createBusiness(t, owner)
    const other = await createActor(t, { email: 'terence@coastal.test' })
    const { ownerMembershipId: theirs } = await createBusiness(
      t,
      other,
      'Coastal Pest',
    )
    await expect(
      owner.as.mutation(api.teamJoins.dismiss, {
        businessId,
        membershipId: theirs,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })

  test('nobody but the owner hears it or can put it away', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'jo@jospest.test' })
    const { businessId } = await createBusiness(t, owner)
    const kevin = await joinVia(t, owner, businessId, 'kevin@kevpest.test')
    const since = Date.now() - DAY

    expect(
      await kevin.as.query(api.teamJoins.recent, { businessId, since }),
    ).toEqual([])
    const [row] = await owner.as.query(api.teamJoins.recent, {
      businessId,
      since,
    })
    await expect(
      kevin.as.mutation(api.teamJoins.dismiss, {
        businessId,
        membershipId: row.membershipId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('a contractor’s link says contractor, not subcontractor', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'jo@jospest.test' })
    const { businessId } = await createBusiness(t, owner)
    const { url } = await owner.as.action(api.invitations.create, {
      businessId,
      email: 'dana@danapest.test',
      role: 'contractor',
    })
    const preview = await t.action(api.invitations.preview, {
      token: url.split('/join/')[1],
    })
    expect(preview.roleLabel).toBe('Contractor')
  })
})
