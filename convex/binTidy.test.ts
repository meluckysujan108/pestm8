/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor } from '../test/harness'
import { join, setup } from '../test/binFixture'
import { knownRecipients } from './lib/recipients'
import type { Id } from './_generated/dataModel'
import type { Setup } from '../test/binFixture'

/**
 * The Recycle bin's tidy-ups: a contact goes to the bin rather than being
 * erased by anyone; clients archived before the bin existed move into it;
 * and a wipe deletes a job photo's file only when the file was that job's
 * alone.
 */

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

async function settle(s: Setup) {
  await s.t.finishAllScheduledFunctions(vi.runAllTimers)
}

async function contact(s: Setup, email: string) {
  return s.t.run((ctx) =>
    ctx.db.insert('clientContacts', {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
      name: 'Accounts',
      email,
      createdAt: Date.now(),
    }),
  )
}

describe('a contact', () => {
  test('goes to the bin, gets no reports there, and comes back', async () => {
    const s = await setup()
    const contactId = await contact(s, 'accounts@nguyen.test')
    const entryId = await s.owner.as.mutation(api.bin.deleteContact, {
      businessId: s.businessId,
      contactId,
    })

    const listed = await s.owner.as.query(api.clientContacts.list, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })
    expect(listed.map((c) => c._id)).not.toContain(contactId)
    const recipients = await s.t.run(async (ctx) =>
      knownRecipients(ctx, (await ctx.db.get(s.nguyen.finalId))!),
    )
    expect(recipients).not.toContain('accounts@nguyen.test')

    const { entries } = await s.owner.as.query(api.bin.list, {
      businessId: s.businessId,
    })
    expect(entries[0]).toMatchObject({
      kind: 'contact',
      title: 'Accounts',
      clientName: 'J. Nguyen',
    })

    await s.owner.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })
    const back = await s.owner.as.query(api.clientContacts.list, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })
    expect(back.map((c) => c._id)).toContain(contactId)
  })

  test('the older Remove puts it in the bin too, and only for clients.manage', async () => {
    const s = await setup()
    const contactId = await contact(s, 'accounts@nguyen.test')
    const sub = await createActor(s.t, { email: 'priya@coastal.test' })
    await join(s, sub)

    await expect(
      sub.as.mutation(api.clientContacts.remove, {
        businessId: s.businessId,
        contactId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)

    await s.owner.as.mutation(api.clientContacts.remove, {
      businessId: s.businessId,
      contactId,
    })
    const row = await s.t.run((ctx) => ctx.db.get(contactId))
    expect(row?.deletedAt).toBeDefined()
  })

  test('cannot come back while its client is in the bin', async () => {
    const s = await setup()
    const contactId = await contact(s, 'accounts@nguyen.test')
    const entryId = await s.owner.as.mutation(api.bin.deleteContact, {
      businessId: s.businessId,
      contactId,
    })
    await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })
    await expect(
      s.owner.as.mutation(api.bin.restore, {
        businessId: s.businessId,
        entryId,
      }),
    ).rejects.toThrow(/RESTORE_CLIENT_FIRST/)
  })

  test('is wiped for good', async () => {
    const s = await setup()
    const contactId = await contact(s, 'accounts@nguyen.test')
    const entryId = await s.owner.as.mutation(api.bin.deleteContact, {
      businessId: s.businessId,
      contactId,
    })
    await s.owner.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId,
    })
    await settle(s)
    expect(await s.t.run((ctx) => ctx.db.get(contactId))).toBeNull()
    expect(await s.t.run((ctx) => ctx.db.get(s.nguyen.clientId))).not.toBeNull()
  })
})

describe('clients archived before the bin', () => {
  test('move into it, and restoring one un-archives it', async () => {
    const s = await setup()
    const archivedAt = Date.now() - 5 * 24 * 60 * 60 * 1000
    await s.t.run((ctx) => ctx.db.patch(s.nguyen.clientId, { archivedAt }))

    const preview = await s.t.query(
      internal.migrations.archivedClientsToBinV1.preview,
      {},
    )
    expect(preview).toHaveLength(1)
    expect(preview[0]).toMatchObject({
      clientId: s.nguyen.clientId,
      properties: 1,
      activeSeries: 1,
    })

    await s.t.mutation(internal.migrations.archivedClientsToBinV1.run, {
      cursor: null,
    })
    await settle(s)
    // Safe to run again.
    await s.t.mutation(internal.migrations.archivedClientsToBinV1.run, {
      cursor: null,
    })
    await settle(s)

    const { entries } = await s.owner.as.query(api.bin.list, {
      businessId: s.businessId,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'client',
      title: 'J. Nguyen',
      deletedBy: '',
      archivedAt,
    })
    const job = await s.t.run((ctx) => ctx.db.get(s.nguyen.jobId))
    expect(job?.deletedAt).toBeDefined()

    await s.owner.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId: entries[0]._id,
    })
    const clients = await s.owner.as.query(api.clients.list, {
      businessId: s.businessId,
    })
    expect(clients.map((c) => c._id)).toContain(s.nguyen.clientId)
  })
})

describe('a wiped job photo’s file', () => {
  async function addPhoto(
    s: Setup,
    jobId: Id<'jobs'>,
    storageId: Id<'_storage'>,
  ) {
    await s.owner.as.mutation(api.jobs.addPhoto, {
      businessId: s.businessId,
      jobId,
      storageId,
    })
  }
  const upload = (s: Setup) =>
    s.t.run((ctx) => ctx.storage.store(new Blob(['photo'])))
  const fileExists = async (s: Setup, id: Id<'_storage'>) =>
    (await s.t.run((ctx) => ctx.db.system.get(id))) !== null

  async function wipeJob(s: Setup, jobId: Id<'jobs'>) {
    const entryId = await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId,
    })
    await s.owner.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId,
    })
    await settle(s)
  }

  test('is deleted when it was that job’s alone', async () => {
    const s = await setup()
    const file = await upload(s)
    await addPhoto(s, s.nguyen.jobId, file)
    await wipeJob(s, s.nguyen.jobId)
    expect(await fileExists(s, file)).toBe(false)
  })

  test('is kept when another job holds it too', async () => {
    const s = await setup()
    const file = await upload(s)
    await addPhoto(s, s.nguyen.jobId, file)
    await addPhoto(s, s.patel.jobId, file)
    await wipeJob(s, s.nguyen.jobId)
    expect(await fileExists(s, file)).toBe(true)
  })

  test('is kept when it was not claimed — added late, or before claims', async () => {
    const s = await setup()
    const file = await upload(s)
    vi.advanceTimersByTime(20 * 60 * 1000)
    await addPhoto(s, s.nguyen.jobId, file)
    await wipeJob(s, s.nguyen.jobId)
    expect(await fileExists(s, file)).toBe(true)
  })
})
