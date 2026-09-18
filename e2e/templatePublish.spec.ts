import { expect, test } from '@playwright/test'
import { api, expectRejected, setupBusinessWithSub } from './fixtures'
import {
  createCustomReport,
  customTemplateArgs,
} from './fixtures/reportPayloads'
import type { SectionDef } from '#/lib/reportTemplates'

/**
 * Saving a form and issuing one are different acts.
 *
 * A form halfway through being edited is half-built by definition, and a
 * half-built form must not be the one a technician opens in somebody's
 * driveway. So an owner's edits go to a draft nobody is given, and become the
 * form the business issues only when they say so.
 *
 * The same split fixes the other half of the old behaviour: `sections` is
 * validated on write, so autosaving through it refused every keystroke that
 * left the draft momentarily invalid — and the refusal reached the owner as
 * "check your connection", about a connection that was fine.
 */

async function ownedTemplate(label: string) {
  const s = await setupBusinessWithSub(label)
  const templateId = await s.owner.client.mutation(api.customTemplates.create, {
    businessId: s.businessId,
    ...customTemplateArgs({ name: 'Site Walkthrough' }),
  })
  return { ...s, templateId }
}

test('an unissued edit is invisible to everyone filling the form in', async () => {
  const s = await ownedTemplate('publish-invisible')

  await s.owner.client.mutation(api.customTemplates.saveDraft, {
    businessId: s.businessId,
    templateId: s.templateId,
    name: 'Site Walkthrough (rewritten)',
    shortName: 'Walkthrough',
    legalBasis: 'Internal',
    blurb: 'A rewrite nobody has been given.',
    sections: [
      {
        title: 'Brand new section',
        fields: [{ kind: 'text', key: 'newField', label: 'New question' }],
      },
    ],
    boilerplate: '',
  })

  // The published form has not moved.
  const published = await s.owner.client.query(api.customTemplates.get, {
    businessId: s.businessId,
    templateId: s.templateId,
  })
  expect(published!.name).toBe('Site Walkthrough')
  expect(published!.hasUnpublishedChanges).toBe(true)
  expect(published!.publishedVersion).toBe(1)

  // And a report started right now is started against the published form —
  // the acceptance criterion for the whole split.
  const reportId = await createCustomReport(s.owner.client, s, s.templateId)
  const report = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId,
  })
  const sections = report!.customTemplate!.sections as Array<SectionDef>
  expect(
    sections.some((section) => section.title === 'Brand new section'),
  ).toBe(false)
})

test('issuing it is what puts it in front of the team', async () => {
  const s = await ownedTemplate('publish-issue')

  await s.owner.client.mutation(api.customTemplates.saveDraft, {
    businessId: s.businessId,
    templateId: s.templateId,
    name: 'Site Walkthrough v2',
    shortName: 'Walkthrough',
    legalBasis: 'Internal',
    blurb: 'Now issued.',
    sections: [
      {
        title: 'Brand new section',
        fields: [{ kind: 'text', key: 'newField', label: 'New question' }],
      },
    ],
    boilerplate: '',
  })
  const { version } = await s.owner.client.mutation(
    api.customTemplates.publish,
    {
      businessId: s.businessId,
      templateId: s.templateId,
    },
  )
  expect(version).toBe(2)

  const after = await s.owner.client.query(api.customTemplates.get, {
    businessId: s.businessId,
    templateId: s.templateId,
  })
  expect(after!.name).toBe('Site Walkthrough v2')
  // Cleared, not kept: "published" and "has unpublished changes" are the same
  // question asked twice, and two records of it drift.
  expect(after!.hasUnpublishedChanges).toBe(false)

  const reportId = await createCustomReport(s.owner.client, s, s.templateId)
  const report = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId,
  })
  const sections = report!.customTemplate!.sections as Array<SectionDef>
  expect(
    sections.some((section) => section.title === 'Brand new section'),
  ).toBe(true)
})

