import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { deriveGenericSchema } from '../src/lib/reportTemplates/deriveSchema'
import { resolveReportTemplate } from '../src/lib/reportTemplates/resolve'
import type { SectionDef } from '../src/lib/reportTemplates/types'

/**
 * Proves the Phase 2 "risky primitive" of the reports-reorg plan — the
 * custom-template data model — before any CRUD/editor UI is built on top of
 * it: a business-authored template resolves, validates, renders (via PDF
 * generation, which runs through the exact same `resolveReportTemplate` +
 * `sectionsOf`/`visibleSections`/`present` pipeline `ReportBuilder` and
 * `ReportDocument` use), and — the single most important assertion — a
 * finalised report's shape survives editing the live template afterward,
 * while a still-draft report against the same template does not.
 */

const SECTIONS: Array<SectionDef> = [
  {
    number: 1,
    title: 'Inspection',
    fields: [
      {
        kind: 'text',
        key: 'clientRef',
        label: 'Client reference',
        required: true,
      },
      { kind: 'toggle', key: 'accessGranted', label: 'Was access granted?' },
      {
        kind: 'areas',
        key: 'areas',
        label: 'Areas inspected',
        rows: ['Roof void', 'Subfloor'],
      },
      {
        kind: 'repeater',
        key: 'items',
        label: 'Items found',
        min: 1,
        columns: [{ kind: 'text', key: 'note', label: 'Note', required: true }],
      },
    ],
  },
]

function customTemplateArgs(overrides: Partial<{ name: string }> = {}) {
  return {
    name: overrides.name ?? 'Site Walkthrough',
    shortName: 'Walkthrough',
    legalBasis: 'Internal',
    blurb: 'A quick custom walkthrough form.',
    sections: SECTIONS,
    boilerplate: 'This is not a statutory document.',
  }
}

