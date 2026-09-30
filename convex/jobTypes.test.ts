/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { DEFAULT_JOB_TYPES } from './lib/jobTypes'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * Settings → Job types: the owner's own list of services (convex/jobTypes.ts).
 */

const DAY = 24 * 60 * 60 * 1000

afterEach(() => {
  vi.useRealTimers()
})

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@pestm8.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, { email: 'kevin@pestm8.test' })
  const kevinMembershipId = await join(
    t,
    owner,
    kevin,
    businessId,
    'subcontractor',
  )
  const cara = await createActor(t, { email: 'cara@pestm8.test' })
  await join(t, owner, cara, businessId, 'contractor')
  const propertyId = await t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'Jane Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '12 Kent St',
      suburb: 'Nightcliff',
      state: 'NT',
      postcode: '0810',
      createdAt: now,
    })
  })
  return {
    t,
    owner,
    kevin,
    cara,
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

function book(s: Setup, jobType: string, inDays = 1) {
  return s.owner.as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.kevinMembershipId,
    jobType,
    price: 18000,
    scheduledAt: Date.now() + inDays * DAY,
    durationMinutes: 60,
  })
}

function repeat(s: Setup, jobType: string) {
  return s.owner.as.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.kevinMembershipId,
    intervalCount: 3,
    intervalUnit: 'month',
    jobType,
    price: 18000,
    anchorDate: Date.now() + 2 * DAY,
    durationMinutes: 60,
  })
}

async function label(s: Setup, jobId: Id<'jobs'>) {
  return (await s.t.run((ctx) => ctx.db.get(jobId)))!.jobType
}

async function seriesLabel(s: Setup, id: Id<'recurrences'>) {
  return (await s.t.run((ctx) => ctx.db.get(id)))!.jobType
}

function list(s: Setup, who: TestActor = s.owner) {
  return who.as.query(api.jobTypes.list, { businessId: s.businessId })
}

function manage(s: Setup) {
  return s.owner.as.query(api.jobTypes.manage, { businessId: s.businessId })
}

const offeredNames = async (s: Setup) =>
  (await list(s)).filter((e) => e.offered).map((e) => e.name)

/** Runs a change that rewrites labels, then the rewrite to the end. */
async function andRewrite(s: Setup, change: () => Promise<unknown>) {
  vi.useFakeTimers()
  await change()
  await s.t.finishAllScheduledFunctions(vi.runAllTimers)
  vi.useRealTimers()
}

describe('the list a business starts with', () => {
  test('is the built-in nine, A–Z, for everyone who books work', async () => {
    const s = await setup()
    const names = DEFAULT_JOB_TYPES.map((e) => e.name).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    )
    expect(await offeredNames(s)).toEqual(names)
    expect((await list(s, s.kevin)).map((e) => e.name)).toEqual(names)
    expect((await list(s, s.cara)).map((e) => e.name)).toEqual(names)
    // Nothing is written until the owner changes something.
    const rows = await s.t.run((ctx) => ctx.db.query('jobTypes').collect())
    expect(rows).toHaveLength(0)
  })

  test('is read by nobody outside the business', async () => {
    const s = await setup()
    const stranger = await createActor(s.t, { email: 'x@other.test' })
    await expect(list(s, stranger)).rejects.toThrow(/NO_ACCESS/)
  })
})

