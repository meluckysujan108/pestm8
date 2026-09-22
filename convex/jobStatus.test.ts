/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { convexTest } from 'convex-test'
import { defineSchema } from 'convex/server'
import { api, internal } from './_generated/api'
import schema from './schema'
import { createActor, createBusiness, testApp } from '../test/harness'
import { dayKeyOf, zonedDateTimeToUtc } from './lib/dates'
import { assertStatusChange, orderForDay, setJobStatus } from './lib/jobStatus'
import type { Id } from './_generated/dataModel'
import type { JobStatus } from './lib/jobStatus'
import type { TestActor, TestApp } from '../test/harness'

/**
 * The job status rules (convex/lib/jobStatus.ts): a job booked by hand starts
 * `pending`; `recurring` is written only by the recurrence engine, as it
 * inserts a visit; nothing moves a job into `recurring`; completed work sinks
 * to the bottom of the day.
 */

const DAY = 24 * 60 * 60 * 1000
const TZ = 'Australia/Perth'

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const propertyId = await seedProperty(t, businessId)
  return { t, owner, businessId, ownerMembershipId, propertyId }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function seedProperty(t: TestApp, businessId: Id<'businesses'>) {
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

function book(s: Setup, scheduledAt = Date.now() + DAY) {
  return s.owner.as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt,
    durationMinutes: 60,
  })
}

function monthlySeries(s: Setup, anchorDate = Date.now() + DAY) {
  return s.owner.as.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    frequency: 'monthly',
    jobType: 'Rodents',
    price: 18000,
    anchorDate,
    durationMinutes: 45,
  })
}

async function visitsOf(s: Setup, recurrenceId: Id<'recurrences'>) {
  const visits = await s.t.run(async (ctx) =>
    ctx.db
      .query('jobs')
      .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
      .collect(),
  )
  return visits.sort((a, b) => a.scheduledAt - b.scheduledAt)
}

async function statusOf(s: Setup, jobId: Id<'jobs'>) {
  return (await s.t.run(async (ctx) => ctx.db.get(jobId)))?.status
}

describe('a job booked by hand', () => {
  test('saves as pending', async () => {
    const s = await setup()
    const jobId = await book(s)
    expect(await statusOf(s, jobId)).toBe('pending')
  })

  test('cannot be created with a status of its own choosing', async () => {
    const s = await setup()
    await expect(
      s.owner.as.mutation(api.jobs.create, {
        businessId: s.businessId,
        propertyId: s.propertyId,
        assignedMembershipId: s.ownerMembershipId,
        jobType: 'General Pest Control',
        price: 20000,
        scheduledAt: Date.now() + DAY,
        durationMinutes: 60,
        // @ts-expect-error — the point of the test is that this is rejected.
        status: 'recurring',
      }),
    ).rejects.toThrow()
  })
})

