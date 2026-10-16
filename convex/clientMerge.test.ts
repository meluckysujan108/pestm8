/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import { connectAndFinish, contactsIn, fakeXero } from '../test/fakeXero'
import { MAX_TAGS } from './lib/clientRecord'
import type { FakeXero } from '../test/fakeXero'
import type { Doc, Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * Merging one client into another (convex/clientMerge.ts, the build spec of
 * 2026-10-16): the third answer to "these two are the same customer", after
 * sharing a Xero contact and giving it away (xeroSameCustomer.test.ts) — and
 * one the Clients page needs whether or not Xero is connected.
 *
 * B is merged into A. What matters most:
 * - nothing of B's is lost: its live sites (and with them every job,
 *   Recurring Job and report at them), its contacts and its notes become
 *   A's, untouched otherwise — and a wipe of B, thirty days on, takes none
 *   of them;
 * - A stays A: its name, kind, number and status, and every detail it has.
 *   B only fills A's blanks;
 * - B goes to the Recycle bin, saying what it was merged into, and can't be
 *   restored from there: its sites and jobs are A's now;
 * - in Xero, A keeps its contact and gets the filled-in blanks. Where A has
 *   none and B has one, A takes B's over — never a second contact for one
 *   customer — and whoever shared it follows to A. Where both have one, B's
 *   links go (anyone sharing B's contact is put To check), but B's own
 *   contact is never archived or deleted there;
 * - only the people who manage the client book may, and not while switched
 *   into someone else's account.
 */

const XU = { terence: 'xu-terence', kevin: 'xu-kevin', jo: 'xu-jo' } as const
const ORG = {
  coastal: 'tenant-coastal',
  kevin: 'tenant-kevin',
  jo: 'tenant-jo',
} as const

const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Terence owns Coastal Pest; Kevin is a subcontractor, Jo a contractor.
 * With `xero`, Xero is faked and its organisations made. */
async function setup(opts: { xero?: boolean } = {}) {
  const t = testApp()
  let xero: FakeXero | null = null
  if (opts.xero) {
    xero = fakeXero()
    xero.tenant({ tenantId: ORG.coastal, name: 'Coastal Pest Pty Ltd' })
    xero.tenant({ tenantId: ORG.kevin, name: 'Kevin Walsh Pest Services' })
    xero.tenant({ tenantId: ORG.jo, name: 'Bloggs Bookkeeping' })
  }
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
  const jo = await createActor(t, {
    email: 'jo@coastal.test',
    name: 'Jo Bloggs',
  })
  const joId = await joinBusiness(t, terence, jo, businessId, 'contractor')
  return {
    t,
    xero,
    businessId,
    terence,
    ownerMembershipId,
    kevin,
    kevinId,
    jo,
    joId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

function xeroOf(s: Setup): FakeXero {
  if (!s.xero) throw new Error('this test has no Xero')
  return s.xero
}

const settle = (s: Setup) =>
  s.t.finishAllScheduledFunctions(vi.runAllTimers, 1000)

/** Xero's sends log as they go; a test reading what they did needs none of
 * it. */
const quietly = () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
}

// ─────────────────────────────────────────────────────────────── the book

type Site = { addressLine: string; suburb: string }

type ClientSeed = {
  name: string
  kind?: 'person' | 'business'
  clientNumber?: number
  email?: string
  phone?: string
  abn?: string
  /** The client's own (mailing, head-office) address — any of its fields. */
  address?: Partial<{
    addressLine: string
    suburb: string
    state: string
    postcode: string
  }>
  tags?: Array<string>
  status?: 'active' | 'lead' | 'inactive'
  binned?: boolean
  archived?: boolean
  sites?: Array<Site>
  /** Oldest first; `primary` is its contact person. */
  contacts?: Array<{ name: string; email?: string; primary?: boolean }>
}

/** A client as the app keeps one, inserted directly. */
async function addClient(
  s: Setup,
  seed: ClientSeed,
  businessId: Id<'businesses'> = s.businessId,
): Promise<Id<'clients'>> {
  return s.t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: seed.kind ?? 'person',
      name: seed.name,
      ...(seed.clientNumber !== undefined
        ? { clientNumber: seed.clientNumber }
        : {}),
      ...(seed.email ? { email: seed.email } : {}),
      ...(seed.phone ? { phone: seed.phone } : {}),
      ...(seed.abn ? { abn: seed.abn } : {}),
      ...(seed.address ?? {}),
      ...(seed.tags ? { tags: seed.tags } : {}),
      ...(seed.status ? { status: seed.status } : {}),
      ...(seed.binned ? { deletedAt: now } : {}),
      ...(seed.archived ? { archivedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    })
    for (const [i, site] of (
      seed.sites ?? [{ addressLine: '1 Test Street', suburb: 'Perth' }]
    ).entries()) {
      await ctx.db.insert('properties', {
        businessId,
        clientId,
        addressLine: site.addressLine,
        suburb: site.suburb,
        state: 'WA',
        postcode: '6000',
        createdAt: now + i,
      })
    }
    for (const [i, contact] of (seed.contacts ?? []).entries()) {
      await ctx.db.insert('clientContacts', {
        businessId,
        clientId,
        name: contact.name,
        ...(contact.email ? { email: contact.email } : {}),
        ...(contact.primary ? { isPrimary: true } : {}),
        createdAt: now + i,
      })
    }
    return clientId
  })
}

const sitesOf = (s: Setup, clientId: Id<'clients'>) =>
  s.t.run((ctx) =>
    ctx.db
      .query('properties')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect(),
  )

const contactsOf = (s: Setup, clientId: Id<'clients'>) =>
  s.t.run((ctx) =>
    ctx.db
      .query('clientContacts')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect(),
  )

const notesOf = (s: Setup, clientId: Id<'clients'>) =>
  s.t.run((ctx) =>
    ctx.db
      .query('notes')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect(),
  )

const clientRow = (s: Setup, clientId: Id<'clients'>) =>
  s.t.run(async (ctx) => {
    const row = await ctx.db.get(clientId)
    if (!row) throw new Error('client gone')
    return row
  })

/** A note about a client — or, with a site, about that site (which carries
 * its client too, as notes.ts writes one). */
const addNote = (
  s: Setup,
  clientId: Id<'clients'>,
  propertyId?: Id<'properties'>,
) =>
  s.t.run(async (ctx) => {
    const now = Date.now()
    return ctx.db.insert('notes', {
      businessId: s.businessId,
      authorMembershipId: s.ownerMembershipId,
      lastEditedByMembershipId: s.ownerMembershipId,
      clientId,
      ...(propertyId ? { propertyId } : {}),
      title: 'Gate code',
      preview: '',
      plainText: 'Gate code\n',
      createdAt: now,
      updatedAt: now,
    })
  })

/** Work at a site: two booked jobs, a Recurring Job and a finalised report.
 * Inserted directly, so nothing else (a series' visits) is made with it. */
const addWork = (s: Setup, propertyId: Id<'properties'>) =>
  s.t.run(async (ctx) => {
    const now = Date.now()
    const job = (scheduledAt: number) =>
      ctx.db.insert('jobs', {
        businessId: s.businessId,
        propertyId,
        assignedMembershipId: s.ownerMembershipId,
        jobType: 'General Pest',
        price: 18000,
        scheduledAt,
        durationMinutes: 60,
        status: 'booked',
        createdAt: now,
      })
    const jobIds = [await job(now + DAY), await job(now + 2 * DAY)]
    const seriesId = await ctx.db.insert('recurrences', {
      businessId: s.businessId,
      propertyId,
      assignedMembershipId: s.ownerMembershipId,
      intervalCount: 3,
      intervalUnit: 'month',
      jobType: 'Rodents',
      price: 12000,
      anchorDate: now + 7 * DAY,
      active: true,
    })
    const reportId = await ctx.db.insert('reports', {
      businessId: s.businessId,
      propertyId,
      jobId: jobIds[0],
      authorMembershipId: s.ownerMembershipId,
      template: 'serviceReport',
      templateVersion: 1,
      legalBasis: 'APVMA',
      data: {},
      photoIds: [],
      status: 'finalised',
      finalisedAt: now,
      createdAt: now,
    })
    return { jobIds, seriesId, reportId }
  })