describe('only the owner changes the list', () => {
  test('a subcontractor and a contractor are refused every change, and the page', async () => {
    const s = await setup()
    for (const who of [s.kevin, s.cara]) {
      const businessId = s.businessId
      await expect(
        who.as.query(api.jobTypes.manage, { businessId }),
      ).rejects.toThrow(/NO_ACCESS/)
      await expect(
        who.as.mutation(api.jobTypes.create, {
          businessId,
          name: 'Possum Removal',
          report: 'none',
        }),
      ).rejects.toThrow(/NO_ACCESS/)
      await expect(
        who.as.mutation(api.jobTypes.update, {
          businessId,
          name: 'Ants',
          newName: 'Ant Treatment',
        }),
      ).rejects.toThrow(/NO_ACCESS/)
      await expect(
        who.as.mutation(api.jobTypes.remove, { businessId, name: 'Ants' }),
      ).rejects.toThrow(/NO_ACCESS/)
      await expect(
        who.as.mutation(api.jobTypes.restore, { businessId, name: 'Ants' }),
      ).rejects.toThrow(/NO_ACCESS/)
      await expect(
        who.as.mutation(api.jobTypes.swap, {
          businessId,
          from: 'Gpc',
          to: ['General Pest Control'],
        }),
      ).rejects.toThrow(/NO_ACCESS/)
    }
    expect(await s.t.run((ctx) => ctx.db.query('jobTypes').collect())).toEqual(
      [],
    )
  })

  test('an owner of another business cannot touch this one', async () => {
    const s = await setup()
    const other = await createActor(s.t, { email: 'boss@other.test' })
    await createBusiness(s.t, other)
    await expect(
      other.as.mutation(api.jobTypes.create, {
        businessId: s.businessId,
        name: 'Possum Removal',
        report: 'none',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })
})

describe('adding a job type', () => {
  test('writes the nine first, then the new one, offered by New Job', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.jobTypes.create, {
      businessId: s.businessId,
      name: '  Possum   Removal ',
      report: 'none',
    })
    const entries = await list(s)
    expect(entries).toHaveLength(10)
    expect(entries.find((e) => e.name === 'Possum Removal')).toMatchObject({
      offered: true,
      report: 'none',
    })
    // Anyone sees it at once.
    expect((await list(s, s.kevin)).map((e) => e.name)).toContain(
      'Possum Removal',
    )
  })

  test('refuses a name the list has, in any capitals', async () => {
    const s = await setup()
    await expect(
      s.owner.as.mutation(api.jobTypes.create, {
        businessId: s.businessId,
        name: 'general pest control',
        report: 'serviceReport',
      }),
    ).rejects.toThrow(/JOB_TYPE_EXISTS/)
  })

  test('refuses a blank name, a comma, and a name too long for a picker', async () => {
    const s = await setup()
    const add = (name: string) =>
      s.owner.as.mutation(api.jobTypes.create, {
        businessId: s.businessId,
        name,
        report: 'none',
      })
    await expect(add('   ')).rejects.toThrow(/JOB_TYPE_EMPTY/)
    await expect(add('Possums, rats')).rejects.toThrow(/JOB_TYPE_COMMA/)
    await expect(add('x'.repeat(61))).rejects.toThrow(/JOB_TYPE_TOO_LONG/)
  })

  test('adopting one typed into jobs puts every job under the name chosen', async () => {
    const s = await setup()
    const typed = await book(s, 'possum removal, Rodents')
    await andRewrite(s, () =>
      s.owner.as.mutation(api.jobTypes.create, {
        businessId: s.businessId,
        name: 'Possum Removal',
        report: 'none',
        from: 'possum removal',
      }),
    )
    expect(await label(s, typed)).toBe('Possum Removal, Rodents')

    // A typo fixed on the way onto the list is fixed everywhere, and the
    // old spelling is remembered.
    const typo = await book(s, 'Rodent Bait Top-Up Montly')
    await andRewrite(s, () =>
      s.owner.as.mutation(api.jobTypes.create, {
        businessId: s.businessId,
        name: 'Rodent Bait Top-Up',
        report: 'serviceReport',
        from: 'Rodent Bait Top-Up Montly',
      }),
    )
    expect(await label(s, typo)).toBe('Rodent Bait Top-Up')
    expect(await label(s, await book(s, 'Rodent Bait Top-Up Montly'))).toBe(
      'Rodent Bait Top-Up',
    )
  })
})

describe('deleting a job type', () => {
  test('stops New Job offering it, and no job loses it', async () => {
    const s = await setup()
    const jobId = await book(s, 'Wasps, Spiders')
    await s.owner.as.mutation(api.jobTypes.remove, {
      businessId: s.businessId,
      name: 'Wasps',
    })
    expect(await offeredNames(s)).not.toContain('Wasps')
    expect((await list(s)).find((e) => e.name === 'Wasps')?.offered).toBe(false)
    expect(await label(s, jobId)).toBe('Wasps, Spiders')
  })

  test('Offer again brings it back as it was', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.jobTypes.update, {
      businessId: s.businessId,
      name: 'Wasps',
      report: 'none',
    })
    await s.owner.as.mutation(api.jobTypes.remove, {
      businessId: s.businessId,
      name: 'Wasps',
    })
    await s.owner.as.mutation(api.jobTypes.restore, {
      businessId: s.businessId,
      name: 'wasps',
    })
    expect((await list(s)).find((e) => e.name === 'Wasps')).toMatchObject({
      offered: true,
      report: 'none',
    })
  })

  test('adding a deleted name brings that one back rather than a second', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.jobTypes.remove, {
      businessId: s.businessId,
      name: 'Bed Bugs',
    })
    await s.owner.as.mutation(api.jobTypes.create, {
      businessId: s.businessId,
      name: 'Bed bugs',
      report: 'serviceReport',
    })
    const bedBugs = (await list(s)).filter(
      (e) => e.name.toLowerCase() === 'bed bugs',
    )
    expect(bedBugs).toEqual([
      expect.objectContaining({
        name: 'Bed bugs',
        offered: true,
        report: 'serviceReport',
      }),
    ])
  })

  test('the last one offered stays', async () => {
    const s = await setup()
    const names = await offeredNames(s)
    for (const name of names.slice(1)) {
      await s.owner.as.mutation(api.jobTypes.remove, {
        businessId: s.businessId,
        name,
      })
    }
    await expect(
      s.owner.as.mutation(api.jobTypes.remove, {
        businessId: s.businessId,
        name: names[0],
      }),
    ).rejects.toThrow(/LAST_JOB_TYPE/)
  })
})

