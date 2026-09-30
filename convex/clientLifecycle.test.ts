/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import type { Doc, Id } from './_generated/dataModel'

/**
 * A client over its life: numbered once and never renumbered by accident, a
 * lead until work is booked, and — when they stop being a client — their
 * recurring services stopped on request.
 */

const DAY = 24 * 60 * 60 * 1000

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  return { t, owner, businessId, ownerMembershipId }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** A subcontractor, who books their own work and nobody else's. */
async function subcontractor(s: Setup) {
  const kev = await createActor(s.t, {
    email: 'kev@coastal.test',
    name: 'Kevin',
  })
  const membershipId = await s.t.run((ctx) =>
    ctx.db.insert('memberships', {
      userId: kev.userId,
      businessId: s.businessId,
      role: 'subcontractor',
      canViewAllJobs: false,
      colour: '#34C759',
      status: 'active',
      createdAt: Date.now(),
    }),
  )
  return { ...kev, membershipId }
}

let street = 0
async function newClient(s: Setup, fields: Record<string, unknown> = {}) {
  street++
  const propertyId = await s.owner.as.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: `Client ${street}`,
    addressLine: `${street} Marine Parade`,
    suburb: 'Cottesloe',
    state: 'WA',
    postcode: '6011',
    ...fields,
  })
  const client = await s.t.run(async (ctx) => {
    const property = await ctx.db.get(propertyId)
    return (await ctx.db.get(property!.clientId))!
  })
  return { propertyId, client }
}

const clientOf = (s: Setup, clientId: Id<'clients'>) =>
  s.t.run(async (ctx) => (await ctx.db.get(clientId))!)

function booking(s: Setup, propertyId: Id<'properties'>) {
  return {
    businessId: s.businessId,
    propertyId,
    assignedMembershipId: s.ownerMembershipId,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 60,
  }
}

function series(
  s: Setup,
  propertyId: Id<'properties'>,
  assignedMembershipId: Id<'memberships'> = s.ownerMembershipId,
) {
  return {
    businessId: s.businessId,
    propertyId,
    assignedMembershipId,
    intervalCount: 1,
    intervalUnit: 'month' as const,
    jobType: 'General Pest Control',
    price: 18500,
    anchorDate: Date.now() + DAY,
    durationMinutes: 60,
  }
}

describe('client numbers are never given out twice', () => {
  test('a client wiped for good keeps its number out of use', async () => {
    const s = await setup()
    await newClient(s)
    await newClient(s)
    const { client: third } = await newClient(s)
    expect(third.clientNumber).toBe(3)

    // What the Recycle bin's wipe does to the row.
    await s.t.run((ctx) => ctx.db.delete(third._id))

    const { client: next } = await newClient(s)
    expect(next.clientNumber).toBe(4)
  })

  test('a business numbered before the count began carries on from its highest', async () => {
    const s = await setup()
    await s.t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert('clients', {
        businessId: s.businessId,
        kind: 'person',
        name: 'Numbered long ago',
        clientNumber: 1916,
        createdAt: now,
        updatedAt: now,
      })
    })
    const { client } = await newClient(s)
    expect(client.clientNumber).toBe(1917)
    const business = await s.t.run((ctx) => ctx.db.get(s.businessId))
    expect(business?.nextClientNumber).toBe(1918)
  })

  test('a number set by hand moves the count past it, and the count steps over one held above it', async () => {
    const s = await setup()
    const { client: a } = await newClient(s)
    await s.owner.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: a._id,
      clientNumber: 40,
    })
    const { client: b } = await newClient(s)
    expect(b.clientNumber).toBe(41)

    // A number written straight into the table, ahead of the count, is
    // stepped over rather than handed out a second time.
    await s.t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert('clients', {
        businessId: s.businessId,
        kind: 'person',
        name: 'Squatter',
        clientNumber: 42,
        createdAt: now,
        updatedAt: now,
      })
    })
    const { client: c } = await newClient(s)
    expect(c.clientNumber).toBe(43)
  })

  test('only the owner changes a number', async () => {
    const s = await setup()
    const kev = await subcontractor(s)
    const { client } = await newClient(s)
    await expect(
      kev.as.mutation(api.clients.update, {
        businessId: s.businessId,
        clientId: client._id,
        clientNumber: 77,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    expect((await clientOf(s, client._id)).clientNumber).toBe(1)

    // The rest of the record is still theirs to edit, as before.
    await kev.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: client._id,
      phone: '0412 345 678',
    })
    expect((await clientOf(s, client._id)).phone).toBe('0412 345 678')

    // Sending the number it already has changes nothing, so is not refused.
    await kev.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: client._id,
      clientNumber: 1,
    })
  })
})

