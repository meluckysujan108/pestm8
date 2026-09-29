/// <reference types="vite/client" />
import { describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { MAX_JOB_NOTES_LENGTH } from './lib/jobNotes'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * A job's own note, and a job for several services — the two things a
 * business asked for on 29 Sept 2026: "we do general pest with termites and
 * rodents", and somewhere small on the job to write "if I must add a note".
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
      kind: 'person',
      name: 'Jane Smith',
      createdAt: now,
      updatedAt: now,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '14 Rosewood Ave',
      suburb: 'Morley',
      state: 'WA',
      postcode: '6062',
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

function book(
  s: Setup,
  {
    notes,
    jobType,
    scheduledAt,
  }: { notes?: string; jobType?: string; scheduledAt?: number } = {},
) {
  return s.owner.as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.kevinMembershipId,
    jobType: jobType ?? 'General Pest Control',
    price: 20000,
    scheduledAt: scheduledAt ?? Date.now() + DAY,
    durationMinutes: 60,
    notes,
  })
}

async function stored(s: Setup, jobId: Id<'jobs'>) {
  const job = await s.t.run((ctx) => ctx.db.get(jobId))
  return job!.notes
}

async function visitsOf(s: Setup, recurrenceId: Id<'recurrences'>) {
  const visits = await s.t.run((ctx) =>
    ctx.db
      .query('jobs')
      .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
      .collect(),
  )
  return visits.sort((a, b) => a.scheduledAt - b.scheduledAt)
}

describe('booking a job with a note', () => {
  test('keeps its lines, without the space around it', async () => {
    const s = await setup()
    const jobId = await book(s, {
      notes: '  Tenant home after 10.\r\nSide gate code 4411.  ',
    })
    expect(await stored(s, jobId)).toBe(
      'Tenant home after 10.\nSide gate code 4411.',
    )
  })

  test('a blank one is no note at all, not an empty string', async () => {
    const s = await setup()
    expect(await stored(s, await book(s, { notes: ' \n ' }))).toBeUndefined()
    expect(await stored(s, await book(s, { notes: '' }))).toBeUndefined()
    expect(await stored(s, await book(s))).toBeUndefined()
  })

  test('one longer than a note is refused, and books nothing', async () => {
    const s = await setup()
    await book(s, { notes: 'x'.repeat(MAX_JOB_NOTES_LENGTH) })
    await expect(
      book(s, { notes: 'x'.repeat(MAX_JOB_NOTES_LENGTH + 1) }),
    ).rejects.toThrow(/NOTES_TOO_LONG/)
    const jobs = await s.t.run((ctx) => ctx.db.query('jobs').collect())
    expect(jobs).toHaveLength(1)
  })

  test('the technician the job is for reads it on the job', async () => {
    const s = await setup()
    const jobId = await book(s, { notes: 'Dog in the back yard.' })
    const job = await s.kevin.as.query(api.jobs.get, {
      businessId: s.businessId,
      jobId,
    })
    expect(job?.notes).toBe('Dog in the back yard.')
  })
})

