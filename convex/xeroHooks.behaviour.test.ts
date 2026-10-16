/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import { connectAndFinish, fakeXero } from '../test/fakeXero'
import type { Doc, Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * Every public write to a client, its contacts or its sites queues the
 * client for each organisation that is syncing (lib/xeroHooks.ts) — or, for
 * a client deleted for good, drops its links and anything queued for it.
 *
 * convex/xeroHooks.test.ts holds the SOURCE to that: every write names its
 * table and its function calls a hook. This holds the BEHAVIOUR: each
 * mutation a screen calls, run for real against a business whose Xero has
 * pressed Start syncing, leaves a row in `xeroOutbox` for exactly the
 * clients it changed. A hook wired to the wrong client, skipped on one
 * branch, or lost in a refactor shows up here as a change Xero never gets.
 *
 * The kill switch is on throughout, once syncing has started: the hooks
 * still queue (that is the switch's promise — nothing is lost while it is
 * on), but no drain sends, so what each mutation queued stays to be read.
 */

const XU = { terence: 'xu-terence', kevin: 'xu-kevin' } as const
const ORG = { coastal: 'tenant-coastal', kevin: 'tenant-kevin' } as const

const SECOND = 1000
const DAY = 24 * 60 * 60 * SECOND

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

type Seed = {
  name: string
  kind?: 'person' | 'business'
  status?: 'lead'
  sites?: Array<string>
  contacts?: Array<{ name: string; primary?: boolean }>
}

async function insertClient(
  s: { t: ReturnType<typeof testApp>; businessId: Id<'businesses'> },
  seed: Seed,
  clientNumber: number,
) {
  return s.t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId: s.businessId,
      kind: seed.kind ?? 'person',
      name: seed.name,
      clientNumber,
      ...(seed.status ? { status: seed.status } : {}),
      createdAt: now,
      updatedAt: now,
    })
    for (const [i, addressLine] of (
      seed.sites ?? ['1 Test Street']
    ).entries()) {
      await ctx.db.insert('properties', {
        businessId: s.businessId,
        clientId,
        addressLine,
        suburb: 'Bayswater',
        state: 'WA',
        postcode: '6053',
        createdAt: now + i,
      })
    }
    for (const [i, contact] of (seed.contacts ?? []).entries()) {
      await ctx.db.insert('clientContacts', {
        businessId: s.businessId,
        clientId,
        name: contact.name,
        ...(contact.primary ? { isPrimary: true } : {}),
        createdAt: now + i,
      })
    }
    return clientId
  })
}

/**
 * Coastal Pest with a small book, its Xero connected and syncing — the book
 * sent — and then the kill switch on, so what each mutation under test
 * queues stays in the queue. Kevin, a subcontractor, has connected his own
 * Xero, but only starts it when a test says so.
 */
async function started() {
  const t = testApp()
  const xero = fakeXero()
  xero.tenant({ tenantId: ORG.coastal, name: 'Coastal Pest Pty Ltd' })
  xero.tenant({ tenantId: ORG.kevin, name: 'Kevin Walsh Pest Services' })
  const terence = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, terence)
  const kevin = await createActor(t, {
    email: 'kevin@coastal.test',
    name: 'Kevin Walsh',
  })
  const kevinId = await joinBusiness(
    t,
    terence,
    kevin,
    businessId,
    'subcontractor',
  )
  const base = { t, businessId }
  const book = {
    /** A person, in Xero once syncing starts. */
    alice: await insertClient(base, { name: 'Alice Archer' }, 1),
    /** A business with two sites and two contacts, in Xero. */
    bob: await insertClient(
      base,
      {
        name: 'Bob Builders Pty Ltd',
        kind: 'business',
        sites: ['2 Brick Road', '3 Mortar Lane'],
        contacts: [{ name: 'Beth Boss', primary: true }, { name: 'Ben Hand' }],
      },
      2,
    ),
    /** A lead: in no organisation. */
    lena: await insertClient(base, { name: 'Lena Lead', status: 'lead' }, 3),
  }
  xero.contacts(ORG.coastal, [])
  xero.contacts(ORG.kevin, [])

  const s = {
    t,
    xero,
    businessId,
    terence,
    ownerMembershipId,
    kevin,
    kevinId,
    book,
  }
  const connection = await connect(
    s,
    terence,
    'business',
    XU.terence,
    ORG.coastal,
  )
  const kevins = await connect(s, kevin, 'member', XU.kevin, ORG.kevin)
  await terence.as.mutation(api.xeroSync.startSyncing, {
    businessId,
    connectionId: connection._id,
  })
  await t.finishAllScheduledFunctions(vi.runAllTimers, 1000)
  expect(xero.named(ORG.coastal, 'Alice Archer')).toHaveLength(1)

  vi.stubEnv('XERO_SYNC_PAUSED', 'on')
  await clear({ t })
  return { ...s, connection, kevins }
}

