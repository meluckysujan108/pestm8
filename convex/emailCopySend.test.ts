/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { getTemplate } from '../src/lib/reportTemplates'
import { RENDER_VERSION } from './reports'
import { EMAIL_BUDGET_BYTES } from './lib/emailFit'
import type { CopyResult } from './lib/emailCopyBuild'
import type { Doc, Id } from './_generated/dataModel'

/**
 * Sending a report too big to email: it goes as its lighter copy.
 *
 * The copy's making is real in `emailCopy.test.ts` (codecs, painter and all)
 * and stood in for here, where what is under test is everything around it:
 * that a report which fits goes exactly as it always did, that one which does
 * not goes as a copy made once and kept, that the delivery records the file
 * that went, and that a copy that cannot be made fails the send as before.
 */

const made = vi.hoisted(() => ({
  /** What the next copy comes out as; each call is counted. */
  next: null as null | (() => CopyResult),
  calls: 0,
}))

vi.mock('./lib/emailCopyBuild', () => ({
  buildEmailCopy: async () => {
    made.calls++
    if (!made.next) throw new Error('no copy expected here')
    return made.next()
  },
}))

const CLIENT = 'jane@gmail.com'
const STATS = {
  photos: 53,
  cover: 1,
  sampled: 8,
  tier: { edge: 1000, quality: 75 },
  passes: 1,
  encoded: 60,
  shrunk: 52,
  kept: 0,
  photoBytesBefore: 34_000_000,
  photoBytesAfter: 5_000_000,
  canonicalBytes: 35_297_314,
  copyBytes: 5_900_000,
  images: { original: 54, copy: 54, expected: 54 },
  ms: {},
}
const LIGHTER = new TextEncoder().encode('%PDF-1.7 lighter copy')

function aCopy(): CopyResult {
  return {
    ok: true,
    pdf: LIGHTER,
    tier: { edge: 1000, quality: 75 },
    stats: STATS,
  }
}

beforeEach(() => {
  made.next = null
  made.calls = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

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
  const reportId = await t.run(async (ctx) => {
    await ctx.db.patch(businessId, { email: 'info@pestm8.com.au' })
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'Jane Nguyen',
      email: CLIENT,
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
    return ctx.db.insert('reports', {
      businessId,
      propertyId,
      authorMembershipId: ownerMembershipId,
      template: 'serviceReport',
      templateVersion: getTemplate('serviceReport').version,
      legalBasis: 'APVMA · AEPMA',
      status: 'finalised',
      finalisedAt: now,
      data: {},
      photoIds: [],
      createdAt: now,
    })
  })
  return { t, owner, businessId, reportId }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** The report's own PDF, drawn at the current painter, of this many bytes. */
function drawn(s: Setup, bytes: number) {
  return s.t.run(async (ctx) => {
    const content = new Uint8Array(bytes)
    content.set(new TextEncoder().encode('%PDF-1.7'))
    const storageId = await ctx.storage.store(
      new Blob([content], { type: 'application/pdf' }),
    )
    const pdfId = await ctx.db.insert('reportPdfs', {
      businessId: s.businessId,
      reportId: s.reportId,
      storageId,
      rendererVersion: RENDER_VERSION,
      version: 1,
      bytes,
      createdAt: Date.now(),
    })
    await ctx.db.patch(s.reportId, {
      pdfStorageId: storageId,
      pdfRenderVersion: RENDER_VERSION,
      pdfStatus: 'ready',
    })
    return { storageId, pdfId }
  })
}

const TOO_BIG = EMAIL_BUDGET_BYTES + 1

/** Resend and storage, faked: what was sent, and which files were fetched. */
function fakeResend() {
  vi.stubEnv('RESEND_API_KEY', 're_test')
  vi.stubEnv('RESEND_FROM_EMAIL', 'info@pestm8.com.au')
  const sent: Array<{ attachments: Array<{ content: string }> }> = []
  const fetched: Array<string> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.resend.com/emails') {
        sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number])
        return new Response(JSON.stringify({ id: `msg_${sent.length}` }), {
          status: 200,
        })
      }
      fetched.push(url)
      return new Response(new Blob([LIGHTER]), { status: 200 })
    }),
  )
  return { sent, fetched }
}

async function send(s: Setup, to = CLIENT) {
  const { deliveryId } = await s.owner.as.mutation(api.deliveries.request, {
    businessId: s.businessId,
    reportId: s.reportId,
    to: [to],
  })
  return deliveryId
}

