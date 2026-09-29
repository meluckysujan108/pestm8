/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * Deleting into the Recycle bin and restoring from it (convex/bin.ts): a
 * delete takes everything that belongs to the record and nothing else,
 * never a finalised report; a restore brings back exactly that delete; and
 * only the owner restores.
 */

const DAY = 24 * 60 * 60 * 1000
const MONTH = 31 * DAY

async function setup() {
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
type Setup = Awaited<ReturnType<typeof setup>>

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

type Seeded = Setup['nguyen']

async function state(s: Setup, c: Seeded) {
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

async function join(s: Base, invitee: TestActor) {
  const { url } = await s.owner.as.action(api.invitations.create, {
    businessId: s.businessId,
    email: invitee.email,
    role: 'subcontractor',
  })
  await invitee.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })
}

describe('deleting a client', () => {
  test('takes everything that belongs to it, and never a finalised report', async () => {
    const s = await setup()
    const entryId = await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })

    const after = await state(s, s.nguyen)
    expect(after.binned.every(Boolean)).toBe(true)
    expect(after.entries).toEqual([entryId])
    expect(after.finalised?.deletedAt).toBeUndefined()
    expect(after.finalised?.binEntryId).toBeUndefined()

    // The other client is untouched.
    const other = await state(s, s.patel)
    expect(other.binned.some(Boolean)).toBe(false)

    const { entries } = await s.owner.as.query(api.bin.list, {
      businessId: s.businessId,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'client',
      title: 'J. Nguyen',
      counts: {
        properties: 1,
        // The booked job and the series' visits.
        jobs: after.visits + 1,
        recurrences: 1,
        notes: 2,
        drafts: 1,
      },
    })
  })

  test('restore brings every row back', async () => {
    const s = await setup()
    const entryId = await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })
    await s.owner.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })

    const after = await state(s, s.nguyen)
    expect(after.binned.some(Boolean)).toBe(false)
    expect(after.entries).toEqual([null])
    const { entries } = await s.owner.as.query(api.bin.list, {
      businessId: s.businessId,
    })
    expect(entries).toEqual([])
    const clients = await s.owner.as.query(api.clients.list, {
      businessId: s.businessId,
    })
    expect(clients.map((c) => c._id)).toContain(s.nguyen.clientId)
  })

  test('is recorded in the activity log, with no name or address', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })
    const rows = await s.t.run((ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_entity', (q) =>
          q.eq('entityType', 'clients').eq('entityId', s.nguyen.clientId),
        )
        .collect(),
    )
    expect(rows.map((r) => r.action)).toEqual(['bin.delete'])
    const logged = JSON.stringify(rows[0].meta)
    expect(logged).not.toContain('Nguyen')
    expect(logged).not.toContain('Wattle')
  })
})

describe('separate deletes stay separate', () => {
  test('a job deleted first keeps its own entry through its client’s round trip', async () => {
    const s = await setup()
    const jobEntry = await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId: s.nguyen.jobId,
    })
    const clientEntry = await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })
    await s.owner.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId: clientEntry,
    })

    const job = await s.t.run((ctx) => ctx.db.get(s.nguyen.jobId))
    expect(job?.deletedAt).toBeDefined()
    expect(job?.binEntryId).toBe(jobEntry)

    await s.owner.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId: jobEntry,
    })
    expect(
      (await s.t.run((ctx) => ctx.db.get(s.nguyen.jobId)))?.deletedAt,
    ).toBeUndefined()
  })

  test('a property cannot come back while its client is in the bin', async () => {
    const s = await setup()
    const propertyEntry = await s.owner.as.mutation(api.bin.deleteProperty, {
      businessId: s.businessId,
      propertyId: s.nguyen.propertyId,
    })
    const clientEntry = await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })

    await expect(
      s.owner.as.mutation(api.bin.restore, {
        businessId: s.businessId,
        entryId: propertyEntry,
      }),
    ).rejects.toThrow(/RESTORE_CLIENT_FIRST/)

    await s.owner.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId: clientEntry,
    })
    await s.owner.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId: propertyEntry,
    })
    const after = await state(s, s.nguyen)
    expect(after.binned.some(Boolean)).toBe(false)
  })
})