type Started = Awaited<ReturnType<typeof started>>

async function connect(
  s: {
    t: ReturnType<typeof testApp>
    businessId: Id<'businesses'>
  },
  who: TestActor,
  kind: 'business' | 'member',
  xeroUserId: string,
  tenantId: string,
): Promise<Doc<'xeroConnections'>> {
  await connectAndFinish(s.t, who.as, {
    businessId: s.businessId,
    kind,
    xeroUserId,
    tenantId,
  })
  const row = (
    await s.t.run((ctx) => ctx.db.query('xeroConnections').collect())
  )
    .filter((r) => r.tenantId === tenantId && r.status === 'connected')
    .at(-1)
  if (!row) throw new Error(`${tenantId} did not connect`)
  return row
}

const settle = (s: Started) =>
  s.t.finishAllScheduledFunctions(vi.runAllTimers, 1000)

const rows = (s: Pick<Started, 't'>) =>
  s.t.run((ctx) => ctx.db.query('xeroOutbox').collect())

async function clear(s: Pick<Started, 't'>) {
  await s.t.run(async (ctx) => {
    for (const row of await ctx.db.query('xeroOutbox').collect()) {
      await ctx.db.delete(row._id)
    }
  })
}

/** Exactly these clients are queued — each once, for the business's Xero
 * only — and nothing else. */
async function expectQueued(
  s: Started,
  clientIds: Array<Id<'clients'>>,
): Promise<void> {
  const queued = await rows(s)
  expect(queued.map((row) => row.clientId).sort()).toEqual(
    [...clientIds].sort(),
  )
  for (const row of queued) {
    expect(row).toMatchObject({
      businessId: s.businessId,
      connectionId: s.connection._id,
      attempts: 0,
    })
  }
}

/** Runs `act` on an empty queue, and checks what it queued. */
async function queues(
  s: Started,
  act: () => Promise<unknown>,
  clientIds: Array<Id<'clients'>>,
): Promise<void> {
  await clear(s)
  await act()
  await expectQueued(s, clientIds)
}

const clientNamed = (s: Started, name: string) =>
  s.t.run(async (ctx) => {
    const row = (await ctx.db.query('clients').collect()).find(
      (c) => c.name === name,
    )
    if (!row) throw new Error(`no client ${name}`)
    return row._id
  })

const sitesOf = (s: Started, clientId: Id<'clients'>) =>
  s.t.run(async (ctx) =>
    (
      await ctx.db
        .query('properties')
        .withIndex('by_client', (q) => q.eq('clientId', clientId))
        .collect()
    ).map((p) => p._id),
  )

const contactsOf = (s: Started, clientId: Id<'clients'>) =>
  s.t.run(async (ctx) =>
    (
      await ctx.db
        .query('clientContacts')
        .withIndex('by_client', (q) => q.eq('clientId', clientId))
        .collect()
    ).map((c) => c._id),
  )

const linksOf = (s: Started, clientId: Id<'clients'>) =>
  s.t.run((ctx) =>
    ctx.db
      .query('xeroContactLinks')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect(),
  )

const newSite = {
  addressLine: '9 New Site Road',
  suburb: 'Morley',
  state: 'WA',
  postcode: '6062',
}

async function bookAt(s: Started, propertyId: Id<'properties'>) {
  return s.terence.as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId,
    assignedMembershipId: s.ownerMembershipId,
    jobType: 'General Pest',
    price: 18000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 60,
  })
}

