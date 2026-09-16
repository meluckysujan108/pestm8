/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * Each of these is a specific way the audit found to reach across a boundary.
 * They are grouped here rather than spread through feature tests because what
 * they have in common is the shape of the mistake: a document id accepted as an
 * argument and used without asking who it belongs to.
 */

async function twoBusinesses() {
  const t = testApp()

  const terence = await createActor(t, { email: 'terence@coastal.test' })
  const coastal = await createBusiness(t, terence, 'Coastal Pest')

  const rival = await createActor(t, { email: 'rival@other.test' })
  const other = await createBusiness(t, rival, 'Other Pest')

  const kevin = await createActor(t, { email: 'kevin@coastal.test' })
  const kevinMembershipId = await join(t, terence, kevin, coastal.businessId)

  const property = await seedProperty(t, coastal.businessId)

  return {
    t,
    terence,
    rival,
    kevin,
    coastal,
    other,
    kevinMembershipId,
    property,
  }
}

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

describe('who work can be booked onto', () => {
  test('a rival cannot push jobs onto another business member', async () => {
    const s = await twoBusinesses()
    const rivalProperty = await seedProperty(s.t, s.other.businessId)

    // The attacker owns their own business and knows a membership id from the
    // victim's — ids are handed to every member by the team roster.
    await expect(
      s.rival.as.mutation(api.jobs.create, {
        businessId: s.other.businessId,
        propertyId: rivalProperty,
        assignedMembershipId: s.kevinMembershipId,
        jobType: 'General Pest Control',
        price: 20000,
        scheduledAt: Date.now() + 86_400_000,
        durationMinutes: 60,
      }),
    ).rejects.toThrow(/INVALID_ASSIGNEE/)
  })

  test('nor onto a repeating series, which the cron would keep re-booking', async () => {
    const s = await twoBusinesses()
    const rivalProperty = await seedProperty(s.t, s.other.businessId)

    await expect(
      s.rival.as.mutation(api.recurrences.create, {
        businessId: s.other.businessId,
        propertyId: rivalProperty,
        assignedMembershipId: s.kevinMembershipId,
        frequency: 'quarterly',
        jobType: 'General Pest Control',
        price: 20000,
        anchorDate: Date.now(),
        durationMinutes: 60,
      }),
    ).rejects.toThrow(/INVALID_ASSIGNEE/)
  })

  test('nor by reassigning an existing job across the boundary', async () => {
    const s = await twoBusinesses()
    const rivalProperty = await seedProperty(s.t, s.other.businessId)

    const jobId = await s.rival.as.mutation(api.jobs.create, {
      businessId: s.other.businessId,
      propertyId: rivalProperty,
      assignedMembershipId: s.other.ownerMembershipId,
      jobType: 'General Pest Control',
      price: 20000,
      scheduledAt: Date.now() + 86_400_000,
      durationMinutes: 60,
    })

    await expect(
      s.rival.as.mutation(api.jobs.update, {
        businessId: s.other.businessId,
        jobId,
        assignedMembershipId: s.kevinMembershipId,
      }),
    ).rejects.toThrow(/INVALID_ASSIGNEE/)
  })

  test('work cannot be booked onto someone who has been removed', async () => {
    const s = await twoBusinesses()
    await s.terence.as.mutation(api.team.remove, {
      businessId: s.coastal.businessId,
      membershipId: s.kevinMembershipId,
    })

    await expect(
      s.terence.as.mutation(api.jobs.create, {
        businessId: s.coastal.businessId,
        propertyId: s.property,
        assignedMembershipId: s.kevinMembershipId,
        jobType: 'General Pest Control',
        price: 20000,
        scheduledAt: Date.now() + 86_400_000,
        durationMinutes: 60,
      }),
    ).rejects.toThrow(/INVALID_ASSIGNEE/)
  })
})

describe('invoiced jobs', () => {
  test('cannot be marked invoiced by an edit, and cannot be edited afterwards', async () => {
    const s = await twoBusinesses()
    const jobId = await s.terence.as.mutation(api.jobs.create, {
      businessId: s.coastal.businessId,
      propertyId: s.property,
      assignedMembershipId: s.kevinMembershipId,
      jobType: 'General Pest Control',
      price: 20000,
      scheduledAt: Date.now() + 86_400_000,
      durationMinutes: 60,
    })

    // 'invoiced' is no longer in the argument validator: the invoicing flow
    // owns that transition, not whoever happens to be assigned.
    await expect(
      s.kevin.as.mutation(api.jobs.update, {
        businessId: s.coastal.businessId,
        jobId,
        // @ts-expect-error — the point of the test is that this is rejected.
        status: 'invoiced',
      }),
    ).rejects.toThrow()

    // And once something else has invoiced it, the job is settled.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(jobId, { status: 'invoiced' })
    })
    await expect(
      s.kevin.as.mutation(api.jobs.update, {
        businessId: s.coastal.businessId,
        jobId,
        price: 1,
      }),
    ).rejects.toThrow(/JOB_INVOICED/)
  })
})

