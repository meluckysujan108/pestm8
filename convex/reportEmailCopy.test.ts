/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { getTemplate } from '../src/lib/reportTemplates'
import { deliveryAddressing } from './lib/reportEmail'
import { RENDER_VERSION } from './reports'
import { SEND_LIMIT_REACHED } from './lib/sendLimit'
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

/** Someone on the team who is not an owner. Until 29 Sept 2026 their email
 * to an address nobody had on file waited for one; it goes now. */
async function technician(s: Setup) {
  const person = await createActor(s.t, {
    email: 'kev@pestm8.test',
    name: 'Kevin',
  })
  const membershipId = await s.t.run((ctx) =>
    ctx.db.insert('memberships', {
      userId: person.userId,
      businessId: s.businessId,
      role: 'subcontractor',
      canViewAllJobs: false,
      colour: '#34C759',
      status: 'active',
      createdAt: Date.now(),
    }),
  )
  return { person, membershipId }
}

/** A file already drawn at the current renderer, so nothing re-renders. */
function withPdf(s: Setup, reportId: Id<'reports'>) {
  return s.t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob(['%PDF-1.7 test'], { type: 'application/pdf' }),
    )
    await ctx.db.patch(reportId, {
      pdfStorageId: storageId,
      pdfRenderVersion: RENDER_VERSION,
      pdfStatus: 'ready',
    })
  })
}

/** Resend, faked: every email asked for, and the stored PDF when fetched. */
function fakeResend() {
  vi.stubEnv('RESEND_API_KEY', 're_test')
  vi.stubEnv('RESEND_FROM_EMAIL', 'info@pestm8.com.au')
  const sent: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.resend.com/emails') {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ id: `msg_${sent.length}` }), {
          status: 200,
        })
      }
      return new Response(new Blob(['%PDF-1.7 test']), { status: 200 })
    }),
  )
  return sent
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
      // On the client's record: nothing to point out.
      newAddresses: [],
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
  test('a technician’s lock emails everyone the form asked for at once, and records who was new', async () => {
    const s = await setup()
    const { person, membershipId } = await technician(s)
    const reportId = await report(s, { authorMembershipId: membershipId })

    await person.as.mutation(api.reports.finalise, {
      businessId: s.businessId,
      reportId,
      data: {
        serviceDate: '2026-09-29',
        safeToStart: true,
        treatments: [],
        technicianSignature: { signedAt: Date.now() },
        sendCopy: true,
        emailReportTo: ['strata@harbourside.example'],
      },
      templateVersion: getTemplate('serviceReport').version,
    })

    // One email, nothing held: the strata manager nobody has on file goes
    // with the client, and the row says they were new.
    const rows = await deliveries(s)
    expect(
      rows.map(
        ({ to, bcc, status, trigger, newAddresses, sentByMembershipId }) => ({
          to,
          bcc,
          status,
          trigger,
          newAddresses,
          sentByMembershipId,
        }),
      ),
    ).toEqual([
      {
        to: [CLIENT, 'strata@harbourside.example'],
        bcc: ['info@pestm8.com.au'],
        status: 'queued',
        trigger: 'finalise',
        newAddresses: ['strata@harbourside.example'],
        sentByMembershipId: membershipId,
      },
    ])
  })

  test('a technician is told where the copy goes, and that nothing needs an owner', async () => {
    const s = await setup()
    const { person, membershipId } = await technician(s)
    const reportId = await report(s, { authorMembershipId: membershipId })

    const told = await person.as.query(api.deliveries.known, {
      businessId: s.businessId,
      reportId,
    })
    expect(told.copy).toBe('info@pestm8.com.au')
    expect(told.addresses).toContain(CLIENT)
    // Always true since approval was retired: a screen from before then reads
    // false as "this address needs an owner's approval".
    expect(told.unrestricted).toBe(true)
  })

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