/** Every row a merge might write, to show a refused one wrote none. */
const everything = (s: Setup) =>
  s.t.run(async (ctx) => ({
    clients: await ctx.db.query('clients').collect(),
    properties: await ctx.db.query('properties').collect(),
    contacts: await ctx.db.query('clientContacts').collect(),
    notes: await ctx.db.query('notes').collect(),
    jobs: await ctx.db.query('jobs').collect(),
    bin: await ctx.db.query('binEntries').collect(),
    links: await ctx.db.query('xeroContactLinks').collect(),
  }))

const audits = (s: Setup, action: string) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query('auditLog').collect()).filter(
      (row) => row.action === action,
    ),
  )

/** A valid ABN (the ATO's own). */
const ABN = '51824753556'

/**
 * ACME, twice: the record Terence keeps (A, #42) and an older one (B, #77)
 * with everything A is missing, and work of its own — a live site with jobs,
 * a series and a report, a site already in the Recycle bin, two contacts
 * (one starred) and two notes.
 */
async function acmeTwice(s: Setup) {
  const a = await addClient(s, {
    name: 'Acme Holdings Pty Ltd',
    kind: 'business',
    clientNumber: 42,
    phone: '08 9111 2222',
    tags: ['VIP', 'Termite'],
    status: 'lead',
    sites: [{ addressLine: '1 Factory Road', suburb: 'Osborne Park' }],
    contacts: [{ name: 'Ann Acme', primary: true }],
  })
  const b = await addClient(s, {
    name: 'ACME Holdings',
    kind: 'business',
    clientNumber: 77,
    email: 'accounts@acme.test',
    phone: '08 9999 0000',
    abn: ABN,
    address: {
      addressLine: '10 Pier Street',
      suburb: 'Fremantle',
      state: 'WA',
      postcode: '6160',
    },
    tags: ['vip', 'Rodents'],
    sites: [
      { addressLine: '9 Wharf Street', suburb: 'Fremantle' },
      { addressLine: '5 Quay Road', suburb: 'Fremantle' },
    ],
    contacts: [
      { name: 'Bob Books', email: 'bob@acme.test', primary: true },
      { name: 'Cat Clerk' },
    ],
  })
  const [wharf, quay] = await sitesOf(s, b)
  // The quay went in the Recycle bin on its own, last week.
  const quayEntry = await s.terence.as.mutation(api.bin.deleteProperty, {
    businessId: s.businessId,
    propertyId: quay._id,
  })
  const work = await addWork(s, wharf._id)
  const notes = {
    client: await addNote(s, b),
    site: await addNote(s, b, wharf._id),
  }
  return { a, b, wharf: wharf._id, quay: quay._id, quayEntry, work, notes }
}

// ─────────────────────────────────────────────────────────── the API

const merge = (
  s: Setup,
  who: TestActor,
  fromClientId: Id<'clients'>,
  intoClientId: Id<'clients'>,
  businessId: Id<'businesses'> = s.businessId,
) =>
  who.as.mutation(api.clientMerge.merge, {
    businessId,
    fromClientId,
    intoClientId,
  })

const preview = (
  s: Setup,
  who: TestActor,
  fromClientId: Id<'clients'>,
  intoClientId: Id<'clients'>,
) =>
  who.as.query(api.clientMerge.mergePreview, {
    businessId: s.businessId,
    fromClientId,
    intoClientId,
  })

// ═══════════════════════════════════════════════════════════ what moves

describe('merging one client into another', () => {
  test('moves its live sites — and the jobs, series and reports at them, untouched — its contacts and its notes', async () => {
    const s = await setup()
    const acme = await acmeTwice(s)
    const [factory] = await sitesOf(s, acme.a)
    const work = await s.t.run(async (ctx) => ({
      jobs: await Promise.all(acme.work.jobIds.map((id) => ctx.db.get(id))),
      series: await ctx.db.get(acme.work.seriesId),
      report: await ctx.db.get(acme.work.reportId),
    }))

    await merge(s, s.terence, acme.b, acme.a)

    // The live site is A's now, and live; the one in the bin stays with B,
    // and goes with it.
    const sites = await sitesOf(s, acme.a)
    expect(sites.map((p) => p._id).sort()).toEqual(
      [factory._id, acme.wharf].sort(),
    )
    for (const site of sites) {
      expect(site.deletedAt).toBeUndefined()
      expect(site.binEntryId).toBeUndefined()
    }
    expect((await sitesOf(s, acme.b)).map((p) => p._id)).toEqual([acme.quay])

    // The work at it follows the site, and nothing about it changes — not
    // a date, not the series: the schedule is as it was.
    expect(
      await s.t.run(async (ctx) => ({
        jobs: await Promise.all(acme.work.jobIds.map((id) => ctx.db.get(id))),
        series: await ctx.db.get(acme.work.seriesId),
        report: await ctx.db.get(acme.work.reportId),
      })),
    ).toEqual(work)

    // Its contacts are A's; A's contact person stays A's contact person.
    const people = await contactsOf(s, acme.a)
    expect(people.map((c) => c.name).sort()).toEqual([
      'Ann Acme',
      'Bob Books',
      'Cat Clerk',
    ])
    expect(people.filter((c) => c.isPrimary).map((c) => c.name)).toEqual([
      'Ann Acme',
    ])
    expect(people.find((c) => c.name === 'Bob Books')?.email).toBe(
      'bob@acme.test',
    )
    expect(await contactsOf(s, acme.b)).toEqual([])

    // Its notes, about it and about its site, are about A.
    expect((await notesOf(s, acme.a)).map((n) => n._id).sort()).toEqual(
      [acme.notes.client, acme.notes.site].sort(),
    )
    expect(
      (await s.t.run((ctx) => ctx.db.get(acme.notes.site)))?.propertyId,
    ).toBe(acme.wharf)
    expect(await notesOf(s, acme.b)).toEqual([])
  }, 30_000)

  test('A stays A, with B filling its blanks: email, ABN, its address whole, tags joined — and a lead made active by an active B', async () => {
    const s = await setup()
    const acme = await acmeTwice(s)

    await merge(s, s.terence, acme.b, acme.a)

    const a = await clientRow(s, acme.a)
    expect(a).toMatchObject({
      // A's own, kept.
      name: 'Acme Holdings Pty Ltd',
      kind: 'business',
      clientNumber: 42,
      phone: '08 9111 2222',
      // A's blanks, filled from B.
      email: 'accounts@acme.test',
      abn: ABN,
      addressLine: '10 Pier Street',
      suburb: 'Fremantle',
      state: 'WA',
      postcode: '6160',
      // One of each tag, whatever its capitals: A's spelling first.
      tags: ['VIP', 'Termite', 'Rodents'],
    })
    // A lead; B was active work.
    expect(a.status ?? 'active').toBe('active')
    expect(a.deletedAt).toBeUndefined()
    expect(a.mergedIntoClientId).toBeUndefined()
  }, 30_000)

  test('nothing A has is replaced: its phone, email and address stay, a person gets no ABN, and an inactive client stays inactive', async () => {
    const s = await setup()
    const a = await addClient(s, {
      name: 'Sarah Brown',
      clientNumber: 8,
      email: 'sarah@brown.test',
      phone: '0412 345 678',
      // Part of an address is still hers: none of B's goes with it.
      address: { addressLine: 'PO Box 12' },
      status: 'inactive',
    })
    const b = await addClient(s, {
      name: 'S Brown',
      clientNumber: 9,
      email: 'sbrown@old.test',
      phone: '08 9444 5555',
      abn: ABN,
      address: {
        addressLine: '4 Gum Road',
        suburb: 'Morley',
        state: 'WA',
        postcode: '6062',
      },
    })

    await merge(s, s.terence, b, a)

    const after = await clientRow(s, a)
    expect(after).toMatchObject({
      name: 'Sarah Brown',
      clientNumber: 8,
      email: 'sarah@brown.test',
      phone: '0412 345 678',
      addressLine: 'PO Box 12',
      status: 'inactive',
    })
    for (const field of ['abn', 'suburb', 'state', 'postcode'] as const) {
      expect(after[field]).toBeUndefined()
    }
  }, 30_000)

  test('B’s contact person stays one when A has none; tags past the limit are left off rather than refused', async () => {
    const s = await setup()
    const many = Array.from({ length: MAX_TAGS - 2 }, (_, i) => `Tag ${i}`)
    const a = await addClient(s, {
      name: 'Harbourside Strata',
      kind: 'business',
      clientNumber: 10,
      tags: many,
    })
    const b = await addClient(s, {
      name: 'Harbourside Strata Plan 123',
      kind: 'business',
      clientNumber: 11,
      tags: ['Strata', 'Real estate', 'Quarterly', 'Termite', 'tag 0'],
      contacts: [{ name: 'Jan Brown', primary: true }, { name: 'Sam Lee' }],
    })

    await merge(s, s.terence, b, a)

    const people = await contactsOf(s, a)
    expect(people.filter((c) => c.isPrimary).map((c) => c.name)).toEqual([
      'Jan Brown',
    ])
    const tags = (await clientRow(s, a)).tags ?? []
    expect(tags).toHaveLength(MAX_TAGS)
    // A's come first, every one of them; B's new ones fill what is left.
    expect(tags.slice(0, many.length)).toEqual(many)
    expect(tags.slice(many.length)).toEqual(['Strata', 'Real estate'])
  }, 30_000)
})

