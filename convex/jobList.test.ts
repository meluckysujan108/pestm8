/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import type { Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * `jobs.list` — what the Job tab reads. Newest first whatever the day, every
 * status including cancelled, and scoped like every other job query: a
 * subcontractor's list is their own work, not the business's.
 */

const DAY = 24 * 60 * 60 * 1000

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const propertyId = await t.run(async (ctx) => {
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
  return { t, owner, businessId, ownerMembershipId, propertyId }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function join(s: Setup, invitee: TestActor) {
  const { url } = await s.owner.as.action(api.invitations.create, {
    businessId: s.businessId,
    email: invitee.email,
    role: 'subcontractor',
  })
  await invitee.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })
  const membership = await s.t.run(async (ctx) =>
    ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', invitee.userId).eq('businessId', s.businessId),
      )
      .unique(),
  )
  return membership!._id
}

function book(s: Setup, scheduledAt: number, assignedMembershipId?: string) {
  return s.owner.as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: (assignedMembershipId ??
      s.ownerMembershipId) as Id<'memberships'>,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt,
    durationMinutes: 60,
  })
}

function listFor(actor: TestActor, businessId: Id<'businesses'>) {
  return actor.as.query(api.jobs.list, { businessId })
}

describe('the Job tab list', () => {
  test('is newest booked first, whatever day each job is on', async () => {
    const s = await setup()
    // Booked in this order, for days in the opposite order: the list must
    // follow when each was created, not when it is due.
    const first = await book(s, Date.now() + 30 * DAY)
    const second = await book(s, Date.now() + 2 * DAY)
    const third = await book(s, Date.now() - 5 * DAY)

    const { jobs, capped } = await listFor(s.owner, s.businessId)
    expect(jobs.map((job) => job._id)).toEqual([third, second, first])
    expect(capped).toBe(false)
  })

  test('keeps cancelled jobs, which the schedule drops', async () => {
    const s = await setup()
    const jobId = await book(s, Date.now() + DAY)
    await s.owner.as.mutation(api.jobs.cancel, {
      businessId: s.businessId,
      jobId,
    })

    const { jobs } = await listFor(s.owner, s.businessId)
    expect(jobs.map((job) => job.status)).toEqual(['cancelled'])
  })

  test('shows a subcontractor their own work and nobody else’s', async () => {
    const s = await setup()
    const kevin = await createActor(s.t, { email: 'kevin@coastal.test' })
    const kevinId = await join(s, kevin)

    const his = await book(s, Date.now() + DAY, kevinId)
    await book(s, Date.now() + 2 * DAY)

    const mine = await listFor(kevin, s.businessId)
    expect(mine.jobs.map((job) => job._id)).toEqual([his])

    // The owner sees both, his own included.
    const all = await listFor(s.owner, s.businessId)
    expect(all.jobs).toHaveLength(2)
  })

  test('says so when it is holding only the newest jobs', async () => {
    const s = await setup()
    // One more than the limit the query documents.
    const { limit } = await listFor(s.owner, s.businessId)
    await s.t.run(async (ctx) => {
      for (let i = 0; i <= limit; i++) {
        await ctx.db.insert('jobs', {
          businessId: s.businessId,
          propertyId: s.propertyId,
          assignedMembershipId: s.ownerMembershipId,
          jobType: 'General Pest Control',
          price: 20000,
          scheduledAt: Date.now() + i * DAY,
          durationMinutes: 60,
          status: 'pending',
          createdAt: Date.now(),
        })
      }
    })

    const { jobs, capped } = await listFor(s.owner, s.businessId)
    expect(jobs).toHaveLength(limit)
    expect(capped).toBe(true)
  })

  test('a job in another business never appears in this one’s list', async () => {
    const s = await setup()
    const rival = await createActor(s.t, { email: 'rival@other.test' })
    const other = await createBusiness(s.t, rival, 'Other Pest')
    await s.t.run(async (ctx) => {
      const clientId = await ctx.db.insert('clients', {
        businessId: other.businessId,
        kind: 'person',
        name: 'Someone Else',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      const propertyId = await ctx.db.insert('properties', {
        businessId: other.businessId,
        clientId,
        addressLine: '9 Other Road',
        suburb: 'Fremantle',
        state: 'WA',
        postcode: '6160',
        createdAt: Date.now(),
      })
      await ctx.db.insert('jobs', {
        businessId: other.businessId,
        propertyId,
        assignedMembershipId: other.ownerMembershipId,
        jobType: 'Rodents',
        price: 100,
        scheduledAt: Date.now(),
        durationMinutes: 60,
        status: 'pending',
        createdAt: Date.now(),
      })
    })

    const { jobs } = await listFor(s.owner, s.businessId)
    expect(jobs).toHaveLength(0)
  })
})