describe('who locked it, and how many a person may send', () => {
  test('a lock made in someone else’s account is written down as theirs, by whoever locked it', async () => {
    const s = await setup()
    const { membershipId } = await technician(s)
    const reportId = await report(s, { authorMembershipId: membershipId })

    await s.owner.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: membershipId,
    })
    await finalise(s, reportId)

    const [row] = await deliveries(s)
    expect(row).toMatchObject({
      status: 'queued',
      sentByMembershipId: s.ownerMembershipId,
      onBehalfOfMembershipId: membershipId,
    })
  })

  test('a lock over the hourly limit still locks, and its email is written down as not sent', async () => {
    const s = await setup()
    const { person, membershipId } = await technician(s)
    const reportId = await report(s, { authorMembershipId: membershipId })
    // Twenty emails already this hour.
    await s.t.run(async (ctx) => {
      for (let n = 0; n < 20; n++) {
        await ctx.db.insert('reportDeliveries', {
          businessId: s.businessId,
          reportId,
          to: [CLIENT],
          cc: [],
          subject: 'Service Report',
          trigger: 'manual',
          status: 'sent',
          sentByMembershipId: membershipId,
          createdAt: Date.now(),
        })
      }
    })

    await person.as.mutation(api.reports.finalise, {
      businessId: s.businessId,
      reportId,
      data: {
        serviceDate: '2026-09-29',
        safeToStart: true,
        treatments: [],
        technicianSignature: { signedAt: Date.now() },
        sendCopy: true,
      },
      templateVersion: getTemplate('serviceReport').version,
    })

    // The document is finished whatever becomes of its email.
    const locked = await s.t.run((ctx) => ctx.db.get(reportId))
    expect(locked?.status).toBe('finalised')
    const sends = (await deliveries(s)).filter(
      (row) => row.trigger === 'finalise',
    )
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({
      to: [CLIENT],
      status: 'failed',
      error: SEND_LIMIT_REACHED,
      sentByMembershipId: membershipId,
    })
    const logs = await s.owner.as.query(api.auditLog.forEntity, {
      businessId: s.businessId,
      entityType: 'reports',
      entityId: reportId,
    })
    expect(logs.find((e) => e.action === 'report.email.failed')).toMatchObject({
      actorName: 'Kevin',
      meta: {
        to: [CLIENT],
        trigger: 'finalise',
        detail: SEND_LIMIT_REACHED,
      },
    })
  })

  test('the hour holds fifty addresses across every email, however they are split', async () => {
    const s = await setup()
    const reportId = await report(s, {
      status: 'finalised',
      finalisedAt: Date.now(),
    })
    const many = Array.from(
      { length: 51 },
      (_, n) => `strata${n}@harbourside.example`,
    )
    const send = (to: Array<string>) =>
      s.owner.as.mutation(api.deliveries.request, {
        businessId: s.businessId,
        reportId,
        to,
      })

    await expect(send(many)).rejects.toThrow(/SEND_RATE_LIMITED/)
    expect(await deliveries(s)).toEqual([])
    await send(many.slice(0, 49))
    await expect(send(many.slice(49))).rejects.toThrow(/SEND_RATE_LIMITED/)
    // The fiftieth still fits.
    await send([many[49]])
    expect(await deliveries(s)).toHaveLength(2)
  })
})