// ═════════════════════════════════════════════════════════════════ clients

describe('clients', () => {
  test('a new client, from New client: queued', async () => {
    const s = await started()
    await clear(s)
    await s.terence.as.mutation(api.properties.create, {
      businessId: s.businessId,
      clientName: 'Nancy New',
      ...newSite,
    })
    await expectQueued(s, [await clientNamed(s, 'Nancy New')])
  })

  test('a new lead: not queued — it waits for its first job', async () => {
    const s = await started()
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.properties.create, {
          businessId: s.businessId,
          clientName: 'Larry Lead',
          status: 'lead',
          ...newSite,
        }),
      [],
    )
    // Nor when a lead in no organisation is edited.
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.clients.update, {
          businessId: s.businessId,
          clientId: s.book.lena,
          phone: '0411 222 333',
        }),
      [],
    )
  })

  test('an edit: queued; a save with nothing in it: not', async () => {
    const s = await started()
    const update = (patch: Record<string, string>) =>
      s.terence.as.mutation(api.clients.update, {
        businessId: s.businessId,
        clientId: s.book.alice,
        ...patch,
      })
    await queues(s, () => update({ email: 'alice@archer.test' }), [
      s.book.alice,
    ])
    await queues(s, () => update({ name: 'Alice Archer-Smith' }), [
      s.book.alice,
    ])
    // The edit form sends every field, so a save that changes nothing is
    // still queued, and the drain finds nothing to send (convex/
    // xeroSync.test.ts: no read, no write). Only a save of no fields at all
    // writes nothing, and queues nothing.
    await queues(s, () => update({}), [])
  })

  test('a new contact person for a business: queued', async () => {
    const s = await started()
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.clients.update, {
          businessId: s.businessId,
          clientId: s.book.bob,
          contactPerson: 'Ben Hand',
        }),
      [s.book.bob],
    )
  })

  test('archived the old way, and back: queued each time', async () => {
    const s = await started()
    const args = { businessId: s.businessId, clientId: s.book.alice }
    await queues(s, () => s.terence.as.mutation(api.clients.archive, args), [
      s.book.alice,
    ])
    await queues(s, () => s.terence.as.mutation(api.clients.unarchive, args), [
      s.book.alice,
    ])
  })
})

// ═══════════════════════════════════════════════════════════════════ sites

describe('sites', () => {
  test('another site for a client: queued', async () => {
    const s = await started()
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.properties.createForClient, {
          businessId: s.businessId,
          clientId: s.book.alice,
          ...newSite,
        }),
      [s.book.alice],
    )
  })

  test('a site edited: its client queued; a save with nothing in it: not', async () => {
    const s = await started()
    const [site] = await sitesOf(s, s.book.alice)
    const update = (patch: { addressLine?: string }) =>
      s.terence.as.mutation(api.properties.update, {
        businessId: s.businessId,
        propertyId: site,
        ...patch,
      })
    await queues(s, () => update({ addressLine: '11 Moved Street' }), [
      s.book.alice,
    ])
    await queues(s, () => update({}), [])
  })
})

// ════════════════════════════════════════════════════════════════ contacts

describe('contacts', () => {
  test('added, edited, starred and removed: its client queued each time', async () => {
    const s = await started()
    const businessId = s.businessId
    let contactId: Id<'clientContacts'> | null = null
    await queues(s, async () => {
      contactId = await s.terence.as.mutation(api.clientContacts.create, {
        businessId,
        clientId: s.book.bob,
        name: 'Pat Payroll',
        email: 'pat@bob.test',
      })
    }, [s.book.bob])
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.clientContacts.update, {
          businessId,
          contactId: contactId!,
          email: 'pat.payroll@bob.test',
        }),
      [s.book.bob],
    )
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.clientContacts.setPrimary, {
          businessId,
          contactId: contactId!,
        }),
      [s.book.bob],
    )
    // The older screen's Remove, which goes to the Recycle bin now.
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.clientContacts.remove, {
          businessId,
          contactId: contactId!,
        }),
      [s.book.bob],
    )
  })
})

// ═════════════════════════════════════════════════════════ the Recycle bin

