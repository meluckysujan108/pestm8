import { describe, expect, test } from 'vitest'
import {
  REPORT_TEMPLATES,
  isDataField,
  printHeadingOf,
  sectionRuns,
  sectionsOf,
  templateFor,
} from './index'
import { canonicalise, hashSnapshot, snapshotOf } from './snapshot'
import { customTemplateSectionsSchema } from './customTemplateSchema'
import { present } from './present'
import { resolveReportTemplate } from './resolve'
import { deriveGenericSchema } from './deriveSchema'
import { pruneHidden } from './visibility'
import { coverPhotoOf } from './cover'
import type { FieldDef, ReportTemplate, SectionDef } from './types'

/**
 * The engine's new vocabulary, and the guarantee the whole phase rests on: a
 * finalised report renders from its own frozen wording, not from whatever the
 * template modules say today.
 */

const NOTE: FieldDef = {
  kind: 'note',
  key: 'warranty_preamble',
  label: 'Warranty preamble',
  body: {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Terms apply.' }] },
    ],
  },
}

const HEADING: FieldDef = {
  kind: 'heading',
  key: 'wood_borers',
  label: 'Wood borers group',
  text: 'Wood Borers',
}

describe('canonicalise', () => {
  test('is independent of key order, so a module literal and a Convex read hash alike', () => {
    const fromModule = { name: 'A', shortName: 'B', sections: [{ title: 'T', fields: [] }] }
    const fromConvex = { sections: [{ fields: [], title: 'T' }], shortName: 'B', name: 'A' }
    expect(canonicalise(fromModule)).toBe(canonicalise(fromConvex))
  })

  test('treats an absent key and an undefined one as the same, as a round trip does', () => {
    expect(canonicalise({ a: 1 })).toBe(canonicalise({ a: 1, b: undefined }))
  })

  test('is total — a value it cannot serialise never throws', () => {
    expect(() => canonicalise({ fn: () => 1, nan: NaN })).not.toThrow()
  })
})

describe('snapshotOf', () => {
  test.each(Object.values(REPORT_TEMPLATES).map((t) => [t.id, t] as const))(
    '%s freezes the normalised sections, including the synthetic Details wrapper both painters print',
    (_id, template) => {
      const content = snapshotOf(template)
      expect(content.sections).toEqual(sectionsOf(template))
      expect(content.version).toBe(template.version)
    },
  )

  test('identical content hashes identically; a changed word does not', () => {
    const a = snapshotOf(REPORT_TEMPLATES.serviceReport)
    const b = snapshotOf(REPORT_TEMPLATES.serviceReport)
    expect(hashSnapshot(a)).toBe(hashSnapshot(b))
    expect(hashSnapshot({ ...a, name: `${a.name} ` })).not.toBe(hashSnapshot(a))
  })

  test('the four built-ins are four distinct rows, not one', () => {
    const hashes = Object.values(REPORT_TEMPLATES).map((t) =>
      hashSnapshot(snapshotOf(t)),
    )
    expect(new Set(hashes).size).toBe(hashes.length)
  })
})

describe('resolveReportTemplate with a snapshot', () => {
  const builtin = REPORT_TEMPLATES.termiteManagementCert

  test('a built-in draft at the current revision resolves to the live module', () => {
    expect(
      resolveReportTemplate({
        template: 'termiteManagementCert',
        templateVersion: builtin.version,
      }),
    ).toBe(builtin)
  })

  test('a report with no revision was written against v1, and resolves to v1', () => {
    // Absent means 1: every report created before revisions existed.
    expect(resolveReportTemplate({ template: 'termiteManagementCert' })).toBe(
      templateFor('termiteManagementCert', 1),
    )
  })

  test('a snapshot overrides the printed wording', () => {
    const frozen = {
      ...snapshotOf(builtin),
      name: 'Certificate as it read in 2026',
      boilerplate: 'The terms that were issued.',
    }
    const resolved = resolveReportTemplate({
      template: 'termiteManagementCert',
      templateSnapshot: frozen,
    })
    expect(resolved.name).toBe('Certificate as it read in 2026')
    expect(resolved.boilerplate).toBe('The terms that were issued.')
  })

  test('keeps the real template id, so the durable-notice branches still fire', () => {
    const resolved = resolveReportTemplate({
      template: 'termiteManagementCert',
      templateSnapshot: snapshotOf(builtin),
    })
    expect(resolved.id).toBe('termiteManagementCert')
  })

  test('keeps the module Zod schema, which JSON sections cannot reconstruct', () => {
    const resolved = resolveReportTemplate({
      template: 'termiteManagementCert',
      templateSnapshot: snapshotOf(builtin),
    })
    expect(resolved.schema).toBe(builtin.schema)
  })

  test('empties `fields` so a snapshot cannot silently fall through to live wording', () => {
    const frozen = snapshotOf(builtin)
    frozen.sections = [{ title: 'Frozen', fields: [] }]
    const resolved = resolveReportTemplate({
      template: 'termiteManagementCert',
      templateSnapshot: frozen,
    })
    expect(sectionsOf(resolved)).toEqual([{ title: 'Frozen', fields: [] }])
  })

  test('a missing snapshot never throws — an unmigrated report must still open', () => {
    expect(() =>
      resolveReportTemplate({
        template: 'serviceReport',
        templateSnapshot: null,
      }),
    ).not.toThrow()
  })
})

