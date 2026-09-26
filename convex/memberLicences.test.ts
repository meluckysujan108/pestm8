/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { SWITCH_TTL_MS } from './lib/capabilities'
import { MAX_LICENCE_IMAGE_BYTES, MAX_LICENCE_PDF_BYTES } from './lib/licences'
import {
  MAX_LICENCES,
  MAX_LICENCE_FILES,
  MAX_LICENCE_NAME_LENGTH,
  MAX_LICENCE_NUMBER_LENGTH,
} from './lib/memberLicences'
import { CLAIM_WINDOW_MS } from './lib/products'
import { DEMO_PLAN } from './demo/shared'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * My licences: each person's wallet of licences — written by its holder
 * alone, read by the holder and the owner, and nobody else.
 *
 * The risks are those of the Phase 8.1 document (licences.test.ts), times
 * twenty: someone changing another person's licences, a teammate or a
 * contractor reading a licence card (a date of birth and a home address), and
 * the claim — an upload is taken by its storage id, and ids reach clients
 * elsewhere, so only a fresh, unclaimed upload of the right kind may become a
 * licence's file. Plus the move: the Phase 8.1 document is copied into the
 * wallet once, and only once.
 *
 * convex-test stores no content type, so these uploads are typed by the file
 * name they are claimed with (`licenceTypeOf`'s fallback); the type rules
 * themselves are tested in lib/licences.test.ts, and the name, number, date
 * and cap rules in lib/memberLicences.test.ts.
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
  // On Jo's team: the one person a contractor manages.
  const sam = await createActor(t, { email: 'sam@coastal.test' })
  const samMembershipId = await join(t, owner, sam, businessId)
  await owner.as.mutation(api.team.assignTo, {
    businessId,
    membershipId: samMembershipId,
    parentMembershipId: joMembershipId,
  })
  return {
    t,
    owner,
    kevin,
    priya,
    jo,
    sam,
    businessId,
    ownerMembershipId,
    kevinMembershipId,
    priyaMembershipId,
    joMembershipId,
    samMembershipId,
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

function create(
  s: Setup,
  as: TestActor,
  name = 'Pest management',
  extra: { number?: string; expiresOn?: string } = {},
) {
  return as.as.mutation(api.memberLicences.create, {
    businessId: s.businessId,
    name,
    ...extra,
  })
}

function addFile(
  s: Setup,
  as: TestActor,
  licenceId: Id<'memberLicences'>,
  storageId: Id<'_storage'>,
  fileName = 'licence.pdf',
) {
  return as.as.mutation(api.memberLicences.addFile, {
    businessId: s.businessId,
    licenceId,
    storageId,
    fileName,
  })
}

function list(s: Setup, as: TestActor, membershipId: Id<'memberships'>) {
  return as.as.query(api.memberLicences.list, {
    businessId: s.businessId,
    membershipId,
  })
}

/** Every write a caller might try on a licence and one of its files. */
function writes(
  s: Setup,
  as: TestActor,
  licenceId: Id<'memberLicences'>,
  fileId: Id<'memberLicenceFiles'>,
  storageId: Id<'_storage'>,
) {
  const businessId = s.businessId
  return {
    update: () =>
      as.as.mutation(api.memberLicences.update, {
        businessId,
        licenceId,
        name: 'Renamed',
        number: null,
      }),
    addFile: () => addFile(s, as, licenceId, storageId),
    removeFile: () =>
      as.as.mutation(api.memberLicences.removeFile, { businessId, fileId }),
    remove: () =>
      as.as.mutation(api.memberLicences.remove, { businessId, licenceId }),
  }
}

async function rows(s: Setup) {
  return s.t.run(async (ctx) => ({
    licences: await ctx.db.query('memberLicences').collect(),
    files: await ctx.db.query('memberLicenceFiles').collect(),
  }))
}

function stored(s: Setup, storageId: Id<'_storage'>) {
  return s.t.run(async (ctx) => ctx.db.system.get('_storage', storageId))
}

function auditOf(s: Setup, membershipId: Id<'memberships'>) {
  return s.t.run(async (ctx) =>
    ctx.db
      .query('auditLog')
      .withIndex('by_entity', (q) =>
        q.eq('entityType', 'memberships').eq('entityId', membershipId),
      )
      .collect(),
  )
}

/** Kevin with one licence holding one file. */
async function kevinsLicence(s: Setup) {
  const licenceId = await create(s, s.kevin, 'Pest management', {
    number: 'PMT 1234',
    expiresOn: '2027-06-30',
  })
  const storageId = await upload(s, 40)
  const { fileId } = await addFile(s, s.kevin, licenceId, storageId)
  return { licenceId, storageId, fileId }
}

function switchInto(
  s: Setup,
  realMembershipId: Id<'memberships'>,
  as: TestActor,
  targetMembershipId: Id<'memberships'>,
) {
  const now = Date.now()
  return s.t.run(async (ctx) =>
    ctx.db.insert('accountSwitches', {
      sessionId: as.sessionId,
      businessId: s.businessId,
      realMembershipId,
      targetMembershipId,
      startedAt: now,
      expiresAt: now + SWITCH_TTL_MS,
    }),
  )
}

describe('the holder keeps their own licences', () => {
  test('adds, renames, changes and clears one', async () => {
    const s = await setup()
    const licenceId = await create(s, s.kevin, '  Pest   management (WA) ', {
      number: ' PMT 1234 ',
      expiresOn: '2027-06-30',
    })

    const first = await list(s, s.kevin, s.kevinMembershipId)
    expect(first.mine).toBe(true)
    expect(first.licences).toEqual([
      {
        _id: licenceId,
        name: 'Pest management (WA)',
        number: 'PMT 1234',
        expiresOn: '2027-06-30',
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        files: [],
      },
    ])

    await s.kevin.as.mutation(api.memberLicences.update, {
      businessId: s.businessId,
      licenceId,
      name: 'Pest management',
      expiresOn: '2028-06-30',
    })
    let [licence] = (await list(s, s.kevin, s.kevinMembershipId)).licences
    expect(licence).toMatchObject({
      name: 'Pest management',
      number: 'PMT 1234', // left out, so left alone
      expiresOn: '2028-06-30',
    })

    // Null clears; so does an empty field, which is what a cleared input
    // sends. The name cannot be cleared.
    await s.kevin.as.mutation(api.memberLicences.update, {
      businessId: s.businessId,
      licenceId,
      number: null,
      expiresOn: '',
    })
    ;[licence] = (await list(s, s.kevin, s.kevinMembershipId)).licences
    expect(licence).not.toHaveProperty('number')
    expect(licence).not.toHaveProperty('expiresOn')
    await expect(
      s.kevin.as.mutation(api.memberLicences.update, {
        businessId: s.businessId,
        licenceId,
        name: '  ',
      }),
    ).rejects.toThrow(/INVALID_NAME/)

    // Saving what is there already changes nothing, and says nothing.
    const history = (await auditOf(s, s.kevinMembershipId)).length
    await s.kevin.as.mutation(api.memberLicences.update, {
      businessId: s.businessId,
      licenceId,
      name: 'Pest management',
      number: null,
    })
    expect((await auditOf(s, s.kevinMembershipId)).length).toBe(history)
    expect(
      (await list(s, s.kevin, s.kevinMembershipId)).licences[0].updatedAt,
    ).toBe(licence.updatedAt)
  })

  test('licences come oldest first, and each one’s files in the order added', async () => {
    const s = await setup()
    const white = await create(s, s.kevin, 'White card')
    const pest = await create(s, s.kevin, 'Pest management')
    const front = await upload(s, 10)
    const back = await upload(s, 11)
    const certificate = await upload(s, 12)
    const a = await addFile(s, s.kevin, pest, front, 'Front.JPEG')
    const b = await addFile(s, s.kevin, pest, back, 'back.png')
    const c = await addFile(s, s.kevin, pest, certificate, 'WA certificate.PDF')

    const { licences } = await list(s, s.kevin, s.kevinMembershipId)
    expect(licences.map((l) => l._id)).toEqual([white, pest])
    expect(licences[1].files).toEqual([
      {
        _id: a.fileId,
        url: expect.any(String),
        kind: 'image',
        contentType: 'image/jpeg',
        fileName: 'Front.jpg',
        size: 10,
        uploadedAt: a.uploadedAt,
      },
      expect.objectContaining({ _id: b.fileId, contentType: 'image/png' }),
      expect.objectContaining({
        _id: c.fileId,
        kind: 'pdf',
        fileName: 'WA certificate.pdf',
      }),
    ])
    expect(licences[0].files).toEqual([])
    // Never the storage ids: the returns validator names none.
    const json = JSON.stringify(licences)
    for (const id of [front, back, certificate]) {
      expect(json).not.toContain(id)
    }
    // A file added moves the licence's `updatedAt`.
    expect(licences[1].updatedAt).toBe(c.uploadedAt)
  })

  test('removing a file or a licence drops the rows and leaves storage alone', async () => {
    const s = await setup()
    const { licenceId, storageId, fileId } = await kevinsLicence(s)
    const second = await upload(s)
    await addFile(s, s.kevin, licenceId, second, 'card.png')

    await s.kevin.as.mutation(api.memberLicences.removeFile, {
      businessId: s.businessId,
      fileId,
    })
    const [licence] = (await list(s, s.kevin, s.kevinMembershipId)).licences
    expect(licence.files.map((f) => f.fileName)).toEqual(['card.png'])
    expect(await stored(s, storageId)).not.toBeNull()
    // Already gone is done: a retry, or a second phone.
    await s.kevin.as.mutation(api.memberLicences.removeFile, {
      businessId: s.businessId,
      fileId,
    })

    await s.kevin.as.mutation(api.memberLicences.remove, {
      businessId: s.businessId,
      licenceId,
    })
    expect(await rows(s)).toEqual({ licences: [], files: [] })
    expect((await list(s, s.kevin, s.kevinMembershipId)).licences).toEqual([])
    expect(await stored(s, second)).not.toBeNull()
    await s.kevin.as.mutation(api.memberLicences.remove, {
      businessId: s.businessId,
      licenceId,
    })
    // But a licence that is gone takes nothing new.
    await expect(
      addFile(s, s.kevin, licenceId, await upload(s)),
    ).rejects.toThrow(/NOT_FOUND/)
    await expect(
      s.kevin.as.mutation(api.memberLicences.update, {
        businessId: s.businessId,
        licenceId,
        name: 'Back again',
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })

  test('every change is in the holder’s history, as done by themself', async () => {
    const s = await setup()
    const { licenceId, fileId } = await kevinsLicence(s)
    await s.kevin.as.mutation(api.memberLicences.update, {
      businessId: s.businessId,
      licenceId,
      number: 'PMT 9999',
    })
    await s.kevin.as.mutation(api.memberLicences.removeFile, {
      businessId: s.businessId,
      fileId,
    })
    await s.kevin.as.mutation(api.memberLicences.remove, {
      businessId: s.businessId,
      licenceId,
    })

    const history = await auditOf(s, s.kevinMembershipId)
    expect(history.map((row) => row.action)).toEqual([
      'membership.addLicence',
      'membership.addLicenceFile',
      'membership.updateLicence',
      'membership.removeLicenceFile',
      'membership.removeLicence',
    ])
    for (const row of history) {
      expect(row.actorMembershipId).toBe(s.kevinMembershipId)
      expect(row.onBehalfOfMembershipId).toBeUndefined()
      expect(row.meta).toMatchObject({ licenceId })
    }
    expect(history[2].meta).toMatchObject({ fields: ['number'] })
    // Which fields changed, never what the number now is.
    expect(JSON.stringify(history[2].meta)).not.toContain('9999')
  })
})

describe('limits and checks', () => {
  test('twenty licences a person, and no more', async () => {
    const s = await setup()
    for (let i = 0; i < MAX_LICENCES; i++) {
      await create(s, s.kevin, `Licence ${i + 1}`)
    }
    await expect(create(s, s.kevin, 'One too many')).rejects.toThrow(
      /TOO_MANY_LICENCES/,
    )
    // Per person: Priya's wallet is her own.
    await create(s, s.priya, 'Fumigation')
    expect((await list(s, s.kevin, s.kevinMembershipId)).licences).toHaveLength(
      MAX_LICENCES,
    )
  })

  test('six files a licence, and no more', async () => {
    const s = await setup()
    const licenceId = await create(s, s.kevin)
    for (let i = 0; i < MAX_LICENCE_FILES; i++) {
      await addFile(s, s.kevin, licenceId, await upload(s), `page-${i}.pdf`)
    }
    const spare = await upload(s)
    await expect(addFile(s, s.kevin, licenceId, spare)).rejects.toThrow(
      /TOO_MANY_FILES/,
    )
    // Another licence still takes one.
    const other = await create(s, s.kevin, 'White card')
    await addFile(s, s.kevin, other, spare)
    expect((await rows(s)).files).toHaveLength(MAX_LICENCE_FILES + 1)
  })

  test('the name, number and expiry are checked on the way in', async () => {
    const s = await setup()
    for (const name of [
      '',
      '   ',
      // Nothing that shows: a row with no name on the owner's screen.
      '\u200B\u200D',
      'x'.repeat(MAX_LICENCE_NAME_LENGTH + 1),
    ]) {
      await expect(create(s, s.kevin, name)).rejects.toThrow(/INVALID_NAME/)
    }
    await expect(
      create(s, s.kevin, 'Pest', {
        number: '9'.repeat(MAX_LICENCE_NUMBER_LENGTH + 1),
      }),
    ).rejects.toThrow(/INVALID_NUMBER/)
    for (const expiresOn of [
      '2027-02-29',
      '2027-04-31',
      '2027-13-01',
      '30/06/2027',
      '2027-6-30',
      '1782777600000',
    ]) {
      await expect(create(s, s.kevin, 'Pest', { expiresOn })).rejects.toThrow(
        /INVALID_DATE/,
      )
    }
    expect((await rows(s)).licences).toEqual([])

    const licenceId = await create(
      s,
      s.kevin,
      'x'.repeat(MAX_LICENCE_NAME_LENGTH),
      {
        number: '9'.repeat(MAX_LICENCE_NUMBER_LENGTH),
        expiresOn: '2028-02-29',
      },
    )
    // And on the way through `update`, which leaves the licence as it was.
    for (const [change, refusal] of [
      [{ name: '' }, /INVALID_NAME/],
      [{ number: '9'.repeat(MAX_LICENCE_NUMBER_LENGTH + 1) }, /INVALID_NUMBER/],
      [{ expiresOn: '2027-02-29' }, /INVALID_DATE/],
    ] as const) {
      await expect(
        s.kevin.as.mutation(api.memberLicences.update, {
          businessId: s.businessId,
          licenceId,
          ...change,
        }),
      ).rejects.toThrow(refusal)
    }
    expect((await rows(s)).licences[0]).toMatchObject({
      expiresOn: '2028-02-29',
    })
  })
})

describe('what an upload may be', () => {
  test('anything but a PDF, PNG or JPEG is refused', async () => {
    const s = await setup()
    const licenceId = await create(s, s.kevin)
    for (const name of ['licence.heic', 'licence.docx', 'licence.svg', 'x']) {
      await expect(
        addFile(s, s.kevin, licenceId, await upload(s), name),
      ).rejects.toThrow(/WRONG_FILE_TYPE/)
    }
    expect((await rows(s)).files).toEqual([])
  })

  test('a photo past its limit is refused; a PDF that size is not', async () => {
    const s = await setup()
    const licenceId = await create(s, s.kevin)
    const big = await upload(s, MAX_LICENCE_IMAGE_BYTES + 1)
    await expect(
      addFile(s, s.kevin, licenceId, big, 'card.png'),
    ).rejects.toThrow(/FILE_TOO_LARGE/)
    await addFile(s, s.kevin, licenceId, big, 'card.pdf')

    const huge = await upload(s, MAX_LICENCE_PDF_BYTES + 1)
    await expect(
      addFile(s, s.kevin, licenceId, huge, 'card.pdf'),
    ).rejects.toThrow(/FILE_TOO_LARGE/)
    expect((await rows(s)).files.map((f) => f.size)).toEqual([
      MAX_LICENCE_IMAGE_BYTES + 1,
    ])
  })

  test('only a fresh upload can be claimed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = await setup()
    const licenceId = await create(s, s.kevin)
    const start = Date.now()
    const stale = await upload(s)
    vi.setSystemTime(start + CLAIM_WINDOW_MS + 1000)
    await expect(addFile(s, s.kevin, licenceId, stale)).rejects.toThrow(
      /FILE_NOT_FOUND/,
    )
    expect((await rows(s)).files).toEqual([])
  })

  test('a file anything holds cannot be claimed — any licence file included', async () => {
    const s = await setup()
    const licenceId = await create(s, s.kevin)

    // A product's PDF.
    const productPdf = await upload(s)
    await s.owner.as.mutation(api.products.create, {
      businessId: s.businessId,
      name: 'Termidor',
      pdf: { storageId: productPdf, fileName: 'sds.pdf' },
    })
    // Someone's Phase 8.1 document — Priya's, and Kevin's own.
    const priyasDocument = await upload(s)
    await s.priya.as.mutation(api.licences.setFile, {
      businessId: s.businessId,
      membershipId: s.priyaMembershipId,
      storageId: priyasDocument,
      fileName: 'licence.pdf',
    })
    const kevinsDocument = await upload(s)
    await s.kevin.as.mutation(api.licences.setFile, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
      storageId: kevinsDocument,
      fileName: 'licence.pdf',
    })
    // A file in someone's wallet — Priya's, and Kevin's own other licence.
    const priyasLicence = await create(s, s.priya, 'Fumigation')
    const inPriyasWallet = await upload(s)
    await addFile(s, s.priya, priyasLicence, inPriyasWallet)
    const kevinsOther = await create(s, s.kevin, 'White card')
    const onKevinsOther = await upload(s)
    await addFile(s, s.kevin, kevinsOther, onKevinsOther)

    for (const held of [
      productPdf,
      priyasDocument,
      kevinsDocument,
      inPriyasWallet,
      onKevinsOther,
    ]) {
      await expect(addFile(s, s.kevin, licenceId, held)).rejects.toThrow(
        /ALREADY_ATTACHED/,
      )
    }

    // And the other way: a wallet file is refused as anything else — a
    // product, where the whole business would read it, or a Phase 8.1
    // document.
    await expect(
      s.owner.as.mutation(api.products.create, {
        businessId: s.businessId,
        name: 'Not a product',
        photoStorageId: inPriyasWallet,
      }),
    ).rejects.toThrow(/ALREADY_ATTACHED/)
    await expect(
      s.priya.as.mutation(api.licences.setFile, {
        businessId: s.businessId,
        membershipId: s.priyaMembershipId,
        storageId: inPriyasWallet,
        fileName: 'licence.pdf',
      }),
    ).rejects.toThrow(/ALREADY_ATTACHED/)
    const onLicence = (await rows(s)).files.filter(
      (f) => f.licenceId === licenceId,
    )
    expect(onLicence).toEqual([])
  })

  test('the same upload sent again is the file already made — even late, even at the cap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = await setup()
    const licenceId = await create(s, s.kevin)
    for (let i = 0; i < MAX_LICENCE_FILES - 1; i++) {
      await addFile(s, s.kevin, licenceId, await upload(s))
    }
    const last = await upload(s)
    const first = await addFile(s, s.kevin, licenceId, last, 'card.png')

    // On a different licence it is not a retry: it is held.
    const other = await create(s, s.kevin, 'White card')
    await expect(addFile(s, s.kevin, other, last)).rejects.toThrow(
      /ALREADY_ATTACHED/,
    )

    vi.setSystemTime(Date.now() + CLAIM_WINDOW_MS + 1000)
    const again = await addFile(s, s.kevin, licenceId, last, 'card.png')
    expect(again).toEqual(first)
    expect((await rows(s)).files).toHaveLength(MAX_LICENCE_FILES)
    expect(
      (await auditOf(s, s.kevinMembershipId)).filter(
        (row) => row.action === 'membership.addLicenceFile',
      ),
    ).toHaveLength(MAX_LICENCE_FILES)
  })
})

describe('who may read and write a person’s licences', () => {
  test('the owner reads anyone’s, and changes none of them', async () => {
    const s = await setup()
    const { licenceId, fileId, storageId } = await kevinsLicence(s)

    const seen = await list(s, s.owner, s.kevinMembershipId)
    expect(seen.mine).toBe(false)
    expect(seen.licences).toEqual([
      expect.objectContaining({
        _id: licenceId,
        name: 'Pest management',
        number: 'PMT 1234',
        expiresOn: '2027-06-30',
        files: [expect.objectContaining({ _id: fileId, size: 40 })],
      }),
    ])
    // Somebody with none: an empty wallet, not an error.
    expect(await list(s, s.owner, s.priyaMembershipId)).toEqual({
      mine: false,
      licences: [],
    })

    const before = await rows(s)
    for (const attempt of Object.values(
      writes(s, s.owner, licenceId, fileId, await upload(s)),
    )) {
      await expect(attempt()).rejects.toThrow(/NO_ACCESS/)
    }
    expect(await rows(s)).toEqual(before)
    expect(await stored(s, storageId)).not.toBeNull()
  })

  test('a contractor or a subcontractor can neither read nor change anyone else’s', async () => {
    const s = await setup()
    const kevins = await kevinsLicence(s)
    // Sam is on Jo's team; Jo manages Sam's day, not Sam's licences.
    const samsLicence = await create(s, s.sam, 'Pest management')
    const samsFile = await addFile(s, s.sam, samsLicence, await upload(s))
    const ownersLicence = await create(s, s.owner, 'Pest management')
    const ownersFile = await addFile(s, s.owner, ownersLicence, await upload(s))

    const before = await rows(s)
    for (const [as, holderId, licence] of [
      [s.jo, s.kevinMembershipId, kevins],
      [s.jo, s.samMembershipId, { ...samsFile, licenceId: samsLicence }],
      [s.priya, s.kevinMembershipId, kevins],
      [
        s.kevin,
        s.ownerMembershipId,
        { ...ownersFile, licenceId: ownersLicence },
      ],
      [s.sam, s.kevinMembershipId, kevins],
    ] as const) {
      await expect(list(s, as, holderId)).rejects.toThrow(/NO_ACCESS/)
      for (const attempt of Object.values(
        writes(s, as, licence.licenceId, licence.fileId, await upload(s)),
      )) {
        await expect(attempt()).rejects.toThrow(/NO_ACCESS/)
      }
    }
    expect(await rows(s)).toEqual(before)
  })

  test('someone outside the business can do nothing with them', async () => {
    const s = await setup()
    const { licenceId, fileId } = await kevinsLicence(s)
    const stranger = await createActor(s.t, { email: 'rival@other.test' })
    await createBusiness(s.t, stranger, 'Other Pest')

    await expect(
      stranger.as.mutation(api.memberLicences.generateUploadUrl, {
        businessId: s.businessId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(list(s, stranger, s.kevinMembershipId)).rejects.toThrow(
      /NO_ACCESS/,
    )
    await expect(create(s, stranger)).rejects.toThrow(/NO_ACCESS/)
    for (const attempt of Object.values(
      writes(s, stranger, licenceId, fileId, await upload(s)),
    )) {
      await expect(attempt()).rejects.toThrow(/NO_ACCESS/)
    }
  })

  test('the owner of another business cannot reach them through their own business', async () => {
    const s = await setup()
    const { licenceId, fileId } = await kevinsLicence(s)
    const rival = await createActor(s.t, { email: 'rival@other.test' })
    const { businessId: rivalBusinessId } = await createBusiness(
      s.t,
      rival,
      'Other Pest',
    )
    // Their own business, where they hold `business.manage` — so it is the
    // holder's business, not the capability, that refuses them.
    const theirs = { businessId: rivalBusinessId }

    await expect(
      rival.as.query(api.memberLicences.list, {
        ...theirs,
        membershipId: s.kevinMembershipId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)

    const before = await rows(s)
    const theirUpload = await upload(s)
    for (const attempt of [
      () =>
        rival.as.mutation(api.memberLicences.update, {
          ...theirs,
          licenceId,
          name: 'Taken',
        }),
      () =>
        rival.as.mutation(api.memberLicences.remove, { ...theirs, licenceId }),
      () =>
        rival.as.mutation(api.memberLicences.addFile, {
          ...theirs,
          licenceId,
          storageId: theirUpload,
          fileName: 'licence.pdf',
        }),
      () =>
        rival.as.mutation(api.memberLicences.removeFile, {
          ...theirs,
          fileId,
        }),
    ]) {
      await expect(attempt()).rejects.toThrow(/NO_ACCESS/)
    }
    expect(await rows(s)).toEqual(before)
  })

  test('an owner switched into a technician’s account cannot touch the technician’s, and keeps only their own', async () => {
    const s = await setup()
    const { licenceId, fileId } = await kevinsLicence(s)
    await switchInto(s, s.ownerMembershipId, s.owner, s.kevinMembershipId)

    const before = await rows(s)
    for (const attempt of Object.values(
      writes(s, s.owner, licenceId, fileId, await upload(s)),
    )) {
      await expect(attempt()).rejects.toThrow(/NO_ACCESS/)
    }
    expect(await rows(s)).toEqual(before)
    // Nor read them through the switch: `business.manage` does not cross one.
    await expect(list(s, s.owner, s.kevinMembershipId)).rejects.toThrow(
      /NO_ACCESS/,
    )

    // Their own wallet is still theirs — it is the real person's, as
    // Settings always is — and what they add lands there, not in Kevin's.
    const ownersLicence = await create(s, s.owner, 'Fumigation')
    const own = await list(s, s.owner, s.ownerMembershipId)
    expect(own).toMatchObject({
      mine: true,
      licences: [{ _id: ownersLicence, name: 'Fumigation' }],
    })
    const [row] = (await rows(s)).licences.filter(
      (l) => l._id === ownersLicence,
    )
    expect(row.membershipId).toBe(s.ownerMembershipId)
    const history = await auditOf(s, s.ownerMembershipId)
    expect(history.at(-1)).toMatchObject({
      action: 'membership.addLicence',
      actorMembershipId: s.ownerMembershipId,
    })
    expect(history.at(-1)?.onBehalfOfMembershipId).toBeUndefined()
    // Kevin's own view of his is unchanged.
    expect((await list(s, s.kevin, s.kevinMembershipId)).licences).toHaveLength(
      1,
    )
  })

  test('not once the holder has left: nobody reads a former worker’s licences', async () => {
    const s = await setup()
    await kevinsLicence(s)
    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
    })
    // The id is in any roster the owner loaded before; it must not still work.
    await expect(list(s, s.owner, s.kevinMembershipId)).rejects.toThrow(
      /NO_ACCESS/,
    )
    // The rows stay, like every file here.
    expect((await rows(s)).licences).toHaveLength(1)
  })

  test('the roster says how many each holds — to the owner, and to each person of their own', async () => {
    const s = await setup()
    await kevinsLicence(s)
    await create(s, s.kevin, 'White card')
    await create(s, s.jo, 'Pest management')

    const counts = (roster: Array<{ _id: string; licenceCount?: number }>) =>
      Object.fromEntries(roster.map((m) => [m._id, m.licenceCount]))

    expect(
      counts(
        await s.owner.as.query(api.team.roster, { businessId: s.businessId }),
      ),
    ).toEqual({
      [s.ownerMembershipId]: 0,
      [s.kevinMembershipId]: 2,
      [s.priyaMembershipId]: 0,
      [s.joMembershipId]: 1,
      [s.samMembershipId]: 0,
    })
    // A contractor manages a team, but cannot open anyone's licences, so is
    // told only their own.
    expect(
      counts(
        await s.jo.as.query(api.team.roster, { businessId: s.businessId }),
      ),
    ).toEqual({
      [s.ownerMembershipId]: undefined,
      [s.kevinMembershipId]: undefined,
      [s.priyaMembershipId]: undefined,
      [s.joMembershipId]: 1,
      [s.samMembershipId]: undefined,
    })
  })

  test('the roster tells nobody how many a member not active holds', async () => {
    const s = await setup()
    await kevinsLicence(s)
    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
    })
    // Invited back: on the roster again, as invited, with their rows still
    // there — which nobody may open until they have joined.
    await s.owner.as.mutation(api.memberships.invite, {
      businessId: s.businessId,
      userId: s.kevin.userId,
      role: 'subcontractor',
    })
    const roster = await s.owner.as.query(api.team.roster, {
      businessId: s.businessId,
    })
    const kevin = roster.find((m) => m._id === s.kevinMembershipId)
    expect(kevin?.status).toBe('invited')
    expect(kevin?.licenceCount).toBeUndefined()
    expect((await rows(s)).licences).toHaveLength(1)
  })
})

describe('other features never take a wallet file', () => {
  test('a note cannot claim one as its picture', async () => {
    const s = await setup()
    const { storageId } = await kevinsLicence(s)
    for (const who of [s.kevin, s.priya]) {
      const noteId = await who.as.mutation(api.notes.create, {
        businessId: s.businessId,
      })
      await expect(
        who.as.mutation(api.notes.addAttachment, {
          businessId: s.businessId,
          noteId,
          storageId,
        }),
      ).rejects.toThrow(/ALREADY_ATTACHED/)
    }
    const attachments = await s.t.run(async (ctx) =>
      ctx.db.query('noteAttachments').collect(),
    )
    expect(attachments).toEqual([])
  })
})

describe('moving the Phase 8.1 document into the wallet', () => {
  async function withDocuments() {
    const s = await setup()
    const kevinsDocument = await upload(s, 40)
    const uploadedAt = await s.kevin.as.mutation(api.licences.setFile, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
      storageId: kevinsDocument,
      fileName: 'WA licence.PDF',
    })
    await s.owner.as.mutation(api.licences.setFile, {
      businessId: s.businessId,
      membershipId: s.ownerMembershipId,
      storageId: await upload(s, 12),
      fileName: 'card.jpg',
    })
    // Priya has a licence in her wallet already, and no document.
    await create(s, s.priya, 'Fumigation')
    return { s, kevinsDocument, uploadedAt }
  }

  const run = (s: Setup, dryRun?: boolean) =>
    s.t.mutation(
      internal.migrations.licenceWalletV1.run,
      dryRun === undefined ? {} : { dryRun },
    )
  const remaining = (s: Setup) =>
    s.t.query(internal.migrations.licenceWalletV1.remaining, {})

  test('a dry run says what it would copy and writes nothing', async () => {
    const { s } = await withDocuments()
    expect(await remaining(s)).toBe(2)
    const before = await rows(s)

    const preview = await run(s, true)
    expect(preview.dryRun).toBe(true)
    expect(preview.alreadyCopied).toBe(0)
    expect(
      preview.copied.map((c) => [c.membershipId, c.licenceId]).sort(),
    ).toEqual(
      [
        [s.kevinMembershipId, null],
        [s.ownerMembershipId, null],
      ].sort(),
    )
    expect(await rows(s)).toEqual(before)
    expect(await remaining(s)).toBe(2)
  })

  test('each document becomes a licence called "Licence" with that file, once', async () => {
    const { s, kevinsDocument, uploadedAt } = await withDocuments()
    const result = await run(s)
    expect(result.copied).toHaveLength(2)
    expect(await remaining(s)).toBe(0)

    const { licences } = await list(s, s.kevin, s.kevinMembershipId)
    expect(licences).toEqual([
      {
        _id: expect.any(String),
        name: 'Licence',
        createdAt: uploadedAt,
        updatedAt: uploadedAt,
        files: [
          {
            _id: expect.any(String),
            url: expect.any(String),
            kind: 'pdf',
            contentType: 'application/pdf',
            fileName: 'WA licence.pdf',
            size: 40,
            uploadedAt,
          },
        ],
      },
    ])
    // The same file, not a copy of it.
    const [file] = (await rows(s)).files.filter(
      (f) => f.membershipId === s.kevinMembershipId,
    )
    expect(file.storageId).toBe(kevinsDocument)
    expect(file.licenceId).toBe(licences[0]._id)
    // The document stays where the live Profile page reads it.
    expect(
      await s.kevin.as.query(api.licences.file, {
        businessId: s.businessId,
        membershipId: s.kevinMembershipId,
      }),
    ).toMatchObject({ fileName: 'WA licence.pdf', uploadedAt })
    // Priya's wallet is as she left it.
    expect(
      (await list(s, s.priya, s.priyaMembershipId)).licences.map((l) => l.name),
    ).toEqual(['Fumigation'])
    // Nobody in the business did this, so it is in nobody's history.
    expect(
      (await auditOf(s, s.kevinMembershipId)).filter(
        (row) => row.action === 'membership.addLicence',
      ),
    ).toEqual([])

    // A second run copies nothing.
    const before = await rows(s)
    expect(await run(s)).toEqual({
      dryRun: false,
      copied: [],
      alreadyCopied: 2,
      skippedInactive: 0,
    })
    expect(await rows(s)).toEqual(before)
  })

  /** Kevin's copied licence and its one file, after the run. */
  async function copied(s: Setup) {
    await run(s)
    const [licence] = (await list(s, s.kevin, s.kevinMembershipId)).licences
    return { licenceId: licence._id, fileId: licence.files[0]._id }
  }

  const documentOf = (s: Setup) =>
    s.kevin.as.query(api.licences.file, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
    })

  async function ownersRosterRow(s: Setup) {
    const roster = await s.owner.as.query(api.team.roster, {
      businessId: s.businessId,
    })
    return roster.find((m) => m._id === s.kevinMembershipId)
  }

  test('deleting the copied licence takes the document with it, and no second run brings it back', async () => {
    const { s } = await withDocuments()
    const { licenceId } = await copied(s)

    await s.kevin.as.mutation(api.memberLicences.remove, {
      businessId: s.businessId,
      licenceId,
    })

    // Nobody reads it through the Phase 8.1 query any more — the owner
    // included — and the roster no longer says there is one.
    expect(await documentOf(s)).toBeNull()
    expect(
      await s.owner.as.query(api.licences.file, {
        businessId: s.businessId,
        membershipId: s.kevinMembershipId,
      }),
    ).toBeNull()
    expect(await ownersRosterRow(s)).toMatchObject({
      hasLicenceFile: false,
      licenceCount: 0,
    })
    // Nothing left to copy, and a run copies nothing back.
    expect(await remaining(s)).toBe(0)
    expect((await run(s)).copied).toEqual([])
    expect((await list(s, s.kevin, s.kevinMembershipId)).licences).toEqual([])
    // The owner's own document, not deleted, is untouched.
    expect(
      await s.owner.as.query(api.licences.file, {
        businessId: s.businessId,
        membershipId: s.ownerMembershipId,
      }),
    ).not.toBeNull()
    // One change, one line in Kevin's history, which says so.
    const [row] = (await auditOf(s, s.kevinMembershipId)).filter(
      (entry) => entry.action === 'membership.removeLicence',
    )
    expect(row.meta).toMatchObject({ licenceId, clearedLicenceFile: true })
  })

  test('taking the copied file off does the same; taking another file off does not', async () => {
    const { s, kevinsDocument } = await withDocuments()
    const { licenceId, fileId } = await copied(s)
    const back = await addFile(s, s.kevin, licenceId, await upload(s), 'b.png')

    // Another file on the same licence: the document stays.
    await s.kevin.as.mutation(api.memberLicences.removeFile, {
      businessId: s.businessId,
      fileId: back.fileId,
    })
    expect(await documentOf(s)).not.toBeNull()

    await s.kevin.as.mutation(api.memberLicences.removeFile, {
      businessId: s.businessId,
      fileId,
    })
    expect(await documentOf(s)).toBeNull()
    expect(await ownersRosterRow(s)).toMatchObject({ hasLicenceFile: false })
    expect(await remaining(s)).toBe(0)
    expect((await run(s)).copied).toEqual([])
    // The licence stays, now with no file; the file stays in storage.
    const [licence] = (await list(s, s.kevin, s.kevinMembershipId)).licences
    expect(licence).toMatchObject({ _id: licenceId, files: [] })
    expect(await stored(s, kevinsDocument)).not.toBeNull()

    const history = await auditOf(s, s.kevinMembershipId)
    const removals = history.filter(
      (entry) => entry.action === 'membership.removeLicenceFile',
    )
    expect(removals.map((entry) => entry.meta?.clearedLicenceFile)).toEqual([
      undefined,
      true,
    ])
  })

  test('a document replaced since the copy is a new licence, and stays', async () => {
    const { s } = await withDocuments()
    const { licenceId } = await copied(s)
    // Replaced from the old Profile page after the run.
    await s.kevin.as.mutation(api.licences.setFile, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
      storageId: await upload(s, 50),
      fileName: 'new card.png',
    })

    await s.kevin.as.mutation(api.memberLicences.remove, {
      businessId: s.businessId,
      licenceId,
    })
    expect(await documentOf(s)).toMatchObject({ fileName: 'new card.png' })
    expect(await remaining(s)).toBe(1)
  })

  test('a member who is not active is not copied, and not counted as left to do', async () => {
    const { s } = await withDocuments()
    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
    })
    expect(await remaining(s)).toBe(1) // the owner's

    const result = await run(s)
    expect(result.copied.map((c) => c.membershipId)).toEqual([
      s.ownerMembershipId,
    ])
    expect(result.skippedInactive).toBe(1)
    expect(await remaining(s)).toBe(0)
    const kevins = (await rows(s)).licences.filter(
      (l) => l.membershipId === s.kevinMembershipId,
    )
    expect(kevins).toEqual([])
    // The document is where it was, on the membership.
    const membership = await s.t.run(async (ctx) =>
      ctx.db.get(s.kevinMembershipId),
    )
    expect(membership?.licenceFile).toBeDefined()

    // Invited back but not yet joined: still not active, still not copied.
    await s.owner.as.mutation(api.memberships.invite, {
      businessId: s.businessId,
      userId: s.kevin.userId,
      role: 'subcontractor',
    })
    expect(await run(s)).toMatchObject({ copied: [], skippedInactive: 1 })
  })
})

