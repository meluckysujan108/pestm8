/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { MAX_ALSO_GOING } from './lib/jobPeople'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * A job for more than one person (lib/jobPeople.ts): the owner leads, a
 * subcontractor is also going — and sees it, and may do on it whatever its
 * lead may. Seen from each side: the owner, Kevin who is on it, Sam who is
 * not, and a contractor with her own team.
 */

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

afterEach(() => {
  vi.useRealTimers()
})

async function join(
  t: TestApp,
  owner: TestActor,
  invitee: TestActor,
  businessId: Id<'businesses'>,
  role: 'subcontractor' | 'contractor',
) {
  const { url } = await owner.as.action(api.invitations.create, {
    businessId,
    email: invitee.email,
    role,
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
  const owner = await createActor(t, { email: 'terence@pestm8.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, { email: 'kevin@pestm8.test' })
  const kevinId = await join(t, owner, kevin, businessId, 'subcontractor')
  const sam = await createActor(t, { email: 'sam@pestm8.test' })
  const samId = await join(t, owner, sam, businessId, 'subcontractor')
  const propertyId = await t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'business',
      name: 'Karratha Primary School',
      createdAt: now,
      updatedAt: now,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '14 Balmoral Rd',
      suburb: 'Bulgarra',
      state: 'WA',
      postcode: '6714',
      createdAt: now,
    })
  })
  return {
    t,
    owner,
    kevin,
    sam,
    businessId,
    ownerId: ownerMembershipId,
    kevinId,
    samId,
    propertyId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** Tomorrow at 9am-ish, or `days` from now. */
function at(days = 1) {
  return Date.now() + days * DAY
}

function book(
  s: Setup,
  opts: {
    lead?: Id<'memberships'>
    alsoGoing?: Array<Id<'memberships'>>
    when?: number
    by?: TestActor
  } = {},
) {
  return (opts.by ?? s.owner).as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: opts.lead ?? s.ownerId,
    jobType: 'General Pest Control, Termite Inspection',
    price: 145000,
    scheduledAt: opts.when ?? at(),
    durationMinutes: 180,
    ...(opts.alsoGoing && { alsoGoing: opts.alsoGoing }),
  })
}

function dayKeyOf(when: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
  }).format(new Date(when))
}

async function dayOf(s: Setup, who: TestActor, when: number) {
  const rows = await who.as.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey: dayKeyOf(when),
  })
  return rows.map((j) => j._id)
}

async function peopleRows(s: Setup, jobId: Id<'jobs'>) {
  return s.t.run((ctx) =>
    ctx.db
      .query('jobPeople')
      .withIndex('by_job', (q) => q.eq('jobId', jobId))
      .collect(),
  )
}

describe('a job the owner leads and Kevin is also going on', () => {
  test('is on Kevin’s day and not on Sam’s', async () => {
    const s = await setup()
    const when = at()
    const jobId = await book(s, { alsoGoing: [s.kevinId], when })
    expect(await dayOf(s, s.kevin, when)).toContain(jobId)
    expect(await dayOf(s, s.sam, when)).not.toContain(jobId)
    // The owner sees it once, whoever else is on it.
    const owners = await dayOf(s, s.owner, when)
    expect(owners.filter((id) => id === jobId)).toHaveLength(1)
  })

  test('opens for Kevin, naming everyone on it, and for Sam reads as gone', async () => {
    const s = await setup()
    const jobId = await book(s, { alsoGoing: [s.kevinId] })
    const forKevin = await s.kevin.as.query(api.jobs.get, {
      businessId: s.businessId,
      jobId,
    })
    expect(forKevin?.assignee?._id).toBe(s.ownerId)
    expect(forKevin?.alsoGoing.map((p) => p._id)).toEqual([s.kevinId])
    expect(forKevin?.canEdit).toBe(true)
    expect(
      await s.sam.as.query(api.jobs.get, { businessId: s.businessId, jobId }),
    ).toBeNull()
  })

  test('the day row carries each person also going, with their colour', async () => {
    const s = await setup()
    const when = at()
    const jobId = await book(s, { alsoGoing: [s.kevinId], when })
    const rows = await s.owner.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: dayKeyOf(when),
    })
    const row = rows.find((j) => j._id === jobId)
    expect(row?.alsoGoing).toEqual([
      expect.objectContaining({ _id: s.kevinId }),
    ])
  })

  test('Kevin may do on it whatever its lead may: move it, complete it', async () => {
    const s = await setup()
    const jobId = await book(s, { alsoGoing: [s.kevinId], when: at(1) })
    const later = at(3)
    await s.kevin.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      scheduledAt: later,
    })
    // His people row moved with it, so the job is on his new day.
    expect((await peopleRows(s, jobId)).map((r) => r.scheduledAt)).toEqual([
      later,
    ])
    expect(await dayOf(s, s.kevin, later)).toContain(jobId)
    await s.kevin.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId,
    })
    const job = await s.t.run((ctx) => ctx.db.get(jobId))
    expect(job?.status).toBe('completed')
  })

  test('Sam, not on it, may change nothing', async () => {
    const s = await setup()
    const jobId = await book(s, { alsoGoing: [s.kevinId] })
    await expect(
      s.sam.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        scheduledAt: at(4),
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      s.sam.as.mutation(api.jobs.complete, { businessId: s.businessId, jobId }),
    ).rejects.toThrow(/NO_ACCESS/)
  })
})

