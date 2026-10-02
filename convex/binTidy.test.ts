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

/**
 * A client's contact person is its one starred contact (lib/contactPerson.ts,
 * the job card's Contact line). The bin keeps the star, so a contact person
 * deleted by mistake comes back as one, but never as a second.
 */
describe('a contact person and the bin', () => {
  function starred(s: Setup) {
    return s.t.run(async (ctx) =>
      (
        await ctx.db
          .query('clientContacts')
          .withIndex('by_client', (q) => q.eq('clientId', s.nguyen.clientId))
          .collect()
      )
        .filter((c) => c.deletedAt === undefined && c.isPrimary)
        .map((c) => c.name),
    )
  }

  function person(s: Setup, name: string, isPrimary = false) {
    return s.t.run((ctx) =>
      ctx.db.insert('clientContacts', {
        businessId: s.businessId,
        clientId: s.nguyen.clientId,
        name,
        ...(isPrimary && { isPrimary }),
        createdAt: Date.now(),
      }),
    )
  }

  test('comes back as the contact person when nobody replaced them', async () => {
    const s = await setup()
    const sam = await person(s, 'Sam Lee', true)
    const entryId = await s.owner.as.mutation(api.bin.deleteContact, {
      businessId: s.businessId,
      contactId: sam,
    })
    expect(await starred(s)).toEqual([])

    await s.owner.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })
    expect(await starred(s)).toEqual(['Sam Lee'])
  })

  test('comes back as a plain contact when someone else was made it meanwhile', async () => {
    const s = await setup()
    const sam = await person(s, 'Sam Lee', true)
    const entryId = await s.owner.as.mutation(api.bin.deleteContact, {
      businessId: s.businessId,
      contactId: sam,
    })
    const priya = await person(s, 'Priya Shah')
    await s.owner.as.mutation(api.clientContacts.setPrimary, {
      businessId: s.businessId,
      contactId: priya,
    })

    await s.owner.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })
    // One star, and it is the later choice.
    expect(await starred(s)).toEqual(['Priya Shah'])
    const back = await s.t.run((ctx) => ctx.db.get(sam))
    expect(back?.deletedAt).toBeUndefined()
    expect(back?.isPrimary).toBe(false)
  })

  test('the same when the replacement came through the client form', async () => {
    const s = await setup()
    // The form's contact person is a business client's.
    await s.t.run((ctx) =>
      ctx.db.patch(s.nguyen.clientId, { kind: 'business' }),
    )
    const sam = await person(s, 'Sam Lee', true)
    const entryId = await s.owner.as.mutation(api.bin.deleteContact, {
      businessId: s.businessId,
      contactId: sam,
    })
    await s.owner.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
      contactPerson: 'Priya Shah',
    })

    await s.owner.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })
    expect(await starred(s)).toEqual(['Priya Shah'])
  })

  test('a client restored from the bin keeps its one contact person', async () => {
    const s = await setup()
    await person(s, 'Sam Lee', true)
    await person(s, 'Priya Shah')
    const entryId = await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.nguyen.clientId,
    })

    await s.owner.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })
    expect(await starred(s)).toEqual(['Sam Lee'])
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