describe('renaming a job type', () => {
  test('changes it on every job and series, finished ones and mixed labels included', async () => {
    const s = await setup()
    const done = await book(s, 'General Pest Control', -3)
    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId: done,
    })
    const mixed = await book(s, 'Termite Inspection, General Pest Control')
    const recurrenceId = await repeat(s, 'General Pest Control')

    await andRewrite(s, () =>
      s.owner.as.mutation(api.jobTypes.update, {
        businessId: s.businessId,
        name: 'General Pest Control',
        newName: 'General Pest Treatment',
      }),
    )

    expect(await label(s, done)).toBe('General Pest Treatment')
    expect(await label(s, mixed)).toBe(
      'Termite Inspection, General Pest Treatment',
    )
    expect(await seriesLabel(s, recurrenceId)).toBe('General Pest Treatment')
    const visits = await s.t.run((ctx) =>
      ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
        .collect(),
    )
    expect(visits.length).toBeGreaterThan(0)
    expect(new Set(visits.map((v) => v.jobType))).toEqual(
      new Set(['General Pest Treatment']),
    )
    expect(await offeredNames(s)).toContain('General Pest Treatment')
    expect(await offeredNames(s)).not.toContain('General Pest Control')
  })

  test('the old name, sent by a phone on last week’s build, is saved as the new one', async () => {
    const s = await setup()
    await andRewrite(s, () =>
      s.owner.as.mutation(api.jobTypes.update, {
        businessId: s.businessId,
        name: 'Rodents',
        newName: 'Rodent Baiting',
      }),
    )
    expect(await label(s, await book(s, 'rodents, Ants'))).toBe(
      'Rodent Baiting, Ants',
    )
    const recurrenceId = await repeat(s, 'Rodents')
    expect(await seriesLabel(s, recurrenceId)).toBe('Rodent Baiting')
  })

  test('two quick renames end on the newest name everywhere', async () => {
    const s = await setup()
    const jobs = await Promise.all([1, 2, 3].map((d) => book(s, 'Ants', d)))
    vi.useFakeTimers()
    await s.owner.as.mutation(api.jobTypes.update, {
      businessId: s.businessId,
      name: 'Ants',
      newName: 'Ant Treatment',
    })
    await s.owner.as.mutation(api.jobTypes.update, {
      businessId: s.businessId,
      name: 'Ant Treatment',
      newName: 'Ant Full Block Spray',
    })
    await s.t.finishAllScheduledFunctions(vi.runAllTimers)
    vi.useRealTimers()
    for (const jobId of jobs) {
      expect(await label(s, jobId)).toBe('Ant Full Block Spray')
    }
  })

  test('onto a name the list has is a merge, and asks first', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.jobTypes.create, {
      businessId: s.businessId,
      name: 'Roaches',
      report: 'none',
    })
    const jobId = await book(s, 'Roaches')
    await expect(
      s.owner.as.mutation(api.jobTypes.update, {
        businessId: s.businessId,
        name: 'Roaches',
        newName: 'cockroaches',
      }),
    ).rejects.toThrow(/JOB_TYPE_EXISTS/)
    expect(await label(s, jobId)).toBe('Roaches')

    let result: { merged: boolean } | undefined
    await andRewrite(s, async () => {
      result = await s.owner.as.mutation(api.jobTypes.update, {
        businessId: s.businessId,
        name: 'Roaches',
        // Typed in lower case: the survivor keeps its own spelling.
        newName: 'cockroaches',
        merge: true,
      })
    })
    expect(result).toEqual({ merged: true })
    expect(await label(s, jobId)).toBe('Cockroaches')
    const cockroaches = (await list(s)).filter((e) =>
      ['roaches', 'cockroaches'].includes(e.name.toLowerCase()),
    )
    // One service, keeping its own report, remembering the other's name.
    expect(cockroaches).toEqual([
      expect.objectContaining({
        name: 'Cockroaches',
        report: 'serviceReport',
        formerNames: ['Roaches'],
      }),
    ])
  })

  test('a change of capitals only is a rename, not a merge', async () => {
    const s = await setup()
    const jobId = await book(s, 'Bed Bugs')
    await andRewrite(s, () =>
      s.owner.as.mutation(api.jobTypes.update, {
        businessId: s.businessId,
        name: 'Bed Bugs',
        newName: 'Bed bugs',
      }),
    )
    expect(await label(s, jobId)).toBe('Bed bugs')
    expect(
      (await list(s)).find((e) => e.name === 'Bed bugs')?.formerNames,
    ).toEqual([])
  })
})