describe('a lead becomes a client when work is booked', () => {
  test('booking a job makes a lead active', async () => {
    const s = await setup()
    const { propertyId, client } = await newClient(s, { status: 'lead' })
    expect(client.status).toBe('lead')

    await s.owner.as.mutation(api.jobs.create, booking(s, propertyId))
    expect((await clientOf(s, client._id)).status).toBe('active')
  })

  test('booking a recurring service makes a lead active', async () => {
    const s = await setup()
    const { propertyId, client } = await newClient(s, { status: 'lead' })
    await s.owner.as.mutation(api.recurrences.create, series(s, propertyId))
    expect((await clientOf(s, client._id)).status).toBe('active')
  })

  test('moving a job onto a lead’s property makes them active', async () => {
    const s = await setup()
    const { propertyId: first } = await newClient(s)
    const { propertyId: second, client: lead } = await newClient(s, {
      status: 'lead',
    })
    const jobId = await s.owner.as.mutation(api.jobs.create, booking(s, first))
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      propertyId: second,
    })
    expect((await clientOf(s, lead._id)).status).toBe('active')
  })

  test('an inactive client stays inactive: that was somebody’s choice', async () => {
    const s = await setup()
    const { propertyId, client } = await newClient(s, { status: 'inactive' })
    await s.owner.as.mutation(api.jobs.create, booking(s, propertyId))
    expect((await clientOf(s, client._id)).status).toBe('inactive')
  })

  test('a client with no status is left without one', async () => {
    const s = await setup()
    const { propertyId, client } = await newClient(s)
    const before = client.updatedAt
    await s.owner.as.mutation(api.jobs.create, booking(s, propertyId))
    const after = await clientOf(s, client._id)
    expect(after.status).toBeUndefined()
    expect(after.updatedAt).toBe(before)
  })
})

describe('stopping a client’s recurring services', () => {
  test('counts what is running and stops it, cancelling visits still to come', async () => {
    const s = await setup()
    const { propertyId, client } = await newClient(s)
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      series(s, propertyId),
    )

    expect(
      await s.owner.as.query(api.recurrences.runningForClient, {
        businessId: s.businessId,
        clientId: client._id,
      }),
    ).toEqual({ running: 1, stoppable: 1 })

    expect(
      await s.owner.as.mutation(api.recurrences.stopForClient, {
        businessId: s.businessId,
        clientId: client._id,
      }),
    ).toEqual({ stopped: 1, skipped: 0 })

    const after = await s.t.run(async (ctx) => ({
      recurrence: (await ctx.db.get(recurrenceId)) as Doc<'recurrences'>,
      visits: await ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
        .collect(),
    }))
    expect(after.recurrence.active).toBe(false)
    expect(after.visits.length).toBeGreaterThan(0)
    // Kept, marked cancelled: nothing is deleted.
    expect(after.visits.every((v) => v.status === 'cancelled')).toBe(true)

    expect(
      await s.owner.as.query(api.recurrences.runningForClient, {
        businessId: s.businessId,
        clientId: client._id,
      }),
    ).toEqual({ running: 0, stoppable: 0 })
  })

  test('stops only what the caller can see and may stop', async () => {
    const s = await setup()
    const kev = await subcontractor(s)
    const { propertyId, client } = await newClient(s)
    // The owner's own service, and one of Kevin's, at the same house.
    await s.owner.as.mutation(api.recurrences.create, series(s, propertyId))
    await s.owner.as.mutation(
      api.recurrences.create,
      series(s, propertyId, kev.membershipId),
    )

    // Kevin sees only his own series.
    expect(
      await kev.as.query(api.recurrences.runningForClient, {
        businessId: s.businessId,
        clientId: client._id,
      }),
    ).toEqual({ running: 1, stoppable: 1 })

    expect(
      await kev.as.mutation(api.recurrences.stopForClient, {
        businessId: s.businessId,
        clientId: client._id,
      }),
    ).toEqual({ stopped: 1, skipped: 0 })

    expect(
      await s.owner.as.query(api.recurrences.runningForClient, {
        businessId: s.businessId,
        clientId: client._id,
      }),
    ).toEqual({ running: 1, stoppable: 1 })
  })

  test('refuses a client of another business', async () => {
    const s = await setup()
    const other = await createActor(s.t, { email: 'rival@other.test' })
    const { businessId: otherBusiness } = await createBusiness(
      s.t,
      other,
      'Other Pest',
    )
    const { client } = await newClient(s)
    await expect(
      other.as.mutation(api.recurrences.stopForClient, {
        businessId: otherBusiness,
        clientId: client._id,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })
})
