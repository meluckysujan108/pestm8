/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { SWITCH_TTL_MS } from './lib/capabilities'
import {
  CLAIM_WINDOW_MS,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PDF_BYTES,
  MAX_PHOTO_BYTES,
  MAX_PRODUCTS,
  nameKeyOf,
} from './lib/products'
import type { Doc, Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * Phase 7.1: the Products page's backend — one list per business, which every
 * active member reads and adds to, and in which only a product's creator or
 * the owner changes or removes anything.
 *
 * The risks are the usual ones for a list everyone writes to — someone else's
 * business, someone else's product, a removed member still writing — and two
 * that are about files. A product claims an upload by its storage id, and
 * storage ids reach clients elsewhere in the app, so a claim must only ever
 * take a fresh, unclaimed upload, the list must never hand an id back out, and
 * nothing here may delete a file (see the note at the top of products.ts).
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

/** A second tenant, with an owner and a product of its own. */
async function rival(s: Setup) {
  const owner = await createActor(s.t, { email: 'rival@other.test' })
  const { businessId } = await createBusiness(s.t, owner, 'Other Pest')
  const productId = await owner.as.mutation(api.products.create, {
    businessId,
    name: 'Their Termidor',
    photoStorageId: await upload(s),
  })
  return { owner, businessId, productId }
}

/**
 * A file, as the browser's POST to an upload URL leaves one: stored, and
 * claimed by nothing. convex-test records no content type for it.
 */
function upload(s: Setup, bytes = 3) {
  return s.t.run(async (ctx) =>
    ctx.storage.store(new Blob([new Uint8Array(bytes).fill(7)])),
  )
}

function stored(s: Setup, storageId: Id<'_storage'>) {
  return s.t.run(async (ctx) => ctx.db.system.get('_storage', storageId))
}

/** Every product row, to prove a refusal wrote nothing. */
function everything(s: Setup) {
  return s.t.run(async (ctx) => ctx.db.query('products').collect())
}

function row(s: Setup, productId: Id<'products'>) {
  return s.t.run(async (ctx) => ctx.db.get(productId))
}

function add(
  s: Setup,
  as: TestActor,
  fields: Partial<{
    name: string
    description: string
    url: string
    photoStorageId: Id<'_storage'>
    pdf: { storageId: Id<'_storage'>; fileName: string }
  }> = {},
) {
  return as.as.mutation(api.products.create, {
    businessId: s.businessId,
    name: 'Termidor Residual',
    ...fields,
  })
}

function listAs(s: Setup, as: TestActor) {
  return as.as.query(api.products.list, { businessId: s.businessId })
}

/** Every public function, called by `as` on `businessId` — for the refusals
 * that must hold across the whole surface. */
function everyCall(
  as: Pick<TestApp, 'query' | 'mutation'>,
  businessId: Id<'businesses'>,
  productId: Id<'products'>,
  storageId: Id<'_storage'>,
): Array<[string, () => Promise<unknown>]> {
  return [
    ['list', () => as.query(api.products.list, { businessId })],
    [
      'generateUploadUrl',
      () => as.mutation(api.products.generateUploadUrl, { businessId }),
    ],
    [
      'create',
      () =>
        as.mutation(api.products.create, {
          businessId,
          name: 'Coopex Dust',
          photoStorageId: storageId,
        }),
    ],
    [
      'update',
      () =>
        as.mutation(api.products.update, {
          businessId,
          productId,
          name: 'Renamed',
          photoStorageId: storageId,
        }),
    ],
    [
      'remove',
      () => as.mutation(api.products.remove, { businessId, productId }),
    ],
  ]
}

describe('who may read the list and add to it', () => {
  test('nobody signed out', async () => {
    const s = await setup()
    const productId = await add(s, s.owner)
    const before = await everything(s)

    for (const [name, call] of everyCall(
      s.t,
      s.businessId,
      productId,
      await upload(s),
    )) {
      await expect(call(), name).rejects.toThrow(/Unauthenticated/i)
    }
    expect(await everything(s)).toEqual(before)
  })

  test('nobody outside the business — a stranger, or another business’s owner', async () => {
    const s = await setup()
    const productId = await add(s, s.owner)
    const stranger = await createActor(s.t, { email: 'nobody@else.test' })
    const theirs = await rival(s)
    const before = await everything(s)

    for (const outsider of [stranger, theirs.owner]) {
      for (const [name, call] of everyCall(
        outsider.as,
        s.businessId,
        productId,
        await upload(s),
      )) {
        await expect(call(), `${outsider.email} ${name}`).rejects.toThrow(
          /NO_ACCESS/,
        )
      }
    }
    expect(await everything(s)).toEqual(before)
  })

  test('nobody who has been removed from it, even from their own product', async () => {
    const s = await setup()
    const productId = await add(s, s.kevin)
    await s.t.run(async (ctx) =>
      ctx.db.patch(s.kevinMembershipId, { status: 'removed' }),
    )
    const before = await everything(s)

    for (const [name, call] of everyCall(
      s.kevin.as,
      s.businessId,
      productId,
      await upload(s),
    )) {
      await expect(call(), name).rejects.toThrow(/NO_ACCESS/)
    }
    expect(await everything(s)).toEqual(before)
  })

  test('every member: a subcontractor adds one, and everyone sees it', async () => {
    const s = await setup()
    const productId = await add(s, s.kevin, {
      name: 'Coopex Dust',
      description: 'For wall voids.',
    })

    for (const member of [s.owner, s.kevin, s.priya, s.jo]) {
      const list = await listAs(s, member)
      expect(
        list.map((p) => p.id),
        member.email,
      ).toEqual([productId])
    }
    expect(await row(s, productId)).toMatchObject({
      businessId: s.businessId,
      name: 'Coopex Dust',
      nameKey: 'coopex dust',
      description: 'For wall voids.',
      createdByMembershipId: s.kevinMembershipId,
      updatedByMembershipId: s.kevinMembershipId,
    })
    // A contractor adds one just the same.
    await add(s, s.jo, { name: 'Ditrac Blocks' })
    expect((await listAs(s, s.priya)).map((p) => p.name)).toEqual([
      'Coopex Dust',
      'Ditrac Blocks',
    ])
  })

  test('each business sees only its own', async () => {
    const s = await setup()
    await add(s, s.owner)
    const theirs = await rival(s)
    expect((await listAs(s, s.owner)).map((p) => p.name)).toEqual([
      'Termidor Residual',
    ])
    expect(
      (
        await theirs.owner.as.query(api.products.list, {
          businessId: theirs.businessId,
        })
      ).map((p) => p.name),
    ).toEqual(['Their Termidor'])
  })
})

describe('who may change or remove a product', () => {
  test('another business’s product is NOT_FOUND, even to an owner here', async () => {
    const s = await setup()
    const theirs = await rival(s)
    const before = await row(s, theirs.productId)

    await expect(
      s.owner.as.mutation(api.products.update, {
        businessId: s.businessId,
        productId: theirs.productId,
        name: 'Mine now',
      }),
    ).rejects.toThrow(/NOT_FOUND/)
    await expect(
      s.owner.as.mutation(api.products.remove, {
        businessId: s.businessId,
        productId: theirs.productId,
      }),
    ).rejects.toThrow(/NOT_FOUND/)

    expect(await row(s, theirs.productId)).toEqual(before)
  })

  test('a subcontractor may not touch a colleague’s product', async () => {
    const s = await setup()
    const priyas = await add(s, s.priya, { url: 'brand.com.au' })
    const before = await everything(s)

    const refusals = [
      s.kevin.as.mutation(api.products.update, {
        businessId: s.businessId,
        productId: priyas,
        name: 'Kevin was here',
      }),
      s.kevin.as.mutation(api.products.update, {
        businessId: s.businessId,
        productId: priyas,
        url: null,
      }),
      s.kevin.as.mutation(api.products.update, {
        businessId: s.businessId,
        productId: priyas,
        photoStorageId: await upload(s),
      }),
      s.kevin.as.mutation(api.products.remove, {
        businessId: s.businessId,
        productId: priyas,
      }),
      // A contractor is not the owner either.
      s.jo.as.mutation(api.products.remove, {
        businessId: s.businessId,
        productId: priyas,
      }),
    ]
    for (const refusal of refusals) {
      await expect(refusal).rejects.toThrow(/NO_ACCESS/)
    }
    expect(await everything(s)).toEqual(before)
  })

  test('a subcontractor may change and remove their own', async () => {
    const s = await setup()
    const kevins = await add(s, s.kevin)

    await s.kevin.as.mutation(api.products.update, {
      businessId: s.businessId,
      productId: kevins,
      name: 'Termidor HE',
      description: 'High emulsion.',
    })
    expect(await row(s, kevins)).toMatchObject({
      name: 'Termidor HE',
      description: 'High emulsion.',
      updatedByMembershipId: s.kevinMembershipId,
    })

    await s.kevin.as.mutation(api.products.remove, {
      businessId: s.businessId,
      productId: kevins,
    })
    expect(await everything(s)).toEqual([])
  })

  test('the owner may change and remove anyone’s', async () => {
    const s = await setup()
    const kevins = await add(s, s.kevin)
    const jos = await add(s, s.jo, { name: 'Ditrac Blocks' })

    await s.owner.as.mutation(api.products.update, {
      businessId: s.businessId,
      productId: kevins,
      description: 'Checked by Terence.',
    })
    const changed = await row(s, kevins)
    expect(changed).toMatchObject({
      description: 'Checked by Terence.',
      // Still Kevin's, changed by the owner.
      createdByMembershipId: s.kevinMembershipId,
      updatedByMembershipId: s.ownerMembershipId,
    })

    await s.owner.as.mutation(api.products.remove, {
      businessId: s.businessId,
      productId: jos,
    })
    expect((await everything(s)).map((p) => p._id)).toEqual([kevins])
  })

  test('canEdit tells each caller exactly what the writes will allow', async () => {
    const s = await setup()
    const ids = {
      owner: await add(s, s.owner, { name: 'A owner' }),
      kevin: await add(s, s.kevin, { name: 'B kevin' }),
      priya: await add(s, s.priya, { name: 'C priya' }),
      jo: await add(s, s.jo, { name: 'D jo' }),
    }
    const editable = async (as: TestActor) =>
      Object.fromEntries(
        (await listAs(s, as)).map((p) => [p.name.split(' ')[1], p.canEdit]),
      )

    expect(await editable(s.owner)).toEqual({
      owner: true,
      kevin: true,
      priya: true,
      jo: true,
    })
    expect(await editable(s.kevin)).toEqual({
      owner: false,
      kevin: true,
      priya: false,
      jo: false,
    })
    expect(await editable(s.priya)).toEqual({
      owner: false,
      kevin: false,
      priya: true,
      jo: false,
    })
    expect(await editable(s.jo)).toEqual({
      owner: false,
      kevin: false,
      priya: false,
      jo: true,
    })

    // And the writes agree, row for row.
    for (const [who, as] of [
      ['kevin', s.kevin],
      ['priya', s.priya],
      ['jo', s.jo],
    ] as const) {
      for (const [whose, productId] of Object.entries(ids)) {
        const call = as.as.mutation(api.products.update, {
          businessId: s.businessId,
          productId,
          description: `${who} was here`,
        })
        if (whose === who) await call
        else
          await expect(call, `${who} on ${whose}`).rejects.toThrow(/NO_ACCESS/)
      }
    }
  })

  test('an owner switched into someone’s account has a say over their own products only', async () => {
    const s = await setup()
    const owners = await add(s, s.owner, { name: 'A owner' })
    const kevins = await add(s, s.kevin, { name: 'B kevin' })
    await openSwitch(s, s.owner, s.ownerMembershipId, s.priyaMembershipId)

    expect((await listAs(s, s.owner)).map((p) => [p.name, p.canEdit])).toEqual([
      ['A owner', true],
      ['B kevin', false],
    ])
    await expect(
      s.owner.as.mutation(api.products.remove, {
        businessId: s.businessId,
        productId: kevins,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await s.owner.as.mutation(api.products.update, {
      businessId: s.businessId,
      productId: owners,
      description: 'From Priya’s account.',
    })

    // What they add while there is theirs — the person who tapped Save — not
    // the account they were standing in.
    const added = await add(s, s.owner, { name: 'C added while switched' })
    expect(await row(s, added)).toMatchObject({
      createdByMembershipId: s.ownerMembershipId,
      updatedByMembershipId: s.ownerMembershipId,
    })
  })

  test('a switch that has run out refuses every write, uploads included', async () => {
    const s = await setup()
    const owners = await add(s, s.owner)
    await openSwitch(s, s.owner, s.ownerMembershipId, s.priyaMembershipId, {
      expiresAt: Date.now() - 1,
    })
    const before = await everything(s)

    await expect(
      s.owner.as.mutation(api.products.generateUploadUrl, {
        businessId: s.businessId,
      }),
    ).rejects.toThrow(/SWITCH_EXPIRED/)
    await expect(add(s, s.owner, { name: 'Late' })).rejects.toThrow(
      /SWITCH_EXPIRED/,
    )
    await expect(
      s.owner.as.mutation(api.products.remove, {
        businessId: s.businessId,
        productId: owners,
      }),
    ).rejects.toThrow(/SWITCH_EXPIRED/)
    expect(await everything(s)).toEqual(before)
  })
})

/** Open a switch for one session, the way `accountSwitches` does. */
async function openSwitch(
  s: Setup,
  actor: TestActor,
  realMembershipId: Id<'memberships'>,
  targetMembershipId: Id<'memberships'>,
  opts: { expiresAt?: number } = {},
) {
  const now = Date.now()
  await s.t.run(async (ctx) =>
    ctx.db.insert('accountSwitches', {
      sessionId: actor.sessionId,
      businessId: s.businessId,
      realMembershipId,
      targetMembershipId,
      startedAt: now,
      expiresAt: opts.expiresAt ?? now + SWITCH_TTL_MS,
    }),
  )
}

describe('a product’s name', () => {
  test('is required, and fits MAX_NAME_LENGTH; the description fits its own', async () => {
    const s = await setup()
    for (const fields of [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(MAX_NAME_LENGTH + 1) },
      { description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) },
    ]) {
      await expect(add(s, s.owner, fields)).rejects.toThrow(/INVALID_PRODUCT/)
    }
    expect(await everything(s)).toEqual([])

    const productId = await add(s, s.owner, {
      name: ` ${'x'.repeat(MAX_NAME_LENGTH)} `,
      description: '   ',
    })
    const saved = await row(s, productId)
    expect(saved?.name).toBe('x'.repeat(MAX_NAME_LENGTH))
    expect(saved).not.toHaveProperty('description')

    await expect(
      s.owner.as.mutation(api.products.update, {
        businessId: s.businessId,
        productId,
        name: ' ',
      }),
    ).rejects.toThrow(/INVALID_PRODUCT/)
    expect(await row(s, productId)).toEqual(saved)
  })

  test('is one product per name, whatever the case or spacing', async () => {
    const s = await setup()
    await add(s, s.kevin, { name: 'Termidor Residual' })
    const before = await everything(s)

    for (const name of [
      'Termidor Residual',
      'termidor residual',
      '  TERMIDOR   RESIDUAL ',
    ]) {
      // Refused to the owner too: this is not about who is asking.
      await expect(add(s, s.owner, { name }), name).rejects.toThrow(
        /PRODUCT_EXISTS/,
      )
    }
    expect(await everything(s)).toEqual(before)
  })

  test('may not be renamed onto another product’s, but may be kept, or recased', async () => {
    const s = await setup()
    await add(s, s.owner, { name: 'Termidor Residual' })
    const other = await add(s, s.owner, { name: 'Coopex Dust' })
    const rename = (name: string) =>
      s.owner.as.mutation(api.products.update, {
        businessId: s.businessId,
        productId: other,
        name,
      })

    const before = await row(s, other)
    await expect(rename('termidor  RESIDUAL')).rejects.toThrow(/PRODUCT_EXISTS/)
    expect(await row(s, other)).toEqual(before)

    await rename('Coopex Dust')
    await rename('COOPEX dust ')
    expect(await row(s, other)).toMatchObject({
      name: 'COOPEX dust',
      nameKey: 'coopex dust',
    })
  })

  test('orders the list, A to Z, whatever the case', async () => {
    const s = await setup()
    for (const name of ['coopex Dust', 'Ditrac', 'Advion', 'bifenthrin']) {
      await add(s, s.owner, { name })
    }
    expect((await listAs(s, s.kevin)).map((p) => p.name)).toEqual([
      'Advion',
      'bifenthrin',
      'coopex Dust',
      'Ditrac',
    ])
  })
})

describe('a product’s link', () => {
  test('is kept as a full https link, however it was typed', async () => {
    const s = await setup()
    const productId = await add(s, s.kevin, { url: '  brand.com.au/sds ' })
    expect((await row(s, productId))?.url).toBe('https://brand.com.au/sds')
    expect((await listAs(s, s.priya))[0].url).toBe('https://brand.com.au/sds')
  })

  test('that is not a web page is refused, on create and on update', async () => {
    const s = await setup()
    await expect(
      add(s, s.owner, { url: 'javascript:alert(1)' }),
    ).rejects.toThrow(/INVALID_URL/)
    expect(await everything(s)).toEqual([])

    const productId = await add(s, s.owner, { url: 'https://brand.com.au/' })
    const before = await row(s, productId)
    for (const url of ['data:text/html,hi', 'localhost', 'mailto:a@b.com']) {
      await expect(
        s.owner.as.mutation(api.products.update, {
          businessId: s.businessId,
          productId,
          url,
        }),
        url,
      ).rejects.toThrow(/INVALID_URL/)
    }
    expect(await row(s, productId)).toEqual(before)
  })

  test('is cleared by null or a blank, and left alone when not sent', async () => {
    const s = await setup()
    const productId = await add(s, s.owner, {
      url: 'brand.com.au',
      description: 'Keep me.',
    })
    const update = (url: string | null | undefined) =>
      s.owner.as.mutation(api.products.update, {
        businessId: s.businessId,
        productId,
        url,
      })

    await update(undefined)
    expect((await row(s, productId))?.url).toBe('https://brand.com.au/')
    await update('')
    expect(await row(s, productId)).not.toHaveProperty('url')
    await update('brand.com.au')
    await update(null)
    const cleared = await row(s, productId)
    expect(cleared).not.toHaveProperty('url')
    expect(cleared?.description).toBe('Keep me.')
    expect((await listAs(s, s.owner))[0].url).toBeNull()
  })
})

describe('how many products a business keeps', () => {
  test('at most MAX_PRODUCTS; the one past it is refused', async () => {
    const s = await setup()
    await s.t.run(async (ctx) => {
      for (let i = 0; i < MAX_PRODUCTS - 1; i++) {
        const name = `Product ${String(i).padStart(3, '0')}`
        await ctx.db.insert('products', {
          businessId: s.businessId,
          name,
          nameKey: nameKeyOf(name),
          createdByMembershipId: s.ownerMembershipId,
          updatedByMembershipId: s.ownerMembershipId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      }
    })

    const last = await add(s, s.kevin, { name: 'The last one' })
    await expect(add(s, s.owner, { name: 'One too many' })).rejects.toThrow(
      /TOO_MANY_PRODUCTS/,
    )
    const list = await listAs(s, s.owner)
    expect(list).toHaveLength(MAX_PRODUCTS)
    expect(list.map((p) => p.id)).toContain(last)

    // Another business's shelf is its own.
    const theirs = await rival(s)
    expect(
      await theirs.owner.as.query(api.products.list, {
        businessId: theirs.businessId,
      }),
    ).toHaveLength(1)
  })
})

describe('a product’s photo and PDF', () => {
  test('are claimed from a fresh upload and reach the page as URLs', async () => {
    const s = await setup()
    const photo = await upload(s, 5)
    const pdf = await upload(s, 1234)
    const productId = await add(s, s.kevin, {
      photoStorageId: photo,
      pdf: { storageId: pdf, fileName: 'C:\\fakepath\\Termidor SDS' },
    })

    expect(await row(s, productId)).toMatchObject({
      photoStorageId: photo,
      pdfStorageId: pdf,
      pdfFileName: 'C:-fakepath-Termidor SDS.pdf',
      // From the stored file, not from anything the client said.
      pdfSize: 1234,
    })
    const [shown] = await listAs(s, s.priya)
    expect(shown.photoUrl).toMatch(/^https:\/\//)
    expect(shown.pdf).toEqual({
      url: expect.stringMatching(/^https:\/\//),
      fileName: 'C:-fakepath-Termidor SDS.pdf',
      size: 1234,
    })
  })

  test('the list never carries a storage id', async () => {
    const s = await setup()
    const files = [await upload(s, 1), await upload(s, 2)]
    const productId = await add(s, s.owner, {
      photoStorageId: files[0],
      pdf: { storageId: files[1], fileName: 'sds.pdf' },
    })

    for (const as of [s.owner, s.kevin]) {
      const list = await listAs(s, as)
      const serialised = JSON.stringify(list)
      for (const id of files) expect(serialised).not.toContain(id)
      expect(Object.keys(list[0]).sort()).toEqual(
        [
          'canEdit',
          'createdAt',
          'description',
          'id',
          'name',
          'pdf',
          'photoUrl',
          'updatedAt',
          'url',
        ].sort(),
      )
      expect(list[0].id).toBe(productId)
    }
  })

  test('only within CLAIM_WINDOW_MS of the upload, on create and on update', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = await setup()
    const start = Date.now()
    const fresh = await upload(s)
    const stale = await upload(s)
    const staleAsPdf = await upload(s)

    vi.setSystemTime(start + CLAIM_WINDOW_MS - 1000)
    await add(s, s.owner, { name: 'In time', photoStorageId: fresh })

    vi.setSystemTime(start + CLAIM_WINDOW_MS + 1000)
    const before = await everything(s)
    await expect(
      add(s, s.owner, { name: 'Too late', photoStorageId: stale }),
    ).rejects.toThrow(/FILE_NOT_FOUND/)
    await expect(
      add(s, s.owner, {
        name: 'Too late',
        pdf: { storageId: staleAsPdf, fileName: 'sds.pdf' },
      }),
    ).rejects.toThrow(/FILE_NOT_FOUND/)
    // Refused above, so still claimed by nothing: only their age stops these.
    const [inTime] = before
    for (const fields of [
      { photoStorageId: stale },
      { pdf: { storageId: staleAsPdf, fileName: 'sds.pdf' } },
    ]) {
      await expect(
        s.owner.as.mutation(api.products.update, {
          businessId: s.businessId,
          productId: inTime._id,
          ...fields,
        }),
        JSON.stringify(fields),
      ).rejects.toThrow(/FILE_NOT_FOUND/)
    }
    expect(await everything(s)).toEqual(before)
  })

  test('not a file that is no longer stored', async () => {
    const s = await setup()
    const gone = await upload(s)
    await s.t.run(async (ctx) => ctx.storage.delete(gone))
    await expect(add(s, s.owner, { photoStorageId: gone })).rejects.toThrow(
      /FILE_NOT_FOUND/,
    )
    expect(await everything(s)).toEqual([])
  })

  test('not a file another product already holds, as either', async () => {
    const s = await setup()
    const photo = await upload(s, 1)
    const pdf = await upload(s, 2)
    await add(s, s.owner, {
      name: 'First',
      photoStorageId: photo,
      pdf: { storageId: pdf, fileName: 'sds.pdf' },
    })
    const theirs = await rival(s)
    const theirPhoto = (await row(s, theirs.productId))!.photoStorageId!
    const before = await everything(s)

    for (const fields of [
      { photoStorageId: photo },
      { photoStorageId: pdf },
      { pdf: { storageId: photo, fileName: 'x.pdf' } },
      { pdf: { storageId: pdf, fileName: 'x.pdf' } },
      // Another business's, too — and it says nothing about whose.
      { photoStorageId: theirPhoto },
    ]) {
      await expect(
        add(s, s.kevin, { name: 'Second', ...fields }),
        JSON.stringify(fields),
      ).rejects.toThrow(/ALREADY_ATTACHED/)
    }
    expect(await everything(s)).toEqual(before)
  })

  test('not on update either — nor its own file moved to the other place', async () => {
    const s = await setup()
    const photo = await upload(s, 1)
    const pdf = await upload(s, 2)
    await add(s, s.owner, {
      name: 'First',
      photoStorageId: photo,
      pdf: { storageId: pdf, fileName: 'sds.pdf' },
    })
    const ownPhoto = await upload(s, 3)
    const ownPdf = await upload(s, 4)
    const second = await add(s, s.kevin, {
      name: 'Second',
      photoStorageId: ownPhoto,
      pdf: { storageId: ownPdf, fileName: 'label.pdf' },
    })
    const theirs = await rival(s)
    const theirPhoto = (await row(s, theirs.productId))!.photoStorageId!
    const before = await everything(s)

    for (const fields of [
      // A PDF is where a report's id would be tried: every way in is shut.
      { pdf: { storageId: pdf, fileName: 'x.pdf' } },
      { pdf: { storageId: photo, fileName: 'x.pdf' } },
      { pdf: { storageId: theirPhoto, fileName: 'x.pdf' } },
      { photoStorageId: pdf },
      { photoStorageId: photo },
      { photoStorageId: theirPhoto },
      // One file is this product's photo or its PDF, not both.
      { pdf: { storageId: ownPhoto, fileName: 'x.pdf' } },
      { photoStorageId: ownPdf },
    ]) {
      await expect(
        s.kevin.as.mutation(api.products.update, {
          businessId: s.businessId,
          productId: second,
          ...fields,
        }),
        JSON.stringify(fields),
      ).rejects.toThrow(/ALREADY_ATTACHED/)
    }
    expect(await everything(s)).toEqual(before)
  })

  test('not one upload as both the photo and the PDF', async () => {
    const s = await setup()
    const file = await upload(s)
    await expect(
      add(s, s.owner, {
        photoStorageId: file,
        pdf: { storageId: file, fileName: 'sds.pdf' },
      }),
    ).rejects.toThrow(/ALREADY_ATTACHED/)
    expect(await everything(s)).toEqual([])

    const productId = await add(s, s.owner)
    await expect(
      s.owner.as.mutation(api.products.update, {
        businessId: s.businessId,
        productId,
        photoStorageId: file,
        pdf: { storageId: file, fileName: 'sds.pdf' },
      }),
    ).rejects.toThrow(/ALREADY_ATTACHED/)
  })

  test('a photo past MAX_PHOTO_BYTES is refused; a PDF that size is not — on create and on update', async () => {
    const s = await setup()
    const big = await upload(s, MAX_PHOTO_BYTES + 1)
    await expect(add(s, s.owner, { photoStorageId: big })).rejects.toThrow(
      /FILE_TOO_LARGE/,
    )
    expect(await everything(s)).toEqual([])

    const productId = await add(s, s.owner, {
      pdf: { storageId: big, fileName: 'label.pdf' },
    })
    expect((await row(s, productId))?.pdfSize).toBe(MAX_PHOTO_BYTES + 1)

    const other = await add(s, s.owner, { name: 'Coopex Dust' })
    const bigger = await upload(s, MAX_PHOTO_BYTES + 1)
    const before = await everything(s)
    await expect(
      s.owner.as.mutation(api.products.update, {
        businessId: s.businessId,
        productId: other,
        photoStorageId: bigger,
      }),
    ).rejects.toThrow(/FILE_TOO_LARGE/)
    expect(await everything(s)).toEqual(before)

    // The file just refused as a photo is a PDF's size: update checks a PDF
    // by the PDF's rules, not the photo's.
    await s.owner.as.mutation(api.products.update, {
      businessId: s.businessId,
      productId: other,
      pdf: { storageId: bigger, fileName: 'label.pdf' },
    })
    expect((await row(s, other))?.pdfSize).toBe(MAX_PHOTO_BYTES + 1)
  })

  test('a PDF past MAX_PDF_BYTES is refused, on create and on update', async () => {
    const s = await setup()
    // The form refuses one first; this is the Save from a client that did not.
    const huge = await upload(s, MAX_PDF_BYTES + 1)
    await expect(
      add(s, s.owner, { pdf: { storageId: huge, fileName: 'manual.pdf' } }),
    ).rejects.toThrow(/FILE_TOO_LARGE/)
    expect(await everything(s)).toEqual([])

    const productId = await add(s, s.owner)
    const before = await everything(s)
    await expect(
      s.owner.as.mutation(api.products.update, {
        businessId: s.businessId,
        productId,
        pdf: { storageId: huge, fileName: 'manual.pdf' },
      }),
    ).rejects.toThrow(/FILE_TOO_LARGE/)
    expect(await everything(s)).toEqual(before)
  })

  test('sending back the ones it already holds changes nothing', async () => {
    const s = await setup()
    vi.useFakeTimers({ toFake: ['Date'] })
    const photo = await upload(s)
    const pdf = await upload(s, 40)
    const productId = await add(s, s.kevin, {
      photoStorageId: photo,
      pdf: { storageId: pdf, fileName: 'sds.pdf' },
    })
    const before = await row(s, productId)

    // Long after they could be claimed again: re-sending is not a claim.
    vi.setSystemTime(Date.now() + 2 * CLAIM_WINDOW_MS)
    await s.kevin.as.mutation(api.products.update, {
      businessId: s.businessId,
      productId,
      name: before!.name,
      photoStorageId: photo,
      pdf: { storageId: pdf, fileName: 'renamed.pdf' },
    })
    const after = await row(s, productId)
    expect(after).toEqual({
      ...before,
      updatedAt: after!.updatedAt,
    })
    expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt)
  })

  test('are replaced by a new upload, and the old files stay stored', async () => {
    const s = await setup()
    const [oldPhoto, oldPdf, newPhoto, newPdf] = [
      await upload(s, 1),
      await upload(s, 2),
      await upload(s, 3),
      await upload(s, 4),
    ]
    const productId = await add(s, s.owner, {
      photoStorageId: oldPhoto,
      pdf: { storageId: oldPdf, fileName: 'old.pdf' },
    })

    await s.owner.as.mutation(api.products.update, {
      businessId: s.businessId,
      productId,
      name: 'Termidor HE',
      photoStorageId: newPhoto,
      pdf: { storageId: newPdf, fileName: '' },
    })
    expect(await row(s, productId)).toMatchObject({
      photoStorageId: newPhoto,
      pdfStorageId: newPdf,
      // No name of its own: the product's, as it is now.
      pdfFileName: 'Termidor HE.pdf',
      pdfSize: 4,
    })
    expect(await stored(s, oldPhoto)).not.toBeNull()
    expect(await stored(s, oldPdf)).not.toBeNull()

    // And the old ones are free again — nothing holds them now.
    await add(s, s.owner, { name: 'Reuse', photoStorageId: oldPhoto })
  })

  test('are cleared by null, and their files stay stored', async () => {
    const s = await setup()
    const photo = await upload(s)
    const pdf = await upload(s, 9)
    const productId = await add(s, s.owner, {
      photoStorageId: photo,
      pdf: { storageId: pdf, fileName: 'sds.pdf' },
    })

    await s.owner.as.mutation(api.products.update, {
      businessId: s.businessId,
      productId,
      photoStorageId: null,
      pdf: null,
    })
    const cleared = await row(s, productId)
    for (const field of [
      'photoStorageId',
      'pdfStorageId',
      'pdfFileName',
      'pdfSize',
    ] as const) {
      expect(cleared).not.toHaveProperty(field)
    }
    const [shown] = await listAs(s, s.owner)
    expect(shown.photoUrl).toBeNull()
    expect(shown.pdf).toBeNull()
    expect(await stored(s, photo)).not.toBeNull()
    expect(await stored(s, pdf)).not.toBeNull()
  })

  test('outlive the product: removing it deletes the row alone', async () => {
    const s = await setup()
    const photo = await upload(s)
    const pdf = await upload(s, 9)
    const productId = await add(s, s.kevin, {
      photoStorageId: photo,
      pdf: { storageId: pdf, fileName: 'sds.pdf' },
    })

    await s.kevin.as.mutation(api.products.remove, {
      businessId: s.businessId,
      productId,
    })
    expect(await everything(s)).toEqual([])
    expect(await stored(s, photo)).not.toBeNull()
    expect(await stored(s, pdf)).not.toBeNull()
  })

  test('gone from storage, show as missing rather than break the list', async () => {
    const s = await setup()
    const photo = await upload(s)
    const pdf = await upload(s, 9)
    await add(s, s.owner, {
      photoStorageId: photo,
      pdf: { storageId: pdf, fileName: 'sds.pdf' },
    })
    await s.t.run(async (ctx) => {
      await ctx.storage.delete(photo)
      await ctx.storage.delete(pdf)
    })

    const [shown] = await listAs(s, s.kevin)
    expect(shown.photoUrl).toBeNull()
    expect(shown.pdf).toEqual({ url: null, fileName: 'sds.pdf', size: 9 })
  })
})

/** The rows `create` wrote are what `list` shows — kept here so a change to
 * the row shape that the page would not see fails loudly. */
test('list shows what was saved, field for field', async () => {
  const s = await setup()
  const productId = await add(s, s.owner, {
    name: 'Termidor Residual',
    description: 'Termite barrier, 100 g/L fipronil.',
    url: 'termidor.com.au',
  })
  const saved = (await row(s, productId)) as Doc<'products'>
  expect(await listAs(s, s.owner)).toEqual([
    {
      id: productId,
      name: 'Termidor Residual',
      description: 'Termite barrier, 100 g/L fipronil.',
      url: 'https://termidor.com.au/',
      photoUrl: null,
      pdf: null,
      canEdit: true,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    },
  ])
})
