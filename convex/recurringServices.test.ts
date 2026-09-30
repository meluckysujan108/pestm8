/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { startOfDayInZone, todayKeyInZone } from './lib/dates'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * The Recurring Job page by service (30 Sept 2026): every running service
 * the page shows, where and for whom, and its visits around today
 * (`recurrences.services`).
 */

const DAY = 24 * 60 * 60 * 1000
const TODAY = () =>
  startOfDayInZone(todayKeyInZone('Australia/Perth'), 'Australia/Perth')

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

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, { email: 'kevin@coastal.test' })
  const kevinMembershipId = await join(t, owner, kevin, businessId)
  const propertyId = await owner.as.mutation(api.properties.create, {
    businessId,
    clientName: 'Harbourside Strata',
    addressLine: '1 Riverside Dr',
    suburb: 'East Perth',
    state: 'WA',
    postcode: '6004',
  })
  const service = (
    to: Id<'memberships'>,
    unit: 'week' | 'year',
    anchorDate: number,
  ) =>
    owner.as.mutation(api.recurrences.create, {
      businessId,
      propertyId,
      assignedMembershipId: to,
      intervalCount: 1,
      intervalUnit: unit,
      jobType: unit === 'year' ? 'Termite Inspection' : 'General Pest Control',
      price: 18500,
      anchorDate,
      durationMinutes: 60,
    })
  return {
    t,
    owner,
    kevin,
    businessId,
    ownerMembershipId,
    kevinMembershipId,
    propertyId,
    service,
  }
}

describe('recurrences.services', () => {
  test('gives each running service, where and for whom, and its visits around today', async () => {
    const s = await setup()
    const weekly = await s.service(
      s.ownerMembershipId,
      'week',
      Date.now() + DAY,
    )
    const result = await s.owner.as.query(api.recurrences.services, {
      businessId: s.businessId,
      startOfToday: TODAY(),
    })
    expect(result.services).toEqual([
      expect.objectContaining({
        _id: weekly,
        jobType: 'General Pest Control',
        interval: { count: 1, unit: 'week' },
        clientName: 'Harbourside Strata',
        addressLine: '1 Riverside Dr',
        suburb: 'East Perth',
        assignedMembershipId: s.ownerMembershipId,
      }),
    ])
    // Visits ahead: when it is next due is theirs to say.
    expect(result.services[0].lastTaken).toBeUndefined()
    const own = result.visits.filter((v) => v.recurrenceId === weekly)
    // The six months ahead the engine books, and no price on any of them.
    expect(own.length).toBeGreaterThan(20)
    for (const visit of result.visits) expect(visit).not.toHaveProperty('price')
  })

  test('a service with no visit in the next six months still has its row', async () => {
    const s = await setup()
    // Yearly, first due a month ago: nothing is booked for it this side of
    // next year, and the engine books none further than six months ahead.
    const yearly = await s.service(
      s.ownerMembershipId,
      'year',
      Date.now() - 30 * DAY,
    )
    const result = await s.owner.as.query(api.recurrences.services, {
      businessId: s.businessId,
      startOfToday: TODAY(),
    })
    expect(result.services.map((r) => r._id)).toEqual([yearly])
    expect(result.visits.filter((v) => v.recurrenceId === yearly)).toEqual([])
  })

  test('a subcontractor sees their own services, and a stopped one is not listed', async () => {
    const s = await setup()
    const kevins = await s.service(
      s.kevinMembershipId,
      'week',
      Date.now() + DAY,
    )
    const owners = await s.service(
      s.ownerMembershipId,
      'week',
      Date.now() + DAY,
    )
    await s.owner.as.mutation(api.recurrences.setActive, {
      businessId: s.businessId,
      recurrenceId: owners,
      active: false,
    })
    const forKevin = await s.kevin.as.query(api.recurrences.services, {
      businessId: s.businessId,
      startOfToday: TODAY(),
    })
    expect(forKevin.services.map((r) => r._id)).toEqual([kevins])
    expect(
      forKevin.visits.every(
        (v) => v.assignedMembershipId === s.kevinMembershipId,
      ),
    ).toBe(true)
    const forOwner = await s.owner.as.query(api.recurrences.services, {
      businessId: s.businessId,
      startOfToday: TODAY(),
    })
    expect(forOwner.services.map((r) => r._id)).toEqual([kevins])
  })

  test('a first visit booked beyond six months is the service’s next', async () => {
    const s = await setup()
    const yearly = await s.service(
      s.ownerMembershipId,
      'year',
      Date.now() + 200 * DAY,
    )
    const result = await s.owner.as.query(api.recurrences.services, {
      businessId: s.businessId,
      startOfToday: TODAY(),
    })
    const own = result.visits.filter((v) => v.recurrenceId === yearly)
    expect(own).toHaveLength(1)
    expect(own[0].status).toBe('pending')
  })

  test('a visit left to book by a stopped service is still on the page', async () => {
    const s = await setup()
    const monthly = await s.owner.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      intervalCount: 1,
      intervalUnit: 'month',
      jobType: 'Rodents',
      price: 9000,
      anchorDate: Date.now() + DAY,
      durationMinutes: 45,
    })
    // A projection whose day has passed, nobody booking it.
    const overdue = await s.t.run(async (ctx) => {
      const [first] = await ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', monthly))
        .take(1)
      await ctx.db.patch(first._id, {
        status: 'recurring',
        scheduledAt: Date.now() - 3 * DAY,
      })
      return first._id
    })
    await s.owner.as.mutation(api.recurrences.setActive, {
      businessId: s.businessId,
      recurrenceId: monthly,
      active: false,
    })
    const result = await s.owner.as.query(api.recurrences.services, {
      businessId: s.businessId,
      startOfToday: TODAY(),
    })
    expect(result.services).toEqual([])
    expect(result.loose).toEqual([
      expect.objectContaining({
        _id: overdue,
        status: 'recurring',
        clientName: 'Harbourside Strata',
      }),
    ])
  })
})
