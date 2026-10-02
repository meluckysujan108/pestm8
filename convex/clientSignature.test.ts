/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { getTemplate } from '../src/lib/reportTemplates'
import { CLIENT_SIGNATURES_SHOWN } from '../src/lib/reportTemplates/settings'
import type { SectionDef } from '../src/lib/reportTemplates'
import type { Doc, Id } from './_generated/dataModel'

/**
 * A report locks on the technician's signature alone.
 *
 * The client's signature is welcome when they are there to give it, and
 * never required: not by a form, not by a business's own clone, and not by
 * its settings — including settings saved before that was the rule, which
 * named the client's slot. Checked through `reports.finalise`, the one gate
 * that matters, and the same resolve-then-validate the builder runs.
 */

async function setup() {
  const t = testApp()
  const owner = await createActor(t, {
    email: 'terence@pestm8.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(
    t,
    owner,
    'Pest M8 Pest Control',
  )
  const propertyId = await t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'Jane Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '30 Sloan Drive',
      suburb: 'Leda',
      state: 'WA',
      postcode: '6170',
      createdAt: now,
    })
  })
  return { t, owner, businessId, ownerMembershipId, propertyId }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** A Service Report draft, holding a signature in each slot named. */
function draft(
  s: Setup,
  slots: Array<'technician' | 'client'>,
  form: Pick<
    Doc<'reports'>,
    'template' | 'templateVersion' | 'customTemplateId' | 'legalBasis'
  > = {
    template: 'serviceReport',
    templateVersion: getTemplate('serviceReport').version,
    legalBasis: 'APVMA · AEPMA',
  },
) {
  return s.t.run(async (ctx) => {
    const signatureSlots: NonNullable<Doc<'reports'>['signatureSlots']> = {}
    for (const slot of slots) {
      const storageId = await ctx.storage.store(
        new Blob(['signature'], { type: 'image/png' }),
      )
      signatureSlots[slot] = {
        storageId,
        signedAt: Date.now(),
        method: 'drawn',
      }
    }
    return ctx.db.insert('reports', {
      businessId: s.businessId,
      propertyId: s.propertyId,
      authorMembershipId: s.ownerMembershipId,
      ...form,
      status: 'draft',
      data: {},
      photoIds: [],
      signatureSlots,
      createdAt: Date.now(),
    })
  })
}

function finalise(
  s: Setup,
  reportId: Id<'reports'>,
  signed: boolean,
  answers: Record<string, unknown> = {},
) {
  return s.owner.as.mutation(api.reports.finalise, {
    businessId: s.businessId,
    reportId,
    data: {
      serviceDate: '2026-09-29',
      safeToStart: true,
      treatments: [],
      ...(signed ? { technicianSignature: { signedAt: Date.now() } } : {}),
      ...answers,
    },
    templateVersion: getTemplate('serviceReport').version,
  })
}

async function status(s: Setup, reportId: Id<'reports'>) {
  return (await s.t.run((ctx) => ctx.db.get(reportId)))!.status
}

/** The report as locked, and the sections its frozen wording holds. */
async function locked(s: Setup, reportId: Id<'reports'>) {
  return s.t.run(async (ctx) => {
    const report = (await ctx.db.get(reportId))!
    const snapshot = report.templateSnapshotId
      ? await ctx.db.get(report.templateSnapshotId)
      : null
    const sections = (snapshot?.sections ?? []) as Array<SectionDef>
    const pads = sections.flatMap((section) =>
      section.fields.flatMap((field) =>
        field.kind === 'signature' ? [field.slot] : [],
      ),
    )
    return { report, sections, pads }
  })
}

