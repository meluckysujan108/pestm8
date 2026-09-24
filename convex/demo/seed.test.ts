/// <reference types="vite/client" />
import { ConvexError } from 'convex/values'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { components, internal } from '../_generated/api'
import { demoSource } from '../../test/demoFixture'
import { CLIENTS, DEMO_BUSINESS_NAME, DEMO_PLAN } from './shared'
import type { DemoSource } from '../../test/demoFixture'
import type { TestApp } from '../../test/harness'
import type { Id } from '../_generated/dataModel'

/**
 * The whole seed, through `seed:run` itself — the action that stores the
 * images and runs every step in order — twice, the second time alongside the
 * first. Then the things no single step's test can see: what holds across
 * every business at once, and what the app's migration checks say about it.
 *
 * Scheduled work (the PDF render finalise queues, the forecast a new draft
 * asks for) is held with fake timers: it would reach the network.
 */

type Seeded = {
  businessId: Id<'businesses'>
  slug: string
  counts: Record<string, number>
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

/** Every row of every table the demo writes to, across all businesses. */
async function everything(t: TestApp) {
  const read = await t.run(async (ctx) => {
    const notes = await ctx.db.query('notes').collect()
    const withBody: Array<Id<'notes'>> = []
    for (const note of notes) {
      const snapshot = await ctx.runQuery(
        components.prosemirrorSync.lib.getSnapshot,
        { id: note._id },
      )
      if (snapshot.content !== null) withBody.push(note._id)
    }
    return {
      businesses: await ctx.db.query('businesses').collect(),
      memberships: await ctx.db.query('memberships').collect(),
      clients: await ctx.db.query('clients').collect(),
      clientContacts: await ctx.db.query('clientContacts').collect(),
      properties: await ctx.db.query('properties').collect(),
      jobs: await ctx.db.query('jobs').collect(),
      jobPhotos: await ctx.db.query('jobPhotos').collect(),
      recurrences: await ctx.db.query('recurrences').collect(),
      reports: await ctx.db.query('reports').collect(),
      reportPhotos: await ctx.db.query('reportPhotos').collect(),
      snapshots: await ctx.db.query('reportTemplateSnapshots').collect(),
      templates: await ctx.db.query('customReportTemplates').collect(),
      notes,
      noteMentions: await ctx.db.query('noteMentions').collect(),
      withBody,
      files: (await ctx.db.system.query('_storage').collect()).map(
        (file) => file._id,
      ),
    }
  })
  return {
    ...read,
    withBody: new Set(read.withBody),
    files: new Set(read.files),
  }
}

describe('seed:run, end to end', () => {
  let source: DemoSource
  let first: Seeded
  let second: Seeded

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    source = await demoSource()
    first = await source.t.action(internal.demo.seed.run, {
      fromBusinessId: source.fromBusinessId,
    })
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  test('makes one labelled demo, and says what it made', async () => {
    const { t } = source
    const business = await t.run(async (ctx) => ctx.db.get(first.businessId))
    expect(business).toMatchObject({
      name: DEMO_BUSINESS_NAME,
      slug: first.slug,
      plan: DEMO_PLAN,
    })
    expect(await t.query(internal.demo.seed.list, {})).toEqual([
      {
        businessId: first.businessId,
        name: DEMO_BUSINESS_NAME,
        slug: first.slug,
        createdAt: business?.createdAt,
      },
    ])

    // The counts it reports are the rows that are there.
    const status = await t.query(internal.demo.cleanup.status, {
      businessId: first.businessId,
    })
    expect(first.counts).toEqual({
      clients: CLIENTS.length,
      properties: CLIENTS.reduce((n, c) => n + c.properties.length, 0),
      jobs: status.jobs,
      customTemplates: status.customReportTemplates,
      reports: expect.any(Number) as number,
      notes: status.notes,
    })
    expect(status.clients).toBe(first.counts.clients)
    expect(status.properties).toBe(first.counts.properties)
    // The reports step hands back the ones later steps name; the library
    // holds those and the history besides.
    expect(first.counts.reports).toBeGreaterThanOrEqual(10)
    expect(status.reports).toBeGreaterThanOrEqual(first.counts.reports)
    expect(first.counts.jobs).toBeGreaterThan(100)
    expect(first.counts.notes).toBeGreaterThan(30)
    expect(first.counts.customTemplates).toBeGreaterThanOrEqual(2)
    expect(status.noteBodies).toBe(status.notes)
    expect(status.memberships).toBe(5)
  })

  test('will not quietly make a second, but will when asked', async () => {
    const { t, fromBusinessId } = source
    const before = await t.run(async (ctx) =>
      ctx.db.query('businesses').collect(),
    )
    const refused = await refusal(
      t.action(internal.demo.seed.run, { fromBusinessId }),
    )
    expect(String(refused)).toMatch(/^DEMO_EXISTS: /)
    expect(String(refused)).toContain(first.slug)
    expect(
      await t.run(async (ctx) => ctx.db.query('businesses').collect()),
    ).toEqual(before)

    second = await t.action(internal.demo.seed.run, {
      fromBusinessId,
      allowAnother: true,
    })
    expect(second.businessId).not.toBe(first.businessId)
    expect(second.slug).toBe(`${first.slug}-2`)
    expect(second.counts).toEqual(first.counts)
    expect(
      (await t.query(internal.demo.seed.list, {})).map((b) => b.slug),
    ).toEqual([first.slug, second.slug])

    // The same two placeholder people on both rosters, not two more.
    const rosters = await t.run(async (ctx) => {
      const of = async (businessId: Id<'businesses'>) =>
        (
          await ctx.db
            .query('memberships')
            .withIndex('by_business', (q) => q.eq('businessId', businessId))
            .collect()
        )
          .map((m) => m.userId)
          .sort()
      return [await of(first.businessId), await of(second.businessId)]
    })
    expect(rosters[1]).toEqual(rosters[0])
  })

  test('holds together across every business', async () => {
    const { t } = source
    const all = await everything(t)
    const byId = <T extends { _id: string }>(rows: Array<T>) =>
      new Map(rows.map((row) => [row._id, row]))
    const members = byId(all.memberships)
    const properties = byId(all.properties)
    const clients = byId(all.clients)
    const jobsById = byId(all.jobs)
    const recurrences = byId(all.recurrences)
    const templates = byId(all.templates)
    const snapshots = byId(all.snapshots)
    const reportsById = byId(all.reports)
    const notesById = byId(all.notes)

    // One membership per person per business: two lock them out of it.
    const pairs = all.memberships.map((m) => `${m.userId}|${m.businessId}`)
    expect(new Set(pairs).size).toBe(pairs.length)
    const slugs = all.businesses.map((b) => b.slug)
    expect(new Set(slugs).size).toBe(slugs.length)

    for (const property of all.properties) {
      expect(clients.get(property.clientId)?.businessId).toBe(
        property.businessId,
      )
    }
    for (const contact of all.clientContacts) {
      expect(clients.get(contact.clientId)?.businessId).toBe(contact.businessId)
    }

    for (const series of all.recurrences) {
      expect(properties.get(series.propertyId)?.businessId).toBe(
        series.businessId,
      )
      expect(members.get(series.assignedMembershipId)?.businessId).toBe(
        series.businessId,
      )
      expect(series.intervalCount).toBeGreaterThan(0)
      expect(series.frequency).toBeUndefined()
    }

    for (const job of all.jobs) {
      expect(properties.get(job.propertyId)?.businessId).toBe(job.businessId)
      expect(members.get(job.assignedMembershipId)?.businessId).toBe(
        job.businessId,
      )
      if (job.recurrenceId) {
        expect(recurrences.get(job.recurrenceId)?.businessId).toBe(
          job.businessId,
        )
        expect(job.occurrenceAt).toBeDefined()
      }
      if (job.status === 'recurring') expect(job.recurrenceId).toBeDefined()
      expect(Number.isInteger(job.price)).toBe(true)
    }
    for (const photo of all.jobPhotos) {
      expect(jobsById.has(photo.jobId)).toBe(true)
      expect(all.files.has(photo.storageId)).toBe(true)
    }

    for (const report of all.reports) {
      expect(properties.get(report.propertyId)?.businessId).toBe(
        report.businessId,
      )
      expect(members.get(report.authorMembershipId)?.businessId).toBe(
        report.businessId,
      )
      if (report.jobId) {
        const job = jobsById.get(report.jobId)
        expect(job?.businessId).toBe(report.businessId)
        expect(job?.propertyId).toBe(report.propertyId)
      }
      if (report.template === 'custom') {
        expect(report.customTemplateId).toBeDefined()
        if (report.customTemplateId) {
          expect(templates.get(report.customTemplateId)?.businessId).toBe(
            report.businessId,
          )
        }
      }
      if (report.status === 'finalised') {
        expect(report.reportNumber).toBeDefined()
        expect(report.templateSnapshotId).toBeDefined()
        if (report.templateSnapshotId) {
          expect(snapshots.has(report.templateSnapshotId)).toBe(true)
        }
        expect(report.contextSnapshot).toBeDefined()
      }
      const files = [
        ...report.photoIds,
        ...Object.values(report.photoSlots ?? {}),
        ...Object.values(report.signatureSlots ?? {}).map((s) => s.storageId),
      ]
      for (const file of files) expect(all.files.has(file)).toBe(true)
    }
    for (const photo of all.reportPhotos) {
      expect(reportsById.has(photo.reportId)).toBe(true)
      expect(all.files.has(photo.storageId)).toBe(true)
    }

    for (const note of all.notes) {
      expect(members.get(note.authorMembershipId)?.businessId).toBe(
        note.businessId,
      )
      expect(all.withBody.has(note._id)).toBe(true)
      if (note.jobId) {
        const job = jobsById.get(note.jobId)
        expect(job?.businessId).toBe(note.businessId)
        expect(note.propertyId).toBe(job?.propertyId)
      }
      if (note.propertyId) {
        const property = properties.get(note.propertyId)
        expect(property?.businessId).toBe(note.businessId)
        expect(note.clientId).toBe(property?.clientId)
      }
      if (note.clientId) {
        expect(clients.get(note.clientId)?.businessId).toBe(note.businessId)
      }
    }
    for (const mention of all.noteMentions) {
      const note = notesById.get(mention.noteId)
      expect(note).toBeDefined()
      expect(members.get(mention.membershipId)?.businessId).toBe(
        note?.businessId,
      )
    }

    // The counters are one past the highest number handed out, and a number
    // is shared only by the issues of one report.
    for (const business of all.businesses) {
      const jobNumbers = all.jobs
        .filter((j) => j.businessId === business._id)
        .map((j) => j.jobNumber ?? 0)
      if (jobNumbers.length > 0) {
        expect(new Set(jobNumbers).size).toBe(jobNumbers.length)
        expect(business.nextJobNumber).toBe(Math.max(...jobNumbers) + 1)
      }
      const issued = all.reports.filter(
        (r) => r.businessId === business._id && r.reportNumber !== undefined,
      )
      if (issued.length > 0) {
        const issues = issued.map((r) => `${r.reportNumber}v${r.version ?? 1}`)
        expect(new Set(issues).size).toBe(issues.length)
        expect(business.nextReportNumber).toBe(
          Math.max(...issued.map((r) => r.reportNumber ?? 0)) + 1,
        )
      }
      if (business.logoStorageId) {
        expect(all.files.has(business.logoStorageId)).toBe(true)
      }
    }
    for (const member of all.memberships) {
      if (member.savedSignatureStorageId) {
        expect(all.files.has(member.savedSignatureStorageId)).toBe(true)
      }
    }
  })

  test("passes the app's own migration checks", async () => {
    const { t } = source
    expect(
      await t.query(internal.migrations.reportSnapshotsV1.invariant, {}),
    ).toMatchObject({ finalisedWithoutSnapshot: 0 })
    expect(
      await t.query(internal.migrations.reportsContract.invariant, {}),
    ).toMatchObject({
      withCustomSnapshot: 0,
      finalisedCustomWithoutSnapshot: 0,
    })
    expect(
      await t.query(internal.migrations.reportsLibrary.invariant, {}),
    ).toMatchObject({ withoutUpdatedAt: 0, withoutSearchText: 0 })
    expect(
      await t.query(internal.migrations.recurringIntervalV1.invariant, {}),
    ).toMatchObject({ withoutInterval: 0, withFrequency: 0 })
    expect(await t.query(internal.migrations.jobStatusV1.remaining, {})).toBe(0)
    expect(
      await t.query(internal.migrations.memberColoursV1.remaining, {}),
    ).toBe(0)
  })
})