describe('stopping a repeating service', () => {
  test('one visit does not give authority over the whole series', async () => {
    const s = await twoBusinesses()

    // Terence owns the quarterly contract.
    const recurrenceId = await s.terence.as.mutation(api.recurrences.create, {
      businessId: s.coastal.businessId,
      propertyId: s.property,
      assignedMembershipId: s.coastal.ownerMembershipId,
      frequency: 'quarterly',
      jobType: 'General Pest Control',
      price: 20000,
      anchorDate: Date.now() + 86_400_000,
      durationMinutes: 60,
    })

    // One visit is handed to Kevin to cover.
    const visits = await s.t.run(async (ctx) =>
      ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
        .collect(),
    )
    expect(visits.length).toBeGreaterThan(0)
    const covered = visits[0]
    await s.terence.as.mutation(api.jobs.update, {
      businessId: s.coastal.businessId,
      jobId: covered._id,
      assignedMembershipId: s.kevinMembershipId,
    })

    await expect(
      s.kevin.as.mutation(api.recurrences.stopFromJob, {
        businessId: s.coastal.businessId,
        jobId: covered._id,
      }),
    ).rejects.toThrow(/NO_ACCESS/)

    const stillActive = await s.t.run(async (ctx) => ctx.db.get(recurrenceId))
    expect(stillActive?.active).toBe(true)
  })

  test('the owner stopping it cancels future visits instead of deleting them', async () => {
    const s = await twoBusinesses()
    const recurrenceId = await s.terence.as.mutation(api.recurrences.create, {
      businessId: s.coastal.businessId,
      propertyId: s.property,
      assignedMembershipId: s.coastal.ownerMembershipId,
      frequency: 'quarterly',
      jobType: 'General Pest Control',
      price: 20000,
      anchorDate: Date.now() + 86_400_000,
      durationMinutes: 60,
    })

    const before = await s.t.run(async (ctx) =>
      ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
        .collect(),
    )

    await s.terence.as.mutation(api.recurrences.setActive, {
      businessId: s.coastal.businessId,
      recurrenceId,
      active: false,
    })

    const after = await s.t.run(async (ctx) => ctx.db.query('jobs').collect())
    // Nothing vanished — the owner can still see what was dropped.
    expect(after).toHaveLength(before.length)
    expect(after.every((j) => j.status === 'cancelled')).toBe(true)
  })
})

describe('audit history visibility', () => {
  test('a subcontractor cannot read the history of a report that is not theirs', async () => {
    const s = await twoBusinesses()

    const reportId = await s.t.run(async (ctx) => {
      const id = await ctx.db.insert('reports', {
        businessId: s.coastal.businessId,
        propertyId: s.property,
        authorMembershipId: s.coastal.ownerMembershipId,
        template: 'treatmentRecord',
        legalBasis: 'APVMA',
        status: 'finalised',
        data: {},
        photoIds: [],
        createdAt: Date.now(),
        finalisedAt: Date.now(),
      })
      await ctx.db.insert('auditLog', {
        businessId: s.coastal.businessId,
        actorMembershipId: s.coastal.ownerMembershipId,
        action: 'report.email',
        entityType: 'reports',
        entityId: id,
        // Exactly the kind of thing that must not leak: who the client is.
        meta: { to: 'client@example.test' },
        at: Date.now(),
      })
      return id
    })

    // Kevin did not write it and has no view-all grant.
    await expect(
      s.kevin.as.query(api.auditLog.forEntity, {
        businessId: s.coastal.businessId,
        entityType: 'reports',
        entityId: reportId,
      }),
    ).resolves.toEqual([])

    // The owner sees the whole history.
    const ownerView = await s.terence.as.query(api.auditLog.forEntity, {
      businessId: s.coastal.businessId,
      entityType: 'reports',
      entityId: reportId,
    })
    expect(ownerView).toHaveLength(1)
  })

  test('team and invitation history is management-only', async () => {
    const s = await twoBusinesses()
    await expect(
      s.kevin.as.query(api.auditLog.forEntity, {
        businessId: s.coastal.businessId,
        entityType: 'memberships',
        entityId: s.kevinMembershipId,
      }),
    ).resolves.toEqual([])
  })
})

describe('licence changes', () => {
  test('are recorded, with what the number was before', async () => {
    const s = await twoBusinesses()

    await s.terence.as.mutation(api.memberships.setLicence, {
      businessId: s.coastal.businessId,
      membershipId: s.kevinMembershipId,
      licenceNumber: 'PMT-1111',
    })
    await s.terence.as.mutation(api.memberships.setLicence, {
      businessId: s.coastal.businessId,
      membershipId: s.kevinMembershipId,
      licenceNumber: 'PMT-2222',
    })

    const history = await s.terence.as.query(api.auditLog.forEntity, {
      businessId: s.coastal.businessId,
      entityType: 'memberships',
      entityId: s.kevinMembershipId,
    })
    const licenceRows = history.filter(
      (row) => row.action === 'membership.setLicence',
    )
    expect(licenceRows).toHaveLength(2)
    // Not by position: both writes land in the same millisecond here, and
    // forEntity sorts on that timestamp, so their relative order is arbitrary.
    expect(licenceRows.map((row) => row.meta)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: '', to: 'PMT-1111' }),
        expect.objectContaining({ from: 'PMT-1111', to: 'PMT-2222' }),
      ]),
    )
  })
})
