/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { MAX_WORK_ORDER_LENGTH } from './lib/workOrder'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * Prompt 5.2: a job carries the client's work order — their facilities
 * portal's WO or PO number, which their accounts team needs on the invoice.
 */

const DAY = 24 * 60 * 60 * 1000

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, { email: 'kevin@coastal.test' })
  const kevinMembershipId = await join(t, owner, kevin, businessId)
  const propertyId = await t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'business',
      name: 'Coastal Cafe Group',
      createdAt: now,
      updatedAt: now,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '88 Marine Parade',
      suburb: 'Cottesloe',
      state: 'WA',
      postcode: '6011',
      createdAt: now,
    })
  })
  return {
    t,
    owner,
    kevin,
    businessId,
    ownerMembershipId,
    kevinMembershipId,
    propertyId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

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

function book(s: Setup, workOrder?: string) {
  return s.owner.as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.kevinMembershipId,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 60,
    workOrder,
  })
}

async function stored(s: Setup, jobId: Id<'jobs'>) {
  const job = await s.t.run((ctx) => ctx.db.get(jobId))
  return job!.workOrder
}

async function visitsOf(s: Setup, recurrenceId: Id<'recurrences'>) {
  return s.t.run((ctx) =>
    ctx.db
      .query('jobs')
      .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
      .collect(),
  )
}

describe('booking a job with a work order', () => {
  test('is stored as typed, without the spaces around it', async () => {
    const s = await setup()
    const jobId = await book(s, '  WO-448120 ')
    expect(await stored(s, jobId)).toBe('WO-448120')
  })

  test('a blank one is no work order at all, not an empty string', async () => {
    const s = await setup()
    expect(await stored(s, await book(s, '   '))).toBeUndefined()
    expect(await stored(s, await book(s, ''))).toBeUndefined()
    expect(await stored(s, await book(s))).toBeUndefined()
  })

  test('one too long to be a reference is refused, and books nothing', async () => {
    const s = await setup()
    await book(s, 'X'.repeat(MAX_WORK_ORDER_LENGTH))
    await expect(
      book(s, 'X'.repeat(MAX_WORK_ORDER_LENGTH + 1)),
    ).rejects.toThrow(/INVALID_WORK_ORDER/)

    // Nor does it leave a half-made client behind when one was being added.
    await expect(
      s.owner.as.mutation(api.jobs.create, {
        businessId: s.businessId,
        newClient: {
          clientName: 'Harbour Strata',
          kind: 'business',
          addressLine: '1 Quay Road',
          suburb: 'Fremantle',
          state: 'WA',
          postcode: '6160',
        },
        assignedMembershipId: s.kevinMembershipId,
        jobType: 'General Pest Control',
        price: 0,
        scheduledAt: Date.now() + DAY,
        durationMinutes: 60,
        workOrder: 'X'.repeat(MAX_WORK_ORDER_LENGTH + 1),
      }),
    ).rejects.toThrow(/INVALID_WORK_ORDER/)
    const clients = await s.t.run((ctx) => ctx.db.query('clients').collect())
    expect(clients.map((c) => c.name)).toEqual(['Coastal Cafe Group'])
  })

  test('the technician the job is for can read it on the job', async () => {
    const s = await setup()
    const jobId = await book(s, 'PO 4500123456')
    const job = await s.kevin.as.query(api.jobs.get, {
      businessId: s.businessId,
      jobId,
    })
    expect(job?.workOrder).toBe('PO 4500123456')
  })
})

describe('changing a job’s work order', () => {
  test('sets, replaces and clears it; leaving it out leaves it alone', async () => {
    const s = await setup()
    const jobId = await book(s)
    const update = (patch: { workOrder?: string; durationMinutes?: number }) =>
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        ...patch,
      })

    await update({ workOrder: 'WO-1' })
    expect(await stored(s, jobId)).toBe('WO-1')

    await update({ workOrder: ' WO-2 ' })
    expect(await stored(s, jobId)).toBe('WO-2')

    await update({ durationMinutes: 90 })
    expect(await stored(s, jobId)).toBe('WO-2')

    await update({ workOrder: '' })
    const cleared = await s.t.run((ctx) => ctx.db.get(jobId))
    expect(cleared).not.toHaveProperty('workOrder')
  })

  test('is locked with the other billed details once invoiced', async () => {
    const s = await setup()
    const jobId = await book(s, 'WO-1')
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      status: 'invoiced',
    })

    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        workOrder: 'WO-2',
      }),
    ).rejects.toThrow(/JOB_INVOICED/)
    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        workOrder: '',
      }),
    ).rejects.toThrow(/JOB_INVOICED/)
    expect(await stored(s, jobId)).toBe('WO-1')

    // Moved back out of Invoiced, it can be corrected — the way a PO that
    // arrived after the invoice gets onto the job.
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      status: 'completed',
    })
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      workOrder: 'WO-2',
    })
    expect(await stored(s, jobId)).toBe('WO-2')
  })

  test('an over-long one is refused here too', async () => {
    const s = await setup()
    const jobId = await book(s, 'WO-1')
    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        workOrder: 'X'.repeat(MAX_WORK_ORDER_LENGTH + 1),
      }),
    ).rejects.toThrow(/INVALID_WORK_ORDER/)
    expect(await stored(s, jobId)).toBe('WO-1')
  })
})

