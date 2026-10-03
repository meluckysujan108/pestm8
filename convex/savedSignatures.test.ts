/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { getTemplate } from '../src/lib/reportTemplates'
import { CLAIM_WINDOW_MS } from './lib/products'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * Signatures as they are kept: each person's own saved signature, set and
 * removed by them alone, and a drawing on a report claimed as an upload is —
 * fresh, held by nothing else — with the strokes it was drawn from kept
 * beside it and never handed to a reader.
 *
 * convex-test stores no content type, so the type rules are tested in
 * lib/signatures.test.ts.
 */

afterEach(() => {
  vi.useRealTimers()
})

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, { email: 'kevin@coastal.test' })
  const kevinMembershipId = await join(t, owner, kevin, businessId)
  const priya = await createActor(t, { email: 'priya@coastal.test' })
  const priyaMembershipId = await join(t, owner, priya, businessId)
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
  return {
    t,
    owner,
    kevin,
    priya,
    businessId,
    ownerMembershipId,
    kevinMembershipId,
    priyaMembershipId,
    propertyId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function join(
  t: TestApp,
  owner: TestActor,
  invitee: TestActor,
  businessId: Id<'businesses'>,
) {
  const { url } = await owner.as.action(api.invitations.create, {
    businessId,
    email: invitee.email,
    role: 'subcontractor',
  })
  await invitee.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })
  const membership = await t.run(async (ctx) =>
    ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', invitee.userId).eq('businessId', businessId),
      )
      .unique(),
  )
  return membership!._id
}

/** A file, as a browser's POST to an upload URL leaves one. */
function upload(s: Setup) {
  return s.t.run(async (ctx) =>
    ctx.storage.store(new Blob([new Uint8Array(64).fill(7)])),
  )
}

/** A Service Report draft of Kevin's. */
function draft(s: Setup, author: Id<'memberships'> = s.kevinMembershipId) {
  return s.t.run(async (ctx) =>
    ctx.db.insert('reports', {
      businessId: s.businessId,
      propertyId: s.propertyId,
      authorMembershipId: author,
      template: 'serviceReport',
      templateVersion: getTemplate('serviceReport').version,
      legalBasis: 'APVMA · AEPMA',
      status: 'draft',
      data: {},
      photoIds: [],
      createdAt: Date.now(),
    }),
  )
}

/** A member's saved signature, or null for none. */
function savedOf(s: Setup, membershipId: Id<'memberships'>) {
  return s.t.run(
    async (ctx) =>
      (await ctx.db.get(membershipId))?.savedSignatureStorageId ?? null,
  )
}

/** What a report holds in a signature slot, or null for nothing. */
function slotOf(s: Setup, reportId: Id<'reports'>, slot = 'technician') {
  return s.t.run(
    async (ctx) => (await ctx.db.get(reportId))?.signatureSlots?.[slot] ?? null,
  )
}

function sign(
  s: Setup,
  as: TestActor,
  reportId: Id<'reports'>,
  storageId: Id<'_storage'>,
  extra: {
    method?: 'drawn' | 'saved'
    saveForMember?: boolean
    strokesStorageId?: Id<'_storage'>
    drawnAt?: number
  } = {},
) {
  return as.as.mutation(api.reports.attachSignature, {
    businessId: s.businessId,
    reportId,
    storageId,
    slot: 'technician',
    ...extra,
  })
}

