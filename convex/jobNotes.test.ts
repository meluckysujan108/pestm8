/// <reference types="vite/client" />
import { describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { MAX_JOB_NOTES_LENGTH } from './lib/jobNotes'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * A job's note, and a job for several services — the two things a business
 * asked for on 29 Sept 2026: "we do general pest with termites and rodents",
 * and somewhere on the job to write "if I must add a note". Since 30 Sept a
 * job's note is a note in Notes (`insertJobNote`), in one place with the
 * site's.
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

/** The job's notes in Notes, as their title and first lines. */
async function notesOn(s: Setup, jobId: Id<'jobs'>) {
  const notes = await s.t.run((ctx) =>
    ctx.db
      .query('notes')
      .withIndex('by_job', (q) => q.eq('jobId', jobId))
      .collect(),
  )
  return notes.map((n) => ({
    title: n.title,
    preview: n.preview,
    author: n.authorMembershipId,
    propertyId: n.propertyId,
    clientId: n.clientId,
    shared: n.visibility === undefined,
  }))
}

/** Anything left in the plain-text note field jobs carried for a day
 * (29–30 Sept 2026), read past the schema that no longer has it. */
async function plain(s: Setup, jobId: Id<'jobs'>) {
  const job = await s.t.run((ctx) => ctx.db.get(jobId))
  return (job as Record<string, unknown> | null)?.notes
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
  test('makes it a note in Notes on the job, by whoever booked, first line its title', async () => {
    const s = await setup()
    const jobId = await book(s, {
      notes: '  Tenant home after 10.\r\nSide gate code 4411.  ',
    })
    const clientId = await s.t.run(
      async (ctx) => (await ctx.db.get(s.propertyId))!.clientId,
    )
    expect(await notesOn(s, jobId)).toEqual([
      {
        title: 'Tenant home after 10.',
        preview: 'Side gate code 4411.',
        author: s.ownerMembershipId,
        // Linked to the site and client too, so it is on the client's
        // sheet and in Notes → Jobs.
        propertyId: s.propertyId,
        clientId,
        shared: true,
      },
    ])
    // Nothing is left on the job itself.
    expect(await plain(s, jobId)).toBeUndefined()
  })

  test('a blank one is no note at all', async () => {
    const s = await setup()
    for (const notes of [' \n ', '', undefined]) {
      expect(await notesOn(s, await book(s, { notes }))).toEqual([])
    }
  })

  test('one longer than a note is refused, and books nothing', async () => {
    const s = await setup()
    await book(s, { notes: 'x'.repeat(MAX_JOB_NOTES_LENGTH) })
    await expect(
      book(s, { notes: 'x'.repeat(MAX_JOB_NOTES_LENGTH + 1) }),
    ).rejects.toThrow(/NOTES_TOO_LONG/)
    const [jobs, notes] = await s.t.run(async (ctx) => [
      await ctx.db.query('jobs').collect(),
      await ctx.db.query('notes').collect(),
    ])
    expect(jobs).toHaveLength(1)
    expect(notes).toHaveLength(1)
  })

  test('the technician the job is for reads it on the job, and on its card', async () => {
    const s = await setup()
    const jobId = await book(s, {
      notes: 'Dog in the back yard.\nBring the ladder.',
    })
    const onJob = await s.kevin.as.query(api.notes.listForJob, {
      businessId: s.businessId,
      jobId,
    })
    expect(onJob.map((n) => n.title)).toEqual(['Dog in the back yard.'])

    const job = await s.t.run((ctx) => ctx.db.get(jobId))
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Perth',
    }).format(new Date(job!.scheduledAt))
    const card = await s.kevin.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: day,
    })
    expect(card.find((j) => j._id === jobId)?.notePreview).toBe(
      'Dog in the back yard. · Bring the ladder.',
    )
  })
})

describe('a job’s notes after the booking', () => {
  test('go with the job when it is moved to another site and client', async () => {
    const s = await setup()
    const jobId = await book(s, { notes: 'Tenant home after 10.' })
    const other = await s.t.run(async (ctx) => {
      const now = Date.now()
      const clientId = await ctx.db.insert('clients', {
        businessId: s.businessId,
        kind: 'person',
        name: 'Bob Oak',
        createdAt: now,
        updatedAt: now,
      })
      const propertyId = await ctx.db.insert('properties', {
        businessId: s.businessId,
        clientId,
        addressLine: '3 Oak Street',
        suburb: 'Bayswater',
        state: 'WA',
        postcode: '6053',
        createdAt: now,
      })
      return { clientId, propertyId }
    })
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      propertyId: other.propertyId,
    })
    expect(await notesOn(s, jobId)).toEqual([
      expect.objectContaining({
        propertyId: other.propertyId,
        clientId: other.clientId,
      }),
    ])
    const oldSite = await s.owner.as.query(api.notes.listForProperty, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })
    expect(oldSite.visits).toEqual([])
    const newSite = await s.owner.as.query(api.notes.listForProperty, {
      businessId: s.businessId,
      propertyId: other.propertyId,
    })
    expect(newSite.visits.map((n) => n.title)).toEqual([
      'Tenant home after 10.',
    ])
  })

  test('an empty note begun on the job never hides the one that says something', async () => {
    const s = await setup()
    const jobId = await book(s, { notes: 'Ring first.' })
    // "+ Visit note", then nothing typed.
    await s.owner.as.mutation(api.notes.create, {
      businessId: s.businessId,
      template: 'blank',
      title: '',
      jobId,
    })
    const job = await s.t.run((ctx) => ctx.db.get(jobId))
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Perth',
    }).format(new Date(job!.scheduledAt))
    const card = await s.owner.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: day,
    })
    expect(card.find((j) => j._id === jobId)?.notePreview).toBe('Ring first.')
  })
})