describe('isDataField', () => {
  test('static blocks and record-bound facts hold no answer', () => {
    expect(isDataField(NOTE)).toBe(false)
    expect(isDataField(HEADING)).toBe(false)
    expect(
      isDataField({ kind: 'derived', key: 'c', label: 'Client', source: 'client.name' }),
    ).toBe(false)
    expect(isDataField({ kind: 'cover', key: 'cp', label: 'Front photo' })).toBe(false)
  })

  test('signature and member do — their answers live in `data`', () => {
    expect(
      isDataField({ kind: 'signature', key: 's', label: 'Sign', slot: 's', role: 'technician' }),
    ).toBe(true)
    expect(isDataField({ kind: 'member', key: 'm', label: 'Technician' })).toBe(true)
  })
})

describe('present', () => {
  test('a note never reads as an unanswered field', () => {
    // The failure this guards: `isBlank` runs before the kind switch, so a
    // block with no stored value would come back `blank` and both painters
    // would print "Warranty preamble —" on a signed document.
    const shown = present(NOTE, undefined)
    expect(shown.kind).toBe('rich')
  })

  test('a heading prints its own text, not its editor-only label', () => {
    const shown = present(HEADING, undefined)
    expect(shown).toEqual({ kind: 'text', text: 'Wood Borers' })
  })

  test('a cover photo is omitted from the field table — it has a page', () => {
    expect(present({ kind: 'cover', key: 'cp', label: 'Front photo' }, undefined)).toEqual({
      kind: 'omit',
    })
  })

  test('a derived field reads the record, never `data`', () => {
    const field: FieldDef = {
      kind: 'derived',
      key: 'client_name',
      label: 'Client Name',
      source: 'client.name',
    }
    expect(present(field, 'ignored', { client: { name: 'J. Sample' } })).toEqual({
      kind: 'text',
      text: 'J. Sample',
    })
  })

  test('a derived field with nothing behind it prints blank, never a guess', () => {
    const field: FieldDef = {
      kind: 'derived',
      key: 'abn',
      label: 'ABN',
      source: 'business.abn',
    }
    expect(present(field, undefined, { business: {} })).toEqual({ kind: 'blank' })
  })

  test('a member prints the roster name, and never a raw membership id', () => {
    const field: FieldDef = { kind: 'member', key: 'tech', label: "Technician's Name" }
    expect(present(field, 'm1', { roster: { m1: 'K. Edgar (Licence 4132)' } })).toEqual({
      kind: 'text',
      text: 'K. Edgar (Licence 4132)',
    })
    // A Convex id on a signed document is worse than an unanswered row.
    expect(present(field, 'm1')).toEqual({ kind: 'blank' })
  })

  test('emails join, and an empty list reads as unanswered', () => {
    const field: FieldDef = { kind: 'emails', key: 'to', label: 'Email Report To' }
    expect(present(field, ['a@example.com', 'b@example.com'])).toEqual({
      kind: 'text',
      text: 'a@example.com, b@example.com',
    })
    expect(present(field, []).kind).toBe('blank')
  })

  test('GPS keeps its single joined line unless a template asks for stacked', () => {
    const value = { lat: -32.25, lng: 115.79, at: 0 }
    expect(present({ kind: 'gps', key: 'g', label: 'GPS' }, value)).toEqual({
      kind: 'text',
      text: '-32.250000, 115.790000',
    })
    expect(
      present({ kind: 'gps', key: 'g', label: 'GPS', format: 'lines' }, value),
    ).toEqual({ kind: 'lines', lines: ['Lat: -32.250000', 'Lng: 115.790000'] })
  })
})

