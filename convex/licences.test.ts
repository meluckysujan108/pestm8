/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { SWITCH_TTL_MS } from './lib/capabilities'
import { MAX_LICENCE_IMAGE_BYTES, MAX_LICENCE_PDF_BYTES } from './lib/licences'
import { CLAIM_WINDOW_MS } from './lib/products'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * Phase 8.1: each person's licence document — uploaded by its holder, read by
 * the holder and the owner, and nobody else.
 *
 * The risks: someone putting a file on another person's licence, a teammate
 * reading a licence card (a date of birth and a home address), and the claim
 * — an upload is taken by its storage id, and ids reach clients elsewhere, so
 * only a fresh, unclaimed upload of the right kind may become a licence.
 *
 * convex-test stores no content type, so these uploads are typed by the file
 * name they are claimed with (`licenceTypeOf`'s fallback); the type rules
 * themselves are tested in lib/licences.test.ts.
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
  const jo = await createActor(t, { email: 'jo@coastal.test' })
  const joMembershipId = await join(t, owner, jo, businessId, 'contractor')
  return {
    t,
    owner,
    kevin,
    priya,
    jo,
    businessId,
    ownerMembershipId,
    kevinMembershipId,
    priyaMembershipId,
    joMembershipId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function join(
  t: TestApp,
  owner: TestActor,
  invitee: TestActor,
  businessId: Id<'businesses'>,
  role: 'subcontractor' | 'contractor' = 'subcontractor',
) {
  const { url } = await owner.as.action(api.invitations.create, {
    businessId,
    email: invitee.email,
    role,
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
function upload(s: Setup, bytes = 3) {
  return s.t.run(async (ctx) =>
    ctx.storage.store(new Blob([new Uint8Array(bytes).fill(7)])),
  )
}

function licenceOf(s: Setup, membershipId: Id<'memberships'>) {
  return s.t.run(
    async (ctx) => (await ctx.db.get(membershipId))?.licenceFile ?? null,
  )
}

function setFile(
  s: Setup,
  as: TestActor,
  membershipId: Id<'memberships'>,
  storageId: Id<'_storage'>,
  fileName = 'licence.pdf',
) {
  return as.as.mutation(api.licences.setFile, {
    businessId: s.businessId,
    membershipId,
    storageId,
    fileName,
  })
}

function view(s: Setup, as: TestActor, membershipId: Id<'memberships'>) {
  return as.as.query(api.licences.file, {
    businessId: s.businessId,
    membershipId,
  })
}

describe('uploading a licence', () => {
  test('a member puts a PDF or a photo on their own licence', async () => {
    const s = await setup()
    const pdf = await upload(s, 40)
    const uploadedAt = await setFile(
      s,
      s.kevin,
      s.kevinMembershipId,
      pdf,
      'WA licence.PDF',
    )

    expect(await licenceOf(s, s.kevinMembershipId)).toEqual({
      storageId: pdf,
      kind: 'pdf',
      contentType: 'application/pdf',
      fileName: 'WA licence.pdf',
      size: 40,
      uploadedAt,
    })

    const own = await view(s, s.kevin, s.kevinMembershipId)
    expect(own).toMatchObject({
      kind: 'pdf',
      fileName: 'WA licence.pdf',
      size: 40,
      uploadedAt,
      mine: true,
    })
    expect(own?.url).toEqual(expect.any(String))
    // Never the storage id: the returns validator names none.
    expect(JSON.stringify(own)).not.toContain(pdf)

    const photo = await upload(s, 12)
    await setFile(s, s.priya, s.priyaMembershipId, photo, 'IMG_0412.JPEG')
    expect(await licenceOf(s, s.priyaMembershipId)).toMatchObject({
      kind: 'image',
      contentType: 'image/jpeg',
      fileName: 'IMG_0412.jpg',
    })
  })

  test('nobody puts a file on someone else’s licence — the owner included', async () => {
    const s = await setup()
    for (const [as, target] of [
      [s.priya, s.kevinMembershipId],
      [s.owner, s.kevinMembershipId],
      [s.jo, s.kevinMembershipId],
      [s.kevin, s.ownerMembershipId],
    ] as const) {
      await expect(setFile(s, as, target, await upload(s))).rejects.toThrow(
        /NO_ACCESS/,
      )
      await expect(
        as.as.mutation(api.licences.removeFile, {
          businessId: s.businessId,
          membershipId: target,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
    }
    expect(await licenceOf(s, s.kevinMembershipId)).toBeNull()
    expect(await licenceOf(s, s.ownerMembershipId)).toBeNull()
  })

  test('an owner switched into a technician’s account cannot upload theirs', async () => {
    const s = await setup()
    const now = Date.now()
    await s.t.run(async (ctx) =>
      ctx.db.insert('accountSwitches', {
        sessionId: s.owner.sessionId,
        businessId: s.businessId,
        realMembershipId: s.ownerMembershipId,
        targetMembershipId: s.kevinMembershipId,
        startedAt: now,
        expiresAt: now + SWITCH_TTL_MS,
      }),
    )
    await expect(
      setFile(s, s.owner, s.kevinMembershipId, await upload(s)),
    ).rejects.toThrow(/NO_ACCESS/)
    // Nor read it through the switch: `business.manage` does not cross one.
    await setFile(s, s.kevin, s.kevinMembershipId, await upload(s))
    await expect(view(s, s.owner, s.kevinMembershipId)).rejects.toThrow(
      /NO_ACCESS/,
    )
  })

  test('someone outside the business can do nothing with it', async () => {
    const s = await setup()
    const stranger = await createActor(s.t, { email: 'rival@other.test' })
    await createBusiness(s.t, stranger, 'Other Pest')
    await expect(
      stranger.as.mutation(api.licences.generateUploadUrl, {
        businessId: s.businessId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(view(s, stranger, s.kevinMembershipId)).rejects.toThrow(
      /NO_ACCESS/,
    )
  })

  test('replacing keeps working, and keeps the old file in storage', async () => {
    const s = await setup()
    const first = await upload(s)
    await setFile(s, s.kevin, s.kevinMembershipId, first, 'card.jpg')
    const second = await upload(s, 9)
    await setFile(s, s.kevin, s.kevinMembershipId, second, 'certificate.pdf')

    expect(await licenceOf(s, s.kevinMembershipId)).toMatchObject({
      storageId: second,
      kind: 'pdf',
      size: 9,
    })
    expect(
      await s.t.run(async (ctx) => ctx.db.system.get('_storage', first)),
    ).not.toBeNull()

    // The same upload sent again (a retry) is not a second claim.
    const again = await setFile(s, s.kevin, s.kevinMembershipId, second)
    expect(again).toBe((await licenceOf(s, s.kevinMembershipId))?.uploadedAt)

    await s.kevin.as.mutation(api.licences.removeFile, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
    })
    expect(await licenceOf(s, s.kevinMembershipId)).toBeNull()
    expect(await view(s, s.kevin, s.kevinMembershipId)).toBeNull()
    expect(
      await s.t.run(async (ctx) => ctx.db.system.get('_storage', second)),
    ).not.toBeNull()
  })
})

describe('what an upload may be', () => {
  test('anything but a PDF, PNG or JPEG is refused', async () => {
    const s = await setup()
    for (const name of ['licence.heic', 'licence.docx', 'licence.svg', 'x']) {
      await expect(
        setFile(s, s.kevin, s.kevinMembershipId, await upload(s), name),
      ).rejects.toThrow(/WRONG_FILE_TYPE/)
    }
    expect(await licenceOf(s, s.kevinMembershipId)).toBeNull()
  })

  test('a photo past its limit is refused; a PDF that size is not', async () => {
    const s = await setup()
    const big = await upload(s, MAX_LICENCE_IMAGE_BYTES + 1)
    await expect(
      setFile(s, s.kevin, s.kevinMembershipId, big, 'card.png'),
    ).rejects.toThrow(/FILE_TOO_LARGE/)
    await setFile(s, s.kevin, s.kevinMembershipId, big, 'card.pdf')
    expect((await licenceOf(s, s.kevinMembershipId))?.size).toBe(
      MAX_LICENCE_IMAGE_BYTES + 1,
    )

    const huge = await upload(s, MAX_LICENCE_PDF_BYTES + 1)
    await expect(
      setFile(s, s.priya, s.priyaMembershipId, huge, 'card.pdf'),
    ).rejects.toThrow(/FILE_TOO_LARGE/)
  })

  test('only a fresh upload can be claimed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = await setup()
    const start = Date.now()
    const stale = await upload(s)
    vi.setSystemTime(start + CLAIM_WINDOW_MS + 1000)
    await expect(
      setFile(s, s.kevin, s.kevinMembershipId, stale),
    ).rejects.toThrow(/FILE_NOT_FOUND/)
    expect(await licenceOf(s, s.kevinMembershipId)).toBeNull()
  })

  test('a file something else holds cannot be claimed, nor a licence by anything else', async () => {
    const s = await setup()

    // A product's PDF.
    const productPdf = await upload(s)
    await s.owner.as.mutation(api.products.create, {
      businessId: s.businessId,
      name: 'Termidor',
      pdf: { storageId: productPdf, fileName: 'sds.pdf' },
    })
    await expect(
      setFile(s, s.kevin, s.kevinMembershipId, productPdf),
    ).rejects.toThrow(/ALREADY_ATTACHED/)

    // Someone else's licence.
    const priyas = await upload(s)
    await setFile(s, s.priya, s.priyaMembershipId, priyas)
    await expect(
      setFile(s, s.kevin, s.kevinMembershipId, priyas),
    ).rejects.toThrow(/ALREADY_ATTACHED/)

    // And the other way: a licence's file on a product, where the whole
    // business would read it.
    await expect(
      s.priya.as.mutation(api.products.create, {
        businessId: s.businessId,
        name: 'Not a product',
        photoStorageId: priyas,
      }),
    ).rejects.toThrow(/ALREADY_ATTACHED/)
    expect(await licenceOf(s, s.kevinMembershipId)).toBeNull()
  })
})

describe('who may read a licence', () => {
  test('the holder and the owner; a teammate or a contractor is refused', async () => {
    const s = await setup()
    await setFile(s, s.kevin, s.kevinMembershipId, await upload(s))

    expect(await view(s, s.owner, s.kevinMembershipId)).toMatchObject({
      kind: 'pdf',
      mine: false,
    })
    for (const as of [s.priya, s.jo]) {
      await expect(view(s, as, s.kevinMembershipId)).rejects.toThrow(
        /NO_ACCESS/,
      )
    }
    // No licence answers null to the owner, not an error.
    expect(await view(s, s.owner, s.priyaMembershipId)).toBeNull()
  })

  test('the owner’s roster says who has one; nobody else’s does', async () => {
    const s = await setup()
    await setFile(s, s.kevin, s.kevinMembershipId, await upload(s))

    const roster = await s.owner.as.query(api.team.roster, {
      businessId: s.businessId,
    })
    const flags = Object.fromEntries(
      roster.map((m) => [m._id, m.hasLicenceFile]),
    )
    expect(flags[s.kevinMembershipId]).toBe(true)
    expect(flags[s.priyaMembershipId]).toBe(false)

    // A contractor manages a team, but cannot open a licence, so is not told.
    const theirs = await s.jo.as.query(api.team.roster, {
      businessId: s.businessId,
    })
    expect(theirs.every((m) => !m.hasLicenceFile)).toBe(true)
  })
})
