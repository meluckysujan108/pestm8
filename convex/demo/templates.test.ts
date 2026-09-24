/// <reference types="vite/client" />
import { beforeAll, describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import { loadOverrides } from '../lib/optionSets'
import { settingsFor } from '../templateSettings'
import { getTemplate, sectionsOf } from '../../src/lib/reportTemplates'
import { customTemplateSectionsSchema } from '../../src/lib/reportTemplates/customTemplateSchema'
import {
  MAX_OPTION_LENGTH,
  MAX_RECENT,
  MAX_USUAL,
  OPTION_SET_KEYS,
  defaultOptionSet,
} from '../../src/lib/reportTemplates/optionLibraries'
import { resolveReportTemplate } from '../../src/lib/reportTemplates/resolve'
import {
  MAX_SNIPPETS_PER_FIELD,
  MAX_SNIPPET_LENGTH,
  sameSnippet,
} from '../../src/lib/reportTemplates/snippets'
import { runDemoSteps } from '../../test/demoFixture'
import { at } from './shared'
import {
  BAIT_STATION,
  BAIT_STATION_REVISED,
  LONG_PHRASE,
  LONG_PRODUCT,
  PHRASES,
  POSSUM,
  PRODUCT_CHANGES,
  SERVICE_CLONE,
  SUB_PICKS,
  TEMPLATE_SETTINGS,
  TIMBER_VARIANT,
  USUAL_TREATMENTS,
  withField,
} from './templates'
import type { DemoRun } from '../../test/demoFixture'
import type { TestApp } from '../../test/harness'
import type { SectionDef } from '../../src/lib/reportTemplates'
import type { Doc, Id } from '../_generated/dataModel'

/**
 * The demo's report settings (convex/demo/templates.ts).
 *
 * These rows are read by every report the later steps create and frozen into
 * every one they finalise, and a bad one breaks whole screens rather than one
 * record: a published form that fails its schema takes Settings > Reports
 * down with it, and a second settings or option row for the same form makes
 * `.unique()` throw in every report of that form. So most of this checks the
 * invariants the app relies on, through its own queries where it has one, and
 * the last block makes the same changes through the public mutations and
 * compares what the two paths leave behind.
 */

const DAY = 24 * 60 * 60 * 1000

async function rowsOf(t: TestApp, businessId: Id<'businesses'>) {
  return t.run(async (ctx) => {
    const templates = await ctx.db
      .query('customReportTemplates')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
    const versions: Array<Doc<'customReportTemplateVersions'>> = []
    for (const template of templates) {
      versions.push(
        ...(await ctx.db
          .query('customReportTemplateVersions')
          .withIndex('by_template', (q) => q.eq('templateId', template._id))
          .collect()),
      )
    }
    return {
      templates,
      versions,
      settings: await ctx.db
        .query('templateSettings')
        .withIndex('by_business_template', (q) =>
          q.eq('businessId', businessId),
        )
        .collect(),
      optionSets: await ctx.db
        .query('optionSets')
        .withIndex('by_business_key', (q) => q.eq('businessId', businessId))
        .collect(),
      snippets: await ctx.db
        .query('reportSnippets')
        .withIndex('by_business_field', (q) => q.eq('businessId', businessId))
        .collect(),
      audit: await ctx.db
        .query('auditLog')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .collect(),
    }
  })
}

type Rows = Awaited<ReturnType<typeof rowsOf>>

function byId<T extends { _id: string }>(rows: Array<T>, id: string): T {
  const row = rows.find((r) => r._id === id)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

function optionSet(rows: Rows, key: string): Doc<'optionSets'> {
  const row = rows.optionSets.find((r) => r.key === key)
  if (!row) throw new Error(`no ${key} row`)
  return row
}

function keysOf(sections: unknown): Array<string> {
  return (sections as Array<SectionDef>).flatMap((s) =>
    s.fields.map((f) => f.key),
  )
}

describe('the demo report settings', () => {
  let run: DemoRun
  let rows: Rows
  let when: (day: number, hh: number, mm?: number) => number
  let template: (key: string) => Doc<'customReportTemplates'>

  beforeAll(async () => {
    run = await runDemoSteps('templates')
    rows = await rowsOf(run.t, run.base.businessId)
    when = (day, hh, mm = 0) => at(run.base, day, hh, mm)
    template = (key) => byId(rows.templates, run.customTemplates[key])
  })

  describe('custom templates', () => {
    test('four, under the keys later steps look them up by, oldest first', async () => {
      expect(Object.keys(run.customTemplates).sort()).toEqual([
        'baitStation',
        'possumArchived',
        'serviceClone',
        'timberDraftInvalid',
      ])
      expect(rows.templates).toHaveLength(4)

      // The list sorts by `_creationTime`, newest first, whatever createdAt
      // says — so insertion order has to be date order.
      const listed = await run.owner.as.query(api.customTemplates.list, {
        businessId: run.base.businessId,
      })
      expect(listed.map((t) => t.name)).toEqual([
        TIMBER_VARIANT.name,
        POSSUM.name,
        'Swan River Service Report — Residential & Strata',
        BAIT_STATION.name,
      ])
      const created = listed.map((t) => t.createdAt)
      expect([...created].sort((a, b) => b - a)).toEqual(created)

      for (const row of rows.templates) {
        expect(row.createdByMembershipId).toBe(run.base.members.owner)
        expect(row.createdAt).toBeLessThanOrEqual(
          row.publishedAt ?? row.createdAt,
        )
        expect(row.publishedAt ?? row.createdAt).toBeLessThanOrEqual(
          row.updatedAt,
        )
        if (row.draft) {
          expect(row.draft.savedAt).toBe(row.updatedAt)
          expect(row.draft.savedAt).toBeGreaterThanOrEqual(
            row.publishedAt ?? row.createdAt,
          )
        }
      }
    })

    test('every published form and every issued version passes the schema', () => {
      const published = [
        ...rows.templates.map((row) => row.sections),
        ...rows.versions.map((row) => row.sections),
      ]
      expect(published).toHaveLength(6)
      for (const sections of published) {
        const parsed = customTemplateSectionsSchema.safeParse(sections)
        expect(parsed.success).toBe(true)
        // Stored as parsed: nothing a re-parse would strip or change.
        expect(parsed.data).toEqual(sections)
      }
    })

    test('the bait check: issued once, with a valid edit waiting', async () => {
      const row = template('baitStation')
      expect(row.name).toBe('Rodent Bait Station Check')
      expect(row.shortName).toBe('Bait Check')
      expect(row.legalBasis).toBe('APVMA')
      expect(row.publishedVersion).toBe(1)
      expect(row.publishedAt).toBe(row.createdAt)
      expect(row.updatedByMembershipId).toBe(run.base.members.owner)
      expect(row.terms).toBeUndefined()
      expect(row.print).toBeUndefined()
      expect(rows.versions.filter((v) => v.templateId === row._id)).toEqual([])

      const fields = (row.sections as Array<SectionDef>).flatMap(
        (s) => s.fields,
      )
      const field = (key: string) => {
        const found = fields.find((f) => f.key === key)
        if (!found) throw new Error(`no field ${key}`)
        return found
      }
      expect(fields.map((f) => [f.key, f.kind])).toEqual([
        ['visitDate', 'date'],
        ['site', 'derived'],
        ['tech', 'member'],
        ['sendCopy', 'toggle'],
        ['baitType', 'select'],
        ['stations', 'number'],
        ['activity', 'toggle'],
        ['activityNotes', 'area'],
        ['stationsLog', 'repeater'],
        ['photos', 'gallery'],
        ['techSig', 'signature'],
        ['cc', 'emails'],
      ])
      expect(field('visitDate')).toMatchObject({
        required: true,
        defaultToday: true,
      })
      expect(field('site')).toMatchObject({ source: 'property.address' })
      expect(field('sendCopy')).toMatchObject({ semantic: 'sendCopyToClient' })
      expect(field('cc')).toMatchObject({ semantic: 'emailTo' })
      expect(field('activityNotes')).toMatchObject({
        required: true,
        visibleWhen: { when: 'activity', eq: true },
      })
      expect(field('stationsLog')).toMatchObject({
        min: 1,
        columns: [
          { kind: 'text', key: 'station', required: true },
          { kind: 'select', key: 'consumption' },
        ],
      })
      expect(field('techSig')).toMatchObject({
        slot: 'technician',
        role: 'technician',
        required: true,
      })

      const draft = row.draft
      if (!draft) throw new Error('the bait check has no draft')
      expect(Object.keys(draft).sort()).toEqual([
        'blurb',
        'boilerplate',
        'legalBasis',
        'name',
        'savedAt',
        'savedByMembershipId',
        'sections',
        'shortName',
      ])
      expect(draft.name).toBe('Rodent Bait Station Check (revised)')
      expect(draft.savedByMembershipId).toBe(run.base.members.owner)
      expect(
        customTemplateSectionsSchema.safeParse(draft.sections).success,
      ).toBe(true)

      // A technician is handed the issued form, never the owner's edit.
      const asSub = await run.sub.as.query(api.customTemplates.get, {
        businessId: run.base.businessId,
        templateId: row._id,
      })
      expect(asSub?.draft).toBeUndefined()
      expect(asSub?.hasUnpublishedChanges).toBe(true)
      expect(asSub?.publishedVersion).toBe(1)
    })

    test('the Service Report clone: issued twice, renamed each time', async () => {
      const row = template('serviceClone')
      const source = getTemplate('serviceReport')
      const history = rows.versions
        .filter((v) => v.templateId === row._id)
        .sort((a, b) => a.version - b.version)

      expect(row.publishedVersion).toBe(3)
      expect(row.draft).toBeUndefined()
      expect(history.map((v) => v.version)).toEqual([2, 3])
      expect(history.map((v) => v.name)).toEqual(
        SERVICE_CLONE.issues.map((i) => i.name),
      )
      expect(
        new Set([SERVICE_CLONE.name, ...history.map((v) => v.name)]).size,
      ).toBe(3)
      expect(row.name).toBe(history[1].name)
      expect(row.publishedAt).toBe(history[1].publishedAt)
      expect(history[0].publishedAt).toBe(when(-60, 19, 6))
      expect(history[1].publishedAt).toBe(when(-21, 18, 37))

      // Terms and print travel with the row, not the draft.
      expect(row.terms).toEqual(source.terms)
      expect(row.print).toEqual(source.print)
      for (const version of history) {
        expect(version.businessId).toBe(run.base.businessId)
        expect(version.terms).toEqual(row.terms)
        expect(version.print).toEqual(row.print)
        expect(version.publishedByMembershipId).toBe(run.base.members.owner)
      }
      expect(keysOf(history[0].sections)).toContain('accessNotes')
      expect(keysOf(history[0].sections)).not.toContain('strataPlan')
      expect(keysOf(history[1].sections)).toEqual(keysOf(row.sections))
      expect(keysOf(row.sections)).toEqual(
        keysOf(
          withField(
            withField(
              sectionsOf(source),
              'siteAddress',
              SERVICE_CLONE.issues[0].field,
            ),
            'accessNotes',
            SERVICE_CLONE.issues[1].field,
          ),
        ),
      )

      const versions = await run.owner.as.query(api.customTemplates.versions, {
        businessId: run.base.businessId,
        templateId: row._id,
      })
      expect(versions.map((v) => v.version)).toEqual([3, 2])
    })

    test('the possum form: archived ten days ago, never edited since', () => {
      const row = template('possumArchived')
      expect(row.archivedAt).toBe(when(-10, 16, 0))
      expect(row.updatedAt).toBe(row.archivedAt)
      expect(row.createdAt).toBeLessThan(when(-10, 0))
      expect(row.publishedVersion).toBe(1)
      expect(row.draft).toBeUndefined()
      expect(rows.versions.filter((v) => v.templateId === row._id)).toEqual([])
    })

    test('the Timber clone: never issued, and only its draft is invalid', async () => {
      const row = template('timberDraftInvalid')
      const source = getTemplate('timberPestInspection')

      // cloneBuiltin's shape: no version, publish stamp or history.
      expect('publishedVersion' in row).toBe(false)
      expect('publishedAt' in row).toBe(false)
      expect(row.sections).toEqual(sectionsOf(source))
      expect(row.terms).toEqual(source.terms)
      expect(row.print).toEqual(source.print)
      expect(customTemplateSectionsSchema.safeParse(row.sections).success).toBe(
        true,
      )
      // saveDraft is what stamped an editor on it.
      expect(row.updatedByMembershipId).toBe(run.base.members.owner)

      const parsed = customTemplateSectionsSchema.safeParse(row.draft?.sections)
      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues.map((i) => i.message)).toEqual([
        'Field key "siteDrainage" is used by more than one field',
      ])

      await expect(
        run.owner.as.mutation(api.customTemplates.publish, {
          businessId: run.base.businessId,
          templateId: row._id,
        }),
      ).rejects.toThrow('INVALID_TEMPLATE')
    })

    test('each form resolves for a new report, with the business lists over it', async () => {
      const overrides = await run.t.run((ctx) =>
        loadOverrides(ctx, run.base.businessId),
      )
      for (const row of rows.templates) {
        const resolved = resolveReportTemplate({
          template: 'custom',
          customTemplate: row,
          optionSets: overrides,
        })
        expect(resolved.name).toBe(row.name)
        expect(resolved.schema.safeParse({}).success).toBe(false)
      }
      // The clone's product column now offers the business's own list.
      const clone = resolveReportTemplate({
        template: 'custom',
        customTemplate: template('serviceClone'),
        optionSets: overrides,
      })
      const grid = sectionsOf(clone)
        .flatMap((s) => s.fields)
        .find((f) => f.key === 'treatments')
      if (grid?.kind !== 'repeater') throw new Error('no treatment grid')
      const product = grid.columns.find((c) => c.key === 'product')
      expect(product && 'options' in product ? product.options : []).toEqual(
        overrides.products,
      )
    })
  })

  describe('option lists', () => {
    test('one row per list, and only the two the owner touched', () => {
      expect(rows.optionSets.map((r) => r.key).sort()).toEqual([
        'products',
        'treatments',
      ])
      for (const key of OPTION_SET_KEYS) {
        expect(
          rows.optionSets.filter((r) => r.key === key).length,
        ).toBeLessThanOrEqual(1)
      }
      for (const row of rows.optionSets) {
        expect(row.seedVersion).toBe(defaultOptionSet(row.key)?.version)
        expect(row.updatedByMembershipId).toBe(run.base.members.owner)
        for (const option of row.options) {
          expect(option.value).toBe(option.label)
          expect(option.value.length).toBeLessThanOrEqual(MAX_OPTION_LENGTH)
          // true or absent, never false.
          expect([true, undefined]).toContain(option.usual)
        }
        for (const option of row.archived ?? []) {
          expect(Object.keys(option).sort()).toEqual(['label', 'value'])
        }
        const ats = row.renames.map((r) => r.at)
        expect([...ats].sort((a, b) => a - b)).toEqual(ats)
        expect(new Set(row.options.map((o) => o.value)).size).toBe(
          row.options.length,
        )
      }
    })

    test('products: two added, three starred, one renamed, one archived', () => {
      const row = optionSet(rows, 'products')
      const defaults = defaultOptionSet('products')?.options ?? []
      const values = row.options.map((o) => o.value)

      expect(values).toEqual([
        ...defaults
          .map((o) => o.value)
          .filter((value) => value !== PRODUCT_CHANGES.archived)
          .map((value) =>
            value === PRODUCT_CHANGES.rename.from
              ? PRODUCT_CHANGES.rename.to
              : value,
          ),
        ...PRODUCT_CHANGES.added,
      ])
      expect(defaults.map((o) => o.value)).not.toContain(
        'Termidor HE (Fipronil 100 g/L)',
      )
      expect(LONG_PRODUCT).toHaveLength(MAX_OPTION_LENGTH)
      for (const mark of ['&', '/', 'µg', '(', ')', '[', ']']) {
        expect(LONG_PRODUCT).toContain(mark)
      }

      expect(row.options.filter((o) => o.usual).map((o) => o.value)).toEqual([
        PRODUCT_CHANGES.rename.to,
        'Ditrac All Weather Blox (0.05 g/kg Bromadiolone)',
        'Termidor HE (Fipronil 100 g/L)',
      ])
      expect(row.archived).toEqual([
        { value: PRODUCT_CHANGES.archived, label: PRODUCT_CHANGES.archived },
      ])
      expect(row.renames).toEqual([
        { ...PRODUCT_CHANGES.rename, at: when(-70, 8, 0) },
      ])
      expect(row.updatedAt).toBe(when(-40, 17, 20))
    })

    test('treatments: nine starred, which a picker caps at eight', () => {
      const row = optionSet(rows, 'treatments')
      expect(row.options.map((o) => o.value)).toEqual(
        defaultOptionSet('treatments')?.options.map((o) => o.value),
      )
      expect(row.options.filter((o) => o.usual).map((o) => o.value)).toEqual(
        USUAL_TREATMENTS,
      )
      expect(USUAL_TREATMENTS.length).toBeGreaterThan(MAX_USUAL)
      // setUsual touches nothing else.
      expect('archived' in row).toBe(false)
      expect(row.renames).toEqual([])
    })

    test('the owner’s editor opens, shows both kinds of list, and pins nothing', async () => {
      const lists = await run.owner.as.query(api.optionSets.editable, {
        businessId: run.base.businessId,
      })
      const byKey = new Map(lists.map((l) => [l.key, l]))
      expect(byKey.get('products')?.isDefault).toBe(false)
      expect(byKey.get('treatments')?.isDefault).toBe(false)
      expect(byKey.get('risks')?.isDefault).toBe(true)
      expect(byKey.get('nextVisit')?.isDefault).toBe(true)
      expect(lists.flatMap((l) => l.pinned)).toEqual([])
    })

    test('the audit trail: what the owner changed, when, and nothing more', () => {
      const products = optionSet(rows, 'products')
      const trail = rows.audit
        .filter((r) => r.action.startsWith('optionSet.'))
        .sort((a, b) => a.at - b.at)
      expect(trail.map((r) => [r.action, r.meta, r.at])).toEqual([
        [
          'optionSet.add',
          { key: 'products', value: PRODUCT_CHANGES.added[0] },
          when(-88, 9, 40),
        ],
        [
          'optionSet.add',
          { key: 'products', value: PRODUCT_CHANGES.added[1] },
          when(-88, 9, 43),
        ],
        [
          'optionSet.rename',
          { key: 'products', ...PRODUCT_CHANGES.rename },
          when(-70, 8, 0),
        ],
        [
          'optionSet.archive',
          { key: 'products', value: PRODUCT_CHANGES.archived },
          when(-40, 17, 20),
        ],
      ])
      for (const row of trail) {
        expect(row.entityType).toBe('optionSets')
        expect(row.entityId).toBe(products._id)
        expect(row.actorMembershipId).toBe(run.base.members.owner)
        expect('onBehalfOfMembershipId' in row).toBe(false)
      }
      // No drafts existed to rewrite.
      expect(
        rows.audit.filter((r) => r.action === 'report.optionRenamed'),
      ).toEqual([])
    })
  })

  describe('template settings', () => {
    test('one row each for two forms, none for the certificate', async () => {
      expect(rows.settings.map((r) => r.templateRef).sort()).toEqual([
        'serviceReport',
        'timberPestInspection',
      ])

      const read = await run.t.run(async (ctx) => ({
        service: await settingsFor(ctx, run.base.businessId, 'serviceReport'),
        timber: await settingsFor(
          ctx,
          run.base.businessId,
          'timberPestInspection',
        ),
        cert: await settingsFor(
          ctx,
          run.base.businessId,
          'termiteManagementCert',
        ),
      }))
      expect(read.service).toEqual({
        templateRef: 'serviceReport',
        print: {
          formName: 'Swan River Service Report',
          cover: {
            title: 'Swan River Service Report',
            subtitle: 'Pest Control · Perth metro',
          },
        },
        requiredSigners: ['technician'],
      })
      expect(read.timber).toEqual({
        templateRef: 'timberPestInspection',
        print: { formName: 'Timber Pest Inspection (Swan River)' },
        requiredSigners: [],
      })
      expect(read.cert).toBeNull()

      const resolved = resolveReportTemplate({
        template: 'serviceReport',
        templateVersion: 2,
        settings: read.service,
      })
      expect(resolved.print?.cover).toEqual({
        title: 'Swan River Service Report',
        subtitle: 'Pest Control · Perth metro',
      })
      expect(resolved.print?.formName).toBe('Swan River Service Report')

      const listed = await run.owner.as.query(api.templateSettings.list, {
        businessId: run.base.businessId,
      })
      expect(listed).toHaveLength(2)
    })
  })

  describe('phrases', () => {
    test('twelve on the service comments, two on a timber box, one on the bait check', () => {
      const count = (key: string) =>
        rows.snippets.filter((s) => s.fieldKey === key).length
      expect(count('comments')).toBe(MAX_SNIPPETS_PER_FIELD)
      expect(count('termiteWorkingsComments')).toBe(2)
      expect(count('activityNotes')).toBe(1)
      expect(rows.snippets).toHaveLength(PHRASES.length)

      // Each on a long-answer box of a form the demo offers.
      const areaKeys = new Set(
        [
          ...sectionsOf(getTemplate('serviceReport')),
          ...sectionsOf(getTemplate('timberPestInspection')),
          ...(template('baitStation').sections as Array<SectionDef>),
        ]
          .flatMap((s) => s.fields)
          .filter((f) => f.kind === 'area')
          .map((f) => f.key),
      )
      for (const row of rows.snippets) expect(areaKeys).toContain(row.fieldKey)
    })

    test('within the limits save enforces, and dated as used', () => {
      for (const row of rows.snippets) {
        expect(row.text).toBe(row.text.trim())
        expect(row.text.length).toBeGreaterThan(0)
        expect(row.text.length).toBeLessThanOrEqual(MAX_SNIPPET_LENGTH)
        const twins = rows.snippets.filter(
          (other) =>
            other.fieldKey === row.fieldKey &&
            sameSnippet(other.text, row.text),
        )
        expect(twins).toHaveLength(1)
        // `used` sets both or neither.
        expect(row.usedCount > 0).toBe(row.lastUsedAt !== undefined)
        if (row.lastUsedAt !== undefined) {
          expect(row.lastUsedAt).toBeGreaterThanOrEqual(row.createdAt)
          expect(row.lastUsedAt).toBeLessThan(Date.now())
        }
      }
      const texts = rows.snippets.map((s) => s.text)
      expect(LONG_PHRASE).toHaveLength(MAX_SNIPPET_LENGTH)
      expect(texts).toContain(LONG_PHRASE)
      expect(texts.some((t) => t.includes('\n'))).toBe(true)
      expect(
        texts.some(
          (t) => /\p{Extended_Pictographic}/u.test(t) && /[éà]/.test(t),
        ),
      ).toBe(true)
      expect(
        new Set(rows.snippets.map((s) => s.usedCount)).size,
      ).toBeGreaterThan(5)
    })

    test('one is the subcontractor’s: theirs to remove, and the owner’s', async () => {
      const theirs = rows.snippets.filter(
        (s) => s.createdByMembershipId === run.base.members.sub,
      )
      expect(theirs).toHaveLength(1)
      expect(
        rows.snippets.filter(
          (s) =>
            s.createdByMembershipId !== run.base.members.sub &&
            s.createdByMembershipId !== run.base.members.owner,
        ),
      ).toEqual([])

      const asSub = await run.sub.as.query(api.snippets.list, {
        businessId: run.base.businessId,
      })
      expect(asSub.filter((s) => s.canRemove).map((s) => s.id)).toEqual([
        theirs[0]._id,
      ])
      const asContractor = await run.contractor.as.query(api.snippets.list, {
        businessId: run.base.businessId,
      })
      expect(asContractor.some((s) => s.canRemove)).toBe(false)
      const asOwner = await run.owner.as.query(api.snippets.list, {
        businessId: run.base.businessId,
      })
      expect(asOwner.every((s) => s.canRemove)).toBe(true)
      expect(asOwner).toHaveLength(PHRASES.length)
    })

    test('the comments box is full: a thirteenth is refused, a repeat is the same phrase', async () => {
      const businessId = run.base.businessId
      await expect(
        run.owner.as.mutation(api.snippets.save, {
          businessId,
          fieldKey: 'comments',
          text: 'One phrase too many.',
        }),
      ).rejects.toThrow('TOO_MANY_SNIPPETS')

      const existing = rows.snippets.find((s) =>
        s.text.startsWith('Spider webs'),
      )
      const again = await run.owner.as.mutation(api.snippets.save, {
        businessId,
        fieldKey: 'comments',
        text: `  ${existing?.text.toUpperCase()}  `,
      })
      expect(again).toBe(existing?._id)
    })
  })

  describe("the subcontractor's pickers", () => {
    test('five recent products, one since archived, and a next visit', async () => {
      const sub = await run.t.run((ctx) => ctx.db.get(run.base.members.sub))
      const recent = sub?.reportPrefs?.recent ?? {}
      expect(Object.keys(recent).sort()).toEqual(['nextVisit', 'products'])
      expect(recent.products).toHaveLength(MAX_RECENT)
      expect(recent.products).toContain(PRODUCT_CHANGES.archived)
      expect(recent.nextVisit).toEqual(['3 Months'])
      expect(
        defaultOptionSet('nextVisit')?.options.map((o) => o.value),
      ).toContain('3 Months')

      // Everything else is still on offer, under its current name.
      const live = new Set(
        optionSet(rows, 'products').options.map((o) => o.value),
      )
      expect(recent.products.filter((p) => !live.has(p))).toEqual([
        PRODUCT_CHANGES.archived,
      ])

      const usual = await run.sub.as.query(api.optionSets.usual, {
        businessId: run.base.businessId,
      })
      expect(usual.products).toEqual([
        PRODUCT_CHANGES.rename.to,
        'Ditrac All Weather Blox (0.05 g/kg Bromadiolone)',
        'Termidor HE (Fipronil 100 g/L)',
        'Advion Cockroach Gel AEPMA (6g/kg Indoxacarb)',
        'Clear-Out Crawling Insect Aerosol (0.6 g/kg Fipronil)',
        PRODUCT_CHANGES.archived,
      ])
      expect(usual.treatments).toEqual(USUAL_TREATMENTS.slice(0, MAX_USUAL))
      expect(usual.nextVisit).toEqual(['3 Months'])
    })
  })

  test('all of it dated inside the last ninety days, none of it ahead', () => {
    const stamps = [
      ...rows.templates.flatMap((r) => [
        r.createdAt,
        r.updatedAt,
        r.publishedAt,
        r.archivedAt,
        r.draft?.savedAt,
      ]),
      ...rows.versions.map((r) => r.publishedAt),
      ...rows.settings.map((r) => r.updatedAt),
      ...rows.optionSets.flatMap((r) => [
        r.updatedAt,
        ...r.renames.map((n) => n.at),
      ]),
      ...rows.snippets.flatMap((r) => [r.createdAt, r.lastUsedAt]),
      ...rows.audit
        .filter((r) => r.action.startsWith('optionSet.'))
        .map((r) => r.at),
    ].filter((stamp): stamp is number => stamp !== undefined)

    const now = Date.now()
    for (const stamp of stamps) {
      expect(stamp).toBeGreaterThan(now - 91 * DAY)
      expect(stamp).toBeLessThan(now)
    }
  })

  /**
   * The same changes, made by the owner through the app's own mutations in a
   * business of their own. Every row the seed wrote should differ only in
   * ids and times.
   */
  test('the app’s own mutations leave the same rows', async () => {
    const { t, owner } = run
    const as = owner.as
    const { businessId } = await as.mutation(api.businesses.create, {
      name: 'Reference Pest',
      state: 'WA',
      timezone: 'Australia/Perth',
    })

    for (const label of PRODUCT_CHANGES.added) {
      await as.mutation(api.optionSets.addOption, {
        businessId,
        key: 'products',
        label,
      })
    }
    for (const settings of TEMPLATE_SETTINGS) {
      await as.mutation(api.templateSettings.set, { businessId, ...settings })
    }
    for (const value of USUAL_TREATMENTS) {
      await as.mutation(api.optionSets.setUsual, {
        businessId,
        key: 'treatments',
        value,
        usual: true,
      })
    }
    for (const value of PRODUCT_CHANGES.usual) {
      await as.mutation(api.optionSets.setUsual, {
        businessId,
        key: 'products',
        value,
        usual: true,
      })
    }
    const bait = await as.mutation(api.customTemplates.create, {
      businessId,
      ...BAIT_STATION,
    })
    const clone = await as.mutation(api.customTemplates.cloneBuiltin, {
      businessId,
      sourceTemplateId: 'serviceReport',
      name: SERVICE_CLONE.name,
    })
    await as.mutation(api.optionSets.renameOption, {
      businessId,
      key: 'products',
      ...PRODUCT_CHANGES.rename,
    })
    const possum = await as.mutation(api.customTemplates.create, {
      businessId,
      ...POSSUM,
    })
    const reissue = async (index: 0 | 1) => {
      const change = SERVICE_CLONE.issues[index]
      const row = await t.run((ctx) => ctx.db.get(clone))
      if (!row) throw new Error('clone vanished')
      await as.mutation(api.customTemplates.saveDraft, {
        businessId,
        templateId: clone,
        name: change.name,
        shortName: row.shortName,
        legalBasis: row.legalBasis,
        blurb: change.blurb ?? row.blurb,
        sections: withField(
          row.sections as Array<SectionDef>,
          change.after,
          change.field,
        ),
        boilerplate: row.boilerplate,
      })
      await as.mutation(api.customTemplates.publish, {
        businessId,
        templateId: clone,
      })
    }
    await reissue(0)
    await as.mutation(api.optionSets.archiveOption, {
      businessId,
      key: 'products',
      value: PRODUCT_CHANGES.archived,
    })
    const timber = await as.mutation(api.customTemplates.cloneBuiltin, {
      businessId,
      sourceTemplateId: 'timberPestInspection',
      name: TIMBER_VARIANT.name,
    })
    await reissue(1)
    await as.mutation(api.customTemplates.archive, {
      businessId,
      templateId: possum,
    })
    const timberRow = await t.run((ctx) => ctx.db.get(timber))
    if (!timberRow) throw new Error('timber clone vanished')
    await as.mutation(api.customTemplates.saveDraft, {
      businessId,
      templateId: timber,
      name: timberRow.name,
      shortName: timberRow.shortName,
      legalBasis: timberRow.legalBasis,
      blurb: timberRow.blurb,
      sections: withField(
        timberRow.sections as Array<SectionDef>,
        TIMBER_VARIANT.after,
        TIMBER_VARIANT.duplicate,
      ),
      boilerplate: timberRow.boilerplate,
    })
    await as.mutation(api.customTemplates.saveDraft, {
      businessId,
      templateId: bait,
      ...BAIT_STATION_REVISED,
    })
    // The owner stands in for the subcontractor: same phrases, same pickers.
    for (const phrase of PHRASES) {
      const id = await as.mutation(api.snippets.save, {
        businessId,
        fieldKey: phrase.fieldKey,
        text: phrase.text,
      })
      for (let i = 0; i < (phrase.used?.times ?? 0); i++) {
        await as.mutation(api.snippets.used, { businessId, snippetId: id })
      }
    }
    for (const pick of SUB_PICKS) {
      await as.mutation(api.optionSets.remember, { businessId, ...pick })
    }

    const app = await rowsOf(t, businessId)
    const refs = { bait, clone, possum, timber }
    const demoRefs = {
      bait: run.customTemplates.baitStation,
      clone: run.customTemplates.serviceClone,
      possum: run.customTemplates.possumArchived,
      timber: run.customTemplates.timberDraftInvalid,
    }

    // Ids, times and who: everything else must match.
    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(strip)
      if (value === null || typeof value !== 'object') return value
      const out: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(value)) {
        if (/^_|businessId$|MembershipId$|At$|^at$|^entityId$/.test(key)) {
          out[key] = typeof inner
          continue
        }
        out[key] = strip(inner)
      }
      return out
    }

    for (const name of ['bait', 'clone', 'possum', 'timber'] as const) {
      expect(strip(byId(rows.templates, demoRefs[name]))).toEqual(
        strip(byId(app.templates, refs[name])),
      )
      const history = (r: Rows, id: string) =>
        r.versions
          .filter((v) => v.templateId === id)
          .sort((a, b) => a.version - b.version)
          .map((v) => strip({ ...v, templateId: undefined }))
      expect(history(rows, demoRefs[name])).toEqual(history(app, refs[name]))
    }

    const lists = (r: Rows) =>
      [...r.optionSets].sort((a, b) => a.key.localeCompare(b.key)).map(strip)
    expect(lists(rows)).toEqual(lists(app))

    const settings = (r: Rows) =>
      [...r.settings]
        .sort((a, b) => a.templateRef.localeCompare(b.templateRef))
        .map(strip)
    expect(settings(rows)).toEqual(settings(app))

    const phrases = (r: Rows) =>
      [...r.snippets]
        .sort(
          (a, b) =>
            a.fieldKey.localeCompare(b.fieldKey) ||
            a.text.localeCompare(b.text),
        )
        .map(strip)
    expect(phrases(rows)).toEqual(phrases(app))

    const trail = (r: Rows) =>
      r.audit
        .filter((row) => row.action.startsWith('optionSet.'))
        .sort((a, b) => a.at - b.at)
        .map(strip)
    expect(trail(rows)).toEqual(trail(app))

    const refOwner = await t.run((ctx) =>
      ctx.db
        .query('memberships')
        .withIndex('by_user_business', (q) =>
          q.eq('userId', owner.userId).eq('businessId', businessId),
        )
        .unique(),
    )
    const demoSub = await t.run((ctx) => ctx.db.get(run.base.members.sub))
    expect(demoSub?.reportPrefs).toEqual(refOwner?.reportPrefs)

    // And the bait check's waiting edit really is publishable: version 2.
    await expect(
      as.mutation(api.customTemplates.publish, {
        businessId: run.base.businessId,
        templateId: run.customTemplates.baitStation,
      }),
    ).resolves.toEqual({ version: 2 })
  })
})