describe('a Recurring Job booked under a work order', () => {
  test('carries it onto the first visit and every projected one', async () => {
    const s = await setup()
    const recurrenceId = await s.owner.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.kevinMembershipId,
      intervalCount: 1,
      intervalUnit: 'month',
      jobType: 'General Pest Control',
      price: 20000,
      anchorDate: Date.now() + DAY,
      durationMinutes: 60,
      workOrder: ' PO 4500123456 ',
    })

    const visits = await visitsOf(s, recurrenceId)
    expect(visits.length).toBeGreaterThan(1)
    expect(visits.some((v) => v.status === 'pending')).toBe(true)
    expect(visits.some((v) => v.status === 'recurring')).toBe(true)
    expect(new Set(visits.map((v) => v.workOrder))).toEqual(
      new Set(['PO 4500123456']),
    )
  })

  test('one too long is refused, and no series or visit is made', async () => {
    const s = await setup()
    await expect(
      s.owner.as.mutation(api.recurrences.create, {
        businessId: s.businessId,
        propertyId: s.propertyId,
        assignedMembershipId: s.kevinMembershipId,
        intervalCount: 1,
        intervalUnit: 'month',
        jobType: 'General Pest Control',
        price: 20000,
        anchorDate: Date.now() + DAY,
        durationMinutes: 60,
        workOrder: 'X'.repeat(MAX_WORK_ORDER_LENGTH + 1),
      }),
    ).rejects.toThrow(/INVALID_WORK_ORDER/)
    const [series, jobs] = await s.t.run(async (ctx) => [
      await ctx.db.query('recurrences').collect(),
      await ctx.db.query('jobs').collect(),
    ])
    expect(series).toHaveLength(0)
    expect(jobs).toHaveLength(0)
  })

  test('without one, no visit gets one', async () => {
    const s = await setup()
    const recurrenceId = await s.owner.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.kevinMembershipId,
      intervalCount: 1,
      intervalUnit: 'month',
      jobType: 'General Pest Control',
      price: 20000,
      anchorDate: Date.now() + DAY,
      durationMinutes: 60,
    })
    for (const visit of await visitsOf(s, recurrenceId)) {
      expect(visit).not.toHaveProperty('workOrder')
    }
  })

  test('a job made recurring passes its work order to the visits after it', async () => {
    const s = await setup()
    const jobId = await book(s, 'WO-77')
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.convertJobToRecurring,
      {
        businessId: s.businessId,
        jobId,
        intervalCount: 1,
        intervalUnit: 'month',
      },
    )
    const visits = await visitsOf(s, recurrenceId)
    expect(visits.length).toBeGreaterThan(1)
    expect(visits.every((v) => v.workOrder === 'WO-77')).toBe(true)
  })

  test('changing one visit’s work order leaves the others as they were', async () => {
    const s = await setup()
    const recurrenceId = await s.owner.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.kevinMembershipId,
      intervalCount: 1,
      intervalUnit: 'month',
      jobType: 'General Pest Control',
      price: 20000,
      anchorDate: Date.now() + DAY,
      durationMinutes: 60,
      workOrder: 'PO-OLD',
    })
    const [first, ...rest] = (await visitsOf(s, recurrenceId)).sort(
      (a, b) => a.scheduledAt - b.scheduledAt,
    )
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId: first._id,
      workOrder: 'PO-NEW',
    })
    expect(await stored(s, first._id)).toBe('PO-NEW')
    for (const visit of rest) expect(await stored(s, visit._id)).toBe('PO-OLD')
  })
})