describe('the Recycle bin', () => {
  test('a client, a site or a contact deleted: its client queued; restored: queued again', async () => {
    const s = await started()
    const businessId = s.businessId
    const [, secondSite] = await sitesOf(s, s.book.bob)
    const [, secondContact] = await contactsOf(s, s.book.bob)

    let entries: Array<Id<'binEntries'>> = []
    await queues(s, async () => {
      entries = [
        await s.terence.as.mutation(api.bin.deleteProperty, {
          businessId,
          propertyId: secondSite,
        }),
        await s.terence.as.mutation(api.bin.deleteContact, {
          businessId,
          contactId: secondContact,
        }),
      ]
    }, [s.book.bob])
    let clientEntry: Id<'binEntries'> | null = null
    await queues(s, async () => {
      clientEntry = await s.terence.as.mutation(api.bin.deleteClient, {
        businessId,
        clientId: s.book.alice,
      })
    }, [s.book.alice])
    for (const entryId of entries) {
      await queues(
        s,
        () => s.terence.as.mutation(api.bin.restore, { businessId, entryId }),
        [s.book.bob],
      )
    }
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.bin.restore, {
          businessId,
          entryId: clientEntry!,
        }),
      [s.book.alice],
    )
  })

  test('a job deleted changes no client: nothing queued', async () => {
    const s = await started()
    const [site] = await sitesOf(s, s.book.alice)
    const jobId = await bookAt(s, site)
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.bin.deleteJob, {
          businessId: s.businessId,
          jobId,
        }),
      [],
    )
  })

  test('a client deleted with its sites and contacts is queued once for each organisation syncing', async () => {
    const s = await started()
    await s.kevin.as.mutation(api.xeroSync.startSyncing, {
      businessId: s.businessId,
      connectionId: s.kevins._id,
    })
    await clear(s)

    await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.book.bob,
    })
    const queued = await rows(s)
    expect(
      queued.map((row) => [row.connectionId, row.clientId]).sort(),
    ).toEqual(
      [
        [s.connection._id, s.book.bob],
        [s.kevins._id, s.book.bob],
      ].sort(),
    )
  })

  test('deleted for good: its links and anything queued for it go', async () => {
    const s = await started()
    expect(await linksOf(s, s.book.alice)).not.toEqual([])
    await s.terence.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: s.book.alice,
      email: 'alice@last.test',
    })
    const entryId = await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.book.alice,
    })
    await s.terence.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId,
    })
    await settle(s)

    expect(await s.t.run((ctx) => ctx.db.get(s.book.alice))).toBeNull()
    expect(await linksOf(s, s.book.alice)).toEqual([])
    expect(await rows(s)).toEqual([])
    // Bob, untouched, keeps his.
    expect(await linksOf(s, s.book.bob)).not.toEqual([])
  })

  test('emptying the bin: the same', async () => {
    const s = await started()
    await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.book.bob,
    })
    await s.terence.as.mutation(api.bin.empty, { businessId: s.businessId })
    await settle(s)

    expect(await linksOf(s, s.book.bob)).toEqual([])
    expect(await rows(s)).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════ merging

describe('merging clients', () => {
  // A person into a business: a business's contact people, ABN and office
  // address can't go into a person (clientMerge.ts, KIND_MISMATCH).
  test('one client merged into another: the one kept queued; the one merged gone — its links, and what was queued for it, with it', async () => {
    const s = await started()
    // A change of Alice's is waiting when the merge comes.
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.clients.update, {
          businessId: s.businessId,
          clientId: s.book.alice,
          phone: '0411 222 333',
        }),
      [s.book.alice],
    )
    expect(await linksOf(s, s.book.alice)).not.toEqual([])

    await s.terence.as.mutation(api.clientMerge.merge, {
      businessId: s.businessId,
      fromClientId: s.book.alice,
      intoClientId: s.book.bob,
    })

    // Bob has Alice's site and phone now, so his contact is sent again;
    // nothing is left to send of Alice, and she is in no organisation.
    await expectQueued(s, [s.book.bob])
    expect(await linksOf(s, s.book.alice)).toEqual([])
    expect(await linksOf(s, s.book.bob)).not.toEqual([])
  })

  test('the one kept is queued once for each organisation syncing', async () => {
    const s = await started()
    await s.kevin.as.mutation(api.xeroSync.startSyncing, {
      businessId: s.businessId,
      connectionId: s.kevins._id,
    })
    await clear(s)

    await s.terence.as.mutation(api.clientMerge.merge, {
      businessId: s.businessId,
      fromClientId: s.book.alice,
      intoClientId: s.book.bob,
    })
    expect(
      (await rows(s)).map((row) => [row.connectionId, row.clientId]).sort(),
    ).toEqual(
      [
        [s.connection._id, s.book.bob],
        [s.kevins._id, s.book.bob],
      ].sort(),
    )
  })
})