describe('removing a demo business', () => {
  test('takes its people’s licence rows with it, and leaves their files', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@coastal.test' })
    const { businessId } = await createBusiness(t, owner, 'Demo Pest')
    await t.run(async (ctx) => ctx.db.patch(businessId, { plan: DEMO_PLAN }))
    const licenceId = await owner.as.mutation(api.memberLicences.create, {
      businessId,
      name: 'Pest management',
    })
    const file = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array(3)])),
    )
    await owner.as.mutation(api.memberLicences.addFile, {
      businessId,
      licenceId,
      storageId: file,
      fileName: 'licence.pdf',
    })
    const status = () => t.query(internal.demo.cleanup.status, { businessId })
    expect(await status()).toMatchObject({
      memberLicences: 1,
      memberLicenceFiles: 1,
    })

    const removed = await t.mutation(internal.demo.cleanup.remove, {
      businessId,
      confirmSlug: 'demo-pest',
    })
    expect(removed.done).toBe(true)
    expect(removed.deleted).toMatchObject({
      memberLicences: 1,
      memberLicenceFiles: 1,
    })
    expect(await status()).toMatchObject({
      memberLicences: 0,
      memberLicenceFiles: 0,
    })
    expect(
      await t.run(async (ctx) => ctx.db.system.get('_storage', file)),
    ).not.toBeNull()
  })
})