describe('a client that came in with an import', () => {
  test('merged away: undoing that import takes back nothing that moved to A', async () => {
    const s = await setup()
    const a = await addClient(s, { name: 'Ivy Archer', clientNumber: 1 })
    const importId = await s.terence.as.mutation(api.clientImports.start, {
      businessId: s.businessId,
      fileName: 'clients.csv',
    })
    const [result] = await s.terence.as.mutation(api.clientImports.addBatch, {
      businessId: s.businessId,
      importId,
      clients: [
        {
          key: 'ivy',
          kind: 'person',
          name: 'Ivy Imported',
          sites: [
            {
              addressLine: '3 Wattle Street',
              suburb: 'Bayswater',
              state: 'WA',
              postcode: '6053',
            },
          ],
        },
      ],
    })
    const b = result.clientId!
    const [wattle] = await sitesOf(s, b)

    await merge(s, s.terence, b, a)
    await s.terence.as.mutation(api.clientImports.undo, {
      businessId: s.businessId,
      importId,
    })
    await settle(s)

    // The import brought it, but it is A's now: an undo is for taking back
    // a list that came in wrong, not for taking a site from the client it
    // was merged into.
    expect((await sitesOf(s, a)).map((p) => p._id)).toContain(wattle._id)
    expect((await clientRow(s, a)).deletedAt).toBeUndefined()
  }, 30_000)
})

describe('a client that came in with an import, merged into', () => {
  test('undoing the import that brought it keeps it, with what it took from B — though its own untouched imported site still goes', async () => {
    const s = await setup()
    const importId = await s.terence.as.mutation(api.clientImports.start, {
      businessId: s.businessId,
      fileName: 'clients.csv',
    })
    const [result] = await s.terence.as.mutation(api.clientImports.addBatch, {
      businessId: s.businessId,
      importId,
      clients: [
        {
          key: 'ivy',
          kind: 'person',
          name: 'Ivy Imported',
          sites: [
            {
              addressLine: '3 Wattle Street',
              suburb: 'Bayswater',
              state: 'WA',
              postcode: '6053',
            },
          ],
        },
      ],
    })
    const a = result.clientId!
    const [wattle] = await sitesOf(s, a)
    // B, from a contacts list: a name, an email and a phone, no address.
    const b = await addClient(s, {
      name: 'Ivy Archer',
      email: 'ivy@archer.test',
      phone: '0411 000 111',
      sites: [],
    })

    await merge(s, s.terence, b, a)
    await s.terence.as.mutation(api.clientImports.undo, {
      businessId: s.businessId,
      importId,
    })
    await settle(s)

    // A merge into A is work on A: it stays, with B's email and phone,
    // while B can't be brought back from the bin to hold them.
    const kept = await clientRow(s, a)
    expect(kept).toMatchObject({
      email: 'ivy@archer.test',
      phone: '0411 000 111',
    })
    expect(kept.deletedAt).toBeUndefined()
    expect(kept.importId).toBeUndefined()
    // The site the import brought, untouched since, is the import's to
    // take back.
    expect((await sitesOf(s, a)).map((p) => p._id)).not.toContain(wattle._id)
  }, 30_000)
})

// ═════════════════════════════════════════════════════════ B, in the bin

