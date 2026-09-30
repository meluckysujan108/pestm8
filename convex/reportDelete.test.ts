/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { setup as binSetup } from '../test/binFixture'
import { getTemplate } from '../src/lib/reportTemplates'
import type { Doc, Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * Deleting a finalised report (reports.softDelete, restore, remove and the
 * nightly purge): the owner may, nobody else may, and a report number goes
 * into Recently Deleted, comes back and is deleted for good as one document —
 * every version of it, and a correction still being drafted.
 */

const DAY = 24 * 60 * 60 * 1000

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const tech = await createActor(t, { email: 'kevin@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const ids = await t.run(async (ctx) => {
    const now = Date.now()
    const techMembershipId = await ctx.db.insert('memberships', {
      userId: tech.userId,
      businessId,
      role: 'subcontractor',
      canViewAllJobs: false,
      colour: '#0A84FF',
      status: 'active',
      createdAt: now,
    })
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: now,
    })
    return { techMembershipId, propertyId }
  })
  return { t, owner, tech, businessId, ownerMembershipId, ...ids }
}

type Setup = Awaited<ReturnType<typeof setup>>

function report(
  s: Setup,
  status: 'draft' | 'finalised',
  extra: Partial<Doc<'reports'>> = {},
): Promise<Id<'reports'>> {
  return s.t.run((ctx) =>
    ctx.db.insert('reports', {
      businessId: s.businessId,
      propertyId: s.propertyId,
      authorMembershipId: s.ownerMembershipId,
      template: 'serviceReport',
      templateVersion: getTemplate('serviceReport').version,
      legalBasis: 'APVMA',
      status,
      data: {},
      photoIds: [],
      ...(status === 'finalised' && { finalisedAt: Date.now() }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...extra,
    }),
  )
}

/** #12 issued, corrected once, and a second correction started. */
async function numberWithVersions(s: Setup) {
  const first = await report(s, 'finalised', { reportNumber: 12, version: 1 })
  const second = await report(s, 'finalised', {
    reportNumber: 12,
    version: 2,
    supersedesReportId: first,
    amendmentReason: 'Wrong product',
  })
  const correction = await report(s, 'draft', {
    reportNumber: 12,
    version: 3,
    supersedesReportId: second,
    amendmentReason: 'Wrong dose',
  })
  await s.t.run((ctx) => ctx.db.patch(first, { supersededByReportId: second }))
  return { first, second, correction }
}

const args = (s: Setup, reportId: Id<'reports'>) => ({
  businessId: s.businessId,
  reportId,
})

async function listed(
  s: Setup,
  who: TestActor,
  filter: 'all' | 'finalised' | 'trash',
) {
  const { page } = await who.as.query(api.reports.list, {
    businessId: s.businessId,
    filter,
    paginationOpts: { numItems: 25, cursor: null },
  })
  return page.map((row) => row._id)
}

function rows(t: TestApp, ids: Array<Id<'reports'>>) {
  return t.run(async (ctx) => Promise.all(ids.map((id) => ctx.db.get(id))))
}

function history(s: Setup, reportId: Id<'reports'>) {
  return s.t.run(async (ctx) =>
    (
      await ctx.db
        .query('auditLog')
        .withIndex('by_entity', (q) =>
          q.eq('entityType', 'reports').eq('entityId', reportId),
        )
        .collect()
    ).map((row) => row.action),
  )
}

describe('the owner deletes a finalised report', () => {
  test('into Deleted, and back again, written down both times', async () => {
    const s = await setup()
    const locked = await report(s, 'finalised', { reportNumber: 7 })

    await s.owner.as.mutation(api.reports.softDelete, args(s, locked))
    expect(await listed(s, s.owner, 'finalised')).not.toContain(locked)
    expect(await listed(s, s.owner, 'trash')).toContain(locked)
    // Gone from the report page too: a stale link opens nothing.
    expect(await s.owner.as.query(api.reports.get, args(s, locked))).toBeNull()

    await s.owner.as.mutation(api.reports.restore, args(s, locked))
    expect(await listed(s, s.owner, 'finalised')).toContain(locked)
    expect(await listed(s, s.owner, 'trash')).not.toContain(locked)

    // A draft's delete is written down only when someone works in another's
    // account; a signed record's always is.
    expect(await history(s, locked)).toEqual([
      'report.delete',
      'report.restore',
    ])
  })

  test('nobody else may — not even the technician who signed it', async () => {
    const s = await setup()
    const theirs = await report(s, 'finalised', {
      authorMembershipId: s.techMembershipId,
    })
    const draft = await report(s, 'draft', {
      authorMembershipId: s.techMembershipId,
    })

    await expect(
      s.tech.as.mutation(api.reports.softDelete, args(s, theirs)),
    ).rejects.toThrow('NO_ACCESS')
    // Their own draft is still theirs to delete.
    await s.tech.as.mutation(api.reports.softDelete, args(s, draft))

    // Deleted by the owner, it is the owner's to bring back or throw away.
    await s.owner.as.mutation(api.reports.softDelete, args(s, theirs))
    await expect(
      s.tech.as.mutation(api.reports.restore, args(s, theirs)),
    ).rejects.toThrow('NO_ACCESS')
    await expect(
      s.tech.as.mutation(api.reports.remove, args(s, theirs)),
    ).rejects.toThrow('NO_ACCESS')
    const [row] = await rows(s.t, [theirs])
    expect(row?.deletedAt).toBeDefined()
  })

  test('nor the owner while working inside a technician’s account', async () => {
    const s = await setup()
    const theirs = await report(s, 'finalised', {
      authorMembershipId: s.techMembershipId,
    })
    await s.owner.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: s.techMembershipId,
    })

    // In there he has the technician's reach, and a technician's reach does
    // not include throwing a signed record away.
    await expect(
      s.owner.as.mutation(api.reports.softDelete, args(s, theirs)),
    ).rejects.toThrow('NO_ACCESS')
  })

  test('someone from another business cannot', async () => {
    const s = await setup()
    const locked = await report(s, 'finalised')
    const stranger = await createActor(s.t, { email: 'nadia@other.test' })
    await createBusiness(s.t, stranger, 'Other Pest')

    await expect(
      stranger.as.mutation(api.reports.softDelete, args(s, locked)),
    ).rejects.toThrow()
    const [row] = await rows(s.t, [locked])
    expect(row?.deletedAt).toBeUndefined()
  })
})

