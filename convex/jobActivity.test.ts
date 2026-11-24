/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import type { Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * A job's Activity (convex/jobActivity.ts, lib/jobActivity.ts): every change
 * to a job, by anyone, from what to what — read by whoever may open the job,
 * with prices held back from those who may not see them.
 *
 * Terence owns the business. Kevin is a subcontractor who leads some work
 * and cannot see prices. Jo is another subcontractor.
 */

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

afterEach(() => {
  vi.useRealTimers()
})

async function setup() {
  const t = testApp()
  const terence = await createActor(t, {
    email: 'terence@pestm8.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, terence)
  const kevin = await createActor(t, {
    email: 'kevin@pestm8.test',
    name: 'Kevin',
  })
  const kevinId = await joinBusiness(
    t,
    terence,
    kevin,
    businessId,
    'subcontractor',
  )
  const jo = await createActor(t, { email: 'jo@pestm8.test', name: 'Jo' })
  const joId = await joinBusiness(t, terence, jo, businessId, 'subcontractor')
  const { propertyId, otherPropertyId } = await t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    const site = (addressLine: string) =>
      ctx.db.insert('properties', {
        businessId,
        clientId,
        addressLine,
        suburb: 'Bayswater',
        state: 'WA',
        postcode: '6053',
        createdAt: now,
      })
    return {
      propertyId: await site('12 Wattle Street'),
      otherPropertyId: await site('14 Acacia Avenue'),
    }
  })
  return {
    t,
    terence,
    kevin,
    jo,
    businessId,
    ownerId: ownerMembershipId,
    kevinId,
    joId,
    propertyId,
    otherPropertyId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

function book(
  s: Setup,
  opts: { lead?: Id<'memberships'>; by?: TestActor; when?: number } = {},
) {
  return (opts.by ?? s.terence).as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: opts.lead ?? s.ownerId,
    jobType: 'General Pest Control',
    price: 19500,
    scheduledAt: opts.when ?? Date.now() + 2 * DAY,
    durationMinutes: 60,
  })
}

function history(s: Setup, who: TestActor, jobId: Id<'jobs'>) {
  return who.as.query(api.jobActivity.list, { businessId: s.businessId, jobId })
}

/** The newest line's action and changes, as the reader is sent them. */
async function latest(s: Setup, who: TestActor, jobId: Id<'jobs'>) {
  const read = await history(s, who, jobId)
  return read!.entries[0]
}

describe('what is written', () => {
  test('booking is the first line, by whoever booked it', async () => {
    const s = await setup()
    const jobId = await book(s)

    const read = await history(s, s.terence, jobId)
    expect(read?.entries).toHaveLength(1)
    expect(read?.entries[0]).toMatchObject({
      action: 'job.create',
      by: { name: 'Terence', you: true },
      inAccountOf: null,
      changes: [],
    })
    // Its own booking is in it, so nothing stands in for one.
    expect(read?.origin).toBeNull()
    expect(read?.bookedBefore).toBe(false)
  })

  test('an edit says what each changed fact was, and became', async () => {
    const s = await setup()
    const when = Date.now() + 2 * DAY
    const jobId = await book(s, { when })

    await s.terence.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      scheduledAt: when + 3 * HOUR,
      durationMinutes: 90,
      price: 22000,
      jobType: 'Termite Inspection',
      workOrder: 'PO-1123',
      propertyId: s.otherPropertyId,
    })

    const entry = await latest(s, s.terence, jobId)
    expect(entry.action).toBe('job.update')
    expect(entry.changes).toEqual([
      { field: 'scheduledAt', from: when, to: when + 3 * HOUR },
      { field: 'durationMinutes', from: 60, to: 90 },
      {
        field: 'property',
        from: '12 Wattle Street, Bayswater',
        to: '14 Acacia Avenue, Bayswater',
      },
      {
        field: 'jobType',
        from: 'General Pest Control',
        to: 'Termite Inspection',
      },
      { field: 'price', from: 19500, to: 22000 },
      { field: 'workOrder', to: 'PO-1123' },
    ])
  })

  test('an edit that leaves everything as it was writes nothing', async () => {
    const s = await setup()
    const when = Date.now() + 2 * DAY
    const jobId = await book(s, { when })

    await s.terence.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      scheduledAt: when,
      jobType: 'General Pest Control',
    })

    expect((await history(s, s.terence, jobId))?.entries).toHaveLength(1)
  })

  test('who leads it and who is also going, by name', async () => {
    const s = await setup()
    const jobId = await book(s)

    await s.terence.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      assignedMembershipId: s.kevinId,
      alsoGoing: [s.joId],
    })

    const entry = await latest(s, s.terence, jobId)
    expect(entry.changes).toEqual([
      {
        field: 'lead',
        from: { name: 'Terence', you: true },
        to: { name: 'Kevin', you: false },
      },
      {
        field: 'alsoGoing',
        added: [{ name: 'Jo', you: false }],
        removed: [],
      },
    ])
  })

  test('someone also going made the lead is not also taken off it', async () => {
    const s = await setup()
    const jobId = await book(s)
    await s.terence.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      alsoGoing: [s.kevinId, s.joId],
    })

    await s.terence.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      assignedMembershipId: s.kevinId,
      alsoGoing: [s.joId],
    })

    // Kevin moved up, not off: one line says so.
    const entry = await latest(s, s.terence, jobId)
    expect(entry.changes).toEqual([
      {
        field: 'lead',
        from: { name: 'Terence', you: true },
        to: { name: 'Kevin', you: false },
      },
    ])
  })

  test('an address that has gone to the Recycle bin is another address', async () => {
    const s = await setup()
    const jobId = await book(s)
    await s.terence.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      propertyId: s.otherPropertyId,
    })
    await s.terence.as.mutation(api.bin.deleteProperty, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })

    expect((await latest(s, s.terence, jobId)).changes).toEqual([
      { field: 'property', from: null, to: '14 Acacia Avenue, Bayswater' },
    ])
  })

  test('finishing it, and the money that settles it', async () => {
    const s = await setup()
    const jobId = await book(s)

    await s.terence.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId,
    })
    expect(await latest(s, s.terence, jobId)).toMatchObject({
      action: 'job.complete',
      changes: [{ field: 'status', from: 'pending', to: 'completed' }],
    })

    await s.terence.as.mutation(api.payments.record, {
      businessId: s.businessId,
      jobId,
      method: 'card',
      clientRequestId: crypto.randomUUID(),
    })
    // The status the payment moved is on the payment's own line.
    expect(await latest(s, s.terence, jobId)).toMatchObject({
      action: 'payment.record',
      payment: { method: 'card', amount: 19500, deposit: false },
      changes: [{ field: 'status', from: 'completed', to: 'paid' }],
    })
  })

  test('a photo added changes no field, and is still a line', async () => {
    const s = await setup()
    const jobId = await book(s)
    const storageId = await s.t.run((ctx) =>
      ctx.storage.store(new Blob(['photo'])),
    )

    await s.terence.as.mutation(api.jobs.addPhoto, {
      businessId: s.businessId,
      jobId,
      storageId,
    })

    expect(await latest(s, s.terence, jobId)).toMatchObject({
      action: 'job.photo.add',
      changes: [],
    })
  })
})