describe('who can be put on a job', () => {
  test('the owner adds anyone; a subcontractor only themselves', async () => {
    const s = await setup()
    const jobId = await book(s, { alsoGoing: [s.kevinId] })
    // Kevin, on it, cannot put Sam on it: he may only book himself.
    await expect(
      s.kevin.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        alsoGoing: [s.kevinId, s.samId],
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      alsoGoing: [s.kevinId, s.samId],
    })
    expect(
      (await peopleRows(s, jobId)).map((r) => r.membershipId).sort(),
    ).toEqual([s.kevinId, s.samId].sort())
    // Kevin can still take himself off.
    await s.kevin.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      alsoGoing: [s.samId],
    })
    expect((await peopleRows(s, jobId)).map((r) => r.membershipId)).toEqual([
      s.samId,
    ])
  })

  test('someone from another business is refused', async () => {
    const s = await setup()
    const other = await createActor(s.t, { email: 'boss@other.test' })
    const { ownerMembershipId: stranger } = await createBusiness(s.t, other)
    await expect(book(s, { alsoGoing: [stranger] })).rejects.toThrow()
    expect(await s.t.run((ctx) => ctx.db.query('jobs').collect())).toHaveLength(
      0,
    )
  })

  test('the lead is never also going, and there is a limit', async () => {
    const s = await setup()
    const jobId = await book(s, {
      alsoGoing: [s.ownerId, s.kevinId, s.kevinId],
    })
    expect((await peopleRows(s, jobId)).map((r) => r.membershipId)).toEqual([
      s.kevinId,
    ])
    const many = Array.from({ length: MAX_ALSO_GOING + 1 }, () => s.kevinId)
    // Repeats count once: this many distinct people is what is refused.
    await book(s, { alsoGoing: many })
    const t2 = await setup()
    const extra: Array<Id<'memberships'>> = []
    for (let i = 0; i <= MAX_ALSO_GOING; i++) {
      const a = await createActor(t2.t, { email: `x${i}@pestm8.test` })
      extra.push(await join(t2.t, t2.owner, a, t2.businessId, 'subcontractor'))
    }
    await expect(book(t2, { alsoGoing: extra })).rejects.toThrow(
      /TOO_MANY_PEOPLE/,
    )
  })

  test('someone made lead is no longer also going, and the old lead is', async () => {
    const s = await setup()
    const jobId = await book(s, { alsoGoing: [s.kevinId, s.samId] })
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      assignedMembershipId: s.kevinId,
    })
    expect(
      (await peopleRows(s, jobId)).map((r) => r.membershipId).sort(),
    ).toEqual([s.samId, s.ownerId].sort())
  })

  test('who went on an invoiced job is locked with its other details', async () => {
    const s = await setup()
    const jobId = await book(s, { alsoGoing: [s.kevinId], when: at(-1) })
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      status: 'invoiced',
    })
    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        alsoGoing: [],
      }),
    ).rejects.toThrow(/JOB_INVOICED/)
  })
})

