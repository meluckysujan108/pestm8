import { describe, expect, test } from 'vitest'
import {
  CREATABLE_TEMPLATES,
  REPORT_TEMPLATES,
  RETIRED_TEMPLATES,
  fieldsOf,
  getTemplate,
  printedGalleryKeys,
  sectionRuns,
  sectionsOf,
  templateFor,
} from './index'
import { hashSnapshot, snapshotOf } from './snapshot'
import { resolveReportTemplate } from './resolve'
import { fieldPrints, isFlagged, toggleCheck, withLocked } from './choices'
import {
  applyOptionSets,
  boundPaths,
  pinnedValues,
  renameInData,
  resolveRename,
} from './optionSets'
import { customTemplateSectionsSchema } from './customTemplateSchema'
import type { FieldDef, TemplateId } from './types'

/**
 * The seam that lets the verbatim templates ship without changing a single
 * report written against the old wording.
 */

describe('v1 wording is frozen', () => {
  /**
   * The canonical hashes of the four v1 templates, as they already sit in
   * `reportTemplateSnapshots` on the dev deployment. Production's backfill
   * freezes from the same legacy modules and must mint these same rows, so any
   * edit that reaches the v1 wording — the legacy files, `shared.v1.ts`,
   * `sectionsOf()`, the snapshot shape — fails here first.
   */
  const DEV_HASHES: Record<TemplateId, string> = {
    serviceReport: '57e8f25a-28ad',
    timberPestInspection: 'eb029fc6-969',
    termiteManagementCert: 'a148f822-8a4',
    treatmentRecord: 'e0917a43-87a',
  }

  test.each(Object.entries(DEV_HASHES))('%s v1 hashes to the row already on dev', (id, hash) => {
    expect(hashSnapshot(snapshotOf(templateFor(id as TemplateId, 1)))).toBe(hash)
  })

  test('the rewritten forms are revision 2, and treatmentRecord stays at 1', () => {
    expect(getTemplate('serviceReport').version).toBe(2)
    expect(getTemplate('timberPestInspection').version).toBe(2)
    expect(getTemplate('termiteManagementCert').version).toBe(2)
    expect(getTemplate('treatmentRecord').version).toBe(1)
  })

  test('templateFor returns the revision asked for, and never throws', () => {
    expect(templateFor('serviceReport', 1).version).toBe(1)
    expect(templateFor('serviceReport', 2)).toBe(REPORT_TEMPLATES.serviceReport)
    expect(templateFor('serviceReport', undefined).version).toBe(1)
    expect(templateFor('serviceReport', 99)).toBe(REPORT_TEMPLATES.serviceReport)
  })
})

describe('a signed v1 report never inherits v2 content', () => {
  test.each(['serviceReport', 'timberPestInspection', 'termiteManagementCert'] as const)(
    '%s: the v1 snapshot resolves with no terms and no print spec',
    (id) => {
      const frozen = snapshotOf(templateFor(id, 1))
      const resolved = resolveReportTemplate({
        template: id,
        templateVersion: 1,
        templateSnapshot: frozen,
      })
      // Spreading the live module under the snapshot would hand a v1 document
      // the v2 warranty pages and header lines.
      expect(getTemplate(id).terms).toBeDefined()
      expect(resolved.terms).toBeUndefined()
      expect(resolved.print).toBeUndefined()
      expect(resolved.boilerplate).toBe(templateFor(id, 1).boilerplate)
      expect(resolved.version).toBe(1)
    },
  )

  test('the v1 schema, not the v2 one, validates a v1 snapshot', () => {
    const resolved = resolveReportTemplate({
      template: 'termiteManagementCert',
      templateSnapshot: snapshotOf(templateFor('termiteManagementCert', 1)),
    })
    expect(resolved.schema).toBe(templateFor('termiteManagementCert', 1).schema)
  })

  test('a v2 snapshot carries its terms and print spec', () => {
    const live = getTemplate('termiteManagementCert')
    const resolved = resolveReportTemplate({
      template: 'termiteManagementCert',
      templateVersion: 2,
      templateSnapshot: snapshotOf(live),
    })
    expect(resolved.terms).toEqual(live.terms)
    expect(resolved.print).toEqual(live.print)
  })

  test('the app-invented durable notice stays on v1 certificates only', async () => {
    const { printsDurableNotice } = await import('./index')
    expect(printsDurableNotice(templateFor('termiteManagementCert', 1))).toBe(true)
    expect(printsDurableNotice(getTemplate('termiteManagementCert'))).toBe(false)
  })
})

describe('retirement', () => {
  test('treatmentRecord renders but cannot be started', () => {
    expect(RETIRED_TEMPLATES.has('treatmentRecord')).toBe(true)
    expect(CREATABLE_TEMPLATES.map((t) => t.id)).toEqual(
      expect.not.arrayContaining(['treatmentRecord']),
    )
    expect(CREATABLE_TEMPLATES).toHaveLength(3)
  })
})