test('a draft that is not a valid form is still kept, and refused only at issue', async () => {
  const s = await ownedTemplate('publish-invalid')

  // Mid-edit: a field whose kind has not been chosen yet. The old editor
  // refused this save and blamed the network.
  await s.owner.client.mutation(api.customTemplates.saveDraft, {
    businessId: s.businessId,
    templateId: s.templateId,
    name: 'Site Walkthrough',
    shortName: 'Walkthrough',
    legalBasis: 'Internal',
    blurb: '',
    sections: [{ title: 'Half-built', fields: [{ key: 'unfinished' }] }],
    boilerplate: '',
  })
  const held = await s.owner.client.query(api.customTemplates.get, {
    businessId: s.businessId,
    templateId: s.templateId,
  })
  expect(held!.hasUnpublishedChanges).toBe(true)

  // It is the issuing that refuses, which is the moment it matters.
  await expectRejected(
    () =>
      s.owner.client.mutation(api.customTemplates.publish, {
        businessId: s.businessId,
        templateId: s.templateId,
      }),
    'INVALID_TEMPLATE',
  )
  // And the team keeps filling in the form they already had.
  expect(
    (await s.owner.client.query(api.customTemplates.get, {
      businessId: s.businessId,
      templateId: s.templateId,
    }))!.publishedVersion,
  ).toBe(1)
})

test('a discarded draft leaves the issued form untouched', async () => {
  const s = await ownedTemplate('publish-discard')

  await s.owner.client.mutation(api.customTemplates.saveDraft, {
    businessId: s.businessId,
    templateId: s.templateId,
    name: 'Regrettable rename',
    shortName: 'Walkthrough',
    legalBasis: 'Internal',
    blurb: '',
    sections: [],
    boilerplate: '',
  })
  await s.owner.client.mutation(api.customTemplates.discardDraft, {
    businessId: s.businessId,
    templateId: s.templateId,
  })

  const after = await s.owner.client.query(api.customTemplates.get, {
    businessId: s.businessId,
    templateId: s.templateId,
  })
  expect(after!.name).toBe('Site Walkthrough')
  expect(after!.hasUnpublishedChanges).toBe(false)

  await expectRejected(
    () =>
      s.owner.client.mutation(api.customTemplates.publish, {
        businessId: s.businessId,
        templateId: s.templateId,
      }),
    'NOTHING_TO_PUBLISH',
  )
})

test('the form keeps its own history, and only an owner writes it', async () => {
  const s = await ownedTemplate('publish-history')

  await s.owner.client.mutation(api.customTemplates.update, {
    businessId: s.businessId,
    templateId: s.templateId,
    name: 'Renamed directly',
  })
  await s.owner.client.mutation(api.customTemplates.saveDraft, {
    businessId: s.businessId,
    templateId: s.templateId,
    name: 'Renamed again',
    shortName: 'Walkthrough',
    legalBasis: 'Internal',
    blurb: '',
    sections: [
      {
        title: 'Still a real form',
        fields: [{ kind: 'text', key: 'note', label: 'Note' }],
      },
    ],
    boilerplate: '',
  })
  await s.owner.client.mutation(api.customTemplates.publish, {
    businessId: s.businessId,
    templateId: s.templateId,
  })

  // Both paths that change what the business issues are in the history.
  const versions = await s.owner.client.query(api.customTemplates.versions, {
    businessId: s.businessId,
    templateId: s.templateId,
  })
  expect(versions.map((v) => v.version)).toEqual([3, 2])
  expect(versions[0].name).toBe('Renamed again')

  // A technician cannot touch any of it.
  for (const call of [
    () =>
      s.sub.client.mutation(api.customTemplates.saveDraft, {
        businessId: s.businessId,
        templateId: s.templateId,
        name: 'Hijacked',
        shortName: 'x',
        legalBasis: 'x',
        blurb: '',
        sections: [],
        boilerplate: '',
      }),
    () =>
      s.sub.client.mutation(api.customTemplates.publish, {
        businessId: s.businessId,
        templateId: s.templateId,
      }),
    () =>
      s.sub.client.mutation(api.customTemplates.discardDraft, {
        businessId: s.businessId,
        templateId: s.templateId,
      }),
  ]) {
    await expectRejected(call, 'NO_ACCESS')
  }
})

test('a technician is never handed the owner’s unissued draft', async () => {
  const s = await ownedTemplate('publish-draft-hidden')
  await s.owner.client.mutation(api.customTemplates.saveDraft, {
    businessId: s.businessId,
    templateId: s.templateId,
    name: 'Not for them yet',
    shortName: 'Walkthrough',
    legalBasis: 'Internal',
    blurb: 'Half-written wording.',
    sections: [],
    boilerplate: '',
  })

  const theirs = await s.sub.client.query(api.customTemplates.get, {
    businessId: s.businessId,
    templateId: s.templateId,
  })
  expect(theirs!.name).toBe('Site Walkthrough')
  expect(theirs!.draft).toBeUndefined()
})
