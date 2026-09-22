/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import schema from './schema'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

const modules = import.meta.glob('./**/*.ts')

/**
 * The contract migration for `customTemplateSnapshot`. The one thing it must
 * never do is lose a signed document's wording, so the case that matters most
 * is a report whose inline copy is its ONLY copy.
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
  const customTemplateId = await ctx.db.insert('customReportTemplates', {
    businessId,
    name: 'Site Walkthrough (Revised)',
    shortName: 'Walkthrough',
    legalBasis: 'Internal',
    blurb: 'A walk around.',
    sections: [{ title: 'Notes', fields: [] }],
    boilerplate: 'Revised terms.',
    createdByMembershipId: membershipId,
    createdAt: now,
    updatedAt: now,
  })
  return { businessId, membershipId, propertyId, customTemplateId }
}

const INLINE = {
  name: 'Site Walkthrough',
  shortName: 'Walkthrough',
  legalBasis: 'Internal',
  blurb: 'A walk around.',
  sections: [{ title: 'Notes', fields: [] }],
  boilerplate: 'The terms as signed.',
}

async function insert(
  ctx: MutationCtx,
  ids: Awaited<ReturnType<typeof seed>>,
  extra: Partial<Doc<'reports'>> = {},
): Promise<Id<'reports'>> {
  return ctx.db.insert('reports', {
    businessId: ids.businessId,
    propertyId: ids.propertyId,
    authorMembershipId: ids.membershipId,
    template: 'custom',
    templateVersion: 1,
    customTemplateId: ids.customTemplateId,
    legalBasis: 'Internal',
    status: 'finalised',
    data: {},
    photoIds: [],
    finalisedAt: Date.now(),
    createdAt: Date.now(),
    ...extra,
  })
}

describe('clearCustomSnapshots', () => {
  test('clears the inline copy where the reference already exists', async () => {
    const t = convexTest(schema, modules)
    const { reportId, snapshotId } = await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const frozenId = await ctx.db.insert('reportTemplateSnapshots', {
        hash: 'h1',
        template: 'custom',
        version: 1,
        ...INLINE,
        createdAt: Date.now(),
      })
      const insertedId = await insert(ctx, ids, {
        customTemplateSnapshot: INLINE,
        templateSnapshotId: frozenId,
      })
      return { reportId: insertedId, snapshotId: frozenId }
    })

    const result = await t.mutation(
      internal.migrations.reportsContract.clearCustomSnapshots,
      { cursor: null },
    )
    expect(result).toMatchObject({ cleared: 1, frozen: 0, kept: 0, done: true })

    const after = await t.run((ctx) => ctx.db.get(reportId))
    expect(after!.customTemplateSnapshot).toBeUndefined()
    // The reference is untouched: it is what the report prints from.
    expect(after!.templateSnapshotId).toBe(snapshotId)
  })

  test('an inline copy that is the only copy is frozen before it is cleared', async () => {
    const t = convexTest(schema, modules)
    const reportId = await t.run(async (ctx) => {
      const ids = await seed(ctx)
      return insert(ctx, ids, { customTemplateSnapshot: INLINE })
    })

    const result = await t.mutation(
      internal.migrations.reportsContract.clearCustomSnapshots,
      { cursor: null },
    )
    expect(result).toMatchObject({ cleared: 1, frozen: 1, kept: 0 })

    const after = await t.run((ctx) => ctx.db.get(reportId))
    expect(after!.customTemplateSnapshot).toBeUndefined()
    const snapshot = await t.run((ctx) =>
      ctx.db.get(after!.templateSnapshotId!),
    )
    // The wording as signed, not the live form's later "(Revised)" edit.
    expect(snapshot!.name).toBe('Site Walkthrough')
    expect(snapshot!.boilerplate).toBe('The terms as signed.')
  })

  test('rows without an inline copy are left alone, and the invariant reads zero after', async () => {
    const t = convexTest(schema, modules)
    const untouchedId = await t.run(async (ctx) => {
      const ids = await seed(ctx)
      await insert(ctx, ids, { customTemplateSnapshot: INLINE })
      return insert(ctx, ids, {
        template: 'serviceReport',
        customTemplateId: undefined,
        legalBasis: 'APVMA',
      })
    })
    const before = await t.run((ctx) => ctx.db.get(untouchedId))

    await t.mutation(internal.migrations.reportsContract.clearCustomSnapshots, {
      cursor: null,
    })

    const after = await t.run((ctx) => ctx.db.get(untouchedId))
    expect(after).toEqual(before)
    expect(
      await t.query(internal.migrations.reportsContract.invariant, {}),
    ).toMatchObject({
      withCustomSnapshot: 0,
      finalisedCustomWithoutSnapshot: 0,
    })
  })
})