describe('recurring is written only by the recurrence engine', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('a new series books its first visit pending and projects the rest as recurring', async () => {
    const s = await setup()
    const recurrenceId = await monthlySeries(s)

    const [first, ...rest] = await visitsOf(s, recurrenceId)
    expect(first.status).toBe('pending')
    expect(rest.length).toBeGreaterThan(0)
    expect(rest.every((visit) => visit.status === 'recurring')).toBe(true)
  })

  test('a first visit booked beyond the horizon is still pending when the cron catches up', async () => {
    const s = await setup()
    // Past HORIZON_DAYS (180): the engine projects nothing today, so the
    // hand-booked visit must not be left for the cron to create as recurring.
    const anchorDate = Date.now() + 200 * DAY
    const recurrenceId = await monthlySeries(s, anchorDate)

    const booked = await visitsOf(s, recurrenceId)
    expect(booked.map((visit) => visit.scheduledAt)).toEqual([anchorDate])
    expect(booked[0].status).toBe('pending')

    // Two months on, the horizon reaches past the anchor.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60 * DAY)
    await s.t.mutation(internal.recurrences.materialiseAll, {})

    const [first, ...rest] = await visitsOf(s, recurrenceId)
    expect(first._id).toBe(booked[0]._id)
    expect(first.status).toBe('pending')
    expect(rest.length).toBeGreaterThan(0)
    expect(rest.every((visit) => visit.status === 'recurring')).toBe(true)
  })

  test('the daily cron projects new visits as recurring', async () => {
    const s = await setup()
    const recurrenceId = await s.t.run(async (ctx) =>
      ctx.db.insert('recurrences', {
        businessId: s.businessId,
        propertyId: s.propertyId,
        assignedMembershipId: s.ownerMembershipId,
        frequency: 'monthly',
        jobType: 'Rodents',
        price: 18000,
        anchorDate: Date.now() + DAY,
        active: true,
      }),
    )

    const { created } = await s.t.mutation(
      internal.recurrences.materialiseAll,
      {},
    )
    expect(created).toBeGreaterThan(0)

    const visits = await visitsOf(s, recurrenceId)
    expect(visits).toHaveLength(created)
    expect(visits.every((visit) => visit.status === 'recurring')).toBe(true)
  })

  test('converting a job to a series leaves that job as it was', async () => {
    const s = await setup()
    const jobId = await book(s)

    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.convertJobToRecurring,
      { businessId: s.businessId, jobId, frequency: 'monthly' },
    )

    const visits = await visitsOf(s, recurrenceId)
    expect(visits.find((visit) => visit._id === jobId)?.status).toBe('pending')
    const projected = visits.filter((visit) => visit._id !== jobId)
    expect(projected.length).toBeGreaterThan(0)
    expect(projected.every((visit) => visit.status === 'recurring')).toBe(true)
  })

  test('the API refuses recurring from anyone, even for a job that never had it', async () => {
    const s = await setup()
    const jobId = await book(s)

    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        // @ts-expect-error — the point of the test is that this is rejected.
        status: 'recurring',
      }),
    ).rejects.toThrow()
    expect(await statusOf(s, jobId)).toBe('pending')
  })
})

describe('leaving recurring is one-way', () => {
  test('a projected visit can be booked, and can never go back', async () => {
    const s = await setup()
    const [, visit] = await visitsOf(s, await monthlySeries(s))
    expect(visit.status).toBe('recurring')

    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId: visit._id,
      status: 'booked',
    })
    expect(await statusOf(s, visit._id)).toBe('booked')

    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId: visit._id,
        // @ts-expect-error — the point of the test is that this is rejected.
        status: 'recurring',
      }),
    ).rejects.toThrow()
    expect(await statusOf(s, visit._id)).toBe('booked')
  })

  test('the server-side write path refuses it even when the validator is bypassed', async () => {
    const s = await setup()
    const [, visit] = await visitsOf(s, await monthlySeries(s))
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId: visit._id,
      status: 'pending',
    })

    // `setJobStatus` is what every status write outside `jobs.update` goes
    // through; it asks the rule itself rather than trusting its caller.
    await expect(
      s.t.run(async (ctx) => {
        const job = await ctx.db.get(visit._id)
        await setJobStatus(ctx, job!, 'recurring')
      }),
    ).rejects.toThrow(/STATUS_NOT_SETTABLE/)
    expect(await statusOf(s, visit._id)).toBe('pending')
  })

  test('completing or cancelling a projected visit moves it out of recurring', async () => {
    const s = await setup()
    const [, second, third] = await visitsOf(s, await monthlySeries(s))

    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId: second._id,
    })
    await s.owner.as.mutation(api.jobs.cancel, {
      businessId: s.businessId,
      jobId: third._id,
    })

    expect(await statusOf(s, second._id)).toBe('completed')
    expect(await statusOf(s, third._id)).toBe('cancelled')
  })

  test('the rule itself: nothing arrives at recurring, and leaving it is always allowed', () => {
    const all: Array<JobStatus> = [
      'recurring',
      'pending',
      'booked',
      'completed',
      'invoiced',
      'cancelled',
    ]
    for (const from of all) {
      for (const to of all) {
        const change = () => assertStatusChange(from, to)
        if (to === 'recurring' && from !== 'recurring') {
          expect(change, `${from} -> ${to}`).toThrow(/STATUS_NOT_SETTABLE/)
        } else {
          expect(change, `${from} -> ${to}`).not.toThrow()
        }
      }
    }
  })
})