const deliveryRow = (s: Setup, id: Id<'reportDeliveries'>) =>
  s.t.run((ctx) => ctx.db.get(id))

const copies = (s: Setup) =>
  s.t.run(async (ctx) =>
    (
      await ctx.db
        .query('reportPdfs')
        .withIndex('by_report', (q) => q.eq('reportId', s.reportId))
        .collect()
    ).filter((row) => row.variant === 'email'),
  )

const logs = (s: Setup) =>
  s.owner.as.query(api.auditLog.forEntity, {
    businessId: s.businessId,
    entityType: 'reports',
    entityId: s.reportId,
  })

describe('a report that fits an email', () => {
  test('goes as it always did: its own PDF, and no copy made', async () => {
    const s = await setup()
    const { pdfId } = await drawn(s, 400_000)
    const deliveryId = await send(s)
    const { sent } = fakeResend()

    expect(await s.t.action(internal.email.deliver, { deliveryId })).toEqual({
      ok: true,
    })

    expect(sent).toHaveLength(1)
    expect(made.calls).toBe(0)
    expect(await copies(s)).toEqual([])
    // The delivery names the file it attached.
    expect((await deliveryRow(s, deliveryId))?.pdfId).toBe(pdfId)
    const line = (await logs(s)).find((e) => e.action === 'report.email.sent')
    expect(line?.meta).not.toHaveProperty('lighterCopy')
    const [history] = await s.owner.as.query(api.deliveries.forReport, {
      businessId: s.businessId,
      reportId: s.reportId,
    })
    expect(history.lighterCopy).toBe(false)
  })
})

describe('a report too big to email', () => {
  test('goes as its lighter copy, and the report keeps its own PDF', async () => {
    const s = await setup()
    const original = await drawn(s, TOO_BIG)
    const deliveryId = await send(s)
    const { sent, fetched } = fakeResend()
    made.next = aCopy

    expect(await s.t.action(internal.email.deliver, { deliveryId })).toEqual({
      ok: true,
    })

    const [copy] = await copies(s)
    expect(copy).toMatchObject({
      sourceStorageId: original.storageId,
      photoEdge: 1000,
      bytes: LIGHTER.length,
      rendererVersion: RENDER_VERSION,
    })
    // The copy was what went, and nothing else was fetched to send.
    const copyUrl = await s.t.run((ctx) => ctx.storage.getUrl(copy.storageId))
    const originalUrl = await s.t.run((ctx) =>
      ctx.storage.getUrl(original.storageId),
    )
    expect(fetched).toContain(copyUrl)
    expect(fetched).not.toContain(originalUrl)
    expect(sent).toHaveLength(1)
    expect((await deliveryRow(s, deliveryId))?.pdfId).toBe(copy._id)

    // The report still points at its own, full-size PDF.
    const report = await s.t.run((ctx) => ctx.db.get(s.reportId))
    expect(report?.pdfStorageId).toBe(original.storageId)

    // Said where an owner reads it: the Email tab, and the Logs.
    const [history] = await s.owner.as.query(api.deliveries.forReport, {
      businessId: s.businessId,
      reportId: s.reportId,
    })
    expect(history.lighterCopy).toBe(true)
    const line = (await logs(s)).find((e) => e.action === 'report.email.sent')
    expect(line?.meta).toMatchObject({ lighterCopy: true, photoEdge: 1000 })
  })

  test('the copy is made once: a second recipient gets the same file', async () => {
    const s = await setup()
    await drawn(s, TOO_BIG)
    const first = await send(s)
    const second = await send(s, 'strata@harbourside.example')
    fakeResend()
    made.next = aCopy

    await s.t.action(internal.email.deliver, { deliveryId: first })
    await s.t.action(internal.email.deliver, { deliveryId: second })

    expect(made.calls).toBe(1)
    expect(await copies(s)).toHaveLength(1)
    const [a, b] = await Promise.all([
      deliveryRow(s, first),
      deliveryRow(s, second),
    ])
    expect(a?.pdfId).toBeDefined()
    expect(a?.pdfId).toBe(b?.pdfId)
  })

  test('when no copy can be made, it fails as it always did, and says so in words', async () => {
    const s = await setup()
    await drawn(s, TOO_BIG)
    const deliveryId = await send(s)
    const { sent } = fakeResend()
    made.next = () => ({
      ok: false,
      reason: 'too many photos to fit an email, even at the floor',
      stats: STATS,
    })

    await expect(
      s.t.action(internal.email.deliver, { deliveryId }),
    ).rejects.toThrow(/PDF_TOO_LARGE/)

    expect(sent).toEqual([])
    expect(await copies(s)).toEqual([])
    expect(await deliveryRow(s, deliveryId)).toMatchObject({
      status: 'failed',
      error:
        'Not sent: the report is too large to email, even with its photos made smaller. Share it from the PDF tab instead.',
    })
  })

  test('a copy is only ever of the file it was made from', async () => {
    const s = await setup()
    await drawn(s, TOO_BIG)
    fakeResend()
    made.next = aCopy
    await s.t.action(internal.email.deliver, { deliveryId: await send(s) })

    // Drawn again — a new painter version — so the old copy is of a file
    // that is no longer the report's.
    await drawn(s, TOO_BIG)
    await s.t.action(internal.email.deliver, { deliveryId: await send(s) })

    expect(made.calls).toBe(2)
    const rows = await copies(s)
    expect(new Set(rows.map((row) => row.sourceStorageId)).size).toBe(2)
  })
})

