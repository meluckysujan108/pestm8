/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { getTemplate } from '../src/lib/reportTemplates'
import { deliveryAddressing } from './lib/reportEmail'
import { RENDER_VERSION } from './reports'
import type { Doc, Id } from './_generated/dataModel'

/**
 * The business's own copy of every report it emails, and the rule that only
 * a finished report is emailed at all.
 *
 * The copy is blind (bcc): a client sees who the report is for, not the
 * business's inbox beside them. It goes on the email a form asks for as it
 * is locked AND on one sent from the report's Send button — until 29 Sept
 * 2026 only the first carried a copy, and as a visible cc.
 */

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const CLIENT = 'jane@gmail.com'

async function setup(business: Partial<Doc<'businesses'>> = {}) {
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
    await ctx.db.patch(businessId, { email: 'info@pestm8.com.au', ...business })
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'Jane Nguyen',
      email: CLIENT,
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

function report(
  s: Setup,
  fields: Partial<Doc<'reports'>> = {},
): Promise<Id<'reports'>> {
  return s.t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob(['signature'], { type: 'image/png' }),
    )
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
      signatureSlots: {
        technician: { storageId, signedAt: Date.now(), method: 'drawn' },
      },
      createdAt: Date.now(),
      ...fields,
    })
  })
}

function finalise(s: Setup, reportId: Id<'reports'>, answers: object = {}) {
  return s.owner.as.mutation(api.reports.finalise, {
    businessId: s.businessId,
    reportId,
    data: {
      serviceDate: '2026-09-29',
      safeToStart: true,
      treatments: [],
      technicianSignature: { signedAt: Date.now() },
      sendCopy: true,
      ...answers,
    },
    templateVersion: getTemplate('serviceReport').version,
  })
}

function deliveries(s: Setup) {
  return s.t.run((ctx) => ctx.db.query('reportDeliveries').collect())
}

describe('the business keeps a hidden copy of every report it emails', () => {
  test('the email a form asks for at finalise copies the business email, blind', async () => {
    const s = await setup()
    await finalise(s, await report(s))

    const [row] = await deliveries(s)
    expect(row).toMatchObject({
      to: [CLIENT],
      cc: [],
      bcc: ['info@pestm8.com.au'],
      trigger: 'finalise',
      status: 'queued',
    })
  })

  test('a Business copy address wins over the business email', async () => {
    const s = await setup({ reportCopyEmail: 'Office@PestM8.com.au' })
    await finalise(s, await report(s))

    const [row] = await deliveries(s)
    expect(row.bcc).toEqual(['office@pestm8.com.au'])
  })

  test('a send from the report’s Send button carries the same copy', async () => {
    const s = await setup()
    const reportId = await report(s, {
      status: 'finalised',
      finalisedAt: Date.now(),
    })
    await s.owner.as.mutation(api.deliveries.request, {
      businessId: s.businessId,
      reportId,
      to: [CLIENT],
    })

    const [row] = await deliveries(s)
    expect(row).toMatchObject({
      to: [CLIENT],
      cc: [],
      bcc: ['info@pestm8.com.au'],
      trigger: 'manual',
    })
  })

  test('the business is not copied on an email to itself', async () => {
    const s = await setup()
    const reportId = await report(s, {
      status: 'finalised',
      finalisedAt: Date.now(),
    })
    await s.owner.as.mutation(api.deliveries.request, {
      businessId: s.businessId,
      reportId,
      to: ['INFO@pestm8.com.au'],
    })

    const [row] = await deliveries(s)
    expect(row.to).toEqual(['info@pestm8.com.au'])
    expect(row.bcc).toEqual([])
  })

  test('a Business copy address that can never be delivered to is not swapped for another inbox', async () => {
    // Saved before addresses were checked. The owner named that inbox; the
    // copy does not quietly go to a different one instead.
    const s = await setup({ reportCopyEmail: 'reports@pestm8' })
    await finalise(s, await report(s))

    const [row] = await deliveries(s)
    expect(row.to).toEqual([CLIENT])
    expect(row.bcc).toEqual([])
  })

  test('a business with neither address sends no copy', async () => {
    const s = await setup({ email: undefined })
    await finalise(s, await report(s))

    const [row] = await deliveries(s)
    expect(row.to).toEqual([CLIENT])
    expect(row.bcc).toEqual([])
  })

  test('the sheets are told where the copy goes, and whether email can go at all', async () => {
    const s = await setup()
    const reportId = await report(s)

    const before = await s.owner.as.query(api.deliveries.known, {
      businessId: s.businessId,
      reportId,
    })
    expect(before.copy).toBe('info@pestm8.com.au')
    expect(before.emailReady).toBe(false)

    vi.stubEnv('RESEND_API_KEY', 're_test')
    vi.stubEnv('RESEND_FROM_EMAIL', 'info@pestm8.com.au')
    const after = await s.owner.as.query(api.deliveries.known, {
      businessId: s.businessId,
      reportId,
    })
    expect(after.emailReady).toBe(true)
  })
})

