/// <reference types="vite/client" />
import { ConvexError } from 'convex/values'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { components, internal } from '../_generated/api'
import { demoSource, runDemoSteps } from '../../test/demoFixture'
import { CLIENTS, DEMO_PLAN, PLACEHOLDER_EMAIL_DOMAIN } from './shared'
import type { DemoRun, DemoSource } from '../../test/demoFixture'
import type { TestApp } from '../../test/harness'
import type { Doc, Id } from '../_generated/dataModel'

/**
 * demo/cleanup: `remove` takes away every row, file, note body and
 * placeholder login of a demo, a batch at a time, and nothing else — not the
 * business the demo was copied from, not the real people's logins, not the
 * shared template snapshots, not a file a real business still points at.
 *
 * Scheduled work is held with fake timers, as in the reports step's test: the
 * PDF render and forecast lookup the seed queues would reach the network,
 * and `remove`'s own continuation is replaced by calling it in a loop, which
 * is what the scheduler would do.
 */

/** `remove`'s batch, plus what one report's own files or one note's mentions
 * can carry it over by. */
const MOST_PER_CALL = 350

type Removal = { calls: number; perCall: Array<Record<string, number>> }

async function removeAll(
  t: TestApp,
  businessId: Id<'businesses'>,
  confirmSlug: string,
): Promise<Removal> {
  const perCall: Array<Record<string, number>> = []
  for (let call = 1; call <= 60; call++) {
    const { done, deleted } = await t.mutation(internal.demo.cleanup.remove, {
      businessId,
      confirmSlug,
    })
    perCall.push(deleted)
    if (done) return { calls: call, perCall }
  }
  throw new Error('remove did not finish in 60 calls')
}

/** A ConvexError's payload, from a call that is expected to be refused. */
async function refusal(call: Promise<unknown>): Promise<unknown> {
  try {
    await call
  } catch (error) {
    if (error instanceof ConvexError) return error.data
    throw error
  }
  throw new Error('expected the call to be refused')
}

async function userOf(t: TestApp, userId: string): Promise<unknown> {
  return t.run(async (ctx): Promise<unknown> =>
    ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: '_id', value: userId }],
    }),
  )
}

async function sessionOf(t: TestApp, sessionId: string): Promise<unknown> {
  return t.run(async (ctx): Promise<unknown> =>
    ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'session',
      where: [{ field: '_id', value: sessionId }],
    }),
  )
}

/** Every file a demo row points at, and every one its seed row lists. */
async function demoFiles(t: TestApp, businessId: Id<'businesses'>) {
  return t.run(async (ctx) => {
    const files = new Set<Id<'_storage'>>()
    const seedRow = (
      await ctx.db
        .query('auditLog')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .collect()
    ).find((row) => row.action === 'demo.seed')
    const seeded = (seedRow?.meta as { images: Array<Id<'_storage'>> }).images
    for (const id of seeded) files.add(id)

    const reports = await ctx.db
      .query('reports')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
    const snapshotIds = new Set<Id<'reportTemplateSnapshots'>>()
    for (const report of reports) {
      for (const id of report.photoIds) files.add(id)
      for (const id of Object.values(report.photoSlots ?? {})) files.add(id)
      for (const slot of Object.values(report.signatureSlots ?? {})) {
        files.add(slot.storageId)
      }
      if (report.templateSnapshotId) snapshotIds.add(report.templateSnapshotId)
      for (const photo of await ctx.db
        .query('reportPhotos')
        .withIndex('by_report_field', (q) => q.eq('reportId', report._id))
        .collect()) {
        files.add(photo.storageId)
      }
    }
    for (const job of await ctx.db
      .query('jobs')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()) {
      for (const photo of await ctx.db
        .query('jobPhotos')
        .withIndex('by_job', (q) => q.eq('jobId', job._id))
        .collect()) {
        files.add(photo.storageId)
      }
    }
    for (const member of await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()) {
      if (member.savedSignatureStorageId) {
        files.add(member.savedSignatureStorageId)
      }
    }
    const notes = await ctx.db
      .query('notes')
      .withIndex('by_business_updated', (q) => q.eq('businessId', businessId))
      .collect()
    return {
      seeded,
      files: [...files],
      snapshotIds: [...snapshotIds],
      noteIds: notes.map((n) => n._id),
    }
  })
}