// ═════════════════════════════════════════════════════════════════ imports

describe('imports', () => {
  test('an import queues every client it adds, and one it adds a site to; its undo drops the links of those it takes back and queues the one that keeps going', async () => {
    const s = await started()
    const importId = await s.terence.as.mutation(api.clientImports.start, {
      businessId: s.businessId,
      fileName: 'clients.csv',
    })
    const site = (addressLine: string) => ({
      addressLine,
      suburb: 'Bassendean',
      state: 'WA',
      postcode: '6054',
    })

    await clear(s)
    const results = await s.terence.as.mutation(api.clientImports.addBatch, {
      businessId: s.businessId,
      importId,
      clients: [
        {
          key: 'ivy',
          kind: 'person',
          name: 'Ivy Imported',
          sites: [site('1 Import Street')],
        },
        {
          key: 'alice',
          kind: 'person',
          name: 'Alice Archer',
          existingClientId: s.book.alice,
          sites: [site('2 Import Street')],
        },
      ],
    })
    expect(results.map((r) => r.status)).toEqual(['created', 'added'])
    const ivy = results.find((r) => r.key === 'ivy')!.clientId!
    await expectQueued(s, [ivy, s.book.alice])

    // Ivy reaches Xero (as if sent): she has a link to lose.
    await s.t.run((ctx) =>
      ctx.db.insert('xeroContactLinks', {
        businessId: s.businessId,
        tenantId: ORG.coastal,
        clientId: ivy,
        state: 'linked',
        how: 'created',
        xeroContactId: 'contact-ivy',
      }),
    )
    await clear(s)
    await s.terence.as.mutation(api.clientImports.undo, {
      businessId: s.businessId,
      importId,
    })
    await settle(s)

    expect(await s.t.run((ctx) => ctx.db.get(ivy))).toBeNull()
    expect(await linksOf(s, ivy)).toEqual([])
    // Alice is the business's own: she keeps her links, and is queued, her
    // imported site gone.
    expect(await linksOf(s, s.book.alice)).not.toEqual([])
    await expectQueued(s, [s.book.alice])
  })
})

// ═════════════════════════════════════════════════════════════════ booking