describe('a service typed into jobs', () => {
  test('is listed for tidying, then swapped for services on the list', async () => {
    const s = await setup()
    const jobId = await book(s, 'Gpc & Tpi')
    const recurrenceId = await repeat(s, 'Gpc & Tpi')

    const before = await manage(s)
    // The series' first visit is booked by hand, so it is a job as well.
    expect(before.typedIn).toEqual([{ name: 'Gpc & Tpi', jobs: 2, series: 1 }])

    await andRewrite(s, () =>
      s.owner.as.mutation(api.jobTypes.swap, {
        businessId: s.businessId,
        from: 'gpc & tpi',
        to: ['general pest control', 'Termite Inspection'],
      }),
    )
    expect(await label(s, jobId)).toBe(
      'General Pest Control, Termite Inspection',
    )
    expect(await seriesLabel(s, recurrenceId)).toBe(
      'General Pest Control, Termite Inspection',
    )
    expect((await manage(s)).typedIn).toEqual([])
  })

  test('can only be swapped for services the list offers', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.jobTypes.remove, {
      businessId: s.businessId,
      name: 'Wasps',
    })
    for (const to of [['Possums'], ['Wasps'], []]) {
      await expect(
        s.owner.as.mutation(api.jobTypes.swap, {
          businessId: s.businessId,
          from: 'Gpc',
          to,
        }),
      ).rejects.toThrow(/JOB_TYPE_NOT_FOUND/)
    }
  })
})

describe('the owner’s page', () => {
  test('counts jobs and running series, never the projected visits', async () => {
    const s = await setup()
    await book(s, 'General Pest Control')
    await book(s, 'General Pest Control, Ants')
    await repeat(s, 'Ants')
    const page = await manage(s)
    expect(page.isDefault).toBe(true)
    expect(page.complete).toBe(true)
    const byName = Object.fromEntries(page.types.map((t) => [t.name, t]))
    expect(byName['General Pest Control']).toMatchObject({ jobs: 2, series: 0 })
    // The series' first visit is a job booked by hand; its projections are not.
    expect(byName['Ants']).toMatchObject({ jobs: 2, series: 1 })
    expect(byName['Wasps']).toMatchObject({ jobs: 0, series: 0 })
  })
})

describe('the report each job type produces', () => {
  async function policyOn(s: Setup) {
    await s.t.run((ctx) =>
      ctx.db.patch(s.businessId, { requireReportToComplete: true }),
    )
  }

  test('a service the owner adds is held up for its report like the built-in ones', async () => {
    const s = await setup()
    await policyOn(s)
    const before = await book(s, 'Rodent Bait Top-Up', -1)
    // Not on the list, and not a name the old table knew: no form, so never held.
    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId: before,
    })

    await s.owner.as.mutation(api.jobTypes.create, {
      businessId: s.businessId,
      name: 'Rodent Bait Top-Up',
      report: 'serviceReport',
    })
    const after = await book(s, 'Rodent Bait Top-Up', -1)
    await expect(
      s.owner.as.mutation(api.jobs.complete, {
        businessId: s.businessId,
        jobId: after,
      }),
    ).rejects.toThrow(/REPORT_REQUIRED/)
  })

  test('No report means the job is never held up', async () => {
    const s = await setup()
    await policyOn(s)
    await s.owner.as.mutation(api.jobTypes.update, {
      businessId: s.businessId,
      name: 'Termite Inspection',
      report: 'none',
    })
    const jobId = await book(s, 'Termite Inspection', -1)
    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId,
    })
    const job = await s.t.run((ctx) => ctx.db.get(jobId))
    expect(job?.status).toBe('completed')
  })
})