describe('a report number goes as one document', () => {
  test('every version, and the correction being drafted, go together', async () => {
    const s = await setup()
    const { first, second, correction } = await numberWithVersions(s)

    // Deleting the replaced version is deleting #12.
    await s.owner.as.mutation(api.reports.softDelete, args(s, first))

    const after = await rows(s.t, [first, second, correction])
    expect(after.every((row) => row?.deletedAt !== undefined)).toBe(true)
    expect(after.map((row) => row?.deletedWith)).toEqual([
      undefined,
      first,
      first,
    ])

    // One row in Deleted, and one in the count, for one document.
    expect(await listed(s, s.owner, 'trash')).toEqual([first])
    const counts = await s.owner.as.query(api.reports.counts, {
      businessId: s.businessId,
    })
    expect(counts.trash).toBe(1)
    expect(await listed(s, s.owner, 'all')).toEqual([])

    // Restoring through any of them restores all of them.
    await s.owner.as.mutation(api.reports.restore, args(s, second))
    const back = await rows(s.t, [first, second, correction])
    expect(back.map((row) => row?.deletedAt)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(back.map((row) => row?.deletedWith)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    // Still one number with a correction under way, as it was.
    const current = await s.owner.as.query(api.reports.get, args(s, second))
    expect(current?.openAmendmentId).toBe(correction)
  })

  test('deleting the current version takes the ones it replaced', async () => {
    const s = await setup()
    const { first, second, correction } = await numberWithVersions(s)

    await s.owner.as.mutation(api.reports.softDelete, args(s, second))
    expect(await listed(s, s.owner, 'trash')).toEqual([second])
    const after = await rows(s.t, [first, second, correction])
    expect(after.map((row) => row?.deletedWith)).toEqual([
      second,
      undefined,
      second,
    ])
    // Every version's own history says it went, and with which.
    expect(await history(s, first)).toEqual(['report.delete'])
  })

  test('a correction under way is found and said, however busy the site', async () => {
    const s = await setup()
    const original = await report(s, 'finalised', { reportNumber: 21 })
    const correction = await report(s, 'draft', {
      reportNumber: 21,
      version: 2,
      supersedesReportId: original,
    })
    // A weekly service site: plenty written there since.
    for (let i = 0; i < 45; i++) await report(s, 'draft')

    const { page } = await s.owner.as.query(api.reports.list, {
      businessId: s.businessId,
      filter: 'finalised',
      paginationOpts: { numItems: 25, cursor: null },
    })
    expect(page.find((row) => row._id === original)?.correcting).toBe(true)

    await s.owner.as.mutation(api.reports.softDelete, args(s, original))
    const [row] = await rows(s.t, [correction])
    expect(row?.deletedWith).toBe(original)
  })

  test('a correction of an earlier version goes too, and is said', async () => {
    const s = await setup()
    const first = await report(s, 'finalised', { reportNumber: 8, version: 1 })
    // Started on #8 v1, then left while another correction was issued.
    const stale = await report(s, 'draft', {
      reportNumber: 8,
      version: 2,
      supersedesReportId: first,
    })
    const second = await report(s, 'finalised', {
      reportNumber: 8,
      version: 2,
      supersedesReportId: first,
    })
    await s.t.run((ctx) =>
      ctx.db.patch(first, { supersededByReportId: second }),
    )

    // Said on either version's row, and on its page.
    const { page } = await s.owner.as.query(api.reports.list, {
      businessId: s.businessId,
      filter: 'finalised',
      paginationOpts: { numItems: 25, cursor: null },
    })
    expect(page.find((row) => row._id === first)?.correcting).toBe(true)
    expect(page.find((row) => row._id === second)?.correcting).toBe(true)
    expect(
      (await s.owner.as.query(api.reports.get, args(s, first)))?.correcting,
    ).toBe(true)

    await s.owner.as.mutation(api.reports.softDelete, args(s, second))
    const [row] = await rows(s.t, [stale])
    expect(row?.deletedWith).toBe(second)
    // And still said in Deleted, where Delete now would take it for good.
    const deleted = await s.owner.as.query(api.reports.list, {
      businessId: s.businessId,
      filter: 'trash',
      paginationOpts: { numItems: 25, cursor: null },
    })
    expect(deleted.page.map((r) => [r._id, r.correcting])).toEqual([
      [second, true],
    ])
  })

  test('a correction replaced meanwhile cannot come back either', async () => {
    const s = await setup()
    const original = await report(s, 'finalised', { reportNumber: 6 })
    const abandoned = await report(s, 'draft', {
      reportNumber: 6,
      version: 2,
      supersedesReportId: original,
    })
    await s.owner.as.mutation(api.reports.softDelete, args(s, abandoned))
    const issued = await report(s, 'finalised', {
      reportNumber: 6,
      version: 2,
      supersedesReportId: original,
    })
    await s.t.run((ctx) =>
      ctx.db.patch(original, { supersededByReportId: issued }),
    )

    await expect(
      s.owner.as.mutation(api.reports.restore, args(s, abandoned)),
    ).rejects.toThrow('ALREADY_SUPERSEDED')
  })

  test('a correction deleted on its own cannot come back to a document that is gone', async () => {
    const s = await setup()
    const original = await report(s, 'finalised', { reportNumber: 3 })
    const correction = await report(s, 'draft', {
      reportNumber: 3,
      version: 2,
      supersedesReportId: original,
    })

    // The correction first, on its own; then the document.
    await s.owner.as.mutation(api.reports.softDelete, args(s, correction))
    await s.owner.as.mutation(api.reports.softDelete, args(s, original))
    // It was already gone, so it stays its own row in Deleted.
    expect((await listed(s, s.owner, 'trash')).sort()).toEqual(
      [original, correction].sort(),
    )

    await expect(
      s.owner.as.mutation(api.reports.restore, args(s, correction)),
    ).rejects.toThrow('ORIGINAL_DELETED')

    await s.owner.as.mutation(api.reports.restore, args(s, original))
    await s.owner.as.mutation(api.reports.restore, args(s, correction))
    const [row] = await rows(s.t, [correction])
    expect(row?.deletedAt).toBeUndefined()
  })

  test('nor alongside a second correction started meanwhile', async () => {
    const s = await setup()
    const original = await report(s, 'finalised', { reportNumber: 5 })
    const abandoned = await report(s, 'draft', {
      reportNumber: 5,
      version: 2,
      supersedesReportId: original,
    })
    await s.owner.as.mutation(api.reports.softDelete, args(s, abandoned))
    await report(s, 'draft', {
      reportNumber: 5,
      version: 2,
      supersedesReportId: original,
    })

    await expect(
      s.owner.as.mutation(api.reports.restore, args(s, abandoned)),
    ).rejects.toThrow('AMENDMENT_IN_PROGRESS')
  })
})

describe('deleting for good', () => {
  test('takes every version, its PDFs, its email history and its marks — never a photo’s file', async () => {
    const s = await setup()
    const { first, second, correction } = await numberWithVersions(s)
    const files = await s.t.run(async (ctx) => {
      const pdf = await ctx.storage.store(
        new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
      )
      const photo = await ctx.storage.store(
        new Blob(['jpeg'], { type: 'image/jpeg' }),
      )
      const pdfId = await ctx.db.insert('reportPdfs', {
        businessId: s.businessId,
        reportId: second,
        storageId: pdf,
        rendererVersion: 2,
        version: 2,
        bytes: 8,
        createdAt: Date.now(),
      })
      await ctx.db.patch(second, { pdfStorageId: pdf })
      await ctx.db.insert('reportDeliveries', {
        businessId: s.businessId,
        reportId: second,
        pdfId,
        to: ['client@example.com'],
        cc: [],
        subject: 'Service Report',
        trigger: 'manual',
        status: 'sent',
        createdAt: Date.now(),
      })
      // The correction carries the original's photos, pointing at the same
      // file — which is why no photo file is ever deleted on a purge.
      for (const reportId of [first, correction]) {
        await ctx.db.insert('reportPhotos', {
          reportId,
          fieldKey: 'photos',
          storageId: photo,
          order: 0,
          isCover: false,
          createdAt: Date.now(),
        })
      }
      await ctx.db.insert('reportPdfAnnotations', {
        reportId: second,
        page: 1,
        authorMembershipId: s.ownerMembershipId,
        points: [{ x: 0.1, y: 0.1 }],
        createdAt: Date.now(),
      })
      return { pdf, photo }
    })

    await expect(
      s.owner.as.mutation(api.reports.remove, args(s, second)),
    ).rejects.toThrow('NOT_IN_TRASH')

    await s.owner.as.mutation(api.reports.softDelete, args(s, second))
    // From any row of it: the whole number goes.
    await s.owner.as.mutation(api.reports.remove, args(s, first))

    const left = await s.t.run(async (ctx) => ({
      reports: await Promise.all(
        [first, second, correction].map((id) => ctx.db.get(id)),
      ),
      pdfs: await ctx.db.query('reportPdfs').collect(),
      deliveries: await ctx.db.query('reportDeliveries').collect(),
      photos: await ctx.db.query('reportPhotos').collect(),
      marks: await ctx.db.query('reportPdfAnnotations').collect(),
      pdfFile: await ctx.db.system.get('_storage', files.pdf),
      photoFile: await ctx.db.system.get('_storage', files.photo),
    }))
    expect(left.reports).toEqual([null, null, null])
    expect(left.pdfs).toEqual([])
    expect(left.deliveries).toEqual([])
    expect(left.photos).toEqual([])
    expect(left.marks).toEqual([])
    expect(left.pdfFile).toBeNull()
    expect(left.photoFile).not.toBeNull()

    // Who threw it away, and when, outlives it.
    expect(await history(s, second)).toEqual(['report.delete', 'report.purge'])
    expect(await history(s, first)).toEqual(['report.delete', 'report.purge'])
  })

  test('the nightly purge takes one after thirty days, versions and all', async () => {
    const s = await setup()
    const { first, second, correction } = await numberWithVersions(s)
    const fresh = await report(s, 'finalised', { reportNumber: 13 })

    await s.owner.as.mutation(api.reports.softDelete, args(s, second))
    await s.owner.as.mutation(api.reports.softDelete, args(s, fresh))
    // #12 was deleted a month ago; #13 today.
    await s.t.run(async (ctx) => {
      for (const id of [first, second, correction]) {
        await ctx.db.patch(id, { deletedAt: Date.now() - 31 * DAY })
      }
    })

    await s.t.mutation(internal.reports.purgeExpired, {})

    const after = await rows(s.t, [first, second, correction, fresh])
    expect(after.slice(0, 3)).toEqual([null, null, null])
    expect(after[3]?.deletedAt).toBeDefined()
  })
})

describe('the Recycle bin', () => {
  test('a correction binned with its job comes back to its deleted report, not the list', async () => {
    const s = await binSetup()
    const { jobId, finalId, draftId } = s.nguyen
    // The job's draft is a correction of its finalised report.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(finalId, { reportNumber: 30 })
      await ctx.db.patch(draftId, {
        reportNumber: 30,
        version: 2,
        supersedesReportId: finalId,
      })
    })
    const entryId = await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId,
    })
    // Meanwhile the owner deletes the report it corrects.
    await s.owner.as.mutation(api.reports.softDelete, {
      businessId: s.businessId,
      reportId: finalId,
    })

    await s.owner.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })
    const [final, draft] = await rows(s.t, [finalId, draftId])
    expect(draft?.binEntryId).toBeUndefined()
    expect(draft?.deletedWith).toBe(finalId)
    expect(draft?.deletedAt).toBe(final?.deletedAt)

    // And it comes back with the report.
    await s.owner.as.mutation(api.reports.restore, {
      businessId: s.businessId,
      reportId: finalId,
    })
    const [back] = await rows(s.t, [draftId])
    expect(back?.deletedAt).toBeUndefined()
    expect(back?.deletedWith).toBeUndefined()
  })
})