describe('booking', () => {
  test('a job for a brand-new client, or at a new site: queued', async () => {
    const s = await started()
    const job = {
      businessId: s.businessId,
      assignedMembershipId: s.ownerMembershipId,
      jobType: 'General Pest',
      price: 18000,
      scheduledAt: Date.now() + DAY,
      durationMinutes: 60,
    }
    await clear(s)
    await s.terence.as.mutation(api.jobs.create, {
      ...job,
      newClient: { clientName: 'Jack Jobs', ...newSite },
    })
    await expectQueued(s, [await clientNamed(s, 'Jack Jobs')])

    await queues(
      s,
      () =>
        s.terence.as.mutation(api.jobs.create, {
          ...job,
          newProperty: { clientId: s.book.alice, ...newSite },
        }),
      [s.book.alice],
    )
  })

  test('a job for a lead: queued, and the lead made active', async () => {
    const s = await started()
    const [site] = await sitesOf(s, s.book.lena)
    await queues(s, () => bookAt(s, site), [s.book.lena])
    expect(
      (await s.t.run((ctx) => ctx.db.get(s.book.lena)))?.status ?? 'active',
    ).toBe('active')
  })

  test('a job for a client already in Xero: nothing — but for one not yet there, or that Xero refused: queued', async () => {
    const s = await started()
    const [aliceSite] = await sitesOf(s, s.book.alice)
    await queues(s, () => bookAt(s, aliceSite), [])

    // Added straight into the table after the walk of the book: no link.
    const late = await insertClient(s, { name: 'Late Larry' }, 50)
    const [lateSite] = await sitesOf(s, late)
    await queues(s, () => bookAt(s, lateSite), [late])

    // Refused by Xero last time.
    await s.t.run(async (ctx) => {
      const link = (
        await ctx.db
          .query('xeroContactLinks')
          .withIndex('by_client', (q) => q.eq('clientId', s.book.alice))
          .collect()
      )[0]
      await ctx.db.patch(link._id, {
        state: 'failed',
        xeroContactId: undefined,
        problem: { code: 'email_invalid', at: Date.now() },
      })
    })
    await queues(s, () => bookAt(s, aliceSite), [s.book.alice])
  })

  test('a job moved onto a lead’s site: the lead queued', async () => {
    const s = await started()
    const [aliceSite] = await sitesOf(s, s.book.alice)
    const [lenaSite] = await sitesOf(s, s.book.lena)
    const jobId = await bookAt(s, aliceSite)
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.jobs.update, {
          businessId: s.businessId,
          jobId,
          propertyId: lenaSite,
        }),
      [s.book.lena],
    )
  })

  test('a Recurring Job for a lead: queued; a job made recurring for a client turned back into a lead: queued', async () => {
    const s = await started()
    const [lenaSite] = await sitesOf(s, s.book.lena)
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.recurrences.create, {
          businessId: s.businessId,
          propertyId: lenaSite,
          assignedMembershipId: s.ownerMembershipId,
          intervalCount: 1,
          intervalUnit: 'month',
          jobType: 'Rodents',
          price: 18000,
          anchorDate: Date.now() + DAY,
          durationMinutes: 45,
        }),
      [s.book.lena],
    )

    const [aliceSite] = await sitesOf(s, s.book.alice)
    const jobId = await bookAt(s, aliceSite)
    await s.terence.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: s.book.alice,
      status: 'lead',
    })
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.recurrences.convertJobToRecurring, {
          businessId: s.businessId,
          jobId,
          intervalCount: 1,
          intervalUnit: 'month',
        }),
      [s.book.alice],
    )
  })

  test('the nightly engine booking a lead’s series queues nothing, and leaves it a lead', async () => {
    const s = await started()
    const [lenaSite] = await sitesOf(s, s.book.lena)
    await s.t.run((ctx) =>
      ctx.db.insert('recurrences', {
        businessId: s.businessId,
        propertyId: lenaSite,
        assignedMembershipId: s.ownerMembershipId,
        intervalCount: 1,
        intervalUnit: 'month',
        jobType: 'General Pest',
        price: 18000,
        anchorDate: Date.now() + DAY,
        active: true,
      }),
    )
    let booked = 0
    await queues(s, async () => {
      booked = (await s.t.mutation(internal.recurrences.materialiseAll, {}))
        .created
    }, [])
    // It did book visits for her — and they are nobody's booking.
    expect(booked).toBeGreaterThan(0)
    expect((await s.t.run((ctx) => ctx.db.get(s.book.lena)))?.status).toBe(
      'lead',
    )
  })
})

// ══════════════════════════════════════════════════════════ the match page

describe('the match page, once syncing', () => {
  test('a decision on a client to check: queued', async () => {
    const s = await started()
    const carl = await insertClient(s, { name: 'Carl Check' }, 60)
    await s.t.run((ctx) =>
      ctx.db.insert('xeroContactLinks', {
        businessId: s.businessId,
        tenantId: ORG.coastal,
        clientId: carl,
        state: 'needs_review',
        candidate: {
          contactId: 'contact-carl',
          name: 'Carl Check',
          reason: 'name_only',
        },
      }),
    )
    await queues(
      s,
      () =>
        s.terence.as.mutation(api.xeroMatch.decide, {
          businessId: s.businessId,
          connectionId: s.connection._id,
          clientId: carl,
          choice: 'different',
        }),
      [carl],
    )
  })
})

// ═══════════════════════════════════════════════════════ which connections