describe('only a finalised report is ever emailed', () => {
  test('asking to send a draft is refused', async () => {
    const s = await setup()
    const reportId = await report(s)
    await expect(
      s.owner.as.mutation(api.deliveries.request, {
        businessId: s.businessId,
        reportId,
        to: [CLIENT],
      }),
    ).rejects.toThrow(/REPORT_NOT_FINALISED/)
    expect(await deliveries(s)).toEqual([])
  })

  test('the sender refuses a draft even when a delivery for one exists', async () => {
    const s = await setup()
    const reportId = await report(s)
    const deliveryId = await s.t.mutation(internal.deliveries.queue, {
      reportId,
      to: [CLIENT],
      cc: [],
      bcc: ['info@pestm8.com.au'],
      subject: 'Service Report',
      trigger: 'manual',
      status: 'queued',
      sentByMembershipId: s.ownerMembershipId,
    })
    vi.stubEnv('RESEND_API_KEY', 're_test')
    vi.stubEnv('RESEND_FROM_EMAIL', 'info@pestm8.com.au')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    const result = await s.t.action(internal.email.deliver, { deliveryId })

    expect(result).toEqual({ ok: false, reason: 'notFinalised' })
    expect(fetch).not.toHaveBeenCalled()
    const [row] = await deliveries(s)
    expect(row.status).toBe('failed')
  })
})

describe('what Resend is asked to send', () => {
  test('the copy goes as bcc, never cc, and the client is the only visible recipient', async () => {
    const s = await setup()
    const reportId = await report(s, {
      status: 'finalised',
      finalisedAt: Date.now(),
    })
    // A file already drawn at the current renderer, so nothing re-renders.
    await s.t.run(async (ctx) => {
      const storageId = await ctx.storage.store(
        new Blob(['%PDF-1.7 test'], { type: 'application/pdf' }),
      )
      await ctx.db.patch(reportId, {
        pdfStorageId: storageId,
        pdfRenderVersion: RENDER_VERSION,
        pdfStatus: 'ready',
      })
    })
    await s.owner.as.mutation(api.deliveries.request, {
      businessId: s.businessId,
      reportId,
      to: [CLIENT],
    })
    const [{ _id: deliveryId }] = await deliveries(s)

    vi.stubEnv('RESEND_API_KEY', 're_test')
    vi.stubEnv('RESEND_FROM_EMAIL', 'info@pestm8.com.au')
    const sent: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://api.resend.com/emails') {
          sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
          return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 })
        }
        // The stored PDF, fetched to be attached.
        return new Response(new Blob(['%PDF-1.7 test']), { status: 200 })
      }),
    )

    const result = await s.t.action(internal.email.deliver, { deliveryId })

    expect(result).toEqual({ ok: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      to: [CLIENT],
      bcc: ['info@pestm8.com.au'],
    })
    expect(sent[0]).not.toHaveProperty('cc')
    const [row] = await deliveries(s)
    expect(row).toMatchObject({ status: 'sent', providerMessageId: 'msg_1' })
  })

  test('a row from before blind copies is sent as it was recorded', () => {
    expect(
      deliveryAddressing({ to: [CLIENT], cc: ['info@pestm8.com.au'] }),
    ).toEqual({ to: [CLIENT], cc: ['info@pestm8.com.au'] })
    expect(
      deliveryAddressing({
        to: [CLIENT],
        cc: [],
        bcc: ['info@pestm8.com.au'],
      }),
    ).toEqual({ to: [CLIENT], bcc: ['info@pestm8.com.au'] })
  })
})