describe('the v2 templates are clonable', () => {
  test.each(CREATABLE_TEMPLATES.map((t) => [t.id, t] as const))(
    '%s sections survive the custom-template schema without losing a prop',
    (_id, template) => {
      const sections = sectionsOf(template)
      const parsed = customTemplateSectionsSchema.safeParse(sections)
      expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true)
      // Zod strips unknown keys and `customTemplates.update` stores the parsed
      // output: anything missing from the schema would vanish on first save.
      expect(parsed.success && parsed.data).toEqual(JSON.parse(JSON.stringify(sections)))
    },
  )
})

describe('checklist rules', () => {
  const field: Extract<FieldDef, { kind: 'checks' }> = {
    kind: 'checks',
    key: 'risks',
    label: 'Risks',
    options: ['Pool', 'Dogs', 'No Risk', 'Warranty'].map((v) => ({ value: v, label: v })),
    locked: ['Warranty'],
    exclusive: ['No Risk'],
  }

  test('locked items are always present and cannot be unticked', () => {
    expect(withLocked(field, [])).toEqual(['Warranty'])
    expect(toggleCheck(field, ['Warranty'], 'Warranty')).toEqual(['Warranty'])
  })

  test('an exclusive item clears the rest, and anything else clears it', () => {
    expect(toggleCheck(field, ['Pool', 'Dogs'], 'No Risk')).toEqual(['Warranty', 'No Risk'])
    expect(toggleCheck(field, ['No Risk'], 'Pool')).toEqual(['Warranty', 'Pool'])
  })

  test('flagged answers are recognised per kind', () => {
    expect(isFlagged({ ...field, flaggedValues: ['Dogs'] }, ['Dogs'])).toBe(true)
    expect(isFlagged({ kind: 'toggle', key: 't', label: 'T', flaggedValue: true }, true)).toBe(true)
    expect(isFlagged({ kind: 'toggle', key: 't', label: 'T', flaggedValue: true }, false)).toBe(false)
    expect(isFlagged({ kind: 'toggle', key: 't', label: 'T', flaggedValue: true }, undefined)).toBe(false)
  })
})

describe('what prints on the finished document', () => {
  const question: FieldDef = {
    kind: 'select',
    key: 'weepHoles',
    label: 'Weep Holes',
    options: ['Clear', 'Blocked'].map((v) => ({ value: v, label: v })),
    flaggedValues: ['Blocked'],
  }
  const guidance: FieldDef = {
    kind: 'note',
    key: 'weepGuidance',
    label: 'Weep hole guidance',
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Clear them.' }] }] },
    attachedTo: 'weepHoles',
    printed: 'whenFlagged',
  }
  const formOnly: FieldDef = { kind: 'toggle', key: 'sendCopy', label: 'Send copy?', printed: false }
  const all = [question, guidance, formOnly]

  test('guidance prints only when its question is flagged', () => {
    expect(fieldPrints(guidance, all, { weepHoles: 'Clear' })).toBe(false)
    expect(fieldPrints(guidance, all, { weepHoles: 'Blocked' })).toBe(true)
  })

  test('a form-only control never prints', () => {
    expect(fieldPrints(formOnly, all, { sendCopy: true })).toBe(false)
  })

  test('the document walk drops them; the builder walk keeps them', () => {
    const doc = sectionRuns(all, { allFields: all, data: { weepHoles: 'Clear' } })
    expect(doc.flatMap((r) => (r.type === 'fields' ? r.fields.map((f) => f.key) : [r.field.key]))).toEqual(['weepHoles'])
    expect(sectionRuns(all)).toHaveLength(3)
  })

  test('a broken reference prints rather than silently deleting advice', () => {
    expect(fieldPrints({ ...guidance, attachedTo: 'gone' }, all, {})).toBe(true)
  })
})