async function filesStillStored(t: TestApp, ids: Array<Id<'_storage'>>) {
  return t.run(async (ctx) => {
    const left: Array<Id<'_storage'>> = []
    for (const id of ids) {
      if (await ctx.db.system.get('_storage', id)) left.push(id)
    }
    return left
  })
}

/** Everything of a business that is not the demo's: its row, its people,
 * and the global tables cleanup must never touch. */
async function realSide(t: TestApp, businessId: Id<'businesses'>) {
  return t.run(async (ctx) => ({
    business: await ctx.db.get(businessId),
    memberships: await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect(),
    reports: await ctx.db
      .query('reports')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect(),
    products: await ctx.db
      .query('products')
      .withIndex('by_businessId_and_nameKey', (q) =>
        q.eq('businessId', businessId),
      )
      .collect(),
    snapshots: await ctx.db.query('reportTemplateSnapshots').collect(),
    weather: await ctx.db.query('weatherCache').collect(),
    geocache: await ctx.db.query('suburbGeocache').collect(),
    misses: await ctx.db.query('geocodeMisses').collect(),
  }))
}

describe('removing a demo', () => {
  let run: DemoRun
  let slug: string
  let before: Record<string, number>
  let files: Awaited<ReturnType<typeof demoFiles>>
  let real: Awaited<ReturnType<typeof realSide>>
  let placeholderUserIds: Array<string>
  /** A demo photo the real owner's saved signature was pointed at. */
  let sharedWithReal: Id<'_storage'>
  /** The real business's logo, which a demo report was pointed at. */
  let realLogo: Id<'_storage'>
  /** A demo photo a real report's gallery holds. */
  let inRealGallery: Id<'_storage'>
  let realPhoto: Doc<'reportPhotos'> | null
  /** Real files a hand-made call put on demo rows: a job photo, and a PDF
   * on a demo draft's photo slot. */
  let realOnDemoJob: Id<'_storage'>
  let realOnDemoDraft: Id<'_storage'>
  /** Issues of a real business's form, published after the demo was made. */
  let realVersions: Array<Id<'customReportTemplateVersions'>>
  /** A demo photo a real business's product holds. */
  let inRealProduct: Id<'_storage'>
  /** What someone uploaded to the demo's Products page while trying it out:
   * never the seed's, so never cleanup's to delete. */
  let demoProductUploads: Array<Id<'_storage'>>
  /** A PDF rendered for a demo report, which a demo product also holds. */
  let demoRendered: Id<'_storage'>
  let removal: Removal

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    run = await runDemoSteps('notes')
    const { t, base } = run

    // Files crossing between the demo and the business it came from, which
    // the seed never does but a hand-made call could: a demo photo that is
    // also the real owner's saved signature, the real logo on a demo report,
    // and a demo photo in a real report's gallery. All three must survive.
    sharedWithReal = base.images.photos[4].storageId
    inRealGallery = base.images.photos[5].storageId
    inRealProduct = base.images.photos[6].storageId
    const crossed = await t.run(async (ctx) => {
      const now = Date.now()
      const ownerHere = await ctx.db
        .query('memberships')
        .withIndex('by_user_business', (q) =>
          q.eq('userId', run.owner.userId).eq('businessId', run.fromBusinessId),
        )
        .unique()
      if (!ownerHere) throw new Error('no real owner membership')
      await ctx.db.patch(ownerHere._id, {
        savedSignatureStorageId: sharedWithReal,
      })

      const logo = await ctx.storage.store(
        new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      )
      await ctx.db.patch(run.fromBusinessId, { logoStorageId: logo })
      const demoReport = await ctx.db
        .query('reports')
        .withIndex('by_business', (q) => q.eq('businessId', base.businessId))
        .first()
      if (!demoReport) throw new Error('no demo report')
      await ctx.db.patch(demoReport._id, {
        photoIds: [...demoReport.photoIds, logo],
      })

      const clientId = await ctx.db.insert('clients', {
        businessId: run.fromBusinessId,
        kind: 'person',
        name: 'Real Client',
        createdAt: now,
        updatedAt: now,
      })
      const propertyId = await ctx.db.insert('properties', {
        businessId: run.fromBusinessId,
        clientId,
        addressLine: '1 Real Street',
        suburb: 'Bayswater',
        state: 'WA',
        postcode: '6053',
        createdAt: now,
      })
      const reportId = await ctx.db.insert('reports', {
        businessId: run.fromBusinessId,
        propertyId,
        authorMembershipId: ownerHere._id,
        template: 'serviceReport',
        legalBasis: 'WA Health (Pesticides) Regulations 2011',
        status: 'draft',
        data: {},
        photoIds: [],
        templateVersion: 2,
        createdAt: now,
      })
      const photoId = await ctx.db.insert('reportPhotos', {
        reportId,
        fieldKey: 'photos',
        storageId: inRealGallery,
        order: 0,
        isCover: false,
        createdAt: now,
      })
      // jobs.addPhoto and reports.attachPhoto take any storage id, so a real
      // file can end up on a demo row. Cleanup deletes only files it made.
      const store = () =>
        ctx.storage.store(
          new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }),
        )
      const onJob = await store()
      const onDraft = await store()
      const demoJob = await ctx.db
        .query('jobs')
        .withIndex('by_business', (q) => q.eq('businessId', base.businessId))
        .first()
      if (!demoJob) throw new Error('no demo job')
      await ctx.db.insert('jobPhotos', {
        jobId: demoJob._id,
        storageId: onJob,
        order: 9,
        createdAt: now,
      })
      const demoDraft = (
        await ctx.db
          .query('reports')
          .withIndex('by_business', (q) => q.eq('businessId', base.businessId))
          .collect()
      ).find((r) => r.status === 'draft')
      if (!demoDraft) throw new Error('no demo draft')
      await ctx.db.patch(demoDraft._id, {
        photoSlots: { ...(demoDraft.photoSlots ?? {}), Other: onDraft },
      })

      // A real business's form, issued twice after the demo existed: the
      // stray-version sweep reads them and must leave them.
      const templateId = await ctx.db.insert('customReportTemplates', {
        businessId: run.fromBusinessId,
        name: 'Real form',
        shortName: 'Real',
        legalBasis: 'APVMA',
        blurb: '',
        sections: [],
        boilerplate: '',
        createdByMembershipId: ownerHere._id,
        createdAt: now,
        updatedAt: now,
      })
      const versions: Array<Id<'customReportTemplateVersions'>> = []
      for (const version of [2, 3]) {
        versions.push(
          await ctx.db.insert('customReportTemplateVersions', {
            businessId: run.fromBusinessId,
            templateId,
            version,
            name: 'Real form',
            shortName: 'Real',
            legalBasis: 'APVMA',
            blurb: '',
            sections: [],
            boilerplate: '',
            publishedByMembershipId: ownerHere._id,
            publishedAt: now,
          }),
        )
      }
      // Products, which the seed makes none of. On the demo: one with files
      // somebody uploaded, one with none, and one holding a demo report's
      // rendered PDF. On the real business: one holding a demo photo (a
      // claim within the window can take any fresh upload's id).
      const productOf = (
        businessId: Id<'businesses'>,
        membershipId: Id<'memberships'>,
        name: string,
        fields: Partial<Doc<'products'>> = {},
      ) =>
        ctx.db.insert('products', {
          businessId,
          name,
          nameKey: name.toLowerCase(),
          createdByMembershipId: membershipId,
          updatedByMembershipId: membershipId,
          createdAt: now,
          updatedAt: now,
          ...fields,
        })
      const uploads = [await store(), await store()]
      // The rendered PDF is the demo's, and so is the product holding it:
      // both go, so the file does too.
      const rendered = await store()
      await ctx.db.patch(demoReport._id, { pdfStorageId: rendered })
      await productOf(base.businessId, base.members.contractor, 'Rendered', {
        pdfStorageId: rendered,
        pdfFileName: 'Report.pdf',
        pdfSize: 3,
      })
      await productOf(base.businessId, base.members.sub, 'Termidor', {
        photoStorageId: uploads[0],
        pdfStorageId: uploads[1],
        pdfFileName: 'Termidor SDS.pdf',
        pdfSize: 3,
      })
      await productOf(base.businessId, base.members.owner, 'Coopex')
      await productOf(run.fromBusinessId, ownerHere._id, 'Real product', {
        photoStorageId: inRealProduct,
      })

      return {
        logo,
        photo: await ctx.db.get(photoId),
        onJob,
        onDraft,
        versions,
        uploads,
        rendered,
      }
    })
    realLogo = crossed.logo
    realPhoto = crossed.photo
    realOnDemoJob = crossed.onJob
    realOnDemoDraft = crossed.onDraft
    realVersions = crossed.versions
    demoProductUploads = crossed.uploads
    demoRendered = crossed.rendered

    slug = await t.query(internal.demo.seed.slugOf, {
      businessId: base.businessId,
    })
    before = await t.query(internal.demo.cleanup.status, {
      businessId: base.businessId,
    })
    files = await demoFiles(t, base.businessId)
    real = await realSide(t, run.fromBusinessId)
    placeholderUserIds = await t.run(async (ctx) => {
      const ids: Array<string> = []
      for (const key of ['dana', 'former'] as const) {
        const member = await ctx.db.get(base.members[key])
        if (member) ids.push(member.userId)
      }
      return ids
    })
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  test('status sees the whole demo before anything goes', () => {
    const totalProperties = CLIENTS.reduce((n, c) => n + c.properties.length, 0)
    expect(before).toMatchObject({
      businesses: 1,
      memberships: 5,
      clients: CLIENTS.length,
      properties: totalProperties,
      notes: run.notes,
      noteBodies: run.notes,
      storage: files.seeded.length,
    })
    expect(before.jobs).toBeGreaterThanOrEqual(run.jobs.length)
    expect(before.reports).toBeGreaterThanOrEqual(
      Object.keys(run.reports).length,
    )
    for (const table of [
      'recurrences',
      'jobPhotos',
      'clientContacts',
      'invitations',
      'auditLog',
      'reportPhotos',
      'reportDeliveries',
      'customReportTemplates',
      'customReportTemplateVersions',
      'templateSettings',
      'optionSets',
      'reportSnippets',
      'noteMentions',
      'products',
    ]) {
      expect(before[table], table).toBeGreaterThan(0)
    }
  })

  test('refuses anything but the demo named by its own slug, deleting nothing', async () => {
    const { t, base } = run
    const source = await t.query(internal.demo.seed.slugOf, {
      businessId: run.fromBusinessId,
    })
    const attempts = [
      { businessId: base.businessId, confirmSlug: `${slug}-2` },
      { businessId: base.businessId, confirmSlug: source },
      { businessId: base.businessId, confirmSlug: '' },
      // A real business, even named by its own slug.
      { businessId: run.fromBusinessId, confirmSlug: source },
      { businessId: run.fromBusinessId, confirmSlug: slug },
    ]
    for (const args of attempts) {
      expect(
        await refusal(t.mutation(internal.demo.cleanup.remove, args)),
      ).toBe('NOT_A_DEMO')
    }
    expect(
      await t.query(internal.demo.cleanup.status, {
        businessId: base.businessId,
      }),
    ).toEqual(before)
    expect(await realSide(t, run.fromBusinessId)).toEqual(real)
  })

  test('removes it in bounded batches, each scheduling the next', async () => {
    const { t, base } = run
    removal = await removeAll(t, base.businessId, slug)
    expect(removal.calls).toBeGreaterThan(1)
    for (const deleted of removal.perCall) {
      const total = Object.values(deleted).reduce((n, k) => n + k, 0)
      expect(total).toBeLessThanOrEqual(MOST_PER_CALL)
    }
    // Every call but the last left a continuation behind.
    const continuations = await t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name.includes('cleanup'),
      ),
    )
    expect(continuations).toHaveLength(removal.calls - 1)
    for (const job of continuations) {
      expect(job.args).toEqual([
        { businessId: base.businessId, confirmSlug: slug },
      ])
    }
    // What was deleted adds up to what status saw, table by table.
    const totals: Record<string, number> = {}
    for (const deleted of removal.perCall) {
      for (const [what, n] of Object.entries(deleted)) {
        totals[what] = (totals[what] ?? 0) + n
      }
    }
    for (const table of [
      'businesses',
      'memberships',
      'recurrences',
      'jobs',
      'jobPhotos',
      'clients',
      'clientContacts',
      'properties',
      'invitations',
      'auditLog',
      'notes',
      'noteMentions',
      'reports',
      'reportPhotos',
      'reportDeliveries',
      'customReportTemplates',
      'customReportTemplateVersions',
      'templateSettings',
      'optionSets',
      'reportSnippets',
      'products',
    ]) {
      expect(totals[table] ?? 0, table).toBe(before[table])
    }
    expect(totals.products).toBe(3)
    expect(totals.noteBodies).toBe(run.notes)
    expect(totals.authUsers).toBe(2)
  })

  test('leaves nothing of the demo', async () => {
    const { t, base } = run
    const after = await t.query(internal.demo.cleanup.status, {
      businessId: base.businessId,
    })
    for (const [what, n] of Object.entries(after)) {
      expect(n, what).toBe(0)
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())

    // Every file, bar those a real business uses too, and those the seed did
    // not make.
    const kept = new Set([
      sharedWithReal,
      realLogo,
      inRealGallery,
      inRealProduct,
      realOnDemoJob,
      realOnDemoDraft,
    ])
    expect(files.files).toEqual(expect.arrayContaining([...kept]))
    expect(await filesStillStored(t, files.files)).toEqual(
      files.files.filter((id) => kept.has(id)),
    )
    expect(
      await filesStillStored(
        t,
        files.seeded.filter((id) => !kept.has(id)),
      ),
    ).toEqual([])
    // A product's files are uploads, and outlive it here as they do in
    // products.remove.
    expect(await filesStillStored(t, demoProductUploads)).toEqual(
      demoProductUploads,
    )
    expect(await filesStillStored(t, [demoRendered])).toEqual([])

    // The note bodies in the component. Their edit history is removed by
    // the component's own scheduled job; the seed wrote none.
    const bodies = await t.run(async (ctx) => {
      let left = 0
      for (const id of files.noteIds) {
        const snapshot = await ctx.runQuery(
          components.prosemirrorSync.lib.getSnapshot,
          { id },
        )
        if (snapshot.content !== null) left++
      }
      return left
    })
    expect(bodies).toBe(0)

    // The placeholder people, who were nobody else's.
    for (const userId of placeholderUserIds) {
      expect(await userOf(t, userId)).toBeNull()
    }
  })

  test('leaves the real business, the real logins and the shared snapshots', async () => {
    const { t } = run
    expect(await realSide(t, run.fromBusinessId)).toEqual(real)
    const versionsLeft = await t.run(async (ctx) =>
      Promise.all(realVersions.map((id) => ctx.db.get(id))),
    )
    expect(versionsLeft.every((row) => row !== null)).toBe(true)
    expect(
      await t.run(async (ctx) =>
        realPhoto ? ctx.db.get(realPhoto._id) : null,
      ),
    ).toEqual(realPhoto)
    // Some of those snapshots are the demo's reports' own: shared by hash,
    // they are never deleted.
    const snapshotIds = new Set(real.snapshots.map((s) => s._id))
    expect(files.snapshotIds.length).toBeGreaterThan(0)
    for (const id of files.snapshotIds) expect(snapshotIds.has(id)).toBe(true)

    for (const actor of [run.owner, run.contractor, run.sub]) {
      expect(await userOf(t, actor.userId)).not.toBeNull()
      expect(await sessionOf(t, actor.sessionId)).not.toBeNull()
      const theirs = await t.run(async (ctx) =>
        ctx.db
          .query('memberships')
          .withIndex('by_user', (q) => q.eq('userId', actor.userId))
          .collect(),
      )
      expect(theirs.map((m) => m.businessId)).toEqual([run.fromBusinessId])
    }
  })

  test('once it is gone, there is nothing left to remove', async () => {
    const { t, base } = run
    expect(
      await refusal(
        t.mutation(internal.demo.cleanup.remove, {
          businessId: base.businessId,
          confirmSlug: slug,
        }),
      ),
    ).toBe('NOT_A_DEMO')
  })
})

