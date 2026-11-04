/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { jobEditChoices } from '../src/lib/jobEditChoices'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * The server half of the job sheet's Edit (src/lib/jobEditChoices.ts): a
 * subcontractor on a job is offered its client and its property, so the
 * server must let them save both — all but the client number, which stays
 * the owner's. Tightened here, this fails, rather than the job sheet quietly
 * offering rows the server then refuses.
 */

const DAY = 24 * 60 * 60 * 1000

async function join(
  t: TestApp,
  owner: TestActor,
  invitee: TestActor,
  businessId: Id<'businesses'>,
) {
  const { url } = await owner.as.action(api.invitations.create, {
    businessId,
    email: invitee.email,
    role: 'subcontractor',
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

/** The owner's job at Mahal Mart, with Kevin, a subcontractor, also going. */
async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@pestm8.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, { email: 'kevin@pestm8.test' })
  const kevinId = await join(t, owner, kevin, businessId)
  const ids = await t.run(async (ctx) => {
    const now = Date.now()
    const client = await ctx.db.insert('clients', {
      businessId,
      kind: 'business',
      name: 'Mahal Mart',
      clientNumber: 1916,
      createdAt: now,
      updatedAt: now,
    })
    const property = await ctx.db.insert('properties', {
      businessId,
      clientId: client,
      addressLine: '14 Kewdale Road',
      suburb: 'Welshpool',
      state: 'WA',
      postcode: '6106',
      createdAt: now,
    })
    return { clientId: client, propertyId: property }
  })
  const { clientId, propertyId } = ids
  const jobId = await owner.as.mutation(api.jobs.create, {
    businessId,
    propertyId,
    assignedMembershipId: ownerMembershipId,
    jobType: 'General Pest Control',
    price: 22000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 60,
    alsoGoing: [kevinId],
  })
  return { t, owner, kevin, businessId, clientId, propertyId, jobId }
}

describe('a subcontractor on the job, from its Edit', () => {
  test('is offered the job, its client and its property', async () => {
    const s = await setup()
    const job = await s.kevin.as.query(api.jobs.get, {
      businessId: s.businessId,
      jobId: s.jobId,
    })
    expect(jobEditChoices(job!).map((choice) => choice.target)).toEqual([
      'job',
      'client',
      'property',
    ])
  })

  test('saves the client’s phone and email, as the client form sends them', async () => {
    const s = await setup()
    await s.kevin.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: s.clientId,
      // The form always sends the type and name.
      kind: 'business',
      name: 'Mahal Mart',
      phone: '0412 345 678',
      email: 'accounts@mahalmart.com.au',
    })
    const client = await s.t.run((ctx) => ctx.db.get(s.clientId))
    expect(client).toMatchObject({
      phone: '0412 345 678',
      email: 'accounts@mahalmart.com.au',
    })
  })

  test('saves the property’s address and site contact', async () => {
    const s = await setup()
    await s.kevin.as.mutation(api.properties.update, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      addressLine: '14A Kewdale Road',
      suburb: 'Welshpool',
      state: 'WA',
      postcode: '6106',
      addressCheck: 'typed',
      siteContactName: 'Priya Shah',
    })
    const property = await s.t.run((ctx) => ctx.db.get(s.propertyId))
    expect(property).toMatchObject({
      addressLine: '14A Kewdale Road',
      siteContactName: 'Priya Shah',
    })
  })

  test('may not change the client number, which stays the owner’s', async () => {
    const s = await setup()
    await expect(
      s.kevin.as.mutation(api.clients.update, {
        businessId: s.businessId,
        clientId: s.clientId,
        clientNumber: 77,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    const client = await s.t.run((ctx) => ctx.db.get(s.clientId))
    expect(client?.clientNumber).toBe(1916)
  })
})