describe('the client merged', () => {
  test('goes to the Recycle bin saying what it was merged into, is audited, and can’t be restored from there', async () => {
    const s = await setup()
    const acme = await acmeTwice(s)

    await merge(s, s.terence, acme.b, acme.a)

    const b = await clientRow(s, acme.b)
    expect(b).toMatchObject({
      name: 'ACME Holdings',
      clientNumber: 77,
      mergedIntoClientId: acme.a,
      deletedAt: Date.now(),
    })
    expect(b.binEntryId).toBeDefined()

    // On the bin page, as merged into A.
    const { entries } = await s.terence.as.query(api.bin.list, {
      businessId: s.businessId,
    })
    const mergedInto = { clientId: acme.a, name: 'Acme Holdings Pty Ltd' }
    expect(entries.find((row) => row._id === b.binEntryId)).toMatchObject({
      kind: 'client',
      title: 'ACME Holdings',
      mergedInto,
    })
    // The site binned on its own last week keeps its own entry — whose
    // client is A's now too.
    expect(entries.find((row) => row._id === acme.quayEntry)).toMatchObject({
      kind: 'property',
      mergedInto,
    })

    // Audited against A, by ids and numbers: the audit log outlives B's
    // wipe, so it carries no name (as every bin row).
    const [audit] = await audits(s, 'clients.merge')
    expect(audit).toMatchObject({
      businessId: s.businessId,
      actorMembershipId: s.ownerMembershipId,
      entityType: 'clients',
      entityId: acme.a,
      meta: {
        fromClientId: acme.b,
        fromClientNumber: 77,
        moved: {
          properties: 1,
          jobs: 2,
          recurrences: 1,
          notes: 2,
          contacts: 2,
          reports: 1,
        },
        // Which of A's records were B's, by id — the merge can't be undone,
        // and once B is wiped nothing else would say.
        movedSiteIds: [acme.wharf],
        movedContactIds: (await contactsOf(s, acme.a))
          .filter((c) => c.name !== 'Ann Acme')
          .map((c) => c._id),
        movedNoteIds: [acme.notes.client, acme.notes.site],
        // Not set up for Xero: nothing happened there.
        xero: { handedOver: [], dropped: [], released: [] },
      },
    })
    // Which of A's details came from B: every blank it had.
    expect(
      [...(audit.meta as { filled: Array<string> }).filled].sort(),
    ).toEqual([
      'abn',
      'addressLine',
      'email',
      'postcode',
      'state',
      'status',
      'suburb',
      'tags',
    ])
    expect(JSON.stringify(audit)).not.toMatch(/ACME|Acme/)
    expect(await audits(s, 'clients.merge')).toHaveLength(1)
    // The merge is the record of it: no delete anyone made.
    expect(
      (await audits(s, 'bin.delete')).filter((row) => row.entityId === acme.b),
    ).toEqual([])

    // Its sites and jobs are A's now: a restore would bring back a client
    // with nothing, beside the one that has it all — and the site it left
    // in the bin can't come back to it either.
    const before = await everything(s)
    for (const entryId of [b.binEntryId!, acme.quayEntry]) {
      await expect(
        s.terence.as.mutation(api.bin.restore, {
          businessId: s.businessId,
          entryId,
        }),
      ).rejects.toThrow(/MERGED/)
    }
    expect(await everything(s)).toEqual(before)
  }, 30_000)

  test('a job or Recurring Job deleted on its own at a site that stayed with it says so, and can’t be restored (MERGED) — never “restore the property first”', async () => {
    const s = await setup()
    const acme = await acmeTwice(s)
    // A third site of B's, with a job and a Recurring Job — each deleted on
    // its own, then the site.
    const { pier, jobId, visitId } = await s.t.run(async (ctx) => {
      const now = Date.now()
      const siteId = await ctx.db.insert('properties', {
        businessId: s.businessId,
        clientId: acme.b,
        addressLine: '7 Pier Street',
        suburb: 'Fremantle',
        state: 'WA',
        postcode: '6160',
        createdAt: now + 10,
      })
      const seriesId = await ctx.db.insert('recurrences', {
        businessId: s.businessId,
        propertyId: siteId,
        assignedMembershipId: s.ownerMembershipId,
        intervalCount: 1,
        intervalUnit: 'month',
        jobType: 'Rodents',
        price: 12000,
        anchorDate: now + DAY,
        active: true,
      })
      const job = (extra: { recurrenceId?: typeof seriesId }) =>
        ctx.db.insert('jobs', {
          businessId: s.businessId,
          propertyId: siteId,
          assignedMembershipId: s.ownerMembershipId,
          jobType: 'General Pest',
          price: 18000,
          scheduledAt: now + DAY,
          durationMinutes: 60,
          status: 'booked',
          createdAt: now,
          ...extra,
        })
      return {
        pier: siteId,
        jobId: await job({}),
        visitId: await job({ recurrenceId: seriesId }),
      }
    })
    const jobEntry = await s.terence.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId,
    })
    const seriesEntry = await s.terence.as.mutation(api.bin.deleteSeries, {
      businessId: s.businessId,
      jobId: visitId,
    })
    await s.terence.as.mutation(api.bin.deleteProperty, {
      businessId: s.businessId,
      propertyId: pier,
    })

    await merge(s, s.terence, acme.b, acme.a)

    const { entries } = await s.terence.as.query(api.bin.list, {
      businessId: s.businessId,
    })
    const mergedInto = { clientId: acme.a, name: 'Acme Holdings Pty Ltd' }
    const before = await everything(s)
    for (const [entryId, kind] of [
      [jobEntry, 'job'],
      [seriesEntry, 'recurrence'],
    ] as const) {
      expect(entries.find((row) => row._id === entryId)).toMatchObject({
        kind,
        mergedInto,
      })
      await expect(
        s.terence.as.mutation(api.bin.restore, {
          businessId: s.businessId,
          entryId,
        }),
      ).rejects.toThrow(/MERGED/)
    }
    expect(await everything(s)).toEqual(before)
  }, 30_000)

  test('is wiped thirty days on like anything else in the bin — taking nothing that moved to A', async () => {
    const s = await setup()
    const acme = await acmeTwice(s)
    await merge(s, s.terence, acme.b, acme.a)
    const moved = {
      sites: (await sitesOf(s, acme.a)).map((p) => p._id).sort(),
      contacts: (await contactsOf(s, acme.a)).map((c) => c._id).sort(),
      notes: (await notesOf(s, acme.a)).map((n) => n._id).sort(),
    }
    expect(moved.sites).toContain(acme.wharf)

    vi.setSystemTime(Date.now() + 31 * DAY)
    await s.t.mutation(internal.bin.purgeExpired, {})
    await settle(s)

    expect(await s.t.run((ctx) => ctx.db.get(acme.b))).toBeNull()
    expect({
      sites: (await sitesOf(s, acme.a)).map((p) => p._id).sort(),
      contacts: (await contactsOf(s, acme.a)).map((c) => c._id).sort(),
      notes: (await notesOf(s, acme.a)).map((n) => n._id).sort(),
    }).toEqual(moved)
    expect(
      await s.t.run(async (ctx) => ({
        jobs: await Promise.all(acme.work.jobIds.map((id) => ctx.db.get(id))),
        series: await ctx.db.get(acme.work.seriesId),
        report: await ctx.db.get(acme.work.reportId),
      })),
    ).toMatchObject({
      jobs: [
        expect.objectContaining({ propertyId: acme.wharf }),
        expect.objectContaining({ propertyId: acme.wharf }),
      ],
      series: expect.objectContaining({ propertyId: acme.wharf }),
      report: expect.objectContaining({ propertyId: acme.wharf }),
    })
    expect((await clientRow(s, acme.a)).deletedAt).toBeUndefined()
  }, 30_000)
})

// ════════════════════════════════════════════════════════ the confirmation

describe('what the confirmation says', () => {
  test('both clients, and how much moves: live sites, the jobs and series at them, notes, contacts and reports', async () => {
    const s = await setup()
    const acme = await acmeTwice(s)

    expect(await preview(s, s.terence, acme.b, acme.a)).toEqual({
      from: { name: 'ACME Holdings', clientNumber: 77 },
      into: { name: 'Acme Holdings Pty Ltd', clientNumber: 42 },
      moves: {
        // The quay, in the bin, stays with B.
        properties: 1,
        jobs: 2,
        recurrences: 1,
        notes: 2,
        contacts: 2,
        reports: 1,
      },
      // Not set up for Xero: nothing to say about it.
      xero: [],
    })
    // Asking writes nothing.
    expect(await audits(s, 'clients.merge')).toEqual([])
    expect((await clientRow(s, acme.b)).deletedAt).toBeUndefined()
  }, 30_000)

  test('a client with no number is named with null', async () => {
    const s = await setup()
    const a = await addClient(s, { name: 'Ann Archer' })
    const b = await addClient(s, { name: 'Annie Archer', sites: [] })
    expect(await preview(s, s.terence, b, a)).toMatchObject({
      from: { name: 'Annie Archer', clientNumber: null },
      into: { name: 'Ann Archer', clientNumber: null },
      moves: {
        properties: 0,
        jobs: 0,
        recurrences: 0,
        notes: 0,
        contacts: 0,
        reports: 0,
      },
    })
  }, 30_000)
})

// ════════════════════════════════════════════════════════════ refusals

describe('what is refused, changing nothing', () => {
  test('a client into itself (SAME_CLIENT); one in the bin, archived, or another business’s (NOT_FOUND); more than a merge should carry (MERGE_TOO_BIG)', async () => {
    const s = await setup()
    const a = await addClient(s, { name: 'Ann Archer', clientNumber: 1 })
    const b = await addClient(s, { name: 'Annie Archer', clientNumber: 2 })
    const binned = await addClient(s, {
      name: 'Barry Binned',
      clientNumber: 3,
      binned: true,
    })
    const archived = await addClient(s, {
      name: 'Alma Archived',
      clientNumber: 4,
      archived: true,
    })
    const mia = await createActor(s.t, {
      email: 'mia@harbour.test',
      name: 'Mia',
    })
    const harbour = await createBusiness(s.t, mia, 'Harbour Pest')
    const theirs = await addClient(
      s,
      { name: 'Ann Archer', clientNumber: 1 },
      harbour.businessId,
    )
    const before = await everything(s)
    const refused = async (press: Promise<unknown>, code: RegExp) => {
      await expect(press).rejects.toThrow(code)
      expect(await everything(s)).toEqual(before)
    }

    await refused(merge(s, s.terence, a, a), /SAME_CLIENT/)
    for (const other of [binned, archived, theirs]) {
      await refused(merge(s, s.terence, other, a), /NOT_FOUND/)
      await refused(merge(s, s.terence, b, other), /NOT_FOUND/)
    }
    // Mia, naming Coastal Pest's clients from her own business.
    await refused(merge(s, mia, b, a, harbour.businessId), /NOT_FOUND/)
    expect(await audits(s, 'clients.merge')).toEqual([])
  }, 30_000)

  test('more than five hundred notes, or sites and contacts, is MERGE_TOO_BIG', async () => {
    const s = await setup()
    const a = await addClient(s, { name: 'Ann Archer', clientNumber: 1 })
    const noisy = await addClient(s, { name: 'Annie Archer', clientNumber: 2 })
    const crowded = await addClient(s, {
      name: 'Anne Archer',
      clientNumber: 3,
      sites: [],
    })
    await s.t.run(async (ctx) => {
      const now = Date.now()
      for (let i = 0; i < 501; i++) {
        await ctx.db.insert('notes', {
          businessId: s.businessId,
          authorMembershipId: s.ownerMembershipId,
          lastEditedByMembershipId: s.ownerMembershipId,
          clientId: noisy,
          title: `Note ${i}`,
          preview: '',
          plainText: '',
          createdAt: now,
          updatedAt: now,
        })
      }
      for (let i = 0; i < 501; i++) {
        await ctx.db.insert('clientContacts', {
          businessId: s.businessId,
          clientId: crowded,
          name: `Contact ${i}`,
          createdAt: now + i,
        })
      }
    })
    const before = await everything(s)

    for (const from of [noisy, crowded]) {
      await expect(merge(s, s.terence, from, a)).rejects.toThrow(
        /MERGE_TOO_BIG/,
      )
    }
    expect(await everything(s)).toEqual(before)
  }, 30_000)
})