describe('ending a series', () => {
  test('cancels every visit not yet started, whichever of those statuses it holds', async () => {
    const s = await setup()
    const recurrenceId = await monthlySeries(s)
    const [first, second, third] = await visitsOf(s, recurrenceId)
    // One visit someone confirmed, one done; the rest still projected.
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId: second._id,
      status: 'booked',
    })
    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId: third._id,
    })

    await s.owner.as.mutation(api.recurrences.setActive, {
      businessId: s.businessId,
      recurrenceId,
      active: false,
    })

    const after = await visitsOf(s, recurrenceId)
    expect(after.find((v) => v._id === first._id)?.status).toBe('cancelled')
    expect(after.find((v) => v._id === second._id)?.status).toBe('cancelled')
    expect(after.find((v) => v._id === third._id)?.status).toBe('completed')
    expect(
      after
        .filter((v) => v._id !== third._id)
        .every((v) => v.status === 'cancelled'),
    ).toBe(true)
  })

  test('stopping from a projected visit keeps it as an ordinary pending job', async () => {
    const s = await setup()
    const recurrenceId = await monthlySeries(s)
    const [, kept, sibling] = await visitsOf(s, recurrenceId)
    expect(kept.status).toBe('recurring')

    await s.owner.as.mutation(api.recurrences.stopFromJob, {
      businessId: s.businessId,
      jobId: kept._id,
    })

    const job = await s.t.run(async (ctx) => ctx.db.get(kept._id))
    expect(job?.recurrenceId).toBeUndefined()
    expect(job?.status).toBe('pending')
    expect(await statusOf(s, sibling._id)).toBe('cancelled')
  })
})

describe('the day on the Schedule page', () => {
  test('completing a job sinks it to the bottom; the rest keep time order', async () => {
    const s = await setup()
    const dayKey = dayKeyOf(Date.now() + DAY, TZ)
    const at = (hour: number) => zonedDateTimeToUtc(dayKey, hour, 0, TZ)

    const eight = await book(s, at(8))
    const ten = await book(s, at(10))
    const noon = await book(s, at(12))
    const two = await book(s, at(14))

    const order = async () =>
      (
        await s.owner.as.query(api.jobs.listDay, {
          businessId: s.businessId,
          dayKey,
        })
      ).map((job) => job._id)

    expect(await order()).toEqual([eight, ten, noon, two])

    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId: noon,
    })
    expect(await order()).toEqual([eight, ten, two, noon])

    // A second completion joins the bottom in its own time order, not in the
    // order it was completed.
    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId: eight,
    })
    expect(await order()).toEqual([ten, two, eight, noon])
  })

  test('orderForDay sinks only completed work', () => {
    const job = (id: string, scheduledAt: number, status: JobStatus) => ({
      id,
      scheduledAt,
      status,
    })
    const ordered = orderForDay([
      job('c', 3, 'completed'),
      job('a', 1, 'invoiced'),
      job('d', 4, 'recurring'),
      job('b', 2, 'completed'),
      job('e', 5, 'booked'),
    ])
    expect(ordered.map((j) => j.id)).toEqual(['a', 'd', 'e', 'b', 'c'])
  })
})

describe('work ahead that the rest of the app counts', () => {
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

  test('removing someone hands on their pending, recurring and pre-billed visits too', async () => {
    const s = await setup()
    const kevin = await createActor(s.t, { email: 'kevin@coastal.test' })
    const priya = await createActor(s.t, { email: 'priya@coastal.test' })
    const kevinId = await join(s.t, s.owner, kevin, s.businessId)
    const priyaId = await join(s.t, s.owner, priya, s.businessId)

    // Invoiced ahead of the visit is still a visit someone has to make.
    const ahead = await s.t.run(async (ctx) =>
      Promise.all(
        (['pending', 'recurring', 'invoiced'] as const).map((status) =>
          ctx.db.insert('jobs', {
            businessId: s.businessId,
            propertyId: s.propertyId,
            assignedMembershipId: kevinId,
            jobType: 'General Pest Control',
            price: 20000,
            scheduledAt: Date.now() + 3 * DAY,
            durationMinutes: 60,
            status,
            createdAt: Date.now(),
          }),
        ),
      ),
    )

    await expect(
      s.owner.as.mutation(api.team.remove, {
        businessId: s.businessId,
        membershipId: kevinId,
      }),
    ).rejects.toThrow(/NEEDS_REASSIGNMENT/)

    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: kevinId,
      reassignTo: priyaId,
    })
    const moved = await s.t.run(async (ctx) =>
      Promise.all(ahead.map((id) => ctx.db.get(id))),
    )
    expect(moved.map((job) => job?.assignedMembershipId)).toEqual([
      priyaId,
      priyaId,
      priyaId,
    ])
  })

  test('the dashboard counts pending and recurring visits as upcoming', async () => {
    const s = await setup()
    // Two days out: clear of "today" in any timezone.
    await book(s, Date.now() + 2 * DAY)
    const recurrenceId = await monthlySeries(s, Date.now() + 2 * DAY)
    const visits = await visitsOf(s, recurrenceId)

    const summary = await s.owner.as.query(api.dashboard.summary, {
      businessId: s.businessId,
    })
    expect(summary?.upcomingCount).toBe(1 + visits.length)
  })
})