describe('an older app still sending a job’s note', () => {
  // `jobs.update` still takes `notes`, from a phone running the app from
  // before job notes were Notes: its job sheet kept the note as text on the
  // job. That field is gone, so what it sends becomes a note in Notes.
  test('keeps it as a note in Notes on the job, once, and never on the job', async () => {
    const s = await setup()
    const jobId = await book(s)
    const update = (patch: { notes?: string; durationMinutes?: number }) =>
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        ...patch,
      })

    await update({ notes: 'Ring first.' })
    expect(await notesOn(s, jobId)).toEqual([
      expect.objectContaining({
        title: 'Ring first.',
        author: s.ownerMembershipId,
        shared: true,
      }),
    ])
    // The same words again — an older app sends the whole note with every
    // change — are the same note.
    await update({ notes: ' Ring first. ' })
    // Other changes, and clearing it, add nothing.
    await update({ durationMinutes: 90 })
    await update({ notes: '' })
    expect(await notesOn(s, jobId)).toHaveLength(1)
    // A changed note is kept too: nothing an older phone sends is lost.
    await update({ notes: 'Ring first. Bring the long ladder.' })
    expect((await notesOn(s, jobId)).map((n) => n.title).sort()).toEqual([
      'Ring first.',
      'Ring first. Bring the long ladder.',
    ])
    expect(await plain(s, jobId)).toBeUndefined()
  })

  test('is taken on an invoiced job, while its billed details stay locked', async () => {
    const s = await setup()
    const jobId = await book(s)
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      status: 'invoiced',
    })
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      notes: 'Paid cash on the day.',
    })
    expect((await notesOn(s, jobId)).map((n) => n.title)).toEqual([
      'Paid cash on the day.',
    ])
    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        notes: 'Changed with it.',
        price: 1,
      }),
    ).rejects.toThrow(/JOB_INVOICED/)
    // Refused whole: the note with it was not kept either.
    expect(await notesOn(s, jobId)).toHaveLength(1)
  })

  test('someone who may not edit the job may not write on it', async () => {
    const s = await setup()
    const jobId = await book(s)
    const priya = await createActor(s.t, { email: 'priya@coastal.test' })
    await join(s.t, s.owner, priya, s.businessId)
    await expect(
      priya.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        notes: 'Not mine to say.',
      }),
    ).rejects.toThrow(/NO_ACCESS|NOT_FOUND/)
    expect(await notesOn(s, jobId)).toEqual([])
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

  async function notedVisits(s: Setup, recurrenceId: Id<'recurrences'>) {
    const visits = await visitsOf(s, recurrenceId)
    const noted = []
    for (const visit of visits) {
      const notes = await notesOn(s, visit._id)
      if (notes.length > 0) noted.push({ visit, notes })
    }
    return { visits, noted }
  }

  test('puts it in Notes on the first visit, the one booked by hand, and no other', async () => {
    const s = await setup()
    const { visits, noted } = await notedVisits(
      s,
      await series(s, Date.now() + DAY, ' Key under the mat. '),
    )
    expect(visits.length).toBeGreaterThan(1)
    expect(visits[0].status).toBe('pending')
    expect(noted.map((n) => n.visit._id)).toEqual([visits[0]._id])
    expect(noted[0].notes[0]).toMatchObject({
      title: 'Key under the mat.',
      author: s.ownerMembershipId,
    })
    for (const visit of visits) expect(visit).not.toHaveProperty('notes')
  })

  test('starting in the past, it goes on the first visit that is booked', async () => {
    const s = await setup()
    const { visits, noted } = await notedVisits(
      s,
      await series(s, Date.now() - 40 * DAY, 'Key under the mat.'),
    )
    expect(visits.length).toBeGreaterThan(1)
    expect(noted.map((n) => n.visit._id)).toEqual([visits[0]._id])
  })

  test('with no visit inside the horizon yet, it waits, then is the booker’s note on the first one booked', async () => {
    const s = await setup()
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
    expect(waiting).toMatchObject({
      firstVisitNotes: 'Key under the mat.',
      firstVisitNotesBy: s.ownerMembershipId,
    })

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 200 * DAY)
      await s.t.mutation(internal.recurrences.materialiseAll, {})
      await s.t.mutation(internal.recurrences.materialiseAll, {})
    } finally {
      vi.useRealTimers()
    }
    const { visits, noted } = await notedVisits(s, recurrenceId)
    expect(visits).toHaveLength(1)
    expect(noted).toHaveLength(1)
    expect(noted[0].notes).toEqual([
      expect.objectContaining({
        title: 'Key under the mat.',
        author: s.ownerMembershipId,
      }),
    ])
    const after = await s.t.run((ctx) => ctx.db.get(recurrenceId))
    expect(after).not.toHaveProperty('firstVisitNotes')
    expect(after).not.toHaveProperty('firstVisitNotesBy')
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