describe('what the reviews found', () => {
  test('an old name is not handed on while its jobs are still being rewritten', async () => {
    const s = await setup()
    const jobId = await book(s, 'Rodents')
    vi.useFakeTimers()
    await s.owner.as.mutation(api.jobTypes.update, {
      businessId: s.businessId,
      name: 'Rodents',
      newName: 'Rodent Baiting',
    })
    // The job still says Rodents: a new Rodents now would take it.
    await expect(
      s.owner.as.mutation(api.jobTypes.create, {
        businessId: s.businessId,
        name: 'Rodents',
        report: 'none',
      }),
    ).rejects.toThrow(/JOB_TYPE_BUSY/)
    await s.t.finishAllScheduledFunctions(vi.runAllTimers)
    vi.useRealTimers()
    expect(await label(s, jobId)).toBe('Rodent Baiting')
    expect(
      await s.t.run((ctx) => ctx.db.query('jobTypeRewrites').collect()),
    ).toEqual([])

    // Once it has landed, the name is free, and the job stays where it went.
    await s.owner.as.mutation(api.jobTypes.create, {
      businessId: s.businessId,
      name: 'Rodents',
      report: 'none',
    })
    expect(await label(s, jobId)).toBe('Rodent Baiting')
    expect(await label(s, await book(s, 'Rodents'))).toBe('Rodents')
  })

  test('the first name a service had is kept however many times it is renamed', async () => {
    const s = await setup()
    let name = 'Ants'
    for (let i = 1; i <= 12; i++) {
      const next = `Ant Treatment ${i}`
      await andRewrite(s, () =>
        s.owner.as.mutation(api.jobTypes.update, {
          businessId: s.businessId,
          name,
          newName: next,
        }),
      )
      name = next
    }
    const entry = (await list(s)).find((e) => e.name === name)!
    expect(entry.formerNames).toHaveLength(10)
    expect(entry.formerNames[0]).toBe('Ants')
    expect(await label(s, await book(s, 'ants'))).toBe(name)
  })

  test('only a service the list does not have is adopted or swapped', async () => {
    const s = await setup()
    await expect(
      s.owner.as.mutation(api.jobTypes.create, {
        businessId: s.businessId,
        name: 'Crawlers',
        report: 'none',
        from: 'ants',
      }),
    ).rejects.toThrow(/JOB_TYPE_ON_LIST/)
    await expect(
      s.owner.as.mutation(api.jobTypes.swap, {
        businessId: s.businessId,
        from: 'Ants',
        to: ['Spiders'],
      }),
    ).rejects.toThrow(/JOB_TYPE_ON_LIST/)
    await expect(
      s.owner.as.mutation(api.jobTypes.swap, {
        businessId: s.businessId,
        from: 'Possums, rats',
        to: ['Rodents'],
      }),
    ).rejects.toThrow(/JOB_TYPE_COMMA/)
    // A service typed as a whole sentence can still be adopted.
    const long =
      'Commercial kitchen follow-up: German cockroach flush and gel baiting (after hours)'
    const jobId = await book(s, long)
    await andRewrite(s, () =>
      s.owner.as.mutation(api.jobTypes.create, {
        businessId: s.businessId,
        name: 'Commercial Cockroach Follow-Up',
        report: 'serviceReport',
        from: long,
      }),
    )
    expect(await label(s, jobId)).toBe('Commercial Cockroach Follow-Up')
  })

  test('a deleted name added back in new capitals takes its jobs with it', async () => {
    const s = await setup()
    const jobId = await book(s, 'Wasps')
    await s.owner.as.mutation(api.jobTypes.remove, {
      businessId: s.businessId,
      name: 'Wasps',
    })
    await andRewrite(s, () =>
      s.owner.as.mutation(api.jobTypes.create, {
        businessId: s.businessId,
        name: 'WASPS',
        report: 'serviceReport',
      }),
    )
    expect(await label(s, jobId)).toBe('WASPS')
  })
})
