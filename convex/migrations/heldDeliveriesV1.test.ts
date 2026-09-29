/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import { createActor, createBusiness, testApp } from '../../test/harness'
import { getTemplate } from '../../src/lib/reportTemplates'
import { NOT_SENT } from './heldDeliveriesV1'
import type { Doc, Id } from '../_generated/dataModel'

/**
 * The one-off that retires the owner's approval: what was still held is marked
 * as not sent — never sent late — and the switch that skipped the approval is
 * cleared, so the contract step can drop both from the schema.
 */

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@pestm8.test' })
  const { businessId, ownerMembershipId } = await createBusiness(
    t,
    owner,
    'Pest M8 Pest Control',
  )
  const ids = await t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'Jane Nguyen',
      email: 'jane@gmail.com',
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '30 Sloan Drive',
      suburb: 'Leda',
      state: 'WA',
      postcode: '6170',
      createdAt: now,
    })
    const reportId = await ctx.db.insert('reports', {
      businessId,
      propertyId,
      authorMembershipId: ownerMembershipId,
      template: 'serviceReport',
      templateVersion: getTemplate('serviceReport').version,
      legalBasis: 'APVMA · AEPMA',
      status: 'finalised',
      data: {},
      photoIds: [],
      finalisedAt: now,
      createdAt: now,
    })
    const delivery = (
      status: Doc<'reportDeliveries'>['status'],
      extra: Partial<Doc<'reportDeliveries'>> = {},
    ) =>
      ctx.db.insert('reportDeliveries', {
        businessId,
        reportId,
        to: ['strata@harbourside.example'],
        cc: [],
        subject: 'Service Report',
        trigger: 'finalise',
        status,
        sentByMembershipId: ownerMembershipId,
        createdAt: now,
        ...extra,
      })
    return {
      reportId,
      held: await delivery('pendingApproval'),
      heldManual: await delivery('pendingApproval', { trigger: 'manual' }),
      queued: await delivery('queued', { to: ['jane@gmail.com'] }),
      refused: await delivery('failed', {
        error: 'Not approved',
        approvedByMembershipId: ownerMembershipId,
      }),
    }
  })
  await t.run((ctx) =>
    ctx.db.patch(businessId, { allowTechnicianRecipients: false }),
  )
  const get = (id: Id<'reportDeliveries'>) => t.run((ctx) => ctx.db.get(id))
  return { t, owner, businessId, ownerMembershipId, ...ids, get }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function runToEnd(s: Setup) {
  await s.t.mutation(internal.migrations.heldDeliveriesV1.run, {
    cursor: null,
  })
  await s.t.finishAllScheduledFunctions(vi.runAllTimers)
}

describe('retiring the owner’s approval', () => {
  test('the preview names what is held and where the switch is set, and changes nothing', async () => {
    const s = await setup()

    const preview = await s.t.query(
      internal.migrations.heldDeliveriesV1.preview,
      {},
    )
    expect(preview.held.map((row) => row.deliveryId).sort()).toEqual(
      [s.held, s.heldManual].sort(),
    )
    // Ids and counts only: this is read in a terminal.
    expect(JSON.stringify(preview)).not.toContain('@')
    expect(preview.switchSet).toEqual([{ businessId: s.businessId, on: false }])
    expect((await s.get(s.held))?.status).toBe('pendingApproval')
  })

  test('a held send is marked not sent, with the reason, and nothing is emailed late', async () => {
    const s = await setup()
    await runToEnd(s)

    for (const id of [s.held, s.heldManual]) {
      expect(await s.get(id)).toMatchObject({
        status: 'failed',
        error: NOT_SENT,
        // Who asked is still who asked.
        sentByMembershipId: s.ownerMembershipId,
      })
    }
    // Nothing scheduled a send, and nothing else changed.
    expect((await s.get(s.queued))?.status).toBe('queued')
    expect(await s.get(s.refused)).toMatchObject({
      status: 'failed',
      error: 'Not approved',
      approvedByMembershipId: s.ownerMembershipId,
    })
    const report = await s.t.run((ctx) => ctx.db.get(s.reportId))
    expect(report?.emailedAt).toBeUndefined()
  })

  test('the retired switch is cleared, no activity is logged, and a second run finds nothing', async () => {
    const s = await setup()
    const logged = () =>
      s.t.run(async (ctx) => (await ctx.db.query('auditLog').collect()).length)
    const before = await logged()

    await runToEnd(s)
    const business = await s.t.run((ctx) => ctx.db.get(s.businessId))
    expect(business).not.toHaveProperty('allowTechnicianRecipients')
    // Nobody in the business did this, so nothing says they did.
    expect(await logged()).toBe(before)

    expect(
      await s.t.query(internal.migrations.heldDeliveriesV1.preview, {}),
    ).toEqual({ held: [], switchSet: [] })
    await runToEnd(s)
    expect((await s.get(s.held))?.error).toBe(NOT_SENT)
  })

  test('a table bigger than one page is released page by page', async () => {
    const s = await setup()
    const more = await s.t.run(async (ctx) => {
      const ids: Array<Id<'reportDeliveries'>> = []
      for (let n = 0; n < 205; n++) {
        ids.push(
          await ctx.db.insert('reportDeliveries', {
            businessId: s.businessId,
            reportId: s.reportId,
            to: [`strata${n}@harbourside.example`],
            cc: [],
            subject: 'Service Report',
            trigger: 'manual',
            status: 'pendingApproval',
            sentByMembershipId: s.ownerMembershipId,
            createdAt: Date.now(),
          }),
        )
      }
      return ids
    })

    await runToEnd(s)
    const statuses = await s.t.run(async (ctx) =>
      Promise.all(more.map(async (id) => (await ctx.db.get(id))?.status)),
    )
    expect(new Set(statuses)).toEqual(new Set(['failed']))
    expect(
      (await s.t.query(internal.migrations.heldDeliveriesV1.preview, {})).held,
    ).toEqual([])
  })

  test('once cleared, the retired switch cannot be set again', async () => {
    const s = await setup()
    await runToEnd(s)

    // A Settings page from before this release, still on someone's phone:
    // accepted, so it cannot fail, and not stored, so the contract step can
    // drop the field.
    await s.owner.as.mutation(api.businesses.update, {
      businessId: s.businessId,
      allowTechnicianRecipients: true,
    })
    const business = await s.t.run((ctx) => ctx.db.get(s.businessId))
    expect(business).not.toHaveProperty('allowTechnicianRecipients')
  })
})
