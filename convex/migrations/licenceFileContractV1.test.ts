/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api, internal } from '../_generated/api'
import { createActor, createBusiness, testApp } from '../../test/harness'
import { MEMBER_COLOURS } from '../lib/colours'
import type { Doc, Id } from '../_generated/dataModel'

/**
 * The contract for the Phase 8.1 licence document: every membership whose
 * document `licenceWalletV1` copied into the wallet has its pointer cleared,
 * and nothing else is touched — a document no wallet file holds stays, and is
 * reported, because clearing it would lose the only way to it.
 */

type Document = NonNullable<Doc<'memberships'>['licenceFile']>
type Status = Doc<'memberships'>['status']

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)

  /** A member with a document on their membership, as `licences.setFile`
   * left one. */
  const holder = (name: string, status: Status = 'active') =>
    t.run(async (ctx) => {
      const storageId = await ctx.storage.store(
        new Blob([new Uint8Array(3).fill(7)]),
      )
      const document: Document = {
        storageId,
        kind: 'pdf',
        contentType: 'application/pdf',
        fileName: `${name}.pdf`,
        size: 3,
        uploadedAt: Date.now(),
      }
      const membershipId = await ctx.db.insert('memberships', {
        userId: `user-${name}`,
        businessId,
        role: 'subcontractor',
        canViewAllJobs: false,
        colour: MEMBER_COLOURS[1],
        status,
        createdAt: Date.now(),
        licenceFile: document,
      })
      return { membershipId, document }
    })

  /** The document copied into the member's wallet, as `licenceWalletV1` did:
   * a licence called "Licence" holding a file with the SAME storage id. */
  const copy = (membershipId: Id<'memberships'>, document: Document) =>
    t.run(async (ctx) => {
      const licenceId = await ctx.db.insert('memberLicences', {
        businessId,
        membershipId,
        name: 'Licence',
        createdAt: document.uploadedAt,
        updatedAt: document.uploadedAt,
      })
      await ctx.db.insert('memberLicenceFiles', {
        businessId,
        membershipId,
        licenceId,
        storageId: document.storageId,
        kind: document.kind,
        contentType: document.contentType,
        fileName: document.fileName,
        size: document.size,
        uploadedAt: document.uploadedAt,
      })
    })

  const kevin = await holder('kevin')
  await copy(kevin.membershipId, kevin.document)
  const priya = await holder('priya')
  await copy(priya.membershipId, priya.document)
  // Removed before the wallet copy ran, so `licenceWalletV1` skipped her.
  const jo = await holder('jo', 'removed')
  // Copied, then replaced from the old Profile page: the wallet holds the
  // first file, and the membership now points at a second one.
  const sam = await holder('sam')
  await copy(sam.membershipId, sam.document)
  const replacement = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([new Uint8Array(5)]))
    const document: Document = { ...sam.document, storageId, size: 5 }
    await ctx.db.patch('memberships', sam.membershipId, {
      licenceFile: document,
    })
    return document
  })

  const run = (dryRun?: boolean) =>
    t.mutation(
      internal.migrations.licenceFileContractV1.run,
      dryRun === undefined ? {} : { dryRun },
    )
  const remaining = () =>
    t.query(internal.migrations.licenceFileContractV1.remaining, {})
  const documentOf = (membershipId: Id<'memberships'>) =>
    t.run(
      async (ctx) =>
        (await ctx.db.get('memberships', membershipId))?.licenceFile ?? null,
    )
  const everything = () =>
    t.run(async (ctx) => ({
      memberships: await ctx.db.query('memberships').collect(),
      licences: await ctx.db.query('memberLicences').collect(),
      files: await ctx.db.query('memberLicenceFiles').collect(),
    }))

  return {
    t,
    owner,
    businessId,
    ownerMembershipId,
    kevin,
    priya,
    jo,
    sam,
    replacement,
    copy,
    run,
    remaining,
    documentOf,
    everything,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

const sortById = <T extends { membershipId: string }>(rows: Array<T>) =>
  [...rows].sort((a, b) => a.membershipId.localeCompare(b.membershipId))

function expectedCleared(s: Setup) {
  return sortById(
    [s.kevin, s.priya].map(({ membershipId }) => ({
      membershipId,
      businessId: s.businessId,
    })),
  )
}

function expectedNotCopied(s: Setup) {
  return sortById([
    {
      membershipId: s.jo.membershipId,
      businessId: s.businessId,
      status: 'removed' as const,
    },
    {
      membershipId: s.sam.membershipId,
      businessId: s.businessId,
      status: 'active' as const,
    },
  ])
}

describe('clearing the copied licence documents', () => {
  test('a copied document is cleared; the wallet and the file stay', async () => {
    const s = await setup()
    expect(await s.remaining()).toBe(4)
    const { licences, files } = await s.everything()

    const result = await s.run()
    expect(result.dryRun).toBe(false)
    expect(sortById(result.cleared)).toEqual(expectedCleared(s))
    expect(await s.documentOf(s.kevin.membershipId)).toBeNull()
    expect(await s.documentOf(s.priya.membershipId)).toBeNull()

    // The wallet is as it was, and the file is still in storage.
    const after = await s.everything()
    expect(after.licences).toEqual(licences)
    expect(after.files).toEqual(files)
    expect(
      await s.t.run(async (ctx) =>
        ctx.db.system.get('_storage', s.kevin.document.storageId),
      ),
    ).not.toBeNull()

    // And it is still a licence: the wallet file is what holds it now, so no
    // other feature can claim it.
    await expect(
      s.owner.as.mutation(api.products.create, {
        businessId: s.businessId,
        name: 'Not a product',
        photoStorageId: s.kevin.document.storageId,
      }),
    ).rejects.toThrow(/ALREADY_ATTACHED/)
  })

  test('a document no wallet file holds is left, and reported', async () => {
    const s = await setup()
    const result = await s.run()

    expect(sortById(result.notCopied)).toEqual(expectedNotCopied(s))
    expect(await s.documentOf(s.jo.membershipId)).toEqual(s.jo.document)
    expect(await s.documentOf(s.sam.membershipId)).toEqual(s.replacement)
    expect(await s.remaining()).toBe(2)
  })

  test('once every document is in a wallet, the run leaves none', async () => {
    const s = await setup()
    // Jo's and Sam's current one copied too — as a later `licenceWalletV1`
    // run does for anyone who has come back.
    await s.copy(s.jo.membershipId, s.jo.document)
    await s.copy(s.sam.membershipId, s.replacement)

    const result = await s.run()
    expect(result.cleared).toHaveLength(4)
    expect(result.notCopied).toEqual([])
    expect(await s.remaining()).toBe(0)
  })

  test('a second run clears nothing new and writes nothing', async () => {
    const s = await setup()
    await s.run()
    const before = await s.everything()

    const again = await s.run()
    expect(again).toEqual({
      dryRun: false,
      cleared: [],
      notCopied: expect.any(Array),
    })
    expect(sortById(again.notCopied)).toEqual(expectedNotCopied(s))
    expect(await s.everything()).toEqual(before)
  })

  test('a dry run says what it would clear and writes nothing', async () => {
    const s = await setup()
    const before = await s.everything()

    const preview = await s.run(true)
    expect(preview.dryRun).toBe(true)
    expect(sortById(preview.cleared)).toEqual(expectedCleared(s))
    expect(sortById(preview.notCopied)).toEqual(expectedNotCopied(s))
    expect(await s.everything()).toEqual(before)
    expect(await s.remaining()).toBe(4)
  })

  test('with no documents anywhere, there is nothing to do', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@coastal.test' })
    await createBusiness(t, owner)
    expect(
      await t.query(internal.migrations.licenceFileContractV1.remaining, {}),
    ).toBe(0)
    expect(
      await t.mutation(internal.migrations.licenceFileContractV1.run, {}),
    ).toEqual({ dryRun: false, cleared: [], notCopied: [] })
  })
})
