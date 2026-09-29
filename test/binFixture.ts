import { api } from '../convex/_generated/api'
import { createActor, createBusiness, testApp } from './harness'
import type { Id } from '../convex/_generated/dataModel'
import type { TestActor, TestApp } from './harness'

/**
 * A business with two clients, each with a site, a booked job there with a
 * note and a draft, a finalised report, a note about the client and a weekly
 * Recurring Job — what the Recycle bin tests delete, restore and wipe
 * (convex/bin*.test.ts).
 */

export const DAY = 24 * 60 * 60 * 1000
export const MONTH = 31 * DAY

export async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const s = { t, owner, businessId, ownerMembershipId }
  const nguyen = await seedClient(s, 'J. Nguyen', '12 Wattle Street')
  const patel = await seedClient(s, 'R. Patel', '3 Banksia Road')
  return { ...s, nguyen, patel }
}

type Base = {
  t: TestApp
  owner: TestActor
  businessId: Id<'businesses'>
  ownerMembershipId: Id<'memberships'>
}
export type Setup = Awaited<ReturnType<typeof setup>>

/** A client with one site, a booked job there with a note and a draft, a
 * finalised report, a note about the client, and a weekly series. */
async function seedClient(s: Base, name: string, addressLine: string) {
  const ids = await s.t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId: s.businessId,
      kind: 'person',
      name,
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId: s.businessId,
      clientId,
      addressLine,
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: now,
    })
    return { clientId, propertyId }
  })
  const jobId = await s.owner.as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: ids.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    jobType: 'General Pest',
    price: 18000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 60,
  })
  await s.owner.as.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: ids.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    intervalCount: 1,
    intervalUnit: 'week',
    jobType: 'Rodents',
    price: 12000,
    anchorDate: Date.now() + 2 * DAY,
    durationMinutes: 45,
  })
  const rest = await s.t.run(async (ctx) => {
    const now = Date.now()
    const note = (fields: {
      jobId?: Id<'jobs'>
      propertyId?: Id<'properties'>
      clientId?: Id<'clients'>
    }) =>
      ctx.db.insert('notes', {
        businessId: s.businessId,
        authorMembershipId: s.ownerMembershipId,
        lastEditedByMembershipId: s.ownerMembershipId,
        ...fields,
        title: 'Gate code',
        preview: '',
        plainText: 'Gate code\n',
        createdAt: now,
        updatedAt: now,
      })
    const report = (status: 'draft' | 'finalised') =>
      ctx.db.insert('reports', {
        businessId: s.businessId,
        propertyId: ids.propertyId,
        jobId,
        authorMembershipId: s.ownerMembershipId,
        template: 'serviceReport',
        templateVersion: 1,
        legalBasis: 'APVMA',
        data: {},
        photoIds: [],
        status,
        ...(status === 'finalised' && { finalisedAt: now }),
        createdAt: now,
      })
    const seriesId = (await ctx.db
      .query('recurrences')
      .withIndex('by_property', (q) => q.eq('propertyId', ids.propertyId))
      .unique())!._id
    return {
      seriesId,
      jobNoteId: await note({
        jobId,
        propertyId: ids.propertyId,
        clientId: ids.clientId,
      }),
      clientNoteId: await note({ clientId: ids.clientId }),
      draftId: await report('draft'),
      finalId: await report('finalised'),
    }
  })
  return { ...ids, jobId, ...rest }
}

export type Seeded = Setup['nguyen']

export async function state(s: Setup, c: Seeded) {
  return s.t.run(async (ctx) => {
    const visits = await ctx.db
      .query('jobs')
      .withIndex('by_recurrence', (q) => q.eq('recurrenceId', c.seriesId))
      .collect()
    const rows = [
      await ctx.db.get(c.clientId),
      await ctx.db.get(c.propertyId),
      await ctx.db.get(c.jobId),
      await ctx.db.get(c.seriesId),
      await ctx.db.get(c.jobNoteId),
      await ctx.db.get(c.clientNoteId),
      await ctx.db.get(c.draftId),
      ...visits,
    ]
    return {
      binned: rows.map((r) => r?.deletedAt !== undefined),
      entries: [...new Set(rows.map((r) => r?.binEntryId ?? null))],
      finalised: await ctx.db.get(c.finalId),
      visits: visits.length,
    }
  })
}

export async function join(s: Base, invitee: TestActor) {
  const { url } = await s.owner.as.action(api.invitations.create, {
    businessId: s.businessId,
    email: invitee.email,
    role: 'subcontractor',
  })
  await invitee.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })
}