test('the nightly purge never takes a finalised report the owner did not delete', async () => {
  const s = await setup()
  // In the trash with no delete on its history: however it got there, it
  // is a record, and it goes back to the list.
  const stray = await report(s, 'finalised', {
    reportNumber: 40,
    deletedAt: Date.now() - 31 * DAY,
  })
  await s.t.mutation(internal.reports.purgeExpired, {})
  const [row] = await rows(s.t, [stray])
  expect(row).not.toBeNull()
  expect(row?.deletedAt).toBeUndefined()
})

test('an email still waiting to go does not go; one already sent is left alone', async () => {
  const s = await setup()
  const locked = await report(s, 'finalised', { reportNumber: 9 })
  const [queued, sent] = await s.t.run(async (ctx) =>
    Promise.all(
      (['queued', 'sent'] as const).map((status) =>
        ctx.db.insert('reportDeliveries', {
          businessId: s.businessId,
          reportId: locked,
          to: ['client@example.com'],
          cc: [],
          subject: 'Service Report',
          trigger: 'finalise',
          status,
          createdAt: Date.now(),
        }),
      ),
    ),
  )

  await s.owner.as.mutation(api.reports.softDelete, args(s, locked))

  const [stopped, went] = await s.t.run(async (ctx) =>
    Promise.all([ctx.db.get(queued), ctx.db.get(sent)]),
  )
  expect(stopped?.status).toBe('failed')
  expect(stopped?.error).toMatch(/deleted before it went/)
  expect(went?.status).toBe('sent')

  // One already on its way when the report was deleted: Resend took it, so
  // it went, and nothing still says it did not.
  await s.t.mutation(internal.deliveries.settle, {
    deliveryId: queued,
    status: 'sent',
  })
  const [late] = await s.t.run(async (ctx) => [await ctx.db.get(queued)])
  expect(late?.status).toBe('sent')
  expect(late?.error).toBeUndefined()
})
