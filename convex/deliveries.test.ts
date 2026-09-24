/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import schema from './schema'
import { internal } from './_generated/api'
import { getTemplate } from '../src/lib/reportTemplates'
import { deliveryRecipients } from '../src/lib/reportTemplates/delivery'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

const modules = import.meta.glob('./**/*.ts')

/**
 * What the form asks for, and what a settled delivery records.
 *
 * The recipient RULE — a technician may send where the business already
 * corresponds, and an owner decides the rest — is exercised in
 * `e2e/deliveries.spec.ts` instead: it runs through `requireMembership`, and
 * convex-test has no Better Auth component registered to answer that.
 */

async function seed(ctx: MutationCtx, options: { clientEmail?: string } = {}) {
  const now = Date.now()
  const businessId = await ctx.db.insert('businesses', {
    name: 'Pest M8 Pest Control',
    slug: `pest-m8-${now}`,
    state: 'WA',
    timezone: 'Australia/Perth',
    email: 'office@pestm8.example',
    createdAt: now,
  })
  const ownerId = await ctx.db.insert('memberships', {
    userId: 'user_owner',
    businessId,
    role: 'owner',
    canViewAllJobs: true,
    colour: '#C8102E',
    status: 'active',
    createdAt: now,
  })
  const techId = await ctx.db.insert('memberships', {
    userId: 'user_tech',
    businessId,
    role: 'subcontractor',
    canViewAllJobs: true,
    colour: '#0A84FF',
    status: 'active',
    createdAt: now,
  })
  const clientId = await ctx.db.insert('clients', {
    businessId,
    kind: 'person',
    name: 'J. Nguyen',
    ...(options.clientEmail ? { email: options.clientEmail } : {}),
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
  return { businessId, ownerId, techId, clientId, propertyId }
}

type Ids = Awaited<ReturnType<typeof seed>>

async function finalisedReport(
  ctx: MutationCtx,
  ids: Ids,
  author: Id<'memberships'>,
  extra: Partial<Doc<'reports'>> = {},
): Promise<Id<'reports'>> {
  return ctx.db.insert('reports', {
    businessId: ids.businessId,
    propertyId: ids.propertyId,
    authorMembershipId: author,
    template: 'serviceReport',
    templateVersion: getTemplate('serviceReport').version,
    legalBasis: 'APVMA · AEPMA',
    status: 'finalised',
    data: {},
    photoIds: [],
    finalisedAt: Date.now(),
    createdAt: Date.now(),
    ...extra,
  })
}

describe('what the form itself asks for', () => {
  const template = getTemplate('serviceReport')

  test('the send-copy toggle means the client, when there is a client email', () => {
    const { to, cc } = deliveryRecipients(
      template,
      { sendCopy: true },
      {
        clientEmail: 'Client@Example.com',
        businessCopyEmail: 'office@pestm8.example',
      },
    )
    // Lower-cased, because case is not what makes two addresses different.
    expect(to).toEqual(['client@example.com'])
    expect(cc).toEqual(['office@pestm8.example'])
  })

  test('the toggle asks for nobody when the client has no email on file', () => {
    const { to } = deliveryRecipients(
      template,
      { sendCopy: true },
      { clientEmail: null },
    )
    expect(to).toEqual([])
  })

  test('"Email Report To" adds whoever was typed there', () => {
    const { to } = deliveryRecipients(
      template,
      {
        sendCopy: true,
        emailReportTo: ['strata@example.com', ' agent@example.com '],
      },
      { clientEmail: 'client@example.com' },
    )
    expect(to).toEqual([
      'client@example.com',
      'strata@example.com',
      'agent@example.com',
    ])
  })

  test('a business that is also the client is copied once, not twice', () => {
    const { to, cc } = deliveryRecipients(
      template,
      { sendCopy: true },
      {
        clientEmail: 'office@pestm8.example',
        businessCopyEmail: 'office@pestm8.example',
      },
    )
    expect(to).toEqual(['office@pestm8.example'])
    expect(cc).toEqual([])
  })

  test('a form that asked for nothing sends to nobody', () => {
    expect(
      deliveryRecipients(template, {}, { clientEmail: 'client@example.com' })
        .to,
    ).toEqual([])
  })
})

describe('what a settled delivery records', () => {
  async function queued(ids: Ids, t: ReturnType<typeof convexTest>) {
    const reportId = await t.run((ctx) =>
      finalisedReport(ctx, ids, ids.ownerId),
    )
    const deliveryId = await t.mutation(internal.deliveries.queue, {
      reportId,
      to: ['client@example.com'],
      cc: [],
      subject: 'Service Report — 30 Sloan Drive, Leda',
      trigger: 'finalise',
      status: 'queued',
      sentByMembershipId: ids.ownerId,
    })
    return { reportId, deliveryId }
  }

  test('a send marks the report emailed and keeps the file it attached', async () => {
    const t = convexTest(schema, modules)
    const ids = await t.run((ctx) =>
      seed(ctx, { clientEmail: 'client@example.com' }),
    )
    const { reportId, deliveryId } = await queued(ids, t)

    const pdfId = await t.run(async (ctx) => {
      // A real stored file: the id has to be one `_storage` will accept, and
      // a made-up string is not.
      const storage = ctx.storage as unknown as {
        store: (blob: Blob) => Promise<Id<'_storage'>>
      }
      const storageId = await storage.store(
        new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
      )
      return ctx.db.insert('reportPdfs', {
        businessId: ids.businessId,
        reportId,
        storageId,
        rendererVersion: 2,
        version: 1,
        bytes: 1024,
        createdAt: Date.now(),
      })
    })

    await t.mutation(internal.deliveries.settle, {
      deliveryId,
      status: 'sent',
      pdfId,
      providerMessageId: 'resend-abc',
    })

    const row = await t.run((ctx) => ctx.db.get(deliveryId))
    expect(row?.status).toBe('sent')
    expect(row?.sentAt).toBeTypeOf('number')
    // Which file the client actually received, so the question has an answer
    // after the renderer has moved on.
    expect(row?.pdfId).toBe(pdfId)
    expect(row?.providerMessageId).toBe('resend-abc')

    const report = await t.run((ctx) => ctx.db.get(reportId))
    expect(report?.emailedAt).toBeTypeOf('number')
  })

  test('a failure is kept, and does not claim the report was emailed', async () => {
    const t = convexTest(schema, modules)
    const ids = await t.run((ctx) =>
      seed(ctx, { clientEmail: 'client@example.com' }),
    )
    const { reportId, deliveryId } = await queued(ids, t)

    await t.mutation(internal.deliveries.settle, {
      deliveryId,
      status: 'failed',
      error: 'Provider said no',
    })

    const row = await t.run((ctx) => ctx.db.get(deliveryId))
    expect(row?.status).toBe('failed')
    expect(row?.sentAt).toBeUndefined()
    const report = await t.run((ctx) => ctx.db.get(reportId))
    expect(report?.emailedAt).toBeUndefined()
  })

  test('only what is queued is picked up when the render lands', async () => {
    const t = convexTest(schema, modules)
    const ids = await t.run((ctx) =>
      seed(ctx, { clientEmail: 'client@example.com' }),
    )
    const { reportId, deliveryId } = await queued(ids, t)

    const held = await t.mutation(internal.deliveries.queue, {
      reportId,
      to: ['someone@elsewhere.example'],
      cc: [],
      subject: 'Service Report',
      trigger: 'manual',
      status: 'pendingApproval',
      sentByMembershipId: ids.techId,
    })

    const ready = await t.query(internal.deliveries.readyForReport, {
      reportId,
    })
    // The held one stays held: a render finishing is not an approval.
    expect(ready).toEqual([deliveryId])
    expect(ready).not.toContain(held)
  })
})

describe('what the provider says afterwards', () => {
  async function sent(t: ReturnType<typeof convexTest>, ids: Ids) {
    const reportId = await t.run((ctx) =>
      finalisedReport(ctx, ids, ids.ownerId),
    )
    const deliveryId = await t.mutation(internal.deliveries.queue, {
      reportId,
      to: ['client@example.com'],
      cc: [],
      subject: 'Service Report',
      trigger: 'manual',
      status: 'queued',
      sentByMembershipId: ids.ownerId,
    })
    await t.mutation(internal.deliveries.settle, {
      deliveryId,
      status: 'sent',
      providerMessageId: 'resend-abc',
    })
    return { reportId, deliveryId }
  }

  test('a bounce stops the report claiming it was sent', async () => {
    const t = convexTest(schema, modules)
    const ids = await t.run((ctx) =>
      seed(ctx, { clientEmail: 'client@example.com' }),
    )
    const { reportId, deliveryId } = await sent(t, ids)

    await t.mutation(internal.deliveries.recordProviderEvent, {
      providerMessageId: 'resend-abc',
      event: 'bounced',
      detail: 'Mailbox does not exist',
    })

    const row = await t.run((ctx) => ctx.db.get(deliveryId))
    expect(row?.status).toBe('bounced')
    expect(row?.error).toBe('Mailbox does not exist')

    // "Sent" is what the library's bucket reads, and a report the client
    // never received is not a sent one.
    const report = await t.run((ctx) => ctx.db.get(reportId))
    expect(report?.emailedAt).toBeUndefined()
  })

  test('a bounce to one recipient leaves a good send standing', async () => {
    const t = convexTest(schema, modules)
    const ids = await t.run((ctx) =>
      seed(ctx, { clientEmail: 'client@example.com' }),
    )
    const { reportId, deliveryId } = await sent(t, ids)

    const second = await t.mutation(internal.deliveries.queue, {
      reportId,
      to: ['office@example.com'],
      cc: [],
      subject: 'Service Report',
      trigger: 'manual',
      status: 'queued',
      sentByMembershipId: ids.ownerId,
    })
    await t.mutation(internal.deliveries.settle, {
      deliveryId: second,
      status: 'sent',
      providerMessageId: 'resend-def',
    })

    await t.mutation(internal.deliveries.recordProviderEvent, {
      providerMessageId: 'resend-abc',
      event: 'bounced',
    })

    const row = await t.run((ctx) => ctx.db.get(deliveryId))
    expect(row?.status).toBe('bounced')
    // Somebody still received it, so the report has been sent.
    const report = await t.run((ctx) => ctx.db.get(reportId))
    expect(report?.emailedAt).toBeTypeOf('number')
  })

  test('a delivery confirmation changes nothing', async () => {
    const t = convexTest(schema, modules)
    const ids = await t.run((ctx) =>
      seed(ctx, { clientEmail: 'client@example.com' }),
    )
    const { deliveryId } = await sent(t, ids)

    await t.mutation(internal.deliveries.recordProviderEvent, {
      providerMessageId: 'resend-abc',
      event: 'delivered',
    })
    const row = await t.run((ctx) => ctx.db.get(deliveryId))
    expect(row?.status).toBe('sent')
  })

  test('an event for a message this deployment never sent is ignored', async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) => seed(ctx, { clientEmail: 'client@example.com' }))

    // Noise, not a failure: another deployment's webhook, or a replay.
    await expect(
      t.mutation(internal.deliveries.recordProviderEvent, {
        providerMessageId: 'resend-unknown',
        event: 'bounced',
      }),
    ).resolves.toBeNull()
  })
})