describe('a contractor and her team on one job', () => {
  test('is listed once, and counted once for each of them', async () => {
    const s = await setup()
    const cara = await createActor(s.t, { email: 'cara@pestm8.test' })
    const caraId = await join(s.t, s.owner, cara, s.businessId, 'contractor')
    // Dan is on Cara's team.
    const dan = await createActor(s.t, { email: 'dan@pestm8.test' })
    const danId = await join(s.t, s.owner, dan, s.businessId, 'subcontractor')
    await s.t.run((ctx) => ctx.db.patch(danId, { parentMembershipId: caraId }))

    const when = at()
    const jobId = await book(s, { lead: caraId, alsoGoing: [danId], when })
    const hers = await dayOf(s, cara, when)
    expect(hers.filter((id) => id === jobId)).toHaveLength(1)

    const monthKey = dayKeyOf(when).slice(0, 7)
    const load = await s.owner.as.query(api.jobs.monthTeamLoad, {
      businessId: s.businessId,
      monthKey,
    })
    const count = (id: Id<'memberships'>) =>
      load.find((row) => row.membershipId === id)?.count
    expect(count(caraId)).toBe(1)
    expect(count(danId)).toBe(1)
  })
})

describe('what comes with the job', () => {
  test('Kevin reads its notes, adds one, and sees its history at the client', async () => {
    const s = await setup()
    const jobId = await book(s, { alsoGoing: [s.kevinId], when: at(-2) })
    const history = await s.kevin.as.query(api.properties.jobHistory, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })
    expect(history.map((j) => j._id)).toContain(jobId)
    const samHistory = await s.sam.as.query(api.properties.jobHistory, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })
    expect(samHistory.map((j) => j._id)).not.toContain(jobId)

    const photos = await s.kevin.as.query(api.jobs.photos, {
      businessId: s.businessId,
      jobId,
    })
    expect(photos).toEqual([])
  })

  test('the owner’s report on it opens for Kevin, not for Sam', async () => {
    const s = await setup()
    const jobId = await book(s, { alsoGoing: [s.kevinId], when: at(-1) })
    const reportId = await s.owner.as.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      jobId,
      template: 'serviceReport',
      legalBasis: 'APVMA',
      data: {},
    })
    const forKevin = await s.kevin.as.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(forKevin).not.toBeNull()
    const onTheSheet = await s.kevin.as.query(api.reports.listByProperty, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })
    expect(onTheSheet.map((r) => r._id)).toContain(reportId)
    expect(
      await s.sam.as.query(api.reports.get, {
        businessId: s.businessId,
        reportId,
      }),
    ).toBeNull()
  })

  test('a report Kevin writes on it starts on Kevin as technician', async () => {
    const s = await setup()
    const jobId = await book(s, { alsoGoing: [s.kevinId], when: at(-1) })
    const reportId = await s.kevin.as.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      jobId,
      template: 'serviceReport',
      legalBasis: 'APVMA',
      data: {},
    })
    const report = await s.t.run((ctx) => ctx.db.get(reportId))
    expect((report?.data as Record<string, unknown>).technician).toBe(s.kevinId)
    // The owner writing one starts on the owner, the job's lead.
    const ownersId = await s.owner.as.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      jobId,
      template: 'serviceReport',
      legalBasis: 'APVMA',
      data: {},
    })
    const owners = await s.t.run((ctx) => ctx.db.get(ownersId))
    expect((owners?.data as Record<string, unknown>).technician).toBe(s.ownerId)
  })

  test('counts in the technician workload for each person, and the job once', async () => {
    const s = await setup()
    await book(s, { alsoGoing: [s.kevinId], when: Date.now() - 2 * HOUR })
    const overview = await s.owner.as.query(api.analytics.overview, {
      businessId: s.businessId,
    })
    const load = overview!.technicianLoad
    expect(load.find((r) => r.membershipId === s.ownerId)?.count).toBe(1)
    expect(load.find((r) => r.membershipId === s.kevinId)?.count).toBe(1)
  })
})

