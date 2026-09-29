/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { getTemplate } from '../src/lib/reportTemplates'
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
function draft(s: Setup, slots: Array<'technician' | 'client'>) {
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
      template: 'serviceReport',
      templateVersion: getTemplate('serviceReport').version,
      legalBasis: 'APVMA · AEPMA',
      status: 'draft',
      data: {},
      photoIds: [],
      signatureSlots,
      createdAt: Date.now(),
    })
  })
}

function finalise(s: Setup, reportId: Id<'reports'>, signed: boolean) {
  return s.owner.as.mutation(api.reports.finalise, {
    businessId: s.businessId,
    reportId,
    data: {
      serviceDate: '2026-09-29',
      safeToStart: true,
      treatments: [],
      ...(signed ? { technicianSignature: { signedAt: Date.now() } } : {}),
    },
    templateVersion: getTemplate('serviceReport').version,
  })
}

async function status(s: Setup, reportId: Id<'reports'>) {
  return (await s.t.run((ctx) => ctx.db.get(reportId)))!.status
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