describe('removing one of two demos', () => {
  let source: DemoSource
  let first: { businessId: Id<'businesses'>; slug: string }
  let second: { businessId: Id<'businesses'>; slug: string }
  let placeholders: Array<Doc<'memberships'>>

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    source = await demoSource()
    const { t, fromBusinessId } = source
    first = await t.action(internal.demo.seed.run, { fromBusinessId })
    second = await t.action(internal.demo.seed.run, {
      fromBusinessId,
      allowAnother: true,
    })
    placeholders = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('memberships')
          .withIndex('by_business', (q) => q.eq('businessId', first.businessId))
          .collect()
      ).filter(
        (m) =>
          m.userId !== source.owner.userId &&
          m.userId !== source.contractor.userId &&
          m.userId !== source.sub.userId,
      ),
    )
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  test('keeps the placeholder people while the other demo has them', async () => {
    const { t } = source
    expect(placeholders).toHaveLength(2)
    const secondBefore = await t.query(internal.demo.cleanup.status, {
      businessId: second.businessId,
    })
    const secondFiles = await demoFiles(t, second.businessId)

    await removeAll(t, first.businessId, first.slug)

    for (const member of placeholders) {
      const user = (await userOf(t, member.userId)) as { email: string } | null
      expect(user?.email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`)).toBe(true)
    }
    expect(
      await t.query(internal.demo.cleanup.status, {
        businessId: second.businessId,
      }),
    ).toEqual(secondBefore)
    expect(await filesStillStored(t, secondFiles.files)).toEqual(
      secondFiles.files,
    )
    expect(
      await t.run(async (ctx) => (await ctx.db.get(second.businessId))?.plan),
    ).toBe(DEMO_PLAN)
  })

  test('and removes them with the last demo that had them', async () => {
    const { t } = source
    await removeAll(t, second.businessId, second.slug)
    for (const member of placeholders) {
      expect(await userOf(t, member.userId)).toBeNull()
    }
    for (const actor of [source.owner, source.contractor, source.sub]) {
      expect(await userOf(t, actor.userId)).not.toBeNull()
      expect(await sessionOf(t, actor.sessionId)).not.toBeNull()
    }
    const businesses = await t.run(async (ctx) =>
      ctx.db.query('businesses').collect(),
    )
    expect(businesses.map((b) => b._id)).toEqual([source.fromBusinessId])
  })
})