describe('a business into a person', () => {
  test('is refused (KIND_MISMATCH), changing nothing, when the business has what a person never shows: contact people, an ABN, an office address or a site contact', async () => {
    const s = await setup()
    const a = await addClient(s, { name: 'Ann Archer', clientNumber: 1 })
    const holdings = (seed: Partial<ClientSeed>) =>
      addClient(s, {
        name: 'Archer Holdings Pty Ltd',
        kind: 'business',
        clientNumber: 2,
        ...seed,
      })
    const withPeople = await holdings({
      contacts: [{ name: 'Office Manager', primary: true }],
    })
    const withAbn = await holdings({ abn: ABN })
    const withOffice = await holdings({
      address: { addressLine: '10 Pier Street', suburb: 'Fremantle' },
    })
    const withSiteContact = await holdings({})
    await s.t.run(async (ctx) => {
      const [site] = await ctx.db
        .query('properties')
        .withIndex('by_client', (q) => q.eq('clientId', withSiteContact))
        .collect()
      await ctx.db.patch(site._id, {
        siteContactName: 'Warehouse manager',
        siteContactPhone: '0400 123 456',
      })
    })
    const before = await everything(s)

    for (const from of [withPeople, withAbn, withOffice, withSiteContact]) {
      await expect(preview(s, s.terence, from, a)).rejects.toThrow(
        /KIND_MISMATCH/,
      )
      await expect(merge(s, s.terence, from, a)).rejects.toThrow(
        /KIND_MISMATCH/,
      )
    }
    expect(await everything(s)).toEqual(before)
    expect(await audits(s, 'clients.merge')).toEqual([])
  }, 30_000)

  test('goes ahead when the business has none of it — and a person into a business always does', async () => {
    const s = await setup()
    const ann = await addClient(s, { name: 'Ann Archer', clientNumber: 1 })
    const bare = await addClient(s, {
      name: 'Archer Holdings Pty Ltd',
      kind: 'business',
      clientNumber: 2,
      email: 'office@archer.test',
    })
    await merge(s, s.terence, bare, ann)
    expect(await clientRow(s, ann)).toMatchObject({
      kind: 'person',
      email: 'office@archer.test',
    })

    const firm = await addClient(s, {
      name: 'Bayside Strata',
      kind: 'business',
      clientNumber: 3,
      contacts: [{ name: 'Body corporate', primary: true }],
    })
    const tenant = await addClient(s, { name: 'Bea Bayside', clientNumber: 4 })
    await merge(s, s.terence, tenant, firm)
    expect((await clientRow(s, tenant)).mergedIntoClientId).toBe(firm)
  }, 30_000)
})

// ══════════════════════════════════════════════════════════════════ who may

describe('who may merge', () => {
  test('the people who manage the client book: not a subcontractor, and not the owner while switched into someone else’s account', async () => {
    const s = await setup()
    const a = await addClient(s, { name: 'Ann Archer', clientNumber: 1 })
    const b = await addClient(s, { name: 'Annie Archer', clientNumber: 2 })
    const before = await everything(s)

    await expect(merge(s, s.kevin, b, a)).rejects.toThrow(/NO_ACCESS/)
    await expect(preview(s, s.kevin, b, a)).rejects.toThrow(/NO_ACCESS/)

    await s.terence.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: s.kevinId,
    })
    await expect(merge(s, s.terence, b, a)).rejects.toThrow(
      /NO_ACCESS|SWITCHED/,
    )
    await s.terence.as.mutation(api.accountSwitches.stop, {
      businessId: s.businessId,
    })
    expect(await everything(s)).toEqual(before)
    expect(await audits(s, 'clients.merge')).toEqual([])

    // Jo, a contractor, manages the book with Terence.
    await merge(s, s.jo, b, a)
    expect((await clientRow(s, b)).mergedIntoClientId).toBe(a)
    expect(await audits(s, 'clients.merge')).toEqual([
      expect.objectContaining({ actorMembershipId: s.joId, entityId: a }),
    ])
  }, 30_000)
})

// ═════════════════════════════════════════════════════════════════ in Xero