describe('which organisations get a change', () => {
  test('only one that pressed Start syncing and is connected, or waiting to reconnect — not one disconnected', async () => {
    const s = await started()
    const edit = (email: string) =>
      s.terence.as.mutation(api.clients.update, {
        businessId: s.businessId,
        clientId: s.book.alice,
        email,
      })
    const byConnection = async () =>
      (await rows(s)).map((row) => row.connectionId).sort()

    // Kevin's is connected and matched, not started: nothing for it.
    await clear(s)
    await edit('a1@alice.test')
    expect(await byConnection()).toEqual([s.connection._id])

    await s.kevin.as.mutation(api.xeroSync.startSyncing, {
      businessId: s.businessId,
      connectionId: s.kevins._id,
    })
    await clear(s)
    await edit('a2@alice.test')
    expect(await byConnection()).toEqual(
      [s.connection._id, s.kevins._id].sort(),
    )

    // Waiting for Kevin to sign in to Xero again: still queued for him.
    await s.t.run((ctx) =>
      ctx.db.patch(s.kevins._id, { status: 'needs_reconnect' }),
    )
    await clear(s)
    await edit('a3@alice.test')
    expect(await byConnection()).toEqual(
      [s.connection._id, s.kevins._id].sort(),
    )

    // Disconnected: never.
    await s.t.run((ctx) =>
      ctx.db.patch(s.kevins._id, { status: 'disconnected' }),
    )
    await clear(s)
    await edit('a4@alice.test')
    expect(await byConnection()).toEqual([s.connection._id])
  })

  test('a member removed: what waited for their Xero goes, and nothing more comes', async () => {
    const s = await started()
    await s.kevin.as.mutation(api.xeroSync.startSyncing, {
      businessId: s.businessId,
      connectionId: s.kevins._id,
    })
    await s.terence.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: s.book.alice,
      email: 'alice@before.test',
    })
    expect(
      (await rows(s)).filter((row) => row.connectionId === s.kevins._id),
    ).toHaveLength(1)

    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinId,
    })
    await settle(s)
    expect(
      (await rows(s)).filter((row) => row.connectionId === s.kevins._id),
    ).toEqual([])

    await s.terence.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: s.book.alice,
      email: 'alice@after.test',
    })
    expect(
      (await rows(s)).filter((row) => row.connectionId === s.kevins._id),
    ).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════ the queue

describe('the queue', () => {
  test('a burst of changes is one row: its rev counts them, and once it is a minute old its time stops moving', async () => {
    const s = await started()
    const edit = (email: string) =>
      s.terence.as.mutation(api.clients.update, {
        businessId: s.businessId,
        clientId: s.book.alice,
        email,
      })
    await clear(s)
    const firstAt = Date.now()
    await edit('a1@alice.test')
    vi.setSystemTime(Date.now() + 2 * SECOND)
    await edit('a2@alice.test')
    vi.setSystemTime(Date.now() + 2 * SECOND)
    await edit('a3@alice.test')
    const [row] = await rows(s)
    expect(row).toMatchObject({
      clientId: s.book.alice,
      rev: 3,
      firstQueuedAt: firstAt,
      dueAt: Date.now() + 5 * SECOND,
    })
    expect(await rows(s)).toHaveLength(1)

    vi.setSystemTime(firstAt + 61 * SECOND)
    await edit('a4@alice.test')
    expect(await rows(s)).toEqual([
      expect.objectContaining({ _id: row._id, rev: 4, dueAt: row.dueAt }),
    ])
  })

  test('with the kill switch on, a change asks for no drain', async () => {
    const s = await started()
    const drains = async () =>
      (
        await s.t.run((ctx) =>
          ctx.db.system.query('_scheduled_functions').collect(),
        )
      ).filter(
        (job) =>
          /xeroSync(\.js)?:drain$/.test(job.name) &&
          job.state.kind === 'pending',
      )
    await clear(s)
    const before = (await drains()).length
    await s.terence.as.mutation(api.properties.create, {
      businessId: s.businessId,
      clientName: 'Paula Paused',
      ...newSite,
    })
    expect(await rows(s)).toHaveLength(1)
    expect(await drains()).toHaveLength(before)
  })
})
