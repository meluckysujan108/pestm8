/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor } from '../test/harness'
import { DAY, join, setup } from '../test/binFixture'
import type { Id, TableNames } from './_generated/dataModel'
import type { Setup } from '../test/binFixture'

/**
 * Delete forever (convex/bin.ts): a wipe takes every row the delete put in
 * the bin and nothing else, never a finalised report; it cannot be undone
 * once begun; Empty bin and the 30-day sweep do the same; and only the owner
 * wipes.
 */

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Runs every wipe step the mutations scheduled, to the end. */
async function settle(s: Setup) {
  await s.t.finishAllScheduledFunctions(vi.runAllTimers)
}

/** A job photo, a contact and a mark on the draft, so a wipe has each kind
 * of row that hangs off a binned one. */
async function extras(s: Setup, c: Setup['nguyen']) {
  return s.t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(['photo']))
    const photoId = await ctx.db.insert('jobPhotos', {
      jobId: c.jobId,
      storageId,
      order: 0,
      createdAt: Date.now(),
    })
    const contactId = await ctx.db.insert('clientContacts', {
      businessId: s.businessId,
      clientId: c.clientId,
      name: 'Accounts',
      email: 'accounts@nguyen.test',
      createdAt: Date.now(),
    })
    const markId = await ctx.db.insert('reportPdfAnnotations', {
      reportId: c.draftId,
      page: 1,
      authorMembershipId: s.ownerMembershipId,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      createdAt: Date.now(),
    })
    return { storageId, photoId, contactId, markId }
  })
}

async function exists(s: Setup, id: Id<TableNames>) {
  return (await s.t.run((ctx) => ctx.db.get(id))) !== null
}

describe('Delete forever', () => {
  test('wipes every row the delete took, and keeps the finalised report', async () => {
    const s = await setup()
    const more = await extras(s, s.nguyen)
    const entryId = await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })
    await s.owner.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId,
    })
    await settle(s)

    for (const id of [
      s.nguyen.clientId,
      s.nguyen.propertyId,
      s.nguyen.jobId,
      s.nguyen.seriesId,
      s.nguyen.jobNoteId,
      s.nguyen.clientNoteId,
      s.nguyen.draftId,
      more.photoId,
      more.contactId,
      more.markId,
      entryId,
    ]) {
      expect(await exists(s, id)).toBe(false)
    }
    const visits = await s.t.run((ctx) =>
      ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) =>
          q.eq('recurrenceId', s.nguyen.seriesId),
        )
        .collect(),
    )
    expect(visits).toEqual([])

    // The record the business must keep, kept.
    const finalised = await s.t.run((ctx) => ctx.db.get(s.nguyen.finalId))
    expect(finalised?.status).toBe('finalised')
    expect(finalised?.deletedAt).toBeUndefined()

    // The other client is untouched.
    expect(await exists(s, s.patel.clientId)).toBe(true)
    expect(await exists(s, s.patel.jobId)).toBe(true)
  })

  test('cannot be undone once begun, and leaves the bin page at once', async () => {
    const s = await setup()
    const entryId = await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId: s.nguyen.jobId,
    })
    await s.owner.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId,
    })

    const { entries } = await s.owner.as.query(api.bin.list, {
      businessId: s.businessId,
    })
    expect(entries).toEqual([])
    await expect(
      s.owner.as.mutation(api.bin.restore, {
        businessId: s.businessId,
        entryId,
      }),
    ).rejects.toThrow(/WIPING/)
  })

  test('is recorded, with counts and no name', async () => {
    const s = await setup()
    const entryId = await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })
    await s.owner.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId,
    })
    await settle(s)
    const rows = await s.t.run((ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_entity', (q) =>
          q.eq('entityType', 'clients').eq('entityId', s.nguyen.clientId),
        )
        .collect(),
    )
    expect(rows.map((r) => r.action)).toEqual(['bin.delete', 'bin.wipe'])
    expect(JSON.stringify(rows.map((r) => r.meta))).not.toContain('Nguyen')
  })

  test('a separate delete of something under it stays, and says it cannot come back', async () => {
    const s = await setup()
    const jobEntry = await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId: s.nguyen.jobId,
    })
    const propertyEntry = await s.owner.as.mutation(api.bin.deleteProperty, {
      businessId: s.businessId,
      propertyId: s.nguyen.propertyId,
    })
    await s.owner.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId: propertyEntry,
    })
    await settle(s)

    expect(await exists(s, s.nguyen.propertyId)).toBe(false)
    expect(await exists(s, s.nguyen.jobId)).toBe(true)
    await expect(
      s.owner.as.mutation(api.bin.restore, {
        businessId: s.businessId,
        entryId: jobEntry,
      }),
    ).rejects.toThrow(/RESTORE_PARENT_GONE/)
  })
})

describe('Empty bin', () => {
  test('wipes every delete in it', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })
    await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId: s.patel.jobId,
    })
    await s.owner.as.mutation(api.bin.empty, { businessId: s.businessId })
    await settle(s)

    expect(await exists(s, s.nguyen.clientId)).toBe(false)
    expect(await exists(s, s.patel.jobId)).toBe(false)
    expect(await exists(s, s.patel.clientId)).toBe(true)
    const left = await s.t.run((ctx) => ctx.db.query('binEntries').collect())
    expect(left).toEqual([])
  })
})

describe('after thirty days', () => {
  test('a delete is wiped by the nightly sweep, and a newer one is not', async () => {
    const s = await setup()
    const old = await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId: s.nguyen.jobId,
    })
    const recent = await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId: s.patel.jobId,
    })
    await s.t.run((ctx) =>
      ctx.db.patch(old, { deletedAt: Date.now() - 31 * DAY }),
    )

    await s.t.mutation(internal.bin.purgeExpired, {})
    await settle(s)

    expect(await exists(s, s.nguyen.jobId)).toBe(false)
    expect(await exists(s, old)).toBe(false)
    expect(await exists(s, s.patel.jobId)).toBe(true)
    expect(await exists(s, recent)).toBe(true)
  })

  test('the bin page says when each delete will be wiped', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId: s.nguyen.jobId,
    })
    const { entries } = await s.owner.as.query(api.bin.list, {
      businessId: s.businessId,
    })
    expect(entries[0].wipesAt - entries[0].deletedAt).toBe(30 * DAY)
  })
})

describe('who', () => {
  test('only the owner wipes or empties the bin', async () => {
    const s = await setup()
    const sub = await createActor(s.t, { email: 'priya@coastal.test' })
    await join(s, sub)
    const entryId = await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId: s.nguyen.jobId,
    })

    await expect(
      sub.as.mutation(api.bin.wipe, { businessId: s.businessId, entryId }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      sub.as.mutation(api.bin.empty, { businessId: s.businessId }),
    ).rejects.toThrow(/NO_ACCESS/)
    expect(await exists(s, s.nguyen.jobId)).toBe(true)
  })
})