describe('invoiced', () => {
  test('is refused like completed when the business wants a report first', async () => {
    const s = await setup()
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.businessId, { requireReportToComplete: true })
    })
    // General Pest Control has a report form, so the policy applies to it.
    const jobId = await book(s)

    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        status: 'invoiced',
      }),
    ).rejects.toThrow(/REPORT_REQUIRED/)
    expect(await statusOf(s, jobId)).toBe('pending')

    await s.t.run(async (ctx) => {
      await ctx.db.insert('reports', {
        businessId: s.businessId,
        propertyId: s.propertyId,
        jobId,
        authorMembershipId: s.ownerMembershipId,
        template: 'treatmentRecord',
        templateVersion: 1,
        legalBasis: 'APVMA',
        status: 'finalised',
        data: {},
        photoIds: [],
        createdAt: Date.now(),
      })
    })
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      status: 'invoiced',
    })
    expect(await statusOf(s, jobId)).toBe('invoiced')
  })

  test('counts toward this month only when it is booked this month', async () => {
    const s = await setup()
    // Now is always this month; forty days on never is.
    const thisMonth = await book(s, Date.now())
    const later = await book(s, Date.now() + 40 * DAY)
    for (const jobId of [thisMonth, later]) {
      await s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        status: 'invoiced',
      })
    }

    const summary = await s.owner.as.query(api.dashboard.summary, {
      businessId: s.businessId,
    })
    expect(summary?.invoicedThisMonth).toBe(20000)
  })
})

describe('retiring In Progress', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('the migration moves every inProgress job to booked, across batches, and touches nothing else', async () => {
    // The live schema no longer admits `inProgress`, so the legacy rows a
    // deployment may still hold can only be seeded with validation off.
    const t = convexTest(
      defineSchema(schema.tables, { schemaValidation: false }),
      import.meta.glob('./**/*.ts'),
    )
    const legacy = ['inProgress', 'completed', 'pending'] as const
    // More than one page of 100, so the self-scheduling continuation runs.
    const ids = await t.run(async (ctx) => {
      const businessId = await ctx.db.insert('businesses', {
        name: 'Coastal Pest',
        slug: 'coastal',
        state: 'WA',
        timezone: TZ,
        createdAt: Date.now(),
      })
      const out = []
      for (let i = 0; i < 150; i++) {
        out.push(
          await ctx.db.insert('jobs', {
            businessId,
            status: legacy[i % legacy.length],
            startedAt: 1_000,
            scheduledAt: Date.now(),
          } as never),
        )
      }
      return out
    })

    vi.useFakeTimers()
    await t.mutation(internal.migrations.jobStatusV1.retireInProgress, {
      cursor: null,
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(await t.query(internal.migrations.jobStatusV1.remaining, {})).toBe(0)
    const jobs = await t.run(async (ctx) =>
      Promise.all(ids.map((id) => ctx.db.get(id))),
    )
    jobs.forEach((job, i) => {
      const was = legacy[i % legacy.length]
      expect(job?.status).toBe(was === 'inProgress' ? 'booked' : was)
      // The real start time survives, for any report still to be written.
      expect(job?.startedAt).toBe(1_000)
    })
  })
})