describe('who reads it', () => {
  test('anyone on the job, with figures held back from who can’t see prices', async () => {
    const s = await setup()
    const jobId = await book(s, { lead: s.kevinId })
    await s.terence.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      price: 22000,
    })
    await s.terence.as.mutation(api.payments.record, {
      businessId: s.businessId,
      jobId,
      method: 'cash',
      amount: 5000,
      clientRequestId: crypto.randomUUID(),
    })

    const read = await history(s, s.kevin, jobId)
    const [deposit, repriced, booked] = read!.entries
    expect(deposit).toMatchObject({
      action: 'payment.record',
      by: { name: 'Terence', you: false },
      payment: { method: 'cash', amount: null, deposit: true },
    })
    expect(repriced.changes).toEqual([{ field: 'price', from: null, to: null }])
    expect(booked.action).toBe('job.create')
  })

  test('nobody the job is hidden from', async () => {
    const s = await setup()
    const jobId = await book(s, { lead: s.kevinId })

    expect(await history(s, s.jo, jobId)).toBeNull()
  })

  test('not while it is in the Recycle bin', async () => {
    const s = await setup()
    const jobId = await book(s)
    await s.terence.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId,
    })

    expect(await history(s, s.terence, jobId)).toBeNull()
  })
})

describe('working in someone else’s account', () => {
  test('says whose account the change was made in, and still audits it', async () => {
    const s = await setup()
    const jobId = await book(s, { lead: s.kevinId })
    await s.terence.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'account', membershipId: s.kevinId },
    })

    await s.terence.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      durationMinutes: 120,
    })

    // Kevin reads that Terence did it, in his account.
    expect(await latest(s, s.kevin, jobId)).toMatchObject({
      by: { name: 'Terence', you: false },
      inAccountOf: { name: 'Kevin', you: true },
    })
    // The audit row an account holder's own history is read from, as before.
    const audit = await s.t.run((ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_entity', (q) =>
          q.eq('entityType', 'jobs').eq('entityId', jobId),
        )
        .collect(),
    )
    expect(audit.map((row) => row.action)).toContain('job.update')
  })
})