describe('My signature', () => {
  test('is set and removed by its owner alone, on their own membership', async () => {
    const s = await setup()
    const drawn = await upload(s)
    await s.kevin.as.mutation(api.reports.setMySavedSignature, {
      businessId: s.businessId,
      storageId: drawn,
    })
    expect(await savedOf(s, s.kevinMembershipId)).toBe(drawn)
    expect(await savedOf(s, s.priyaMembershipId)).toBeNull()
    expect(
      await s.kevin.as.query(api.reports.mySavedSignature, {
        businessId: s.businessId,
      }),
    ).toMatchObject({ storageId: drawn })
    expect(
      await s.priya.as.query(api.reports.mySavedSignature, {
        businessId: s.businessId,
      }),
    ).toBeNull()

    // Priya's remove is hers: Kevin's stays.
    await s.priya.as.mutation(api.reports.clearMySavedSignature, {
      businessId: s.businessId,
    })
    expect(await savedOf(s, s.kevinMembershipId)).toBe(drawn)

    await s.kevin.as.mutation(api.reports.clearMySavedSignature, {
      businessId: s.businessId,
    })
    expect(await savedOf(s, s.kevinMembershipId)).toBeNull()
    // Reports signed with it still print it.
    expect(
      await s.t.run((ctx) => ctx.db.system.get('_storage', drawn)),
    ).not.toBeNull()
  })

  test('is never someone else’s signature, nor an old upload', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = await setup()
    const priyas = await upload(s)
    await s.priya.as.mutation(api.reports.setMySavedSignature, {
      businessId: s.businessId,
      storageId: priyas,
    })
    await expect(
      s.kevin.as.mutation(api.reports.setMySavedSignature, {
        businessId: s.businessId,
        storageId: priyas,
      }),
    ).rejects.toThrow(/NOT_YOUR_SIGNATURE/)

    const stale = await upload(s)
    vi.setSystemTime(Date.now() + CLAIM_WINDOW_MS + 1000)
    await expect(
      s.kevin.as.mutation(api.reports.setMySavedSignature, {
        businessId: s.businessId,
        storageId: stale,
      }),
    ).rejects.toThrow(/FILE_NOT_FOUND/)
    expect(await savedOf(s, s.kevinMembershipId)).toBeNull()
  })

  test('is never a file something else holds', async () => {
    const s = await setup()
    const productPdf = await upload(s)
    await s.owner.as.mutation(api.products.create, {
      businessId: s.businessId,
      name: 'Termidor',
      pdf: { storageId: productPdf, fileName: 'sds.pdf' },
    })
    await expect(
      s.kevin.as.mutation(api.reports.setMySavedSignature, {
        businessId: s.businessId,
        storageId: productPdf,
      }),
    ).rejects.toThrow(/ALREADY_ATTACHED/)
  })
})