/** Connect, all the way — which runs the first match. Returns the row. */
async function connect(
  s: Setup,
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

const linkOf = (
  s: Setup,
  clientId: Id<'clients'>,
  tenantId: string = ORG.coastal,
) =>
  s.t.run((ctx) =>
    ctx.db
      .query('xeroContactLinks')
      .withIndex('by_business_and_tenant_and_client', (q) =>
        q
          .eq('businessId', s.businessId)
          .eq('tenantId', tenantId)
          .eq('clientId', clientId),
      )
      .unique(),
  )

async function link(
  s: Setup,
  clientId: Id<'clients'>,
  tenantId: string = ORG.coastal,
): Promise<Doc<'xeroContactLinks'>> {
  const row = await linkOf(s, clientId, tenantId)
  if (!row) throw new Error(`no link for ${clientId} in ${tenantId}`)
  return row
}

const linksOfClient = (s: Setup, clientId: Id<'clients'>) =>
  s.t.run((ctx) =>
    ctx.db
      .query('xeroContactLinks')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect(),
  )

const outbox = (s: Setup) =>
  s.t.run((ctx) => ctx.db.query('xeroOutbox').collect())

const syncStateOf = (s: Setup, connectionId: Id<'xeroConnections'>) =>
  s.t.run((ctx) =>
    ctx.db
      .query('xeroSyncState')
      .withIndex('by_connection', (q) => q.eq('connectionId', connectionId))
      .unique(),
  )

const decide = (
  s: Setup,
  connectionId: Id<'xeroConnections'>,
  clientId: Id<'clients'>,
  choice: 'same' | 'different' | 'share' | 'give',
) =>
  s.terence.as.mutation(api.xeroMatch.decide, {
    businessId: s.businessId,
    connectionId,
    clientId,
    choice,
  })

/**
 * The business's match counts, as kept on its organisation's row as
 * decisions move them — what Settings and the match page's chips are given
 * (`xero.status`; xeroSameCustomer.test.ts holds it to passing `shared`
 * on).
 */
async function matchOf(s: Setup) {
  return s.t.run(async (ctx) => {
    const connection = (await ctx.db.query('xeroConnections').collect()).find(
      (row) =>
        row.businessId === s.businessId &&
        row.kind === 'business' &&
        row.status === 'connected',
    )
    if (!connection) return null
    const sync = await ctx.db
      .query('xeroSyncState')
      .withIndex('by_connection', (q) => q.eq('connectionId', connection._id))
      .unique()
    const match = sync?.match
    // Absent only on a match finished before sharing existed.
    return match ? { ...match, shared: match.shared ?? 0 } : null
  })
}

/** The match counts the rows of clients in the book come to. */
async function expectMatchCountsRight(s: Setup): Promise<void> {
  const rows = await s.t.run(async (ctx) => {
    const inBook: Array<Doc<'xeroContactLinks'>> = []
    for (const row of await ctx.db.query('xeroContactLinks').collect()) {
      if (row.tenantId !== ORG.coastal) continue
      const client = await ctx.db.get(row.clientId)
      if (client && !client.deletedAt && !client.archivedAt) inBook.push(row)
    }
    return inBook
  })
  const count = (...states: Array<string>) =>
    rows.filter((r) => states.includes(r.state)).length
  expect(await matchOf(s)).toMatchObject({
    linked: count('linked'),
    review: count('needs_review'),
    fresh: count('new', 'separate'),
    different: count('separate'),
    shared: count('shared'),
  })
}

/** Three Tom Joneses and Xero's one Tom Jones, matched (each To check
 * against it), not syncing. */
async function jones(s: Setup) {
  const site = (addressLine: string, suburb: string) => [
    { addressLine, suburb },
  ]
  const book = {
    a: await addClient(s, {
      name: 'Tom Jones',
      clientNumber: 13,
      sites: site('1 Bay Road', 'Bayswater'),
    }),
    b: await addClient(s, {
      name: 'Tom Jones',
      clientNumber: 14,
      email: 'tom@jones.test',
      sites: site('2 Rock Road', 'Rockingham'),
    }),
    c: await addClient(s, {
      name: 'Tom Jones',
      clientNumber: 15,
      sites: site('3 Peel Street', 'Mandurah'),
    }),
  }
  const [x] = xeroOf(s).contacts(ORG.coastal, [{ name: 'Tom Jones' }])
  const connection = await connect(
    s,
    s.terence,
    'business',
    XU.terence,
    ORG.coastal,
  )
  return { book, connection, X: x.contactId }
}

/**
 * Ann Archer (A, the record kept), Annie Archer (B, with her own email), and
 * a second Annie Archer (C, no email: a duplicate of B). `a` picks how A
 * looks: Ann with her email, Ann still a lead, or another Annie with no
 * email — who, like C, is no more than a name to Xero's Annie Archer.
 */
async function archers(
  s: Setup,
  a: 'ann' | 'lead' | 'annie' = 'ann',
): Promise<{
  a: Id<'clients'>
  b: Id<'clients'>
  c: Id<'clients'>
}> {
  const site = (addressLine: string, suburb: string) => [
    { addressLine, suburb },
  ]
  return {
    a: await addClient(s, {
      name: a === 'annie' ? 'Annie Archer' : 'Ann Archer',
      clientNumber: 1,
      ...(a === 'annie' ? {} : { email: 'ann@archer.test' }),
      ...(a === 'lead' ? { status: 'lead' as const } : {}),
      sites: site('1 Rokeby Road', 'Subiaco'),
    }),
    b: await addClient(s, {
      name: 'Annie Archer',
      clientNumber: 2,
      email: 'annie@archer.test',
      phone: '0411 222 333',
      sites: site('2 Stirling Highway', 'Nedlands'),
    }),
    c: await addClient(s, {
      name: 'Annie Archer',
      clientNumber: 3,
      sites: site('3 Marine Parade', 'Cottesloe'),
    }),
  }
}

describe('in Xero, before Start syncing', () => {
  test('a To check client merged into the client holding its contact: its proposal goes, the counts with it, and A keeps the contact', async () => {
    const s = await setup({ xero: true })
    const { book, connection, X } = await jones(s)
    await decide(s, connection._id, book.a, 'same')

    // B has no contact of its own in Xero: nothing of it stays there.
    expect((await preview(s, s.terence, book.b, book.a)).xero).toEqual([
      { orgName: 'Coastal Pest Pty Ltd', outcome: 'none' },
    ])

    await merge(s, s.terence, book.b, book.a)

    expect(await linksOfClient(s, book.b)).toEqual([])
    expect(await link(s, book.a)).toMatchObject({
      state: 'linked',
      xeroContactId: X,
    })
    // C still To check, against a contact A has.
    expect(await link(s, book.c)).toMatchObject({ state: 'needs_review' })
    expect(await matchOf(s)).toMatchObject({ linked: 1, review: 1 })
    await expectMatchCountsRight(s)
    // B's email filled A's blank — nothing goes to Xero before Start
    // syncing.
    expect((await clientRow(s, book.a)).email).toBe('tom@jones.test')
    expect(xeroOf(s).contactWrites()).toEqual([])
    expect(await outbox(s)).toEqual([])
  }, 30_000)

  test('a client sharing the other’s contact, merged into it: its shared link goes, and the contact is still A’s', async () => {
    const s = await setup({ xero: true })
    const { book, connection, X } = await jones(s)
    await decide(s, connection._id, book.a, 'same')
    await decide(s, connection._id, book.b, 'share')
    expect((await preview(s, s.terence, book.b, book.a)).xero).toEqual([
      { orgName: 'Coastal Pest Pty Ltd', outcome: 'none' },
    ])

    await merge(s, s.terence, book.b, book.a)

    expect(await linksOfClient(s, book.b)).toEqual([])
    expect(await link(s, book.a)).toMatchObject({
      state: 'linked',
      xeroContactId: X,
    })
    expect(await matchOf(s)).toMatchObject({ shared: 0 })
    await expectMatchCountsRight(s)
  }, 30_000)

  test('into a client with no contact of its own: it takes over the merged client’s — decided, `relinked` — and whoever shared that contact now shares its', async () => {
    const s = await setup({ xero: true })
    const { book, connection, X } = await jones(s)
    // B holds Xero's Tom Jones; C shares it. A is still To check against it.
    await decide(s, connection._id, book.b, 'same')
    await decide(s, connection._id, book.c, 'share')
    expect((await preview(s, s.terence, book.b, book.a)).xero).toEqual([
      { orgName: 'Coastal Pest Pty Ltd', outcome: 'takes_over' },
    ])

    await merge(s, s.terence, book.b, book.a)

    expect(await linksOfClient(s, book.b)).toEqual([])
    const a = await link(s, book.a)
    expect(a).toMatchObject({
      state: 'linked',
      how: 'relinked',
      xeroContactId: X,
      xeroName: 'Tom Jones',
      decidedByMembershipId: s.ownerMembershipId,
    })
    expect(a.decidedAt).toEqual(expect.any(Number))
    // Its own question about the contact is answered: it is that contact.
    expect(a.candidate).toBeUndefined()
    expect(await link(s, book.c)).toMatchObject({
      state: 'shared',
      xeroContactId: X,
      sharedWithClientId: book.a,
    })
    expect(await matchOf(s)).toMatchObject({ linked: 1, review: 0, shared: 1 })
    await expectMatchCountsRight(s)
    // The audit says which contact A took over, and that nothing else of
    // B's was dropped or let go.
    const [audit] = await audits(s, 'clients.merge')
    expect(audit.meta).toMatchObject({
      xero: {
        handedOver: [
          { tenantId: ORG.coastal, state: 'linked', xeroContactId: X },
        ],
        dropped: [],
        released: [],
      },
    })
    // Nobody is To check: the cards are gone, and C is under Shared contact,
    // using A's.
    const shared = await s.terence.as.query(api.xeroMatch.reviewPage, {
      businessId: s.businessId,
      connectionId: connection._id,
      filter: 'shared',
      paginationOpts: { numItems: 100, cursor: null },
    })
    expect(shared.page.map((item) => [item.clientId, item.sharedWith])).toEqual(
      [[book.c, { clientId: book.a, name: 'Tom Jones' }]],
    )
    // The holder's word: a run (Check Xero again) leaves it as it is.
    await s.terence.as.mutation(api.xeroMatch.rematch, {
      businessId: s.businessId,
      connectionId: connection._id,
    })
    await settle(s)
    expect(await link(s, book.a)).toMatchObject({
      state: 'linked',
      how: 'relinked',
      xeroContactId: X,
    })
    expect(await link(s, book.c)).toMatchObject({
      state: 'shared',
      sharedWithClientId: book.a,
    })
    await expectMatchCountsRight(s)
  }, 30_000)

  test('into a client sharing the merged client’s contact: it simply takes it, and the others sharing it share its', async () => {
    const s = await setup({ xero: true })
    const { book, connection, X } = await jones(s)
    await decide(s, connection._id, book.b, 'same')
    await decide(s, connection._id, book.a, 'share')
    await decide(s, connection._id, book.c, 'share')
    expect(await matchOf(s)).toMatchObject({ linked: 1, shared: 2 })
    expect((await preview(s, s.terence, book.b, book.a)).xero).toEqual([
      { orgName: 'Coastal Pest Pty Ltd', outcome: 'takes_over' },
    ])

    await merge(s, s.terence, book.b, book.a)

    expect(await linksOfClient(s, book.b)).toEqual([])
    const a = await link(s, book.a)
    expect(a).toMatchObject({
      state: 'linked',
      how: 'relinked',
      xeroContactId: X,
    })
    expect(a.sharedWithClientId).toBeUndefined()
    expect(await link(s, book.c)).toMatchObject({
      state: 'shared',
      xeroContactId: X,
      sharedWithClientId: book.a,
    })
    expect(await matchOf(s)).toMatchObject({ linked: 1, review: 0, shared: 1 })
    await expectMatchCountsRight(s)
  }, 30_000)

  test('into a client with a contact of its own: it keeps it, the merged client’s stays in Xero, and whoever shared that one is put To check against it (was_shared)', async () => {
    const s = await setup({ xero: true })
    const book = await archers(s)
    const [x, xb] = xeroOf(s).contacts(ORG.coastal, [
      { name: 'Ann Archer', email: 'ann@archer.test' },
      { name: 'Annie Archer', email: 'annie@archer.test' },
    ])
    const connection = await connect(
      s,
      s.terence,
      'business',
      XU.terence,
      ORG.coastal,
    )
    expect(await link(s, book.a)).toMatchObject({
      state: 'linked',
      xeroContactId: x.contactId,
    })
    // Two Annie Archers here: B is To check against Xero's, not matched by
    // the rules, until Terence says it is she.
    expect(await link(s, book.b)).toMatchObject({
      state: 'needs_review',
      candidate: { contactId: xb.contactId },
    })
    await decide(s, connection._id, book.b, 'same')
    await decide(s, connection._id, book.c, 'share')
    expect((await preview(s, s.terence, book.b, book.a)).xero).toEqual([
      { orgName: 'Coastal Pest Pty Ltd', outcome: 'stays' },
    ])

    await merge(s, s.terence, book.b, book.a)

    expect(await linksOfClient(s, book.b)).toEqual([])
    expect(await link(s, book.a)).toMatchObject({
      state: 'linked',
      xeroContactId: x.contactId,
    })
    const c = await link(s, book.c)
    expect(c).toMatchObject({
      state: 'needs_review',
      candidate: { contactId: xb.contactId, reason: 'was_shared' },
    })
    expect(c.xeroContactId).toBeUndefined()
    // Its card says whose contact it used: B's, merged away.
    const toCheck = await s.terence.as.query(api.xeroMatch.reviewPage, {
      businessId: s.businessId,
      connectionId: connection._id,
      filter: 'review',
      paginationOpts: { numItems: 100, cursor: null },
    })
    expect(
      toCheck.page.find((item) => item.clientId === book.c)?.sharedWith,
    ).toEqual({ clientId: book.b, name: 'Annie Archer' })
    await expectMatchCountsRight(s)
    // The audit keeps which contact was B's, and who was put To check.
    const [audit] = await audits(s, 'clients.merge')
    expect(audit.meta).toMatchObject({
      xero: {
        handedOver: [],
        dropped: [
          {
            tenantId: ORG.coastal,
            state: 'linked',
            xeroContactId: xb.contactId,
          },
        ],
        released: [book.c],
      },
    })
  }, 30_000)
})

describe('in Xero, once syncing', () => {
  test('B’s links go in every organisation, and anything queued for it; A is queued and gets B’s details where it had none; B’s own contact stays in Xero, untouched', async () => {
    const s = await setup({ xero: true })
    const xero = xeroOf(s)
    const a = await addClient(s, {
      name: 'Ann Archer',
      clientNumber: 1,
      sites: [{ addressLine: '1 Rokeby Road', suburb: 'Subiaco' }],
    })
    const b = await addClient(s, {
      name: 'Annie Archer',
      clientNumber: 2,
      email: 'ann@archer.test',
      sites: [{ addressLine: '2 Stirling Highway', suburb: 'Nedlands' }],
    })
    xero.contacts(ORG.coastal, [])
    xero.contacts(ORG.kevin, [])
    const business = await connect(
      s,
      s.terence,
      'business',
      XU.terence,
      ORG.coastal,
    )
    const kevins = await connect(s, s.kevin, 'member', XU.kevin, ORG.kevin)
    await s.terence.as.mutation(api.xeroSync.startSyncing, {
      businessId: s.businessId,
      connectionId: business._id,
    })
    await s.kevin.as.mutation(api.xeroSync.startSyncing, {
      businessId: s.businessId,
      connectionId: kevins._id,
    })
    await settle(s)

    const contacts = {
      a: {
        coastal: (await link(s, a)).xeroContactId!,
        kevin: (await link(s, a, ORG.kevin)).xeroContactId!,
      },
      b: {
        coastal: (await link(s, b)).xeroContactId!,
        kevin: (await link(s, b, ORG.kevin)).xeroContactId!,
      },
    }
    const bInXero = {
      coastal: xero.view(contacts.b.coastal),
      kevin: xero.view(contacts.b.kevin),
    }
    expect(xero.view(contacts.a.coastal).EmailAddress).toBe('')

    // The confirmation says B's contact stays in Xero: A has its own.
    expect((await preview(s, s.terence, b, a)).xero).toEqual([
      { orgName: 'Coastal Pest Pty Ltd', outcome: 'stays' },
    ])

    // A change of B's is waiting when the merge comes.
    await s.terence.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: b,
      phone: '0411 222 333',
    })
    expect((await outbox(s)).map((row) => row.clientId)).toContain(b)
    const from = xero.requests.length

    await merge(s, s.terence, b, a)

    expect(await linksOfClient(s, b)).toEqual([])
    const queued = await outbox(s)
    expect(queued.filter((row) => row.clientId === b)).toEqual([])
    expect(
      queued
        .filter((row) => row.clientId === a)
        .map((row) => row.connectionId)
        .sort(),
    ).toEqual([business._id, kevins._id].sort())

    await settle(s)

    // A's contact in each organisation has the email it was missing.
    expect(xero.view(contacts.a.coastal).EmailAddress).toBe('ann@archer.test')
    expect(xero.view(contacts.a.kevin).EmailAddress).toBe('ann@archer.test')
    // B's contacts are exactly as they were: never written again, never
    // archived, never deleted.
    expect(xero.view(contacts.b.coastal)).toEqual(bInXero.coastal)
    expect(xero.view(contacts.b.kevin)).toEqual(bInXero.kevin)
    for (const r of xero.contactWrites()) {
      if (xero.requests.indexOf(r) < from) continue
      for (const e of contactsIn(r)) {
        expect([contacts.b.coastal, contacts.b.kevin]).not.toContain(
          e.ContactID,
        )
      }
    }
    expect(
      xero.requests.filter(
        (r) => r.path.startsWith('/api.xro/') && r.method === 'DELETE',
      ),
    ).toEqual([])
    expect(await outbox(s)).toEqual([])

    // The tallies lost B, and agree with a recount.
    for (const connectionId of [business._id, kevins._id]) {
      const kept = (await syncStateOf(s, connectionId))?.counts
      await s.t.mutation(internal.xeroSync.recount, { connectionId })
      await settle(s)
      const recounted = (await syncStateOf(s, connectionId))?.counts
      const { waiting: _k, ...keptCounts } = kept!
      const { waiting: _r, ...recountedCounts } = recounted!
      expect(keptCounts).toEqual(recountedCounts)
      expect(keptCounts.inXero).toBe(1)
    }
  }, 30_000)

  /** Jo's own organisation, connected (which runs its match), and — with
   * `x` — the business's too, where Ann Archer is a contact of her own. */
  async function archersInXero(s: Setup) {
    const xero = xeroOf(s)
    const [x] = xero.contacts(ORG.coastal, [
      { name: 'Ann Archer', email: 'ann@archer.test' },
    ])
    const [y] = xero.contacts(ORG.jo, [
      { name: 'Annie Archer', email: 'annie@archer.test' },
    ])
    const business = await connect(
      s,
      s.terence,
      'business',
      XU.terence,
      ORG.coastal,
    )
    const jos = await connect(s, s.jo, 'member', XU.jo, ORG.jo)
    return { X: x.contactId, Y: y.contactId, business, jos }
  }

  const joDecides = (
    s: Setup,
    connectionId: Id<'xeroConnections'>,
    clientId: Id<'clients'>,
    choice: 'same' | 'different' | 'share' | 'give',
  ) =>
    s.jo.as.mutation(api.xeroMatch.decide, {
      businessId: s.businessId,
      connectionId,
      clientId,
      choice,
    })

  const joStartsSyncing = async (
    s: Setup,
    connectionId: Id<'xeroConnections'>,
  ) => {
    await s.jo.as.mutation(api.xeroSync.startSyncing, {
      businessId: s.businessId,
      connectionId,
    })
    await settle(s)
  }

  /** Contacts PestM8 added (`PUT /Contacts`) to one organisation. */
  const createdIn = (s: Setup, tenantId: string) =>
    xeroOf(s)
      .creates()
      .filter((r) => r.headers['xero-tenant-id'] === tenantId)
      .flatMap(contactsIn)

  async function expectTalliesRight(
    s: Setup,
    connectionId: Id<'xeroConnections'>,
  ) {
    const kept = (await syncStateOf(s, connectionId))?.counts
    expect(kept).toBeDefined()
    await s.t.mutation(internal.xeroSync.recount, { connectionId })
    await settle(s)
    const recounted = (await syncStateOf(s, connectionId))?.counts
    const { waiting: _k, ...keptCounts } = kept!
    const { waiting: _r, ...recountedCounts } = recounted!
    expect(keptCounts).toEqual(recountedCounts)
  }

  test.each([
    {
      name: 'A new there, merged before Start syncing',
      a: 'ann' as const,
      syncingFirst: false,
      aShares: false,
    },
    {
      name: 'A a lead, with no link anywhere, merged once syncing',
      a: 'lead' as const,
      syncingFirst: true,
      aShares: false,
    },
    {
      name: 'A sharing B’s contact there, merged once syncing',
      a: 'annie' as const,
      syncingFirst: true,
      aShares: true,
    },
  ])(
    'where B is a contact of its own and A is none ($name): A takes B’s over — no second contact in Xero — and whoever shared B’s shares A’s',
    async ({ a: kind, syncingFirst, aShares }) => {
      const s = await setup({ xero: true })
      quietly()
      const book = await archers(s, kind)
      const { X, Y, jos } = await archersInXero(s)
      // More than one Annie Archer: B is Jo's to say is Xero's.
      await joDecides(s, jos._id, book.b, 'same')
      expect(await link(s, book.b, ORG.jo)).toMatchObject({
        state: 'linked',
        xeroContactId: Y,
      })
      // C is the same customer as B in Jo's books, and uses B's contact.
      await joDecides(s, jos._id, book.c, 'share')
      if (aShares) await joDecides(s, jos._id, book.a, 'share')
      if (syncingFirst) await joStartsSyncing(s, jos._id)
      const coastalBefore = await linkOf(s, book.a)

      // Each sees the organisations they would on a client's sheet: Jo her
      // own, Terence the business's — where B has no contact of its own.
      expect((await preview(s, s.jo, book.b, book.a)).xero).toEqual([
        { orgName: 'Bloggs Bookkeeping', outcome: 'takes_over' },
      ])
      expect((await preview(s, s.terence, book.b, book.a)).xero).toEqual([
        { orgName: 'Coastal Pest Pty Ltd', outcome: 'none' },
      ])
      const created = createdIn(s, ORG.jo).length

      await merge(s, s.terence, book.b, book.a)
      if (!syncingFirst) await joStartsSyncing(s, jos._id)
      await settle(s)

      expect(await linksOfClient(s, book.b)).toEqual([])
      const a = await link(s, book.a, ORG.jo)
      expect(a).toMatchObject({
        state: 'linked',
        how: 'relinked',
        xeroContactId: Y,
        // What B last sent carries over, so A's own name goes where Xero
        // still holds B's as PestM8 sent it (a lead's "Ann", once syncing).
        // Matched but never sent, the contact only has its blanks filled.
        xeroName: kind === 'lead' ? 'Ann Archer' : 'Annie Archer',
        decidedByMembershipId: s.ownerMembershipId,
      })
      expect(a.sharedWithClientId).toBeUndefined()
      expect(await link(s, book.c, ORG.jo)).toMatchObject({
        state: 'shared',
        xeroContactId: Y,
        xeroName: a.xeroName,
        sharedWithClientId: book.a,
      })
      // One contact for the customer in Jo's books: B's, now A's.
      expect(createdIn(s, ORG.jo).slice(created)).toEqual([])
      expect(
        xeroOf(s)
          .contactsOf(ORG.jo)
          .map((c) => c.contactId),
      ).toEqual([Y])
      // The business's organisation is as it was for A: B had nothing there.
      expect(await linkOf(s, book.a)).toEqual(coastalBefore)
      if (kind === 'ann') {
        expect(coastalBefore).toMatchObject({
          state: 'linked',
          xeroContactId: X,
        })
      }
      expect(await outbox(s)).toEqual([])
      await expectTalliesRight(s, jos._id)
      expect((await syncStateOf(s, jos._id))?.counts?.inXero).toBe(1)

      // A is sent to that contact from now on: a change of A's reaches Y.
      await s.terence.as.mutation(api.clients.update, {
        businessId: s.businessId,
        clientId: book.a,
        phone: '0499 888 777',
      })
      await settle(s)
      expect(createdIn(s, ORG.jo).slice(created)).toEqual([])
      expect(
        xeroOf(s)
          .view(Y)
          .Phones.some((phone) => phone.PhoneNumber.includes('888')),
      ).toBe(true)
    },
    30_000,
  )

  test.each(['archive', 'gdpr'] as const)(
    'where B’s contact was stopped in Xero (%s) and A has none, A takes the stopped link over: never added there with B’s details',
    async (how) => {
      const s = await setup({ xero: true })
      quietly()
      const book = await archers(s, 'lead')
      const { Y, jos } = await archersInXero(s)
      await joDecides(s, jos._id, book.b, 'same')
      await joStartsSyncing(s, jos._id)
      // Xero stops B's contact; B's next change finds it so.
      if (how === 'archive') xeroOf(s).archive(Y)
      else xeroOf(s).gdpr(Y)
      await s.terence.as.mutation(api.clients.update, {
        businessId: s.businessId,
        clientId: book.b,
        phone: '0400 333 444',
      })
      await settle(s)
      const stopped = how === 'archive' ? 'archived_in_xero' : 'gdpr'
      expect(await link(s, book.b, ORG.jo)).toMatchObject({
        state: stopped,
        xeroContactId: Y,
      })
      const before = xeroOf(s).view(Y)
      const created = createdIn(s, ORG.jo).length

      await merge(s, s.terence, book.b, book.a)
      await settle(s)

      // A was a lead with no link: active now (B's work came with it), and
      // without B's stopped link it would be added to Jo's books with B's
      // phone.
      expect((await clientRow(s, book.a)).status).toBe('active')
      expect(await link(s, book.a, ORG.jo)).toMatchObject({
        state: stopped,
        xeroContactId: Y,
        how: 'relinked',
      })
      expect(createdIn(s, ORG.jo).slice(created)).toEqual([])
      expect(xeroOf(s).view(Y)).toEqual(before)
      await expectTalliesRight(s, jos._id)
    },
    30_000,
  )
})