describe('static blocks are excluded from data handling', () => {
  const sections: Array<SectionDef> = [
    {
      title: 'Findings',
      fields: [
        NOTE,
        { kind: 'text', key: 'comments', label: 'Comments' },
        { ...HEADING, required: true },
      ],
    },
  ]

  test('a required static block cannot make a report unfinalisable', () => {
    // Tick "Required" on a heading and a naive validator demands a value for a
    // key no control can fill — the report can never be locked, and the error
    // points at nothing.
    const result = deriveGenericSchema(sections).safeParse({ comments: 'ok' })
    expect(result.success).toBe(true)
  })

  test('pruneHidden never treats a block key as an address into `data`', () => {
    const pruned = pruneHidden(sections, {
      comments: 'ok',
      warranty_preamble: 'a value from an older template version',
    })
    expect(pruned.warranty_preamble).toBe('a value from an older template version')
  })
})

describe('sectionRuns', () => {
  test('keeps document order, so a clause stays between the questions it sits between', () => {
    const runs = sectionRuns([
      { kind: 'text', key: 'a', label: 'A' },
      NOTE,
      { kind: 'text', key: 'b', label: 'B' },
    ])
    expect(runs.map((r) => r.type)).toEqual(['fields', 'block', 'fields'])
  })

  test('groups consecutive answers into one card rather than one card each', () => {
    const runs = sectionRuns([
      { kind: 'text', key: 'a', label: 'A' },
      { kind: 'text', key: 'b', label: 'B' },
    ])
    expect(runs).toHaveLength(1)
  })
})

describe('printHeadingOf', () => {
  const base: SectionDef = { title: 'Risk Assessment', fields: [] }

  test('falls back to the section title', () => {
    expect(printHeadingOf(base)).toBe('Risk Assessment')
  })

  test('an override replaces it', () => {
    expect(printHeadingOf({ ...base, print: { heading: 'Risks' } })).toBe('Risks')
  })

  test('an explicit null suppresses it, and is not the same as an absent key', () => {
    expect(printHeadingOf({ ...base, print: { heading: null } })).toBeNull()
    // `print: {}` carries no override, so the title still prints. Read with
    // `??` these two would be indistinguishable.
    expect(printHeadingOf({ ...base, print: {} })).toBe('Risk Assessment')
  })
})

describe('coverPhotoOf', () => {
  const template = {
    ...REPORT_TEMPLATES.serviceReport,
    fields: [],
    sections: [
      {
        title: 'Cover',
        fields: [{ kind: 'cover', key: 'coverPhoto', label: 'Front photo' }],
      },
    ],
  } satisfies ReportTemplate

  test('resolves by field kind and order, never the isCover flag', () => {
    // The flag is only writable through a star button the gallery hides at one
    // photo, so the declared front-page photo could never set it.
    const photos = [
      { fieldKey: 'coverPhoto', order: 1, isCover: false, url: 'b' },
      { fieldKey: 'coverPhoto', order: 0, isCover: false, url: 'a' },
      { fieldKey: 'photos', order: 0, isCover: true, url: 'c' },
    ]
    expect(coverPhotoOf(template, photos)?.url).toBe('a')
  })

  test('a template with no cover field has no cover page', () => {
    // The v1 service report declared its front photo as a gallery.
    expect(
      coverPhotoOf(templateFor('serviceReport', 1), [
        { fieldKey: 'coverPhoto', order: 0, isCover: true, url: 'a' },
      ]),
    ).toBeUndefined()
  })
})

describe('customTemplateSectionsSchema', () => {
  test.each(Object.values(REPORT_TEMPLATES).map((t) => [t.id, t] as const))(
    '%s can be cloned into a custom template and saved again',
    (_id, template) => {
      // `cloneBuiltin` writes `sectionsOf(source)` without validating, but the
      // owner's very next autosave revalidates. A built-in this schema rejects
      // becomes a template that clones fine and is then permanently unsaveable,
      // surfacing as "check your connection".
      const parsed = customTemplateSectionsSchema.safeParse(sectionsOf(template))
      expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true)
    },
  )

  test('accepts the new kinds', () => {
    const parsed = customTemplateSectionsSchema.safeParse([
      { title: 'Findings', fields: [NOTE, HEADING] },
    ])
    expect(parsed.success).toBe(true)
  })

  test('keeps `print` instead of stripping it', () => {
    // Zod drops unknown keys and `customTemplates.update` stores the parsed
    // output, so a prop missing from this schema is deleted from every custom
    // template on the next keystroke.
    const parsed = customTemplateSectionsSchema.safeParse([
      { title: 'Terms', print: { heading: null }, fields: [NOTE] },
    ])
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data[0].print).toEqual({ heading: null })
  })
})
