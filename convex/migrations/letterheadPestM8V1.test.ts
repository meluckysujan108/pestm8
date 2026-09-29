/// <reference types="vite/client" />
import { afterEach, expect, test, vi } from 'vitest'
import { internal } from '../_generated/api'
import { createActor, createBusiness, testApp } from '../../test/harness'
import { CLAIM_WINDOW_MS } from '../lib/products'

afterEach(() => {
  vi.useRealTimers()
})

let uploads = 0

async function setup() {
  const t = testApp()
  const owner = await createActor(t, {
    email: 'terence@pestm8.test',
    name: 'Terence',
  })
  const { businessId } = await createBusiness(t, owner, 'Pest M8 Pest Control')
  const upload = () =>
    t.run((ctx) => ctx.storage.store(new Blob([`png ${++uploads}`])))
  const jpeg = await upload()
  await t.run((ctx) => ctx.db.patch(businessId, { logoStorageId: jpeg }))
  const pair = async () => ({
    storageId: await upload(),
    email: { storageId: await upload(), width: 220, height: 72 },
  })
  const args = {
    businessId,
    businessName: 'Pest M8 Pest Control',
    expectLogo: jpeg,
    logo: await pair(),
    logoOnDark: await pair(),
  }
  const business = () => t.run((ctx) => ctx.db.get(businessId))
  const run = (extra: Partial<typeof args> & { dryRun: boolean }) =>
    t.mutation(internal.migrations.letterheadPestM8V1.run, {
      ...args,
      ...extra,
    })
  return { t, args, business, run, upload }
}

test('a dry run says what it would set, and sets nothing', async () => {
  const s = await setup()
  expect(await s.run({ dryRun: true })).toMatchObject({ status: 'would set' })
  expect((await s.business())?.logoStorageId).toBe(s.args.expectLogo)
  expect((await s.business())?.logoOnDark).toBeUndefined()
})

test('puts the logo, its card and its dark version on, once', async () => {
  const s = await setup()
  expect(await s.run({ dryRun: false })).toMatchObject({ status: 'set' })
  expect(await s.business()).toMatchObject({
    logoStorageId: s.args.logo.storageId,
    logoEmail: s.args.logo.email,
    logoOnDark: s.args.logoOnDark,
  })
  expect(await s.run({ dryRun: false })).toEqual({ status: 'already done' })
})

test('leaves alone a logo the owner has changed since it was seen', async () => {
  const s = await setup()
  const theirs = await s.upload()
  await s.t.run((ctx) =>
    ctx.db.patch(s.args.businessId, { logoStorageId: theirs }),
  )
  expect(await s.run({ dryRun: false })).toEqual({
    status: 'left alone: the logo has changed',
  })
  expect((await s.business())?.logoStorageId).toBe(theirs)
})

test('refuses another business, and files uploaded too long ago', async () => {
  const s = await setup()
  await expect(
    s.run({ dryRun: false, businessName: 'Coastal Pest' }),
  ).rejects.toThrow(/NOT_FOUND/)

  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + CLAIM_WINDOW_MS + 1000)
  await expect(s.run({ dryRun: false })).rejects.toThrow(/FILE_NOT_FOUND/)
  expect((await s.business())?.logoStorageId).toBe(s.args.expectLogo)
})
