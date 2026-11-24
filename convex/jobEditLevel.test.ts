/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
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
 * "Other people's jobs: Hidden · View only · View and edit" (Settings →
 * Team). View and edit is everything a job's own people may do to it, but
 * deleting it — and every change lands on the job's Activity under the name
 * of whoever made it.
 *
 * Terence owns the business. Kevin is a subcontractor, Jo another. Cam is a
 * contractor whose team is nobody here: Terence's job is not his.
 */

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

type Level = 'hidden' | 'view' | 'edit'

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
  const cam = await createActor(t, { email: 'cam@pestm8.test', name: 'Cam' })
  const camId = await joinBusiness(t, terence, cam, businessId, 'contractor')
  const propertyId = await t.run(async (ctx) => {
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
  const when = Date.now() + 2 * DAY
  const jobId = await terence.as.mutation(api.jobs.create, {
    businessId,
    propertyId,
    assignedMembershipId: ownerMembershipId,
    jobType: 'General Pest Control',
    price: 19500,
    scheduledAt: when,
    durationMinutes: 60,
  })
  return {
    t,
    terence,
    kevin,
    jo,
    cam,
    businessId,
    ownerId: ownerMembershipId,
    kevinId,
    joId,
    camId,
    jobId,
    when,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** What Settings → Team sends for each choice. */
function give(s: Setup, membershipId: Id<'memberships'>, level: Level) {
  return s.terence.as.mutation(api.memberships.setGrants, {
    businessId: s.businessId,
    membershipId,
    grants: {
      switchInto: null,
      clientDirectory: true,
      prices: false,
      otherSchedules: level !== 'hidden',
      editOthers: level === 'edit',
    },
  })
}

function read(s: Setup, who: TestActor) {
  return who.as.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.jobId,
  })
}

describe('View and edit', () => {
  test('Kevin changes Terence’s job, and its Activity says it was him', async () => {
    const s = await setup()
    await give(s, s.kevinId, 'edit')

    const job = await read(s, s.kevin)
    expect(job?.canEdit).toBe(true)
    // Never his to delete, whatever he may change.
    expect(job?.canDelete).toBe(false)

    await s.kevin.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId: s.jobId,
      scheduledAt: s.when + 2 * HOUR,
    })

    const activity = await s.terence.as.query(api.jobActivity.list, {
      businessId: s.businessId,
      jobId: s.jobId,
    })
    expect(activity?.entries[0]).toMatchObject({
      action: 'job.update',
      by: { name: 'Kevin', you: false },
      changes: [{ field: 'scheduledAt', from: s.when, to: s.when + 2 * HOUR }],
    })
  })

  test('he may take it onto himself, and onto nobody else', async () => {
    const s = await setup()
    await give(s, s.kevinId, 'edit')

    await expect(
      s.kevin.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId: s.jobId,
        assignedMembershipId: s.joId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)

    await s.kevin.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId: s.jobId,
      assignedMembershipId: s.kevinId,
    })
    const job = await read(s, s.terence)
    expect(job?.assignedMembershipId).toBe(s.kevinId)
  })

  test('he may not make it recurring: that books Terence on every visit', async () => {
    const s = await setup()
    await give(s, s.kevinId, 'edit')

    const job = await read(s, s.kevin)
    expect(job).toMatchObject({ canEdit: true, canRepeat: false })
    await expect(
      s.kevin.as.mutation(api.recurrences.convertJobToRecurring, {
        businessId: s.businessId,
        jobId: s.jobId,
        intervalCount: 3,
        intervalUnit: 'month',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    // Terence, who may book himself, is offered it.
    expect((await read(s, s.terence))?.canRepeat).toBe(true)
  })

  test('he may finish it or cancel it', async () => {
    const s = await setup()
    await give(s, s.kevinId, 'edit')

    await s.kevin.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId: s.jobId,
    })
    expect((await read(s, s.terence))?.status).toBe('completed')
  })

  test('a contractor with it changes work outside their team, and still may not delete it', async () => {
    const s = await setup()
    await give(s, s.camId, 'edit')

    const job = await read(s, s.cam)
    expect(job?.canEdit).toBe(true)
    expect(job?.canDelete).toBe(false)
    await s.cam.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId: s.jobId,
      durationMinutes: 90,
    })

    await expect(
      s.cam.as.mutation(api.bin.deleteJob, {
        businessId: s.businessId,
        jobId: s.jobId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    // Terence, whose job it is, may.
    expect((await read(s, s.terence))?.canDelete).toBe(true)
  })
})

