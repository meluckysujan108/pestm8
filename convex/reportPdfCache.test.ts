/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import schema from './schema'
import { internal } from './_generated/api'
import { RENDER_VERSION } from './reports'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

const modules = import.meta.glob('./**/*.ts')

/**
 * When a stored PDF counts as the current one.
 *
 * This is load-bearing in a way that is easy to miss: every caller treats a
 * non-null `pdfUrl` as "no render needed" and skips the pipeline, so if a
 * stale file's URL is handed out, `RENDER_VERSION` does nothing at all — a
 * report that already has a file can never be redrawn, and one finalised
 * before the document was rewritten shows the new document on screen while
 * its PDF tab, its download and its email attachment all serve the old one.
 * Withholding the URL is the whole mechanism.
 */

async function seed(ctx: MutationCtx) {
  const now = Date.now()
  const businessId = await ctx.db.insert('businesses', {
    name: 'Pest M8 Pest Control',
    slug: 'pest-m8',
    state: 'WA',
    timezone: 'Australia/Perth',
    createdAt: now,
  })
  const membershipId = await ctx.db.insert('memberships', {
    userId: 'user_1',
    businessId,
    role: 'owner',
    canViewAllJobs: true,
    colour: '#C8102E',
    status: 'active',
    createdAt: now,
  })
  const clientId = await ctx.db.insert('clients', {
    businessId,
    kind: 'person',
    name: 'J. Sample',
    createdAt: now,
    updatedAt: now,
  })
  const propertyId = await ctx.db.insert('properties', {
    businessId,
    clientId,
    addressLine: '12 Example Street',
    suburb: 'Leda',
    state: 'WA',
    postcode: '6170',
    createdAt: now,
  })
  return { businessId, membershipId, propertyId }
}

async function finalisedReport(
  ctx: MutationCtx,
  ids: Awaited<ReturnType<typeof seed>>,
  extra: Partial<Doc<'reports'>> = {},
): Promise<Id<'reports'>> {
  return ctx.db.insert('reports', {
    businessId: ids.businessId,
    propertyId: ids.propertyId,
    authorMembershipId: ids.membershipId,
    template: 'serviceReport',
    legalBasis: 'APVMA · AEPMA',
    status: 'finalised',
    data: {},
    photoIds: [],
    finalisedAt: Date.now(),
    createdAt: Date.now(),
    ...extra,
  })
}

/**
 * A stored file, of no particular content — only its pointer is under test.
 *
 * `store` is an action's API and a mutation's `StorageWriter` does not declare
 * it, but convex-test's in-process storage accepts it. The cast is honest
 * about that: this is a fixture writing a byte or two so `getUrl` has
 * something to resolve, not production code taking a shortcut.
 */
async function storeSomething(ctx: MutationCtx): Promise<Id<'_storage'>> {
  const storage = ctx.storage as unknown as {
    store: (blob: Blob) => Promise<Id<'_storage'>>
  }
  return storage.store(new Blob(['%PDF-1.4'], { type: 'application/pdf' }))
}

describe('the PDF a report hands out', () => {
  test('is offered when the current painter drew it', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const storageId = await storeSomething(ctx)
      const reportId = await finalisedReport(ctx, ids, {
        pdfStorageId: storageId,
        pdfStatus: 'ready',
        pdfRenderVersion: RENDER_VERSION,
      })

      const report = await ctx.runQuery(internal.reports.getForRender, {
        reportId,
      })
      expect(report?.pdfUrl).toBeTruthy()
    })
  })

  test('is withheld when an older painter drew it, so the caller redraws', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const storageId = await storeSomething(ctx)
      // Exactly the shape of every report finalised before this branch: a file
      // exists, and nothing records which painter made it.
      const reportId = await finalisedReport(ctx, ids, {
        pdfStorageId: storageId,
      })

      const report = await ctx.runQuery(internal.reports.getForRender, {
        reportId,
      })
      expect(report?.pdfUrl).toBeNull()

      // And the claim is available, rather than being short-circuited by the
      // pointer that is already there.
      const claim = await ctx.runMutation(internal.reports.claimPdf, {
        reportId,
      })
      expect(claim.claimed).toBe(true)
    })
  })

  test('is withheld while a report has never been drawn at all', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const reportId = await finalisedReport(ctx, ids, { pdfStatus: 'pending' })

      const report = await ctx.runQuery(internal.reports.getForRender, {
        reportId,
      })
      expect(report?.pdfUrl).toBeNull()
    })
  })

  test('recording a render is what makes it current', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const reportId = await finalisedReport(ctx, ids)
      const storageId = await storeSomething(ctx)

      await ctx.runMutation(internal.reports.setPdf, {
        reportId,
        storageId,
        bytes: 8,
      })

      const report = await ctx.runQuery(internal.reports.getForRender, {
        reportId,
      })
      expect(report?.pdfUrl).toBeTruthy()
      expect(report?.pdfRenderVersion).toBe(RENDER_VERSION)

      // Append-only: the row is the record, the pointer is a convenience.
      const rows = await ctx.db
        .query('reportPdfs')
        .withIndex('by_report', (q) => q.eq('reportId', reportId))
        .collect()
      expect(rows).toHaveLength(1)
      expect(rows[0].rendererVersion).toBe(RENDER_VERSION)
    })
  })

  test('a second claim on a running render waits rather than starting another', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const reportId = await finalisedReport(ctx, ids)

      const first = await ctx.runMutation(internal.reports.claimPdf, {
        reportId,
      })
      expect(first.claimed).toBe(true)

      // Two tabs opening the PDF at once: the loser waits for the winner's
      // file instead of rendering a second one and orphaning it in storage.
      const second = await ctx.runMutation(internal.reports.claimPdf, {
        reportId,
      })
      expect(second).toEqual({ claimed: false, reason: 'busy' })
    })
  })
})
