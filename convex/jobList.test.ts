/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { dayKeyOf } from './lib/dates'
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

/**
 * What the job card needs from a row, on every query that feeds one. The card
 * shows the suburb alone but maps the street address, and calls the client on
 * the number the detail sheet already dials.
 */
describe('what a job row carries for the card', () => {
  async function withPhone(s: Setup, phone: string | undefined) {
    await s.t.run(async (ctx) => {
      const property = await ctx.db.get(s.propertyId)
      await ctx.db.patch(property!.clientId, { phone })
    })
  }

  test("carries the client's phone and the full address, on the Job tab and the day", async () => {
    const s = await setup()
    await withPhone(s, '0412 345 678')
    const at = Date.now() + 2 * DAY
    await book(s, at)

    const { jobs } = await listFor(s.owner, s.businessId)
    expect(jobs[0]).toMatchObject({
      clientName: 'J. Nguyen',
      clientPhone: '0412 345 678',
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      postcode: '6053',
    })

    const timezone = await s.t.run(
      async (ctx) => (await ctx.db.get(s.businessId))!.timezone,
    )
    const day = await s.owner.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: dayKeyOf(at, timezone),
    })
    expect(day[0]).toMatchObject({ clientPhone: '0412 345 678' })
  })

  test('a client with no number gives an empty one, so the card offers no Call', async () => {
    const s = await setup()
    await withPhone(s, undefined)
    await book(s, Date.now() + DAY)

    const { jobs } = await listFor(s.owner, s.businessId)
    expect(jobs[0].clientPhone).toBe('')
  })

  test("carries the client's email for the card's Email, or an empty one", async () => {
    const s = await setup()
    await book(s, Date.now() + DAY)
    expect((await listFor(s.owner, s.businessId)).jobs[0].clientEmail).toBe('')

    await s.t.run(async (ctx) => {
      const property = await ctx.db.get(s.propertyId)
      await ctx.db.patch(property!.clientId, { email: 'jn@example.test' })
    })
    expect((await listFor(s.owner, s.businessId)).jobs[0].clientEmail).toBe(
      'jn@example.test',
    )
  })
})

/**
 * The card's recurring indicator ("Every 2 weeks") reads the series off the
 * row, on every query that feeds a card — and says nothing once the series
 * has stopped, as the job sheet does.
 */
describe('how often a visit repeats, for the card', () => {
  function everyTwoWeeks(s: Setup) {
    return s.owner.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      intervalCount: 2,
      intervalUnit: 'week',
      jobType: 'Rodent Baiting',
      price: 16000,
      anchorDate: Date.now() + DAY,
      durationMinutes: 45,
    })
  }

  test('every visit of a running series carries its interval, and a one-off none', async () => {
    const s = await setup()
    await everyTwoWeeks(s)
    await book(s, Date.now() + 3 * DAY)

    const { jobs } = await listFor(s.owner, s.businessId)
    const firstVisit = jobs.find((j) => j.jobType === 'Rodent Baiting')!
    const oneOff = jobs.find((j) => j.jobType === 'General Pest Control')!
    expect(firstVisit.repeats).toEqual({ count: 2, unit: 'week' })
    expect(oneOff.repeats).toBeUndefined()

    const timezone = await s.t.run(
      async (ctx) => (await ctx.db.get(s.businessId))!.timezone,
    )
    const day = await s.owner.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: dayKeyOf(firstVisit.scheduledAt, timezone),
    })
    expect(day.find((j) => j._id === firstVisit._id)?.repeats).toEqual({
      count: 2,
      unit: 'week',
    })

    const recurring = await s.owner.as.query(api.jobs.listRecurring, {
      businessId: s.businessId,
    })
    expect(recurring.jobs.length).toBeGreaterThan(0)
    for (const visit of recurring.jobs) {
      expect(visit.repeats).toEqual({ count: 2, unit: 'week' })
    }
  })

  test('once the series stops, what is left of it no longer says it repeats', async () => {
    const s = await setup()
    const recurrenceId = await everyTwoWeeks(s)
    // A visit already past stays after the stop; the future ones are
    // cancelled. Neither should still claim to come round again.
    const [past] = await s.t.run(async (ctx) =>
      ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
        .collect(),
    )
    await s.t.run((ctx) =>
      ctx.db.patch(past._id, { scheduledAt: Date.now() - 2 * DAY }),
    )
    await s.owner.as.mutation(api.recurrences.setActive, {
      businessId: s.businessId,
      recurrenceId,
      active: false,
    })

    const { jobs } = await listFor(s.owner, s.businessId)
    expect(jobs.length).toBeGreaterThan(0)
    for (const job of jobs) expect(job.repeats).toBeUndefined()
  })
})