describe('a report locks on the technician’s signature alone', () => {
  test('with the form as it comes', async () => {
    const s = await setup()
    const reportId = await draft(s, ['technician'])
    await finalise(s, reportId, true)
    expect(await status(s, reportId)).toBe('finalised')
  })

  test('with settings saved before the rule that named the client', async () => {
    const s = await setup()
    await s.t.run((ctx) =>
      ctx.db.insert('templateSettings', {
        businessId: s.businessId,
        templateRef: 'serviceReport',
        requiredSigners: ['technician', 'client'],
        updatedByMembershipId: s.ownerMembershipId,
        updatedAt: Date.now(),
      }),
    )
    const reportId = await draft(s, ['technician'])
    await finalise(s, reportId, true)
    expect(await status(s, reportId)).toBe('finalised')
  })

  test('and not on the client’s alone: the technician still has to sign', async () => {
    const s = await setup()
    const reportId = await draft(s, ['client'])
    await expect(finalise(s, reportId, false)).rejects.toThrow(
      /REPORT_INCOMPLETE/,
    )
    expect(await status(s, reportId)).toBe('draft')
  })

  test('an owner saving the form’s settings cannot make the client required', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.templateSettings.set, {
      businessId: s.businessId,
      templateRef: 'serviceReport',
      requiredSigners: ['technician', 'client'],
    })
    const reportId = await draft(s, ['technician'])
    await finalise(s, reportId, true)
    expect(await status(s, reportId)).toBe('finalised')
  })
})

/**
 * While client signatures are off a draft leaves out the client's part, and
 * the wording frozen when it locks is the form it showed: a client's pad
 * nobody was asked to sign is not printed blank under the technician's
 * signature. A signature the client did give is never left off.
 */
describe('what a locked report keeps of the client’s part', () => {
  test('a report signed by the technician alone freezes without the client’s pad', async () => {
    const s = await setup()
    const reportId = await draft(s, ['technician'])
    await finalise(s, reportId, true)

    const { report, pads } = await locked(s, reportId)
    expect(report.status).toBe('finalised')
    expect(pads).toContain('technician')
    expect(pads.includes('client')).toBe(CLIENT_SIGNATURES_SHOWN)
  })

  test('a report the client signed too keeps the client’s pad, and the signature', async () => {
    const s = await setup()
    const reportId = await draft(s, ['technician', 'client'])
    const signedAt = Date.now()
    await finalise(s, reportId, true, { clientSignature: { signedAt } })

    const { report, pads } = await locked(s, reportId)
    expect(report.status).toBe('finalised')
    expect(pads).toEqual(expect.arrayContaining(['technician', 'client']))
    expect((report.data as Record<string, unknown>).clientSignature).toEqual({
      signedAt,
    })
    expect(report.signatureSlots?.client).toBeDefined()
  })

  test('a business’s own client sign-off, with a required name, does not hold the lock', async () => {
    const s = await setup()
    // A business's own form is a regulated document, signed on a licence.
    await s.t.run((ctx) =>
      ctx.db.patch(s.ownerMembershipId, { licenceNumber: 'PMT 4132' }),
    )
    const customTemplateId = await s.t.run((ctx) =>
      ctx.db.insert('customReportTemplates', {
        businessId: s.businessId,
        name: 'Site Visit',
        shortName: 'Site Visit',
        legalBasis: 'Internal',
        blurb: 'What was done.',
        sections: [
          {
            title: 'Work done',
            fields: [
              { kind: 'area', key: 'notes', label: 'Notes' },
              {
                kind: 'signature',
                key: 'technicianSignature',
                label: 'Technician’s signature',
                slot: 'technician',
                role: 'technician',
                required: true,
              },
            ],
          },
          {
            // The built-in forms' own keys, as a clone of one keeps them.
            title: 'Client acknowledgment',
            fields: [
              {
                kind: 'text',
                key: 'clientSignatoryName',
                label: 'Client name',
                required: true,
              },
              {
                kind: 'signature',
                key: 'clientSignature',
                label: 'Client signature',
                slot: 'client',
                role: 'client',
              },
              { kind: 'date', key: 'clientDateSigned', label: 'Date signed' },
            ],
          },
        ],
        boilerplate: '',
        createdByMembershipId: s.ownerMembershipId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    const reportId = await draft(s, ['technician'], {
      template: 'custom',
      templateVersion: 1,
      customTemplateId,
      legalBasis: 'Internal',
    })
    const lock = s.owner.as.mutation(api.reports.finalise, {
      businessId: s.businessId,
      reportId,
      data: { technicianSignature: { signedAt: Date.now() } },
      templateVersion: 1,
    })

    if (CLIENT_SIGNATURES_SHOWN) {
      // Asked, so the client's name is required as the form says.
      await expect(lock).rejects.toThrow(/REPORT_INCOMPLETE/)
      return
    }
    await lock
    const { report, sections } = await locked(s, reportId)
    expect(report.status).toBe('finalised')
    expect(sections.map((section) => section.title)).toEqual(['Work done'])
  })
})