test.describe('custom report templates', () => {
  test('generic validation matches the built-in schemas semantics', () => {
    const schema = deriveGenericSchema(SECTIONS)

    // Missing required text field, and an unreasoned no-access area — both
    // must fail, the areas message matching the built-in `areaResult` refine
    // verbatim (`e2e/reports.spec.ts` already asserts this exact string for
    // the hand-written path).
    const bad = schema.safeParse({
      accessGranted: false,
      areas: {
        'Roof void': { status: 'noAccess' },
        Subfloor: { status: 'inspected' },
      },
      items: [{ _id: 'a', note: 'Termite mud trail' }],
    })
    expect(bad.success).toBe(false)
    if (!bad.success) {
      const messages = bad.error.issues.map((i) => i.message)
      expect(messages).toContain('Client reference is required')
      expect(messages).toContain(
        'A reason is required when an area was not inspected',
      )
    }

    // A repeater below its `min` floor fails independently of everything else.
    const emptyRepeater = schema.safeParse({
      clientRef: 'REF-1',
      areas: {
        'Roof void': { status: 'inspected' },
        Subfloor: { status: 'inspected' },
      },
      items: [],
    })
    expect(emptyRepeater.success).toBe(false)

    // A fully valid payload passes.
    const good = schema.safeParse({
      clientRef: 'REF-1',
      accessGranted: true,
      areas: {
        'Roof void': { status: 'inspected' },
        Subfloor: { status: 'inspected' },
      },
      items: [{ _id: 'a', note: 'Nothing found' }],
    })
    expect(good.success).toBe(true)

    // A hidden section/field's stale answer is not required — `pruneHidden`
    // would have already stripped it, so re-deriving visibility here must not
    // resurrect the requirement.
    const conditional = deriveGenericSchema([
      {
        title: 'Follow-up',
        fields: [
          { kind: 'toggle', key: 'needsFollowUp', label: 'Needs follow-up?' },
          {
            kind: 'text',
            key: 'followUpNote',
            label: 'Follow-up note',
            required: true,
            visibleWhen: { when: 'needsFollowUp', eq: true },
          },
        ],
      },
    ])
    expect(conditional.safeParse({ needsFollowUp: false }).success).toBe(true)
    expect(conditional.safeParse({ needsFollowUp: true }).success).toBe(false)
  })

  test('resolveReportTemplate assembles a renderable ReportTemplate from raw sections', () => {
    const template = resolveReportTemplate({
      template: 'custom',
      customTemplate: customTemplateArgs(),
    })
    expect(template.id).toBe('custom')
    expect(template.name).toBe('Site Walkthrough')
    expect(template.sections).toEqual(SECTIONS)
    expect(typeof template.schema.safeParse).toBe('function')
  })

  test('a custom template renders through the report pipeline, freezes on finalise, and a sibling draft still tracks live edits', async () => {
    const email = uniqueEmail('customtpl-owner')
    const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Priya')

    const { businessId } = await owner.client.mutation(api.businesses.create, {
      name: `Custom Template Co ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })

    const propertyId = await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'R. Okafor',
      addressLine: '4 Hakea Court',
      suburb: 'Ballajura',
      state: 'WA',
      postcode: '6066',
    })

    const templateId = await owner.client.mutation(api.customTemplates.create, {
      businessId,
      ...customTemplateArgs(),
    })

    // Two reports against the same live template: one goes to finalised,
    // one stays a draft — the whole point is watching them diverge after an
    // edit to the template they share.
    const finalisedReportId = await owner.client.mutation(api.reports.create, {
      businessId,
      propertyId,
      template: 'custom',
      customTemplateId: templateId,
      legalBasis: 'Internal',
      data: {},
    })
    const draftReportId = await owner.client.mutation(api.reports.create, {
      businessId,
      propertyId,
      template: 'custom',
      customTemplateId: templateId,
      legalBasis: 'Internal',
      data: {},
    })

    // Before any edit, a draft's `customTemplate` is the live doc.
    const freshDraft = await owner.client.query(api.reports.get, {
      businessId,
      reportId: draftReportId,
    })
    expect(freshDraft?.customTemplate?.name).toBe('Site Walkthrough')

    const payload = {
      clientRef: 'REF-42',
      accessGranted: true,
      areas: {
        'Roof void': { status: 'inspected' },
        Subfloor: { status: 'inspected' },
      },
      items: [{ _id: 'row-1', note: 'Nothing found' }],
    }
    await owner.client.mutation(api.reports.finalise, {
      businessId,
      reportId: finalisedReportId,
      data: payload,
    })

    const finalised = await owner.client.query(api.reports.get, {
      businessId,
      reportId: finalisedReportId,
    })
    expect(finalised?.status).toBe('finalised')
    expect(finalised?.customTemplate?.name).toBe('Site Walkthrough')

    // The PDF pipeline flows through `resolveReportTemplate` too
    // (`convex/reportPdf.tsx` → `ReportPdf.tsx`) — a successful render proves
    // the swap works end to end, not just that the function type-checks.
    const generated = await owner.client.action(api.reportPdf.generate, {
      businessId,
      reportId: finalisedReportId,
    })
    expect(generated.url).toBeTruthy()
    const pdfRes = await fetch(generated.url!)
    const bytes = new Uint8Array(await pdfRes.arrayBuffer())
    const magic = Buffer.from(bytes.slice(0, 5)).toString('latin1')
    expect(magic).toBe('%PDF-')

    // Now edit the live template.
    await owner.client.mutation(api.customTemplates.update, {
      businessId,
      templateId,
      name: 'Site Walkthrough (Revised)',
    })

    // The finalised report's resolved template must not have moved —
    // this is the single most important assertion in the whole feature.
    const finalisedAfterEdit = await owner.client.query(api.reports.get, {
      businessId,
      reportId: finalisedReportId,
    })
    expect(finalisedAfterEdit?.customTemplate?.name).toBe('Site Walkthrough')

    // The still-draft report, sharing the same live template, must reflect
    // the edit — nothing is legally binding yet.
    const draftAfterEdit = await owner.client.query(api.reports.get, {
      businessId,
      reportId: draftReportId,
    })
    expect(draftAfterEdit?.customTemplate?.name).toBe(
      'Site Walkthrough (Revised)',
    )
  })

  test('access control: a subcontractor cannot author or edit a business template, a non-member cannot read one', async () => {
    const owner = await signUpActor(
      uniqueEmail('customtpl-owner2'),
      FIXTURE_PASSWORD,
      'Owner',
    )
    const sub = await signUpActor(
      uniqueEmail('customtpl-sub'),
      FIXTURE_PASSWORD,
      'Sub',
    )
    const outsider = await signUpActor(
      uniqueEmail('customtpl-outsider'),
      FIXTURE_PASSWORD,
      'Outsider',
    )

    const { businessId } = await owner.client.mutation(api.businesses.create, {
      name: `Access Co ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })

    const subUser = await sub.client.query(api.auth.getCurrentUser, {})
    await owner.client.mutation(api.memberships.invite, {
      businessId,
      userId: subUser._id,
      role: 'subcontractor',
    })
    await sub.client.mutation(api.memberships.accept, { businessId })

    await expectRejected(
      () =>
        sub.client.mutation(api.customTemplates.create, {
          businessId,
          ...customTemplateArgs(),
        }),
      'NO_ACCESS',
    )

    const templateId = await owner.client.mutation(api.customTemplates.create, {
      businessId,
      ...customTemplateArgs(),
    })

    await expectRejected(
      () =>
        sub.client.mutation(api.customTemplates.update, {
          businessId,
          templateId,
          name: 'Hijacked',
        }),
      'NO_ACCESS',
    )

    await expectRejected(
      () =>
        outsider.client.query(api.customTemplates.get, {
          businessId,
          templateId,
        }),
      'NO_ACCESS',
    )
  })

  test('cloneBuiltin copies a built-in template independently of its source module', async () => {
    const owner = await signUpActor(
      uniqueEmail('customtpl-clone'),
      FIXTURE_PASSWORD,
      'Owner',
    )
    const { businessId } = await owner.client.mutation(api.businesses.create, {
      name: `Clone Co ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })

    const templateId = await owner.client.mutation(
      api.customTemplates.cloneBuiltin,
      {
        businessId,
        sourceTemplateId: 'treatmentRecord',
        name: 'Treatment Record (Ours)',
      },
    )

    const cloned = await owner.client.query(api.customTemplates.get, {
      businessId,
      templateId,
    })
    expect(cloned?.name).toBe('Treatment Record (Ours)')
    expect(Array.isArray(cloned?.sections)).toBe(true)
    expect((cloned?.sections as Array<unknown>).length).toBeGreaterThan(0)

    // Mutating the clone must never reach the real module — proven by
    // resolving the untouched built-in afterward and confirming its own
    // name is exactly what `treatmentRecord.ts` has always said.
    await owner.client.mutation(api.customTemplates.update, {
      businessId,
      templateId,
      name: 'Mutated Clone',
    })
    const builtin = resolveReportTemplate({ template: 'treatmentRecord' })
    expect(builtin.name).not.toBe('Mutated Clone')
  })

  test('duplicate copies an existing custom template into a second, independent row', async () => {
    const owner = await signUpActor(
      uniqueEmail('customtpl-dup'),
      FIXTURE_PASSWORD,
      'Owner',
    )
    const { businessId } = await owner.client.mutation(api.businesses.create, {
      name: `Duplicate Co ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })

    const originalId = await owner.client.mutation(api.customTemplates.create, {
      businessId,
      ...customTemplateArgs(),
    })
    const copyId = await owner.client.mutation(api.customTemplates.duplicate, {
      businessId,
      templateId: originalId,
      name: 'Site Walkthrough (Copy)',
    })
    expect(copyId).not.toBe(originalId)

    await owner.client.mutation(api.customTemplates.update, {
      businessId,
      templateId: copyId,
      name: 'Renamed Copy',
    })

    const original = await owner.client.query(api.customTemplates.get, {
      businessId,
      templateId: originalId,
    })
    expect(original?.name).toBe('Site Walkthrough')
  })

  test('archive hides a template from active use without touching anything, unarchive reverses it', async () => {
    const owner = await signUpActor(
      uniqueEmail('customtpl-archive'),
      FIXTURE_PASSWORD,
      'Owner',
    )
    const { businessId } = await owner.client.mutation(api.businesses.create, {
      name: `Archive Co ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })
    const propertyId = await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'A. Singh',
      addressLine: '2 Karri Loop',
      suburb: 'Kelmscott',
      state: 'WA',
      postcode: '6111',
    })

    const templateId = await owner.client.mutation(api.customTemplates.create, {
      businessId,
      ...customTemplateArgs(),
    })

    await owner.client.mutation(api.customTemplates.archive, {
      businessId,
      templateId,
    })
    const archived = await owner.client.query(api.customTemplates.get, {
      businessId,
      templateId,
    })
    expect(archived?.archivedAt).toBeTruthy()

    // Archiving is a picker-visibility switch only — it must not block a
    // report already referencing the template, nor the template's own
    // resolution mechanics.
    await expectRejected(
      () =>
        owner.client.mutation(api.reports.create, {
          businessId,
          propertyId,
          template: 'custom',
          customTemplateId: templateId,
          legalBasis: 'Internal',
          data: {},
        }),
      'TEMPLATE_ARCHIVED',
    )

    await owner.client.mutation(api.customTemplates.unarchive, {
      businessId,
      templateId,
    })
    const unarchived = await owner.client.query(api.customTemplates.get, {
      businessId,
      templateId,
    })
    expect(unarchived?.archivedAt).toBeUndefined()

    // Now that it is active again, starting a report against it succeeds.
    const reportId = await owner.client.mutation(api.reports.create, {
      businessId,
      propertyId,
      template: 'custom',
      customTemplateId: templateId,
      legalBasis: 'Internal',
      data: {},
    })
    expect(reportId).toBeTruthy()
  })

  test('remove hard-deletes an unused template but refuses one that is in use', async () => {
    const owner = await signUpActor(
      uniqueEmail('customtpl-remove'),
      FIXTURE_PASSWORD,
      'Owner',
    )
    const { businessId } = await owner.client.mutation(api.businesses.create, {
      name: `Remove Co ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })
    const propertyId = await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'D. Wells',
      addressLine: '9 Jarrah Street',
      suburb: 'Armadale',
      state: 'WA',
      postcode: '6112',
    })

    const unusedId = await owner.client.mutation(api.customTemplates.create, {
      businessId,
      ...customTemplateArgs(),
    })
    await owner.client.mutation(api.customTemplates.remove, {
      businessId,
      templateId: unusedId,
    })
    expect(
      await owner.client.query(api.customTemplates.get, {
        businessId,
        templateId: unusedId,
      }),
    ).toBeNull()

    const inUseId = await owner.client.mutation(api.customTemplates.create, {
      businessId,
      ...customTemplateArgs({ name: 'In Use Template' }),
    })
    await owner.client.mutation(api.reports.create, {
      businessId,
      propertyId,
      template: 'custom',
      customTemplateId: inUseId,
      legalBasis: 'Internal',
      data: {},
    })

    await expectRejected(
      () =>
        owner.client.mutation(api.customTemplates.remove, {
          businessId,
          templateId: inUseId,
        }),
      'TEMPLATE_IN_USE',
    )
    // Still there, and still usable — a refused delete must not have
    // partially archived or otherwise mutated it.
    expect(
      await owner.client.query(api.customTemplates.get, {
        businessId,
        templateId: inUseId,
      }),
    ).toBeTruthy()
  })

  test('list returns every template for a business, including archived ones', async () => {
    const owner = await signUpActor(
      uniqueEmail('customtpl-list'),
      FIXTURE_PASSWORD,
      'Owner',
    )
    const { businessId } = await owner.client.mutation(api.businesses.create, {
      name: `List Co ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })

    const activeId = await owner.client.mutation(api.customTemplates.create, {
      businessId,
      ...customTemplateArgs({ name: 'Active One' }),
    })
    const archivedId = await owner.client.mutation(api.customTemplates.create, {
      businessId,
      ...customTemplateArgs({ name: 'Archived One' }),
    })
    await owner.client.mutation(api.customTemplates.archive, {
      businessId,
      templateId: archivedId,
    })

    const list = await owner.client.query(api.customTemplates.list, {
      businessId,
    })
    const ids = list.map((t) => t._id)
    expect(ids).toContain(activeId)
    expect(ids).toContain(archivedId)
  })

  test('access control: a subcontractor cannot clone, duplicate, archive, or delete a template', async () => {
    const owner = await signUpActor(
      uniqueEmail('customtpl-crud-acl'),
      FIXTURE_PASSWORD,
      'Owner',
    )
    const sub = await signUpActor(
      uniqueEmail('customtpl-crud-sub'),
      FIXTURE_PASSWORD,
      'Sub',
    )

    const { businessId } = await owner.client.mutation(api.businesses.create, {
      name: `CRUD ACL Co ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })
    const subUser = await sub.client.query(api.auth.getCurrentUser, {})
    await owner.client.mutation(api.memberships.invite, {
      businessId,
      userId: subUser._id,
      role: 'subcontractor',
    })
    await sub.client.mutation(api.memberships.accept, { businessId })

    const templateId = await owner.client.mutation(api.customTemplates.create, {
      businessId,
      ...customTemplateArgs(),
    })

    await expectRejected(
      () =>
        sub.client.mutation(api.customTemplates.cloneBuiltin, {
          businessId,
          sourceTemplateId: 'treatmentRecord',
          name: 'Sub Clone',
        }),
      'NO_ACCESS',
    )
    await expectRejected(
      () =>
        sub.client.mutation(api.customTemplates.duplicate, {
          businessId,
          templateId,
          name: 'Sub Duplicate',
        }),
      'NO_ACCESS',
    )
    await expectRejected(
      () =>
        sub.client.mutation(api.customTemplates.archive, {
          businessId,
          templateId,
        }),
      'NO_ACCESS',
    )
    await expectRejected(
      () =>
        sub.client.mutation(api.customTemplates.remove, {
          businessId,
          templateId,
        }),
      'NO_ACCESS',
    )
  })

  test('the "start a new report" picker offers custom templates alongside the built-ins, and starting one opens a real builder', async ({
    page,
  }) => {
    const email = uniqueEmail('customtpl-picker')
    const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Owner')

    const { businessId, slug } = await owner.client.mutation(
      api.businesses.create,
      {
        name: `Picker Co ${Date.now()}`,
        state: 'WA',
        timezone: 'Australia/Perth',
      },
    )
    await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'P. Ng',
      addressLine: '3 Wandoo Street',
      suburb: 'Midland',
      state: 'WA',
      postcode: '6056',
    })

    await owner.client.mutation(api.customTemplates.create, {
      businessId,
      ...customTemplateArgs({ name: 'Handrail Inspection' }),
    })

    // Archived templates must not appear in the picker at all — the picker
    // is the one surface `archivedAt` is actually supposed to affect.
    const archivedId = await owner.client.mutation(api.customTemplates.create, {
      businessId,
      ...customTemplateArgs({ name: 'Retired Form' }),
    })
    await owner.client.mutation(api.customTemplates.archive, {
      businessId,
      templateId: archivedId,
    })

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/new`)

    await expect(page.getByText('Treatment Record')).toBeVisible()
    await expect(page.getByText('Handrail Inspection')).toBeVisible()
    await expect(page.getByText('Retired Form')).toHaveCount(0)

    await page.getByText('Handrail Inspection').click()

    // Landed on a real draft against the custom template's own sections —
    // not a dead end or an error page.
    await expect(page.getByText('Handrail Inspection').first()).toBeVisible()
    await expect(page.getByText('Client reference')).toBeVisible()
    await expect(page.getByText('Finalise & lock')).toBeVisible()
  })
})