describe('writing a copy down', () => {
  test('two made at the same moment leave one copy, and the other file goes', async () => {
    const s = await setup()
    const { storageId: sourceStorageId } = await drawn(s, TOO_BIG)
    const store = () =>
      s.t.run((ctx) =>
        ctx.storage.store(new Blob([LIGHTER], { type: 'application/pdf' })),
      )
    const [one, two] = [await store(), await store()]
    const record = (storageId: Id<'_storage'>) =>
      s.t.mutation(internal.emailCopies.record, {
        reportId: s.reportId,
        sourceStorageId,
        storageId,
        bytes: LIGHTER.length,
        photoEdge: 1000,
      })

    const first = await record(one)
    const second = await record(two)

    expect(second).toEqual(first)
    expect(await copies(s)).toHaveLength(1)
    const stored = (storageId: Id<'_storage'>) =>
      s.t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)
    expect(await stored(two)).toBe(false)
    expect(await stored(one)).toBe(true)
  })
})

describe('the sheets are told before anything is sent', () => {
  const large = (s: Setup) =>
    s.owner.as
      .query(api.deliveries.known, {
        businessId: s.businessId,
        reportId: s.reportId,
      })
      .then((known) => known.largeForEmail)

  test('by the PDF, once there is one', async () => {
    const small = await setup()
    await drawn(small, 400_000)
    expect(await large(small)).toBe(false)

    const big = await setup()
    await drawn(big, TOO_BIG)
    expect(await large(big)).toBe(true)
  })

  test('by the photos it will print, before there is a PDF', async () => {
    const s = await setup()
    await s.t.run(async (ctx) => {
      for (let order = 0; order < 4; order++) {
        const storageId = await ctx.storage.store(
          new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/jpeg' }),
        )
        await ctx.db.insert('reportPhotos', {
          reportId: s.reportId,
          fieldKey: 'photos',
          storageId,
          order,
          isCover: false,
          createdAt: Date.now(),
        } satisfies Omit<Doc<'reportPhotos'>, '_id' | '_creationTime'>)
      }
    })
    const answer = (addPhotos: boolean) =>
      s.t.run((ctx) => ctx.db.patch(s.reportId, { data: { addPhotos } }))

    // "Add photos to the report?" Yes: 8 MB of them will print.
    await answer(true)
    expect(await large(s)).toBe(true)
    // No: they stay in the report's table, and print nowhere.
    await answer(false)
    expect(await large(s)).toBe(false)
  })

  test('by the size each photo was recorded at, where it was', async () => {
    const s = await setup()
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.reportId, { data: { addPhotos: true } })
      // A small file recorded, at upload, as the big photo it was.
      const storageId = await ctx.storage.store(
        new Blob([new Uint8Array(10)], { type: 'image/jpeg' }),
      )
      await ctx.db.insert('reportPhotos', {
        reportId: s.reportId,
        fieldKey: 'photos',
        storageId,
        order: 0,
        isCover: false,
        bytes: TOO_BIG,
        createdAt: Date.now(),
      })
    })
    expect(await large(s)).toBe(true)
  })
})