describe('when Kevin leaves the team', () => {
  test('he comes off the jobs ahead he was only also going on; no successor is asked for', async () => {
    const s = await setup()
    const ahead = await book(s, { alsoGoing: [s.kevinId], when: at(2) })
    const past = await book(s, { alsoGoing: [s.kevinId], when: at(-2) })
    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinId,
    })
    expect(await peopleRows(s, ahead)).toEqual([])
    // The visit he went on still says he was there.
    expect((await peopleRows(s, past)).map((r) => r.membershipId)).toEqual([
      s.kevinId,
    ])
  })

  test('the owner is told how many jobs ahead he comes off, and only those', async () => {
    const s = await setup()
    await book(s, { alsoGoing: [s.kevinId], when: at(2) })
    await book(s, { alsoGoing: [s.kevinId], when: at(3) })
    // Neither of these is work he'd be missed from.
    await book(s, { alsoGoing: [s.kevinId], when: at(-2) })
    const called = await book(s, { alsoGoing: [s.kevinId], when: at(4) })
    await s.t.run((ctx) => ctx.db.patch(called, { status: 'cancelled' }))

    const preview = await s.owner.as.query(api.team.removalPreview, {
      businessId: s.businessId,
      membershipId: s.kevinId,
    })
    expect(preview.alsoGoingJobs).toBe(2)
    // Nothing of his own ahead, so nobody is asked to take anything over.
    expect(preview.futureJobs).toBe(0)
  })

  test('a successor already also going on a job he led becomes its lead alone', async () => {
    const s = await setup()
    const jobId = await book(s, {
      lead: s.kevinId,
      alsoGoing: [s.samId],
      when: at(2),
    })
    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      reassignTo: s.samId,
    })
    const job = await s.t.run((ctx) => ctx.db.get(jobId))
    expect(job?.assignedMembershipId).toBe(s.samId)
    expect(await peopleRows(s, jobId)).toEqual([])
  })
})

describe('what the reviews found', () => {
  test('someone also going made lead: the lead they replace is also going instead', async () => {
    const s = await setup()
    const jobId = await book(s, { alsoGoing: [s.kevinId], when: at(2) })
    // Kevin, on it, makes himself lead — he may book himself.
    await s.kevin.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      assignedMembershipId: s.kevinId,
    })
    const job = await s.t.run((ctx) => ctx.db.get(jobId))
    expect(job?.assignedMembershipId).toBe(s.kevinId)
    // The owner is still on it, and still sees it.
    expect((await peopleRows(s, jobId)).map((r) => r.membershipId)).toEqual([
      s.ownerId,
    ])
  })

  test('the owner’s report on a shared visit is on Kevin’s client pages too', async () => {
    const s = await setup()
    const jobId = await book(s, { alsoGoing: [s.kevinId], when: at(-1) })
    const reportId = await s.owner.as.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      jobId,
      template: 'serviceReport',
      legalBasis: 'APVMA',
      data: {},
    })
    const clientId = (await s.t.run((ctx) => ctx.db.get(s.propertyId)))!
      .clientId
    const listed = await s.kevin.as.query(api.clients.reports, {
      businessId: s.businessId,
      clientId,
    })
    expect(listed.map((r) => r._id)).toContain(reportId)
    const chips = await s.kevin.as.query(api.clients.visitReports, {
      businessId: s.businessId,
      clientId,
    })
    expect(chips?.reports.map((r) => r._id)).toContain(reportId)
    // Its markup and email history open for him as the report does.
    await s.kevin.as.query(api.reportAnnotations.listForReport, {
      businessId: s.businessId,
      reportId,
    })
    const known = await s.kevin.as.query(api.deliveries.known, {
      businessId: s.businessId,
      reportId,
    })
    expect(known).toBeDefined()
    // Sam, not on it, gets none of it.
    const samListed = await s.sam.as.query(api.clients.reports, {
      businessId: s.businessId,
      clientId,
    })
    expect(samListed.map((r) => r._id)).not.toContain(reportId)
  })

  test('the Job tab lists a shared job booked just now', async () => {
    const s = await setup()
    const jobId = await book(s, { alsoGoing: [s.kevinId], when: at(-1) })
    const page = await s.kevin.as.query(api.jobs.list, {
      businessId: s.businessId,
    })
    expect(page.jobs.map((j: { _id: Id<'jobs'> }) => j._id)).toContain(jobId)
  })
})