describe('a signature on a report', () => {
  test('applies a saved signature only for the person it belongs to', async () => {
    const s = await setup()
    const reportId = await draft(s)
    const priyas = await upload(s)
    await s.priya.as.mutation(api.reports.setMySavedSignature, {
      businessId: s.businessId,
      storageId: priyas,
    })
    // As a saved signature, and dressed as a fresh drawing.
    await expect(
      sign(s, s.kevin, reportId, priyas, { method: 'saved' }),
    ).rejects.toThrow(/NOT_YOUR_SIGNATURE/)
    await expect(sign(s, s.kevin, reportId, priyas)).rejects.toThrow(
      /NOT_YOUR_SIGNATURE/,
    )

    const kevins = await upload(s)
    await s.kevin.as.mutation(api.reports.setMySavedSignature, {
      businessId: s.businessId,
      storageId: kevins,
    })
    await sign(s, s.kevin, reportId, kevins, { method: 'saved' })
    expect(await slotOf(s, reportId)).toMatchObject({
      storageId: kevins,
      method: 'saved',
    })
  })

  test('records the saved signature as saved, whatever the call says', async () => {
    const s = await setup()
    const reportId = await draft(s)
    const kevins = await upload(s)
    await s.kevin.as.mutation(api.reports.setMySavedSignature, {
      businessId: s.businessId,
      storageId: kevins,
    })
    await sign(s, s.kevin, reportId, kevins, { method: 'drawn' })
    expect(await slotOf(s, reportId)).toMatchObject({ method: 'saved' })
  })

  test('takes a drawing only as a fresh upload nothing else holds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = await setup()
    const reportId = await draft(s)
    const productPdf = await upload(s)
    await s.owner.as.mutation(api.products.create, {
      businessId: s.businessId,
      name: 'Termidor',
      pdf: { storageId: productPdf, fileName: 'sds.pdf' },
    })
    await expect(sign(s, s.kevin, reportId, productPdf)).rejects.toThrow(
      /ALREADY_ATTACHED/,
    )

    const stale = await upload(s)
    vi.setSystemTime(Date.now() + CLAIM_WINDOW_MS + 1000)
    await expect(sign(s, s.kevin, reportId, stale)).rejects.toThrow(
      /FILE_NOT_FOUND/,
    )
    expect(await slotOf(s, reportId)).toBeNull()
  })

  test('keeps the strokes beside the image, and hands neither id to a reader', async () => {
    const s = await setup()
    const reportId = await draft(s)
    const image = await upload(s)
    const strokes = await upload(s)
    await sign(s, s.kevin, reportId, image, { strokesStorageId: strokes })
    expect(await slotOf(s, reportId)).toMatchObject({
      storageId: image,
      strokesStorageId: strokes,
      method: 'drawn',
    })

    for (const reader of [s.kevin, s.owner]) {
      const report = await reader.as.query(api.reports.get, {
        businessId: s.businessId,
        reportId,
      })
      const record = report?.signatureSlots?.technician
      expect(record).toBeDefined()
      expect(record).not.toHaveProperty('storageId')
      expect(record).not.toHaveProperty('strokesStorageId')
      expect(JSON.stringify(report)).not.toContain(strokes)
    }
  })

  test('never keeps strokes with a saved signature, nor the image as its own strokes', async () => {
    const s = await setup()
    const reportId = await draft(s)
    const kevins = await upload(s)
    await s.kevin.as.mutation(api.reports.setMySavedSignature, {
      businessId: s.businessId,
      storageId: kevins,
    })
    const strokes = await upload(s)
    await expect(
      sign(s, s.kevin, reportId, kevins, {
        method: 'saved',
        strokesStorageId: strokes,
      }),
    ).rejects.toThrow(/FILE_NOT_FOUND/)

    const image = await upload(s)
    await expect(
      sign(s, s.kevin, reportId, image, { strokesStorageId: image }),
    ).rejects.toThrow(/FILE_NOT_FOUND/)
  })

  test('is stamped with when it was drawn when it arrives later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = await setup()
    const reportId = await draft(s)
    const drawnAt = Date.now() + 60_000
    // Drawn a minute after the report was started, with no signal; the
    // upload and the save come ten minutes later.
    vi.setSystemTime(drawnAt + 10 * 60 * 1000)
    const image = await upload(s)
    const arrived = Date.now()
    const result = await sign(s, s.kevin, reportId, image, { drawnAt })
    expect(result).toEqual({ signedAt: drawnAt })
    expect(await slotOf(s, reportId)).toMatchObject({
      signedAt: drawnAt,
      receivedAt: arrived,
    })
  })

  test('is stamped with its arrival when the phone’s time could not be true', async () => {
    const s = await setup()
    const reportId = await draft(s)
    const image = await upload(s)
    const before = Date.now()
    await sign(s, s.kevin, reportId, image, { drawnAt: 0 })
    const slot = await slotOf(s, reportId)
    expect(slot?.signedAt).toBeGreaterThanOrEqual(before)
    expect(slot).not.toHaveProperty('receivedAt')
  })

  test('saves a drawing as the signer’s own only when asked, and only theirs', async () => {
    const s = await setup()
    const reportId = await draft(s)
    const image = await upload(s)
    await sign(s, s.kevin, reportId, image)
    expect(await savedOf(s, s.kevinMembershipId)).toBeNull()

    const again = await upload(s)
    await sign(s, s.kevin, reportId, again, { saveForMember: true })
    expect(await savedOf(s, s.kevinMembershipId)).toBe(again)
    expect(await savedOf(s, s.priyaMembershipId)).toBeNull()
  })
})