describe('option libraries', () => {
  const service = getTemplate('serviceReport')

  test('the service report draws its product list from a business vocabulary', () => {
    const paths = boundPaths(sectionsOf(service), 'products')
    expect(paths.cells.length + paths.top.length).toBeGreaterThan(0)
  })

  test('a business list replaces the defaults, and only where bound', () => {
    const overlaid = applyOptionSets(service, {
      products: [{ value: 'Our Own Product', label: 'Our Own Product' }],
    })
    const productOptions = fieldsOf(overlaid)
      .flatMap((f) => (f.kind === 'repeater' ? f.columns : [f]))
      .filter((f) => 'optionsFrom' in f && f.optionsFrom === 'products')
      .map((f) => ('options' in f ? f.options.map((o) => o.value) : []))
    expect(productOptions.length).toBeGreaterThan(0)
    for (const options of productOptions) expect(options).toEqual(['Our Own Product'])
  })

  test('no overrides returns the very same template', () => {
    expect(applyOptionSets(service, {})).toBe(service)
    expect(applyOptionSets(service, null)).toBe(service)
  })

  test('a snapshot is never overlaid', () => {
    const frozen = snapshotOf(service)
    const resolved = resolveReportTemplate({
      template: 'serviceReport',
      templateVersion: 2,
      templateSnapshot: frozen,
      optionSets: { products: [{ value: 'Changed Later', label: 'Changed Later' }] },
    })
    expect(JSON.stringify(resolved.sections)).not.toContain('Changed Later')
  })

  test('every built-in schema accepts an answer the business added', () => {
    // A hand-written `z.enum(defaults)` would reject a business's own product
    // at the finalise gate.
    for (const template of CREATABLE_TEMPLATES) {
      for (const field of fieldsOf(template)) {
        if (!('optionsFrom' in field) || !field.optionsFrom) continue
        const value = field.kind === 'checks' || field.kind === 'chips' ? ['A Product We Added'] : 'A Product We Added'
        const shape = (template.schema as unknown as { shape?: Record<string, { safeParse: (v: unknown) => { success: boolean } }> }).shape
        const fieldSchema = shape?.[field.key]
        if (!fieldSchema) continue
        expect(fieldSchema.safeParse(value).success, `${template.id}.${field.key}`).toBe(true)
      }
    }
  })

  test('renaming rewrites top-level answers and repeater cells, de-duplicated', () => {
    const paths = { top: ['risks'], cells: [{ repeater: 'treatments', cell: 'product' }] }
    const { data, changed } = renameInData(
      {
        risks: ['A', 'B'],
        treatments: [{ _id: 'r1', product: ['A', 'B'] }, { _id: 'r2', product: ['C'] }],
      },
      paths,
      'A',
      'B',
    )
    expect(changed).toBe(true)
    expect(data.risks).toEqual(['B'])
    expect(data.treatments).toEqual([
      { _id: 'r1', product: ['B'] },
      { _id: 'r2', product: ['C'] },
    ])
  })

  test('renaming nothing reports no change', () => {
    const input = { risks: ['X'] }
    const result = renameInData(input, { top: ['risks'], cells: [] }, 'A', 'B')
    expect(result.changed).toBe(false)
    expect(result.data).toBe(input)
  })

  test('out-of-order rename jobs converge, and an undo returns home', () => {
    const log = [
      { from: 'A', to: 'B', at: 1 },
      { from: 'B', to: 'C', at: 2 },
    ]
    expect(resolveRename(log, 'A', 1)).toBe('C')
    expect(resolveRename([{ from: 'A', to: 'B', at: 1 }, { from: 'B', to: 'A', at: 2 }], 'A', 1)).toBe('A')
  })

  test('strings a template matches by value cannot be renamed', () => {
    const sections = sectionsOf(service)
    for (const field of fieldsOf(service)) {
      if (field.kind !== 'checks' || !field.optionsFrom) continue
      for (const value of [...(field.exclusive ?? []), ...(field.locked ?? []), ...(field.flaggedValues ?? [])]) {
        expect(pinnedValues(sections, field.optionsFrom).has(value)).toBe(true)
      }
    }
  })
})

describe('which photos may print', () => {
  test('a gallery hidden by its question prints nothing', () => {
    const cert = getTemplate('termiteManagementCert')
    const shown = printedGalleryKeys(sectionsOf(cert), { durableNoticeFitted: 'Yes' })
    const hidden = printedGalleryKeys(sectionsOf(cert), { durableNoticeFitted: 'No' })
    expect(shown.has('durableNoticePhoto')).toBe(true)
    // A certificate that says No must not also show the notice.
    expect(hidden.has('durableNoticePhoto')).toBe(false)
  })

  test("the Service Report's photos print only while Add Photos? is Yes", () => {
    const service = getTemplate('serviceReport')
    expect(printedGalleryKeys(sectionsOf(service), { addPhotos: true }).has('photos')).toBe(true)
    expect(printedGalleryKeys(sectionsOf(service), { addPhotos: false }).has('photos')).toBe(false)
    // The cover field is not conditional, so it prints either way.
    expect(printedGalleryKeys(sectionsOf(service), {}).has('coverPhoto')).toBe(true)
  })

  test('a verbatim form prints each photo set inside its own section', () => {
    const timber = getTemplate('timberPestInspection')
    const runs = sectionsOf(timber).flatMap((section) =>
      sectionRuns(section.fields, { allFields: fieldsOf(timber), data: {}, inlineGalleries: true }),
    )
    const galleries = runs.flatMap((r) => (r.type === 'gallery' ? [r.field.key] : []))
    // In document order, where the form puts them — the borer photos under Wood
    // Borers, not gathered at the end under five identical "Photos" headings.
    expect(galleries.indexOf('borersPhotos')).toBeLessThan(galleries.indexOf('fungalDecayPhotos'))
    expect(galleries.indexOf('termiteWorkingsPhotos')).toBeLessThan(galleries.indexOf('borersPhotos'))
  })
})

describe('empty treatment rows', () => {
  test('an empty row prints nothing, and a table of only empty rows is unanswered', async () => {
    const { present } = await import('./present')
    const treatments = fieldsOf(getTemplate('serviceReport')).find((f) => f.key === 'treatments')!
    expect(present(treatments, [{ _id: 'r1' }, { _id: 'r2', treatment: [], product: [] }]).kind).toBe('blank')
    const shown = present(treatments, [
      { _id: 'r1' },
      { _id: 'r2', treatment: ['General Pest Control'], product: [], quantity: [], method: [] },
    ])
    expect(shown.kind === 'grid' && shown.rows.length).toBe(1)
  })
})