describe('changing a job’s note', () => {
  test('sets, replaces and clears it; leaving it out leaves it alone', async () => {
    const s = await setup()
    const jobId = await book(s)
    const update = (patch: { notes?: string; durationMinutes?: number }) =>
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        ...patch,
      })

    await update({ notes: 'Ring first.' })
    expect(await stored(s, jobId)).toBe('Ring first.')

    await update({ notes: ' Ring first. Bring the long ladder. ' })
    expect(await stored(s, jobId)).toBe('Ring first. Bring the long ladder.')

    await update({ durationMinutes: 90 })
    expect(await stored(s, jobId)).toBe('Ring first. Bring the long ladder.')

    await update({ notes: '' })
    const cleared = await s.t.run((ctx) => ctx.db.get(jobId))
    expect(cleared).not.toHaveProperty('notes')
  })

  test('the technician the job is for may write one', async () => {
    const s = await setup()
    const jobId = await book(s)
    await s.kevin.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      notes: 'Client paid cash on the day.',
    })
    expect(await stored(s, jobId)).toBe('Client paid cash on the day.')
  })

  test('stays open once the job is invoiced, while its billed details lock', async () => {
    const s = await setup()
    const jobId = await book(s, { notes: 'Ring first.' })
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      status: 'invoiced',
    })

    // The invoice does not carry the note, so writing after it contradicts
    // nothing.
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      notes: 'Paid cash on the day.',
    })
    expect(await stored(s, jobId)).toBe('Paid cash on the day.')

    // Anything the invoice does carry is still refused, note or no note.
    for (const detail of [
      { price: 1 },
      { jobType: 'Ants' },
      { workOrder: 'WO-9' },
      { scheduledAt: Date.now() + 2 * DAY },
      { durationMinutes: 90 },
    ]) {
      await expect(
        s.owner.as.mutation(api.jobs.update, {
          businessId: s.businessId,
          jobId,
          notes: 'Changed with it.',
          ...detail,
        }),
      ).rejects.toThrow(/JOB_INVOICED/)
    }
    expect(await stored(s, jobId)).toBe('Paid cash on the day.')
  })

  test('someone who may not edit the job may not write on it', async () => {
    const s = await setup()
    const jobId = await book(s, { notes: 'Ring first.' })
    // Another subcontractor, whose job this is not.
    const priya = await createActor(s.t, { email: 'priya@coastal.test' })
    await join(s.t, s.owner, priya, s.businessId)
    await expect(
      priya.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        notes: 'Not mine to say.',
      }),
    ).rejects.toThrow(/NO_ACCESS|NOT_FOUND/)
    expect(await stored(s, jobId)).toBe('Ring first.')
  })

  test('an over-long one is refused here too', async () => {
    const s = await setup()
    const jobId = await book(s, { notes: 'Ring first.' })
    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        notes: 'x'.repeat(MAX_JOB_NOTES_LENGTH + 1),
      }),
    ).rejects.toThrow(/NOTES_TOO_LONG/)
    expect(await stored(s, jobId)).toBe('Ring first.')
  })
})

describe('a Recurring Job booked with a note', () => {
  function series(s: Setup, anchorDate: number, notes?: string) {
    return s.owner.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.kevinMembershipId,
      intervalCount: 1,
      intervalUnit: 'month',
      jobType: 'General Pest Control',
      price: 20000,
      anchorDate,
      durationMinutes: 60,
      notes,
    })
  }

  test('puts it on the first visit, the one booked by hand, and no other', async () => {
    const s = await setup()
    const visits = await visitsOf(
      s,
      await series(s, Date.now() + DAY, ' Key under the mat. '),
    )
    expect(visits.length).toBeGreaterThan(1)
    expect(visits[0].status).toBe('pending')
    expect(visits[0].notes).toBe('Key under the mat.')
    for (const visit of visits.slice(1)) {
      expect(visit).not.toHaveProperty('notes')
    }
  })

  test('starting in the past, it goes on the first visit that is booked', async () => {
    const s = await setup()
    // No visit is invented for a date already missed (isBackfill), so the
    // first real visit is the first one projected.
    const visits = await visitsOf(
      s,
      await series(s, Date.now() - 40 * DAY, 'Key under the mat.'),
    )
    expect(visits.length).toBeGreaterThan(1)
    expect(visits.filter((v) => v.notes !== undefined)).toEqual([
      expect.objectContaining({
        _id: visits[0]._id,
        notes: 'Key under the mat.',
      }),
    ])
  })

  test('with no visit inside the horizon yet, it waits for the first one booked', async () => {
    const s = await setup()
    // A yearly inspection entered a month after the last one: its next visit
    // is eleven months out, past the horizon, so nothing is booked yet.
    const recurrenceId = await s.owner.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.kevinMembershipId,
      intervalCount: 1,
      intervalUnit: 'year',
      jobType: 'Termite Inspection',
      price: 30000,
      anchorDate: Date.now() - 30 * DAY,
      durationMinutes: 60,
      notes: 'Key under the mat.',
    })
    expect(await visitsOf(s, recurrenceId)).toHaveLength(0)
    const waiting = await s.t.run((ctx) => ctx.db.get(recurrenceId))
    expect(waiting?.firstVisitNotes).toBe('Key under the mat.')

    // Months on, the nightly run books the visit — with the note — and a
    // second run books nothing and copies it nowhere else.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 200 * DAY)
      await s.t.mutation(internal.recurrences.materialiseAll, {})
      await s.t.mutation(internal.recurrences.materialiseAll, {})
    } finally {
      vi.useRealTimers()
    }
    const visits = await visitsOf(s, recurrenceId)
    expect(visits).toHaveLength(1)
    expect(visits[0].notes).toBe('Key under the mat.')
    const after = await s.t.run((ctx) => ctx.db.get(recurrenceId))
    expect(after).not.toHaveProperty('firstVisitNotes')
  })

  test('one too long is refused, and no series or visit is made', async () => {
    const s = await setup()
    await expect(
      series(s, Date.now() + DAY, 'x'.repeat(MAX_JOB_NOTES_LENGTH + 1)),
    ).rejects.toThrow(/NOTES_TOO_LONG/)
    const [recurrences, jobs] = await s.t.run(async (ctx) => [
      await ctx.db.query('recurrences').collect(),
      await ctx.db.query('jobs').collect(),
    ])
    expect(recurrences).toHaveLength(0)
    expect(jobs).toHaveLength(0)
  })
})

