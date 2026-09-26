/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import type { TestActor, TestApp } from '../test/harness'
import type { Id } from './_generated/dataModel'

/**
 * The set-up guide: every item is read off the business as it stands, so
 * these tests make the business the way an owner would and watch each item
 * tick over by itself.
 */

async function newOwner(t: TestApp, team: 'solo' | 'team' = 'solo') {
  const owner = await createActor(t, { email: 'jo@jospest.test', name: 'Jo' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  await t.run((ctx) =>
    ctx.db.patch(businessId, {
      setup: { step: 'team', team, finishedAt: Date.now() },
    }),
  )
  return { owner, businessId, ownerMembershipId }
}

async function guide(owner: TestActor, businessId: Id<'businesses'>) {
  const result = await owner.as.query(api.setupGuide.progress, { businessId })
  return result && Object.fromEntries(result.items.map((i) => [i.key, i.done]))
}

async function aProperty(t: TestApp, businessId: Id<'businesses'>) {
  return t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: now,
    })
  })
}

describe('the set-up guide', () => {
  test('starts with the business already done, and ticks each item from real data', async () => {
    const t = testApp()
    const { owner, businessId, ownerMembershipId } = await newOwner(t)

    expect(await guide(owner, businessId)).toEqual({
      business: true,
      letterhead: false,
      licence: false,
      clients: false,
      firstJob: false,
      firstReport: false,
    })

    // The letterhead needs the logo AND a way to reach them.
    const logo = await t.run((ctx) => ctx.storage.store(new Blob(['logo'])))
    await owner.as.mutation(api.businesses.update, {
      businessId,
      logoStorageId: logo,
    })
    expect((await guide(owner, businessId))?.letterhead).toBe(false)
    await owner.as.mutation(api.businesses.update, {
      businessId,
      phone: '0412 345 678',
    })
    expect((await guide(owner, businessId))?.letterhead).toBe(true)

    await owner.as.mutation(api.memberships.setLicence, {
      businessId,
      membershipId: ownerMembershipId,
      licenceNumber: 'PMT 004512',
    })
    expect((await guide(owner, businessId))?.licence).toBe(true)

    // A client in the book is a step of its own, before anything is booked.
    const propertyId = await aProperty(t, businessId)
    expect(await guide(owner, businessId)).toMatchObject({
      clients: true,
      firstJob: false,
    })
    await t.run((ctx) =>
      ctx.db.insert('jobs', {
        businessId,
        propertyId,
        assignedMembershipId: ownerMembershipId,
        jobType: 'General Pest Control',
        price: 20000,
        scheduledAt: Date.now(),
        durationMinutes: 60,
        status: 'pending',
        createdAt: Date.now(),
      }),
    )
    expect((await guide(owner, businessId))?.firstJob).toBe(true)

    // A draft is not a report finished.
    const draft = {
      businessId,
      propertyId,
      authorMembershipId: ownerMembershipId,
      template: 'serviceReport' as const,
      templateVersion: 1,
      legalBasis: 'APVMA' as const,
      data: {},
      photoIds: [],
      createdAt: Date.now(),
    }
    await t.run((ctx) =>
      ctx.db.insert('reports', { ...draft, status: 'draft' }),
    )
    expect((await guide(owner, businessId))?.firstReport).toBe(false)
    await t.run((ctx) =>
      ctx.db.insert('reports', {
        ...draft,
        status: 'finalised',
        finalisedAt: Date.now(),
      }),
    )
    expect(await guide(owner, businessId)).toEqual({
      business: true,
      letterhead: true,
      licence: true,
      clients: true,
      firstJob: true,
      firstReport: true,
    })
  })

  test('lists bringing the clients across after the licence and before the first job', async () => {
    const t = testApp()
    const { owner, businessId } = await newOwner(t, 'team')
    const result = await owner.as.query(api.setupGuide.progress, { businessId })
    expect(result?.items.map((item) => item.key)).toEqual([
      'business',
      'letterhead',
      'licence',
      'clients',
      'firstJob',
      'firstReport',
      'team',
    ])
  })

  test('counts a client brought in by an import, like one added by hand', async () => {
    const t = testApp()
    const { owner, businessId } = await newOwner(t)
    const importId = await owner.as.mutation(api.clientImports.start, {
      businessId,
      fileName: 'clients.csv',
    })
    await owner.as.mutation(api.clientImports.addBatch, {
      businessId,
      importId,
      clients: [
        {
          key: 'c1',
          kind: 'person',
          name: 'J. Nguyen',
          sites: [
            {
              addressLine: '12 Wattle Street',
              suburb: 'Bayswater',
              state: 'WA',
              postcode: '6053',
            },
          ],
        },
      ],
    })
    expect((await guide(owner, businessId))?.clients).toBe(true)
  })

  test('asks about the team only of an owner who said they have one, and an invite sent counts', async () => {
    const t = testApp()
    const { owner, businessId } = await newOwner(t, 'team')
    expect((await guide(owner, businessId))?.team).toBe(false)

    await owner.as.action(api.invitations.create, {
      businessId,
      email: 'kev@kevpest.test',
      role: 'subcontractor',
    })
    expect((await guide(owner, businessId))?.team).toBe(true)

    // Withdrawn, with nobody on the team: not done after all.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('invitations').collect()) {
        await ctx.db.patch(row._id, { revokedAt: Date.now() })
      }
    })
    expect((await guide(owner, businessId))?.team).toBe(false)

    // Someone who has since left does not count either.
    await t.run((ctx) =>
      ctx.db.insert('memberships', {
        userId: 'gone-user',
        businessId,
        role: 'subcontractor',
        canViewAllJobs: false,
        colour: '#0A84FF',
        status: 'removed',
        createdAt: Date.now(),
      }),
    )
    expect((await guide(owner, businessId))?.team).toBe(false)
  })

  test('a business that was running before set-up existed has no guide', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@coastal.test' })
    const { businessId } = await createBusiness(t, owner)
    expect(
      await owner.as.query(api.setupGuide.progress, { businessId }),
    ).toBeNull()
  })

  test('is the owner’s alone: anyone else sees nothing and cannot put it away', async () => {
    const t = testApp()
    const { owner, businessId } = await newOwner(t)
    const { url } = await owner.as.action(api.invitations.create, {
      businessId,
      email: 'kev@kevpest.test',
      role: 'subcontractor',
    })
    const kev = await createActor(t, { email: 'kev@kevpest.test' })
    await kev.as.action(api.invitations.redeem, {
      token: url.split('/join/')[1],
    })

    expect(
      await kev.as.query(api.setupGuide.progress, { businessId }),
    ).toBeNull()
    await expect(
      kev.as.mutation(api.setupGuide.setHidden, { businessId, hidden: true }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('put away and brought back, keeping the rest of set-up as it was', async () => {
    const t = testApp()
    const { owner, businessId } = await newOwner(t, 'team')

    await owner.as.mutation(api.setupGuide.setHidden, {
      businessId,
      hidden: true,
    })
    expect(
      (await owner.as.query(api.setupGuide.progress, { businessId }))?.hidden,
    ).toBe(true)

    await owner.as.mutation(api.setupGuide.setHidden, {
      businessId,
      hidden: false,
    })
    const stored = await t.run((ctx) => ctx.db.get(businessId))
    expect(stored?.setup).toEqual({
      step: 'team',
      team: 'team',
      finishedAt: expect.any(Number),
    })
  })
})