describe('what changes a job without opening it', () => {
  test('deleted with its client and restored, the job keeps its history', async () => {
    const s = await setup()
    const jobId = await book(s)
    const clientId = await s.t.run(
      async (ctx) => (await ctx.db.get(s.propertyId))!.clientId,
    )
    const entryId = await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId,
    })
    await s.terence.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })

    const read = await history(s, s.terence, jobId)
    expect(read!.entries.map((entry) => [entry.action, entry.binRoot])).toEqual(
      [
        ['bin.restore', null],
        ['bin.delete', 'client'],
        ['job.create', null],
      ],
    )
  })

  test('wiped from the Recycle bin, its history goes with it', async () => {
    vi.useFakeTimers()
    const s = await setup()
    const jobId = await book(s)
    const entryId = await s.terence.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId,
    })
    await s.terence.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId,
    })
    await s.t.finishAllScheduledFunctions(vi.runAllTimers)

    const left = await s.t.run((ctx) =>
      ctx.db
        .query('jobActivity')
        .withIndex('by_jobId_and_at', (q) => q.eq('jobId', jobId))
        .collect(),
    )
    expect(left).toEqual([])
  })

  test('a visit still to come, cancelled when its Recurring Job stops', async () => {
    const s = await setup()
    const jobId = await book(s)
    const recurrenceId = await s.terence.as.mutation(
      api.recurrences.convertJobToRecurring,
      {
        businessId: s.businessId,
        jobId,
        intervalCount: 3,
        intervalUnit: 'month',
      },
    )
    expect(await latest(s, s.terence, jobId)).toMatchObject({
      action: 'recurrence.convert',
      interval: 'Every 3 months',
    })

    await s.terence.as.mutation(api.recurrences.setActive, {
      businessId: s.businessId,
      recurrenceId,
      active: false,
    })

    expect(await latest(s, s.terence, jobId)).toMatchObject({
      action: 'recurrence.stop',
      changes: [{ field: 'status', from: 'pending', to: 'cancelled' }],
    })
  })

  test('handed on when its lead leaves the team', async () => {
    const s = await setup()
    const jobId = await book(s, { lead: s.kevinId })

    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      reassignTo: s.joId,
    })

    expect(await latest(s, s.terence, jobId)).toMatchObject({
      action: 'membership.handOn',
      by: { name: 'Terence', you: true },
      changes: [
        {
          field: 'lead',
          from: { name: 'Kevin', you: false },
          to: { name: 'Jo', you: false },
        },
      ],
    })
  })

  test('taken off it when someone also going leaves the team', async () => {
    const s = await setup()
    const jobId = await book(s)
    await s.terence.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      alsoGoing: [s.kevinId, s.joId],
    })

    // Kevin leads nothing, so nothing needs handing on.
    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinId,
    })

    expect(await latest(s, s.terence, jobId)).toMatchObject({
      action: 'membership.takeOff',
      by: { name: 'Terence', you: true },
      changes: [
        {
          field: 'alsoGoing',
          added: [],
          removed: [{ name: 'Kevin', you: false }],
        },
      ],
    })
  })

  test('a Recurring Job’s first visit, booked by hand, is booked by whoever booked it', async () => {
    const s = await setup()
    const recurrenceId = await s.terence.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerId,
      intervalCount: 3,
      intervalUnit: 'month',
      jobType: 'General Pest Control',
      price: 19500,
      anchorDate: Date.now() + 2 * DAY,
      durationMinutes: 60,
    })
    const visits = await s.t.run((ctx) =>
      ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
        .collect(),
    )
    const first = visits.sort((a, b) => a.scheduledAt - b.scheduledAt)[0]

    const read = await history(s, s.terence, first._id)
    expect(read?.entries).toMatchObject([
      { action: 'job.create', by: { name: 'Terence', you: true } },
    ])
    expect(read?.origin).toBeNull()
  })
})

describe('where a history begins', () => {
  test('a job from before the history began says so, and starts with its booking', async () => {
    const s = await setup()
    const bookedAt = Date.now() - 30 * DAY
    // Booked before anything was written down: no line of its own.
    const jobId = await s.t.run((ctx) =>
      ctx.db.insert('jobs', {
        businessId: s.businessId,
        propertyId: s.propertyId,
        assignedMembershipId: s.ownerId,
        jobType: 'General Pest Control',
        price: 19500,
        scheduledAt: Date.now() + DAY,
        durationMinutes: 60,
        status: 'booked',
        createdAt: bookedAt,
      }),
    )
    // The business's history began with something else, since.
    await book(s)

    const read = await history(s, s.terence, jobId)
    expect(read?.entries).toEqual([])
    expect(read?.origin).toEqual({ at: bookedAt, bySeries: false })
    expect(read?.bookedBefore).toBe(true)
    expect(read?.recordedSince).toBeGreaterThan(bookedAt)
  })
})