describe('what Resend is asked to send', () => {
  test('the copy goes as bcc, never cc, and the client is the only visible recipient', async () => {
    const s = await setup()
    const reportId = await report(s, {
      status: 'finalised',
      finalisedAt: Date.now(),
    })
    await withPdf(s, reportId)
    await s.owner.as.mutation(api.deliveries.request, {
      businessId: s.businessId,
      reportId,
      to: [CLIENT],
    })
    const [{ _id: deliveryId }] = await deliveries(s)
    const sent = fakeResend()

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

  test('a technician’s send to someone nobody has on file goes at once, with the copy, and the Logs say so', async () => {
    const s = await setup()
    const { person, membershipId } = await technician(s)
    const reportId = await report(s, {
      authorMembershipId: membershipId,
      status: 'finalised',
      finalisedAt: Date.now(),
    })
    await withPdf(s, reportId)

    const { deliveryId, status } = await person.as.mutation(
      api.deliveries.request,
      {
        businessId: s.businessId,
        reportId,
        to: ['strata@harbourside.example'],
      },
    )
    expect(status).toBe('queued')
    const [row] = await deliveries(s)
    expect(row).toMatchObject({
      to: ['strata@harbourside.example'],
      bcc: ['info@pestm8.com.au'],
      newAddresses: ['strata@harbourside.example'],
      sentByMembershipId: membershipId,
    })
    expect(row.onBehalfOfMembershipId).toBeUndefined()

    const sent = fakeResend()
    expect(await s.t.action(internal.email.deliver, { deliveryId })).toEqual({
      ok: true,
    })
    expect(sent[0]).toMatchObject({
      to: ['strata@harbourside.example'],
      bcc: ['info@pestm8.com.au'],
    })

    // What the owner reads afterwards: who, to whom, where the copy went,
    // and that the address was new to this client.
    const logs = await s.owner.as.query(api.auditLog.forEntity, {
      businessId: s.businessId,
      entityType: 'reports',
      entityId: reportId,
    })
    expect(logs.filter((e) => e.action.startsWith('report.email'))).toEqual([
      expect.objectContaining({
        action: 'report.email.sent',
        actorName: 'Kevin',
        meta: {
          to: ['strata@harbourside.example'],
          bcc: ['info@pestm8.com.au'],
          newAddresses: ['strata@harbourside.example'],
          trigger: 'manual',
          subject: row.subject,
        },
      }),
    ])
  })

  test('a send made in someone else’s account is logged as theirs, by whoever made it', async () => {
    const s = await setup()
    const { membershipId } = await technician(s)
    const reportId = await report(s, {
      authorMembershipId: membershipId,
      status: 'finalised',
      finalisedAt: Date.now(),
    })
    await withPdf(s, reportId)

    await s.owner.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: membershipId,
    })
    const { deliveryId } = await s.owner.as.mutation(api.deliveries.request, {
      businessId: s.businessId,
      reportId,
      to: [CLIENT],
    })
    const [row] = await deliveries(s)
    expect(row.sentByMembershipId).toBe(s.ownerMembershipId)
    expect(row.onBehalfOfMembershipId).toBe(membershipId)

    fakeResend()
    await s.t.action(internal.email.deliver, { deliveryId })
    await s.owner.as.mutation(api.accountSwitches.stop, {
      businessId: s.businessId,
    })

    const history = await s.owner.as.query(api.deliveries.forReport, {
      businessId: s.businessId,
      reportId,
    })
    expect(history[0]).toMatchObject({
      sentBy: { name: 'Terence' },
      onBehalfOf: { name: 'Kevin' },
    })
    const logs = await s.owner.as.query(api.auditLog.forEntity, {
      businessId: s.businessId,
      entityType: 'reports',
      entityId: reportId,
    })
    expect(logs.find((e) => e.action === 'report.email.sent')).toMatchObject({
      actorName: 'Terence',
      onBehalfOfName: 'Kevin',
    })
  })

  test('a send that dies preparing the PDF is logged too, in words', async () => {
    const s = await setup()
    const reportId = await report(s, {
      status: 'finalised',
      finalisedAt: Date.now(),
    })
    await withPdf(s, reportId)
    const { deliveryId } = await s.owner.as.mutation(api.deliveries.request, {
      businessId: s.businessId,
      reportId,
      to: [CLIENT],
    })
    vi.stubEnv('RESEND_API_KEY', 're_test')
    vi.stubEnv('RESEND_FROM_EMAIL', 'info@pestm8.com.au')
    // Storage answers with an error page, so there is no PDF to attach.
    const fetch = vi.fn(async () => new Response('gone', { status: 500 }))
    vi.stubGlobal('fetch', fetch)

    await expect(
      s.t.action(internal.email.deliver, { deliveryId }),
    ).rejects.toThrow(/PDF_UNAVAILABLE/)

    const said =
      'Not sent: the PDF could not be prepared to attach. Open the PDF tab, then send it again.'
    const [row] = await deliveries(s)
    expect(row).toMatchObject({ status: 'failed', error: said })
    const logs = await s.owner.as.query(api.auditLog.forEntity, {
      businessId: s.businessId,
      entityType: 'reports',
      entityId: reportId,
    })
    expect(logs.find((e) => e.action === 'report.email.failed')).toMatchObject({
      actorName: 'Terence',
      meta: {
        to: [CLIENT],
        bcc: ['info@pestm8.com.au'],
        trigger: 'manual',
        detail: said,
      },
    })
  })

  test('a refusal from Resend is logged once, with who it was for', async () => {
    const s = await setup()
    const reportId = await report(s, {
      status: 'finalised',
      finalisedAt: Date.now(),
    })
    await withPdf(s, reportId)
    const { deliveryId } = await s.owner.as.mutation(api.deliveries.request, {
      businessId: s.businessId,
      reportId,
      to: [CLIENT],
    })
    vi.stubEnv('RESEND_API_KEY', 're_test')
    vi.stubEnv('RESEND_FROM_EMAIL', 'info@pestm8.com.au')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === 'https://api.resend.com/emails'
          ? new Response('{"message":"The to address is invalid"}', {
              status: 422,
            })
          : new Response(new Blob(['%PDF-1.7 test']), { status: 200 }),
      ),
    )

    expect(await s.t.action(internal.email.deliver, { deliveryId })).toEqual({
      ok: false,
      reason: 'provider',
    })
    // Words with a next step on the row; Resend's own reply rides on the
    // Logs line, out of sight, for whoever fixes it.
    const [row] = await deliveries(s)
    expect(row.status).toBe('failed')
    expect(row.error).toBe(
      'Not sent: the email service refused it, usually for an address it can’t deliver to. Check the addresses, then send it again.',
    )
    const logs = await s.owner.as.query(api.auditLog.forEntity, {
      businessId: s.businessId,
      entityType: 'reports',
      entityId: reportId,
    })
    expect(logs.filter((e) => e.action.startsWith('report.email'))).toEqual([
      expect.objectContaining({
        action: 'report.email.failed',
        meta: expect.objectContaining({
          to: [CLIENT],
          bcc: ['info@pestm8.com.au'],
          trigger: 'manual',
          detail: row.error,
          reply: '{"message":"The to address is invalid"}',
        }),
      }),
    ])
  })

  test('once Resend has taken it, a reply it cannot read does not make it a failed send', async () => {
    const s = await setup()
    const reportId = await report(s, {
      status: 'finalised',
      finalisedAt: Date.now(),
    })
    await withPdf(s, reportId)
    const { deliveryId } = await s.owner.as.mutation(api.deliveries.request, {
      businessId: s.businessId,
      reportId,
      to: [CLIENT],
    })
    vi.stubEnv('RESEND_API_KEY', 're_test')
    vi.stubEnv('RESEND_FROM_EMAIL', 'info@pestm8.com.au')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === 'https://api.resend.com/emails'
          ? new Response('<html>accepted</html>', { status: 200 })
          : new Response(new Blob(['%PDF-1.7 test']), { status: 200 }),
      ),
    )

    // The email went: "Could not email" would have someone send it again.
    expect(await s.t.action(internal.email.deliver, { deliveryId })).toEqual({
      ok: true,
    })
    const [row] = await deliveries(s)
    expect(row.status).toBe('sent')
    expect(row.providerMessageId).toBeUndefined()
    const logs = await s.owner.as.query(api.auditLog.forEntity, {
      businessId: s.businessId,
      entityType: 'reports',
      entityId: reportId,
    })
    expect(
      logs
        .filter((e) => e.action.startsWith('report.email'))
        .map((e) => e.action),
    ).toEqual(['report.email.sent'])
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