describe('a job for several services', () => {
  async function requireReports(s: Setup) {
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.businessId, { requireReportToComplete: true })
    })
  }

  test('needs its report when any one of its services has a form', async () => {
    const s = await setup()
    await requireReports(s)
    // Bed Bugs has no form; a termite inspection does.
    const jobId = await book(s, { jobType: 'Bed Bugs, Termite Inspection' })
    await expect(
      s.owner.as.mutation(api.jobs.complete, {
        businessId: s.businessId,
        jobId,
      }),
    ).rejects.toThrow(/REPORT_REQUIRED/)
  })

  test('is held the same way when marked complete from the status menu', async () => {
    const s = await setup()
    await requireReports(s)
    const jobId = await book(s, { jobType: 'Bed Bugs, Termite Inspection' })
    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        status: 'completed',
      }),
    ).rejects.toThrow(/REPORT_REQUIRED/)
  })

  test('a service typed in lower case finds its form all the same', async () => {
    const s = await setup()
    await requireReports(s)
    const jobId = await book(s, { jobType: 'bed bugs, termite inspection' })
    await expect(
      s.owner.as.mutation(api.jobs.complete, {
        businessId: s.businessId,
        jobId,
      }),
    ).rejects.toThrow(/REPORT_REQUIRED/)
  })

  test('is not held for a report when none of its services has a form', async () => {
    const s = await setup()
    await requireReports(s)
    const jobId = await book(s, { jobType: 'Bed Bugs, Bird Proofing' })
    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId,
    })
    const job = await s.t.run((ctx) => ctx.db.get(jobId))
    expect(job?.status).toBe('completed')
  })

  test('counts once under each of its services in the analytics', async () => {
    const s = await setup()
    // Now, not tomorrow: the window ends with this month, and on its last
    // day tomorrow is outside it.
    const now = Date.now()
    await book(s, {
      jobType: 'General Pest Control, Rodents',
      scheduledAt: now,
    })
    await book(s, { jobType: 'General Pest Control', scheduledAt: now })
    const overview = await s.owner.as.query(api.analytics.overview, {
      businessId: s.businessId,
    })
    expect(overview?.typeBreakdown).toEqual(
      expect.arrayContaining([
        { jobType: 'General Pest Control', count: 2 },
        { jobType: 'Rodents', count: 1 },
      ]),
    )
    expect(overview?.typeBreakdown).toHaveLength(2)
  })
})