describe('View only, and Hidden', () => {
  test('View only reads it and changes nothing', async () => {
    const s = await setup()
    await give(s, s.kevinId, 'view')

    expect((await read(s, s.kevin))?.canEdit).toBe(false)
    await expect(
      s.kevin.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId: s.jobId,
        durationMinutes: 90,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      s.kevin.as.mutation(api.jobs.complete, {
        businessId: s.businessId,
        jobId: s.jobId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('Hidden doesn’t show it at all', async () => {
    const s = await setup()
    await give(s, s.kevinId, 'hidden')
    expect(await read(s, s.kevin)).toBeNull()
  })
})

describe('the setting itself', () => {
  test('View and edit never stands without View', async () => {
    const s = await setup()
    const saved = await s.terence.as.mutation(api.memberships.setGrants, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      grants: {
        switchInto: null,
        clientDirectory: true,
        prices: false,
        otherSchedules: false,
        editOthers: true,
      },
    })
    expect(saved.editOthers).toBe(false)
  })

  test('a phone from before it, saving another toggle, leaves it as it was', async () => {
    const s = await setup()
    await give(s, s.kevinId, 'edit')

    // "Can see job prices", from an app that knows four grants.
    const saved = await s.terence.as.mutation(api.memberships.setGrants, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      grants: {
        switchInto: null,
        clientDirectory: true,
        prices: true,
        otherSchedules: true,
      },
    })
    expect(saved).toMatchObject({ prices: true, editOthers: true })

    // Turning off the view, from the same app, takes the edit with it.
    const off = await s.terence.as.mutation(api.memberships.setGrants, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      grants: {
        switchInto: null,
        clientDirectory: true,
        prices: true,
        otherSchedules: false,
      },
    })
    expect(off.editOthers).toBe(false)
  })

  test('the old "can view all jobs" switch turned off takes the edit too', async () => {
    const s = await setup()
    await give(s, s.kevinId, 'edit')

    await s.terence.as.mutation(api.memberships.setCanViewAllJobs, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      canViewAllJobs: false,
    })
    await s.terence.as.mutation(api.memberships.setCanViewAllJobs, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      canViewAllJobs: true,
    })
    // Back to View only: the edit isn't handed back with the view.
    expect((await read(s, s.kevin))?.canEdit).toBe(false)
  })
})

describe('leaving a contractor', () => {
  /** Kevin on Cam's crew, with the View and edit Cam gave him — and Cam
   * since cut back to View only by Terence, so Kevin's row still says edit
   * while Cam's ceiling holds it off. */
  async function crewWithStaleEdit() {
    const s = await setup()
    await give(s, s.camId, 'edit')
    await s.terence.as.mutation(api.team.assignTo, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      parentMembershipId: s.camId,
    })
    await s.cam.as.mutation(api.memberships.setGrants, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      grants: {
        switchInto: null,
        clientDirectory: true,
        prices: false,
        otherSchedules: true,
        editOthers: true,
      },
    })
    expect((await read(s, s.kevin))?.canEdit).toBe(true)
    await give(s, s.camId, 'view')
    expect((await read(s, s.kevin))?.canEdit).toBe(false)
    return s
  }

  test('handed back to the owner, he keeps what Cam let him have, not what his row said', async () => {
    const s = await crewWithStaleEdit()
    await s.cam.as.mutation(api.team.assignTo, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      parentMembershipId: null,
    })
    const job = await read(s, s.kevin)
    // Still sees it: View only was Cam's to give, and he gave it.
    expect(job).not.toBeNull()
    expect(job?.canEdit).toBe(false)
  })

  test('made a contractor, the same', async () => {
    const s = await crewWithStaleEdit()
    await s.terence.as.mutation(api.memberships.setRole, {
      businessId: s.businessId,
      membershipId: s.kevinId,
      role: 'contractor',
    })
    expect((await read(s, s.kevin))?.canEdit).toBe(false)
  })
})
