/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import schema from './schema'
import { freezeTemplate } from './lib/templateSnapshot'
import { fieldsOf, getTemplate, sectionsOf, templateFor } from '../src/lib/reportTemplates'
import { buildReportContext, toPresentContext } from './lib/reportContext'
import { present } from '../src/lib/reportTemplates/present'
import { rewriteDraftsForRename } from './lib/optionSets'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

const modules = import.meta.glob('./**/*.ts')

/**
 * What `reports.finalise` and the backfill migration both rely on: freezing a
 * template is content-addressed, so the same wording always lands on the same
 * row no matter which of the two writers got there first, or from which
 * direction.
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

type Ids = Awaited<ReturnType<typeof seed>>

async function insertReport(
  ctx: MutationCtx,
  ids: Ids,
  template: Doc<'reports'>['template'],
  extra: Partial<Doc<'reports'>> = {},
): Promise<Id<'reports'>> {
  return ctx.db.insert('reports', {
    businessId: ids.businessId,
    propertyId: ids.propertyId,
    authorMembershipId: ids.membershipId,
    template,
    legalBasis: 'AS 3660.2-2017',
    status: 'finalised',
    data: {},
    photoIds: [],
    finalisedAt: Date.now(),
    createdAt: Date.now(),
    ...extra,
  })
}

describe('freezeTemplate', () => {
  test('a report written against v1 freezes v1 wording, whatever is current', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      // No revision stamped: every report that predates revisions.
      const reportId = await insertReport(ctx, ids, 'termiteManagementCert')
      const report = (await ctx.db.get(reportId))!

      const snapshotId = await freezeTemplate(ctx, report)
      expect(snapshotId).toBeDefined()

      const snapshot = (await ctx.db.get(snapshotId!))!
      const live = templateFor('termiteManagementCert', 1)
      // The point of the whole seam: the current module is a different form.
      expect(getTemplate('termiteManagementCert').version).toBeGreaterThan(1)
      expect(snapshot.terms).toBeUndefined()
      expect(snapshot.name).toBe(live.name)
      expect(snapshot.boilerplate).toBe(live.boilerplate)
      // Through `sectionsOf()`, so the synthetic "Details" wrapper that three
      // of the four built-ins print is captured rather than normalised away.
      expect(snapshot.sections).toEqual(sectionsOf(live))
      expect(snapshot.version).toBe(live.version)
    })
  })

  test('two reports of the same template share one row', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const first = (await ctx.db.get(
        await insertReport(ctx, ids, 'serviceReport'),
      ))!
      const second = (await ctx.db.get(
        await insertReport(ctx, ids, 'serviceReport'),
      ))!

      const a = await freezeTemplate(ctx, first)
      const b = await freezeTemplate(ctx, second)
      expect(a).toBe(b)

      const rows = await ctx.db.query('reportTemplateSnapshots').collect()
      expect(rows).toHaveLength(1)
    })
  })

  test('different templates do not collapse into each other', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      for (const template of [
        'serviceReport',
        'timberPestInspection',
        'termiteManagementCert',
        'treatmentRecord',
      ] as const) {
        const report = (await ctx.db.get(
          await insertReport(ctx, ids, template),
        ))!
        await freezeTemplate(ctx, report)
      }
      const rows = await ctx.db.query('reportTemplateSnapshots').collect()
      expect(rows).toHaveLength(4)
    })
  })

  test('a custom report freezes the copy it has been rendering from, not the live doc', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const now = Date.now()
      const customTemplateId = await ctx.db.insert('customReportTemplates', {
        businessId: ids.businessId,
        name: 'Site Walkthrough (Revised)',
        shortName: 'Walkthrough',
        legalBasis: 'Internal',
        blurb: 'A walk around.',
        sections: [{ title: 'Notes', fields: [] }],
        boilerplate: 'Revised terms.',
        createdByMembershipId: ids.membershipId,
        createdAt: now,
        updatedAt: now,
      })
      const inline = {
        name: 'Site Walkthrough',
        shortName: 'Walkthrough',
        legalBasis: 'Internal',
        blurb: 'A walk around.',
        sections: [{ title: 'Notes', fields: [] }],
        boilerplate: 'The terms as signed.',
      }
      const report = (await ctx.db.get(
        await insertReport(ctx, ids, 'custom', {
          customTemplateId,
          customTemplateSnapshot: inline,
        }),
      ))!

      const snapshotId = await freezeTemplate(ctx, report, { custom: inline })
      const snapshot = (await ctx.db.get(snapshotId!))!
      // The live row says "(Revised)". A document signed before that edit must
      // keep saying what it said.
      expect(snapshot.name).toBe('Site Walkthrough')
      expect(snapshot.boilerplate).toBe('The terms as signed.')
    })
  })

  test('a custom report with no template left to read is skipped, never crashed on', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const report = (await ctx.db.get(
        await insertReport(ctx, ids, 'custom'),
      ))!
      // Finalising must never fail because a snapshot could not be taken —
      // the alternative is a signed report stuck in draft on a phone.
      await expect(freezeTemplate(ctx, report)).resolves.toBeUndefined()
    })
  })
})

describe('verbatim templates (v2)', () => {
  test('a v2 report freezes its terms and print spec, and dedupes with them', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const version = getTemplate('termiteManagementCert').version
      const first = (await ctx.db.get(
        await insertReport(ctx, ids, 'termiteManagementCert', { templateVersion: version }),
      ))!
      const second = (await ctx.db.get(
        await insertReport(ctx, ids, 'termiteManagementCert', { templateVersion: version }),
      ))!

      const a = await freezeTemplate(ctx, first)
      const b = await freezeTemplate(ctx, second)
      expect(a).toBeDefined()
      // Without terms/print in the comparison, every v2 finalise would mint a
      // duplicate row and nothing would report it.
      expect(b).toBe(a)

      const row = (await ctx.db.get(a!))!
      const live = getTemplate('termiteManagementCert')
      expect(row.version).toBe(version)
      expect(row.terms).toEqual(live.terms)
      expect(row.print).toEqual(live.print)
      expect(row.sections).toEqual(sectionsOf(live))
    })
  })

  test('the v2 service report, with its nested notes, survives a real insert', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      for (const template of ['serviceReport', 'timberPestInspection'] as const) {
        const report = (await ctx.db.get(
          await insertReport(ctx, ids, template, {
            templateVersion: getTemplate(template).version,
          }),
        ))!
        // freezeTemplate swallows errors so signing never blocks — which is
        // exactly why a value Convex refuses (too deeply nested) must be caught
        // here and not on a technician's phone.
        const id = await freezeTemplate(ctx, report)
        expect(id, `${template} snapshot was not written`).toBeDefined()
      }
    })
  })

  test('a business with its own product list mints its own row; defaults share one', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const version = getTemplate('serviceReport').version
      const plain = (await ctx.db.get(
        await insertReport(ctx, ids, 'serviceReport', { templateVersion: version }),
      ))!
      const before = await freezeTemplate(ctx, plain)

      await ctx.db.insert('optionSets', {
        businessId: ids.businessId,
        key: 'products',
        options: [{ value: 'House Brand Spray', label: 'House Brand Spray' }],
        renames: [],
        seedVersion: version,
        updatedAt: Date.now(),
        updatedByMembershipId: ids.membershipId,
      })
      const customised = (await ctx.db.get(
        await insertReport(ctx, ids, 'serviceReport', { templateVersion: version }),
      ))!
      const after = await freezeTemplate(ctx, customised)

      expect(after).not.toBe(before)
      const row = (await ctx.db.get(after!))!
      expect(JSON.stringify(row.sections)).toContain('House Brand Spray')
    })
  })
})

describe('report context', () => {
  test('the technician is whoever the member field names, not the author', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const inspector = await ctx.db.insert('memberships', {
        userId: 'user_2',
        businessId: ids.businessId,
        role: 'subcontractor',
        canViewAllJobs: false,
        colour: '#000000',
        status: 'active',
        licenceNumber: '4132',
        createdAt: Date.now(),
      })
      const template = getTemplate('timberPestInspection')
      const memberKey = fieldsOf(template).find((f) => f.kind === 'member')?.key
      expect(memberKey).toBeDefined()

      const report = (await ctx.db.get(
        await insertReport(ctx, ids, 'timberPestInspection', {
          templateVersion: template.version,
          status: 'draft',
        }),
      ))!
      const { snapshot } = await buildReportContext(ctx, report, {
        [memberKey!]: inspector,
      })
      expect(snapshot.technician?.membershipId).toBe(inspector)
      expect(snapshot.technician?.licence).toBe('4132')
      expect(snapshot.client?.name).toBe('J. Sample')
      expect(snapshot.property?.address).toBe('12 Example Street Leda WA 6170')
      // Only chosen members are frozen into the printed roster.
      expect(Object.keys(snapshot.roster)).toEqual([inspector])
    })
  })

  test('a form that names nobody falls back to the author and reads no identities', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const report = (await ctx.db.get(await insertReport(ctx, ids, 'treatmentRecord')))!
      const { snapshot, roster } = await buildReportContext(ctx, report, {})
      expect(snapshot.technician?.membershipId).toBe(ids.membershipId)
      expect(roster).toEqual([])
    })
  })
})

describe('rows bound to a member field', () => {
  test('each installer row prints its own person, and a blank choice prints nobody', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const addMember = (userId: string, licence: string, phone: string) =>
        ctx.db.insert('memberships', {
          userId,
          businessId: ids.businessId,
          role: 'subcontractor',
          canViewAllJobs: false,
          colour: '#000000',
          status: 'active',
          licenceNumber: licence,
          phone,
          createdAt: Date.now(),
        })
      const first = await addMember('user_a', '4132', '0400 111 111')
      const second = await addMember('user_b', '9999', '0400 999 999')

      const cert = getTemplate('termiteManagementCert')
      const report = (await ctx.db.get(
        await insertReport(ctx, ids, 'termiteManagementCert', {
          templateVersion: cert.version,
          status: 'draft',
        }),
      ))!
      const data = { installer: first, certifyingInstaller: second }
      const { snapshot } = await buildReportContext(ctx, report, data)
      const context = { ...toPresentContext(snapshot), answers: data }

      const field = (key: string) => fieldsOf(cert).find((f) => f.key === key)!
      const text = (key: string) => {
        const shown = present(field(key), undefined, context)
        return shown.kind === 'text' ? shown.text : shown.kind
      }
      // Two different people on one certificate, each row beside its own name.
      expect(text('installerLicence')).toBe('4132')
      expect(text('certifyingInstallerLicence')).toBe('9999')
      expect(text('certifyingInstallerPhone')).toBe('0400 999 999')

      // Nobody chosen in §7: its licence row is blank, never someone else's.
      const blankData = { installer: first }
      const blank = await buildReportContext(ctx, report, blankData)
      const blankContext = { ...toPresentContext(blank.snapshot), answers: blankData }
      expect(present(field('certifyingInstallerLicence'), undefined, blankContext).kind).toBe('blank')
    })
  })

  test('a form that asks who did the work and got no answer credits nobody', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ids = await seed(ctx)
      const timber = getTemplate('timberPestInspection')
      const report = (await ctx.db.get(
        await insertReport(ctx, ids, 'timberPestInspection', {
          templateVersion: timber.version,
          status: 'draft',
        }),
      ))!
      const { snapshot } = await buildReportContext(ctx, report, {})
      // Not the author: the form names an inspector, and none was named.
      expect(snapshot.technician).toBeNull()
    })
  })
})

describe('option renames', () => {
  async function seedDrafts(ctx: MutationCtx) {
    const ids = await seed(ctx)
    const version = getTemplate('serviceReport').version
    const insert = (status: 'draft' | 'finalised', product: string) =>
      insertReport(ctx, ids, 'serviceReport', {
        templateVersion: version,
        status,
        data: { treatments: [{ _id: 'r1', product: [product] }] },
      })
    return { ids, insert }
  }
  const productOf = (report: Doc<'reports'>) =>
    (report.data as { treatments: Array<{ product: Array<string> }> }).treatments[0].product

  test('a rename rewrites drafts and leaves finalised reports alone', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const { ids, insert } = await seedDrafts(ctx)
      const draftId = await insert('draft', 'Fipforce HP (100 g/L FIPRONIL)')
      const finalId = await insert('finalised', 'Fipforce HP (100 g/L FIPRONIL)')

      const rewritten = await rewriteDraftsForRename(ctx, {
        businessId: ids.businessId,
        key: 'products',
        from: 'Fipforce HP (100 g/L FIPRONIL)',
        to: 'Fipforce HP',
        actorMembershipId: ids.membershipId,
      })
      expect(rewritten).toBe(1)
      expect(productOf((await ctx.db.get(draftId))!)).toEqual(['Fipforce HP'])
      expect(productOf((await ctx.db.get(finalId))!)).toEqual(['Fipforce HP (100 g/L FIPRONIL)'])
    })
  })

  test('chained renames apply in the order made, never folding two answers together', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const { ids, insert } = await seedDrafts(ctx)
      const hadA = await insert('draft', 'A')
      const hadC = await insert('draft', 'C')
      const rename = (from: string, to: string) =>
        rewriteDraftsForRename(ctx, {
          businessId: ids.businessId,
          key: 'products',
          from,
          to,
          actorMembershipId: ids.membershipId,
        })
      // A to B, then C to A: an A draft ends as B, and a C draft as A. Scheduled
      // out of order, the second step's A was indistinguishable from the first's.
      await rename('A', 'B')
      await rename('C', 'A')
      expect(productOf((await ctx.db.get(hadA))!)).toEqual(['B'])
      expect(productOf((await ctx.db.get(hadC))!)).toEqual(['A'])
    })
  })
})