describe('deleting a Recurring Job', () => {
  test('takes the series and its visits, and nothing is booked for it', async () => {
    const s = await setup()
    const visit = await s.t.run(async (ctx) =>
      ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) =>
          q.eq('recurrenceId', s.nguyen.seriesId),
        )
        .first(),
    )
    await s.owner.as.mutation(api.bin.deleteSeries, {
      businessId: s.businessId,
      jobId: visit!._id,
    })

    const visits = await s.t.run((ctx) =>
      ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) =>
          q.eq('recurrenceId', s.nguyen.seriesId),
        )
        .collect(),
    )
    expect(visits.every((j) => j.deletedAt !== undefined)).toBe(true)
    // The one-off job at the same site is not part of the series.
    const oneOff = await s.t.run((ctx) => ctx.db.get(s.nguyen.jobId))
    expect(oneOff?.deletedAt).toBeUndefined()

    await s.t.mutation(internal.recurrences.materialiseAll, {})
    const again = await s.t.run((ctx) =>
      ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) =>
          q.eq('recurrenceId', s.nguyen.seriesId),
        )
        .collect(),
    )
    expect(again).toHaveLength(visits.length)
  })
})

describe('notes and drafts that went with a record', () => {
  test('are not in Recently Deleted, and cannot be restored on their own', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })

    const notes = await s.owner.as.query(api.notes.list, {
      businessId: s.businessId,
      filter: 'trash',
      paginationOpts: { numItems: 50, cursor: null },
    })
    expect(notes.page).toEqual([])
    const drafts = await s.owner.as.query(api.reports.list, {
      businessId: s.businessId,
      filter: 'trash',
      paginationOpts: { numItems: 50, cursor: null },
    })
    expect(drafts.page).toEqual([])

    await expect(
      s.owner.as.mutation(api.notes.restore, {
        businessId: s.businessId,
        noteId: s.nguyen.clientNoteId,
      }),
    ).rejects.toThrow(/IN_RECYCLE_BIN/)
    await expect(
      s.owner.as.mutation(api.reports.restore, {
        businessId: s.businessId,
        reportId: s.nguyen.draftId,
      }),
    ).rejects.toThrow(/IN_RECYCLE_BIN/)
  })

  test('are not purged on their own clock', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })
    // As if deleted two months ago.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.nguyen.clientNoteId, {
        deletedAt: Date.now() - 2 * MONTH,
      })
      await ctx.db.patch(s.nguyen.draftId, {
        deletedAt: Date.now() - 2 * MONTH,
      })
    })
    await s.t.mutation(internal.notes.purgeExpired, {})
    await s.t.mutation(internal.reports.purgeExpired, {})

    expect(
      await s.t.run((ctx) => ctx.db.get(s.nguyen.clientNoteId)),
    ).not.toBeNull()
    expect(await s.t.run((ctx) => ctx.db.get(s.nguyen.draftId))).not.toBeNull()
  })
})

describe('who', () => {
  test('a subcontractor cannot delete, and only the owner sees or restores the bin', async () => {
    const s = await setup()
    const sub = await createActor(s.t, { email: 'priya@coastal.test' })
    await join(s, sub)

    await expect(
      sub.as.mutation(api.bin.deleteClient, {
        businessId: s.businessId,
        clientId: s.nguyen.clientId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      sub.as.mutation(api.bin.deleteJob, {
        businessId: s.businessId,
        jobId: s.nguyen.jobId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)

    const entryId = await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })
    await expect(
      sub.as.query(api.bin.list, { businessId: s.businessId }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      sub.as.mutation(api.bin.restore, { businessId: s.businessId, entryId }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('a record already in the bin cannot be deleted again', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId: s.nguyen.jobId,
    })
    await expect(
      s.owner.as.mutation(api.bin.deleteJob, {
        businessId: s.businessId,
        jobId: s.nguyen.jobId,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })
})
