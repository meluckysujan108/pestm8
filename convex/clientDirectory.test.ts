/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import schema from './schema'
import { directory as directoryQuery } from './clients'
import { requireActor } from './lib/actor'
import { clientFacets } from './lib/clientFacets'
import { visibleClientIds } from './lib/clientScope'
import type { FunctionReturnType } from 'convex/server'
import type { Doc, Id, TableNames } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import type { TestActor } from '../test/harness'

/**
 * What the Clients page and the booking pickers read instead of every client
 * and every site with its client attached: `clients.directory` (slim, whole),
 * `clients.page` (the first screen, a page at a time) and `clients.overview`
 * (the header and filters, counted on the server). The directory is also
 * what a phone matches a caller against (lib/clientMatch.ts), so it carries
 * emails and business clients' contact people; and, because every change to
 * what it reads re-sends the whole book, it reads nothing but the book.
 */

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  return { t, owner, businessId, ownerMembershipId }
}

type Setup = Awaited<ReturnType<typeof setup>>

type ClientSeed = {
  name: string
  kind?: 'person' | 'business'
  status?: 'active' | 'lead' | 'inactive'
  tags?: Array<string>
  archived?: boolean
  binned?: boolean
  email?: string
  phone?: string
  sites?: Array<{ addressLine: string; suburb: string; binned?: boolean }>
  contacts?: Array<{
    name: string
    role?: string
    phone?: string
    email?: string
    binned?: boolean
  }>
  importedFrom?: Id<'clientImports'>
}

/** Clients inserted in order, so the last is the newest. */
async function seed(s: Setup, clients: Array<ClientSeed>) {
  return s.t.run(async (ctx) => {
    const out: Array<{
      clientId: Id<'clients'>
      siteIds: Array<Id<'properties'>>
      contactIds: Array<Id<'clientContacts'>>
    }> = []
    for (const c of clients) {
      const now = Date.now()
      const clientId = await ctx.db.insert('clients', {
        businessId: s.businessId,
        kind: c.kind ?? 'person',
        name: c.name,
        ...(c.status ? { status: c.status } : {}),
        ...(c.tags ? { tags: c.tags } : {}),
        ...(c.email ? { email: c.email } : {}),
        ...(c.phone ? { phone: c.phone } : {}),
        ...(c.archived ? { archivedAt: now } : {}),
        ...(c.binned ? { deletedAt: now } : {}),
        ...(c.importedFrom ? { importedFrom: c.importedFrom } : {}),
        createdAt: now,
        updatedAt: now,
      })
      const siteIds = []
      for (const site of c.sites ?? [
        { addressLine: `1 ${c.name} Street`, suburb: 'Bayswater' },
      ]) {
        siteIds.push(
          await ctx.db.insert('properties', {
            businessId: s.businessId,
            clientId,
            addressLine: site.addressLine,
            suburb: site.suburb,
            state: 'WA',
            postcode: '6053',
            createdAt: now,
            ...(site.binned || c.binned ? { deletedAt: now } : {}),
          }),
        )
      }
      const contactIds = []
      for (const contact of c.contacts ?? []) {
        contactIds.push(
          await ctx.db.insert('clientContacts', {
            businessId: s.businessId,
            clientId,
            name: contact.name,
            ...(contact.role ? { role: contact.role } : {}),
            ...(contact.phone ? { phone: contact.phone } : {}),
            ...(contact.email ? { email: contact.email } : {}),
            createdAt: now,
            ...(contact.binned || c.binned ? { deletedAt: now } : {}),
          }),
        )
      }
      out.push({ clientId, siteIds, contactIds })
    }
    return out
  })
}

function directory(actor: TestActor, businessId: Id<'businesses'>) {
  return actor.as.query(api.clients.directory, { businessId })
}

async function everyPage(
  actor: TestActor,
  businessId: Id<'businesses'>,
  numItems: number,
) {
  const rows: FunctionReturnType<typeof api.clients.page>['page'] = []
  let cursor: string | null = null
  for (let i = 0; i < 50; i++) {
    const p: FunctionReturnType<typeof api.clients.page> = await actor.as.query(
      api.clients.page,
      {
        businessId,
        paginationOpts: { numItems, cursor },
      },
    )
    rows.push(...p.page)
    if (p.isDone) return rows
    cursor = p.continueCursor
  }
  throw new Error('never finished')
}

describe('the directory', () => {
  test('holds every live client and site, oldest first, archived ones flagged', async () => {
    const s = await setup()
    const [a, archived, , c] = await seed(s, [
      { name: 'A. First' },
      { name: 'B. Archived', archived: true },
      { name: 'C. Binned', binned: true },
      {
        name: 'D. Two sites',
        sites: [
          { addressLine: '1 Kept Road', suburb: 'Morley' },
          { addressLine: '2 Binned Road', suburb: 'Morley', binned: true },
        ],
      },
    ])

    const dir = await directory(s.owner, s.businessId)
    expect(dir.capped).toBe(false)
    expect(dir.clients.map((client) => client.name)).toEqual([
      'A. First',
      'B. Archived',
      'D. Two sites',
    ])
    expect(dir.clients[1].archivedAt).toBeTypeOf('number')
    expect(dir.clients[0].archivedAt).toBeUndefined()
    // The pickers keep an archived client's site; the binned one's is gone,
    // and so is a site binned on its own.
    expect(dir.sites.map((site) => site._id)).toEqual([
      a.siteIds[0],
      archived.siteIds[0],
      c.siteIds[0],
    ])
  })

  test('sends only what the screens and matching use: no head-office address', async () => {
    const s = await setup()
    await seed(s, [{ name: 'A. First', email: 'a@first.test', tags: ['VIP'] }])
    await s.t.run(async (ctx) => {
      const client = await ctx.db
        .query('clients')
        .withIndex('by_business', (q) => q.eq('businessId', s.businessId))
        .first()
      await ctx.db.patch(client!._id, {
        addressLine: '99 Head Office Way',
        phone: '0412 345 678',
      })
    })

    const dir = await directory(s.owner, s.businessId)
    const allowed = new Set([
      '_id',
      '_creationTime',
      'name',
      'kind',
      'phone',
      // For matching a caller by their email (lib/clientMatch.ts).
      'email',
      'abn',
      'clientNumber',
      'status',
      'tags',
      'archivedAt',
      'createdAt',
      'imported',
    ])
    for (const client of dir.clients) {
      for (const key of Object.keys(client)) expect(allowed).toContain(key)
    }
    expect(dir.clients[0].phone).toBe('0412 345 678')
    expect(dir.clients[0].email).toBe('a@first.test')
    expect(JSON.stringify(dir)).not.toContain('Head Office')
  })

  test('says a client or site came from an import, even after Undo kept it', async () => {
    const s = await setup()
    const importId = await s.t.run(async (ctx) =>
      ctx.db.insert('clientImports', {
        businessId: s.businessId,
        createdByMembershipId: s.ownerMembershipId,
        fileName: 'clients.csv',
        createdAt: Date.now(),
        clients: 1,
        sites: 1,
        notes: 0,
        skipped: 0,
        failed: 0,
      }),
    )
    await seed(s, [
      { name: 'By hand' },
      { name: 'Kept', importedFrom: importId },
    ])

    const dir = await directory(s.owner, s.businessId)
    expect(dir.clients.map((client) => client.imported)).toEqual([
      undefined,
      true,
    ])
  })

  test('is the business’s own, and refused to anyone outside it', async () => {
    const s = await setup()
    await seed(s, [{ name: 'Ours' }])
    const other = await createActor(s.t, { email: 'other@elsewhere.test' })
    const { businessId: otherBusiness } = await createBusiness(
      s.t,
      other,
      'Elsewhere Pest',
    )

    expect((await directory(other, otherBusiness)).clients).toEqual([])
    await expect(directory(other, s.businessId)).rejects.toThrow(/NO_ACCESS/)
  })

  test('holds the same sites as properties.list, which the pickers read before it', async () => {
    const s = await setup()
    await seed(s, [
      { name: 'A' },
      { name: 'B', archived: true },
      { name: 'C', binned: true },
      {
        name: 'D',
        sites: [
          { addressLine: '1 Kept Road', suburb: 'Morley' },
          { addressLine: '2 Binned Road', suburb: 'Morley', binned: true },
        ],
      },
    ])
    const dir = await directory(s.owner, s.businessId)
    const old = await s.owner.as.query(api.properties.list, {
      businessId: s.businessId,
    })
    expect(dir.sites.map((site) => site._id)).toEqual(old.map((p) => p._id))
  })
})

/**
 * Every read made while `fn` runs as `actor`: `table.index` for a range,
 * `table (whole table)` for a scan, `table (get)` for one document, and the
 * Better Auth component's as `betterAuth.model`; with the ids of the users
 * looked up. Run over a reader that writes down where each read goes, and
 * has nothing to write with, so the code under it runs as a query does.
 */
async function readsOf(
  actor: TestActor,
  fn: (ctx: QueryCtx) => Promise<unknown>,
) {
  return actor.as.run(async (ctx) => {
    const reads = new Set<string>()
    const users = new Set<string>()
    const tables = Object.keys(schema.tables) as Array<TableNames>
    const db = ctx.db
    const tableOf = (id: string) =>
      tables.find((table) => db.normalizeId(table, id) !== null) ?? 'unknown'
    const reader = {
      query: (table: TableNames) =>
        new Proxy(db.query(table), {
          get(target, prop, receiver) {
            reads.add(prop === 'withIndex' ? '' : `${table} (whole table)`)
            const value: unknown = Reflect.get(target, prop, receiver)
            if (prop === 'withIndex' && typeof value === 'function') {
              return (name: string, range?: unknown) => {
                reads.add(`${table}.${name}`)
                return Reflect.apply(value, target, [name, range]) as unknown
              }
            }
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
      get: (...args: Array<string>) => {
        reads.add(`${args.length === 2 ? args[0] : tableOf(args[0])} (get)`)
        return Reflect.apply(db.get, db, args) as Promise<unknown>
      },
      normalizeId: db.normalizeId.bind(db),
    }
    const runQuery = (ref: unknown, args: unknown) => {
      const model = (args as { model?: unknown }).model
      reads.add(typeof model === 'string' ? `betterAuth.${model}` : 'runQuery')
      const where = (
        args as { where?: Array<{ field: string; value: unknown }> }
      ).where
      const id = where?.find((w) => w.field === '_id')?.value
      if (model === 'user' && typeof id === 'string') users.add(id)
      return Reflect.apply(ctx.runQuery, ctx, [ref, args]) as Promise<unknown>
    }
    await fn({ ...ctx, db: reader, runQuery } as unknown as QueryCtx)
    reads.delete('')
    return { reads: [...reads].sort(), users: [...users] }
  })
}

/** `clients.directory`'s own code, for `readsOf`. */
const directoryHandler = (
  directoryQuery as unknown as {
    _handler: (
      ctx: QueryCtx,
      args: { businessId: Id<'businesses'> },
    ) => Promise<unknown>
  }
)._handler

describe('the directory, for matching callers', () => {
  test('reads the client book and nothing else: never the business row, nor the team', async () => {
    const s = await setup()
    const kevin = await createActor(s.t, { email: 'kevin@coastal.test' })
    await joinBusiness(s.t, s.owner, kevin, s.businessId, 'subcontractor')
    const jo = await createActor(s.t, { email: 'jo@coastal.test' })
    await joinBusiness(s.t, s.owner, jo, s.businessId, 'contractor')
    await seed(s, [
      { name: 'Jane Nguyen', phone: '0412 345 678', email: 'jane@example.com' },
      {
        name: 'Ray White Bayswater',
        kind: 'business',
        contacts: [{ name: 'Sarah Lee', phone: '0412 111 222' }],
      },
    ])

    for (const actor of [s.owner, jo, kevin]) {
      // What every query reads first: who is asking, and what they may see.
      const access = await readsOf(actor, async (ctx) =>
        visibleClientIds(ctx, await requireActor(ctx, s.businessId)),
      )
      const read = await readsOf(actor, (ctx) =>
        directoryHandler(ctx, { businessId: s.businessId }),
      )
      // Every booking, Recurring Job visit and numbered report patches the
      // business row: reading it would re-send the whole book on each.
      expect(read.reads.filter((r) => r.startsWith('businesses'))).toEqual([])
      expect(read.reads).toEqual(
        [
          ...access.reads,
          'clientContacts.by_business',
          'clients.by_business',
          'properties.by_business',
        ].sort(),
      )
      // Only the person asking: no other member's sign-in account.
      expect(read.users).toEqual([actor.userId])
    }
  })

  test('carries no marks: the business’s and the team’s numbers go only as saved on a client', async () => {
    const s = await setup()
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.businessId, {
        phone: '(08) 9272 0000',
        email: 'office@coastal.test',
        reportCopyEmail: 'copies@coastal.test',
      })
      await ctx.db.patch(s.ownerMembershipId, { phone: '0412 000 111' })
    })
    await seed(s, [
      { name: 'Jane Nguyen', phone: '0412 345 678', email: 'jane@example.com' },
      // What offices save on clients who gave none: the office's landline,
      // the owner's mobile and sign-in email, the report copy address.
      { name: 'Office copy', phone: '9272 0000' },
      {
        name: 'Owner’s mobile',
        phone: '+61 412 000 111',
        email: 'Terence@Coastal.test',
      },
      { name: 'Report copies', email: 'copies@coastal.test' },
      {
        name: 'Ray White Bayswater',
        kind: 'business',
        contacts: [{ name: 'Office Login', email: 'terence@coastal.test' }],
      },
    ])

    const dir = await directory(s.owner, s.businessId)
    for (const row of [...dir.clients, ...(dir.contacts ?? [])]) {
      expect(Object.keys(row)).not.toContain('ours')
    }
    // Each goes as it was saved, for the phone's matcher to leave out
    // (lib/clientMatch.ts `oursFor`).
    expect(
      Object.fromEntries(dir.clients.map((c) => [c.name, [c.phone, c.email]])),
    ).toEqual({
      'Jane Nguyen': ['0412 345 678', 'jane@example.com'],
      'Office copy': ['9272 0000', undefined],
      'Owner’s mobile': ['+61 412 000 111', 'Terence@Coastal.test'],
      'Report copies': [undefined, 'copies@coastal.test'],
      'Ray White Bayswater': [undefined, undefined],
    })
    expect(dir.contacts?.map((c) => c.email)).toEqual(['terence@coastal.test'])
    // Nothing of the business's or the team's on its own.
    const sent = JSON.stringify(dir)
    expect(sent).not.toContain('office@coastal.test')
    expect(sent).not.toContain('0412 000 111')
  })

  test('sends business clients’ contact people, and nobody else’s', async () => {
    const s = await setup()
    const [agency, , archivedAgency] = await seed(s, [
      {
        name: 'Ray White Bayswater',
        kind: 'business',
        phone: '08 9272 1234',
        contacts: [
          {
            name: 'Sarah Lee',
            role: 'Property manager',
            phone: '0412 111 222',
            email: 'sarah@raywhite.test',
          },
          { name: 'Gone Person', phone: '0400 000 000', binned: true },
        ],
      },
      // A person's contacts are hidden in the app, so not sent.
      {
        name: 'Jane Nguyen',
        contacts: [{ name: 'Tom Nguyen', phone: '0499 888 777' }],
      },
      // Archived clients stay in the pickers, and so do their contacts.
      {
        name: 'Old Agency',
        kind: 'business',
        archived: true,
        contacts: [{ name: 'Pat Old' }],
      },
      {
        name: 'Binned Agency',
        kind: 'business',
        binned: true,
        contacts: [{ name: 'Binned Contact', phone: '0400 111 111' }],
      },
    ])

    const dir = await directory(s.owner, s.businessId)
    expect(dir.contactsCapped).toBe(false)
    expect(dir.contacts).toEqual([
      {
        _id: agency.contactIds[0],
        clientId: agency.clientId,
        name: 'Sarah Lee',
        role: 'Property manager',
        phone: '0412 111 222',
        email: 'sarah@raywhite.test',
      },
      {
        _id: archivedAgency.contactIds[0],
        clientId: archivedAgency.clientId,
        name: 'Pat Old',
      },
    ])
    const sent = JSON.stringify(dir)
    expect(sent).not.toContain('Tom Nguyen')
    expect(sent).not.toContain('Gone Person')
    expect(sent).not.toContain('Binned Contact')
  })

  test('says when only contact people passed the limit', async () => {
    const s = await setup()
    const [agency] = await seed(s, [{ name: 'Huge Agency', kind: 'business' }])
    await s.t.run(async (ctx) => {
      const now = Date.now()
      for (let i = 0; i < 8001; i++) {
        await ctx.db.insert('clientContacts', {
          businessId: s.businessId,
          clientId: agency.clientId,
          name: `Contact ${i}`,
          createdAt: now,
        })
      }
    })

    const dir = await directory(s.owner, s.businessId)
    expect(dir.capped).toBe(false)
    expect(dir.contactsCapped).toBe(true)
    expect(dir.contacts).toHaveLength(8000)
    // The newest kept, oldest first, as the other lists are.
    expect(dir.contacts?.[0].name).toBe('Contact 1')
    expect(dir.contacts?.at(-1)?.name).toBe('Contact 8000')
  }, 120_000)

  test('a subcontractor is sent emails and contact people too, and none of the team’s numbers', async () => {
    const s = await setup()
    const kevin = await createActor(s.t, { email: 'kevin@coastal.test' })
    const kevinId = await joinBusiness(
      s.t,
      s.owner,
      kevin,
      s.businessId,
      'subcontractor',
    )
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.ownerMembershipId, { phone: '0412 000 111' })
      await ctx.db.patch(kevinId, { phone: '0433 222 333' })
    })
    await seed(s, [
      { name: 'Jane Nguyen', phone: '0412 345 678', email: 'jane@example.com' },
      {
        name: 'Ray White Bayswater',
        kind: 'business',
        contacts: [{ name: 'Sarah Lee', phone: '0412 111 222' }],
      },
    ])

    const forKevin = await directory(kevin, s.businessId)
    expect(forKevin.clients.find((c) => c.name === 'Jane Nguyen')?.email).toBe(
      'jane@example.com',
    )
    expect(forKevin.contacts?.map((c) => c.name)).toEqual(['Sarah Lee'])
    const sent = JSON.stringify(forKevin)
    for (const teams of [
      '0412 000 111',
      '0433 222 333',
      'terence@coastal.test',
      'kevin@coastal.test',
    ]) {
      expect(sent).not.toContain(teams)
    }
  })

  test('a subcontractor’s answer is the owner’s: with no marks in it, nothing says whose a number is', async () => {
    const s = await setup()
    const jo = await createActor(s.t, { email: 'jo.private@gmail.test' })
    const joId = await joinBusiness(
      s.t,
      s.owner,
      jo,
      s.businessId,
      'contractor',
    )
    const kevin = await createActor(s.t, { email: 'kevin@coastal.test' })
    await joinBusiness(s.t, s.owner, kevin, s.businessId, 'subcontractor')
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.businessId, {
        phone: '(08) 9272 0000',
        email: 'office@coastal.test',
      })
      await ctx.db.patch(s.ownerMembershipId, { phone: '0412 000 111' })
      await ctx.db.patch(joId, { phone: '0433 444 555' })
    })
    // The office saved team details on records that had none: the owner's
    // sign-in email on a walk-in, Jo's mobile and email on an agency's
    // contact, and the business's own number on another.
    await seed(s, [
      { name: 'Walk-in bucket', email: 'terence@coastal.test' },
      {
        name: 'Ray White Bayswater',
        kind: 'business',
        contacts: [
          {
            name: 'Jo (ours)',
            phone: '0433 444 555',
            email: 'jo.private@gmail.test',
          },
        ],
      },
      { name: 'Office line', phone: '9272 0000' },
    ])

    // The same answer for the owner, a contractor who manages a team, and
    // a subcontractor: what is the team's is worked out on each phone, from
    // what that person may know (lib/clientMatch.ts `oursFor`).
    const forOwner = await directory(s.owner, s.businessId)
    expect(await directory(jo, s.businessId)).toEqual(forOwner)
    const forKevin = await directory(kevin, s.businessId)
    expect(forKevin).toEqual(forOwner)
    expect(JSON.stringify(forKevin)).not.toContain('"ours"')

    // What he is sent is what the client's sheet shows him already.
    const walkIn = forKevin.clients.find((c) => c.name === 'Walk-in bucket')
    if (!walkIn) throw new Error('the walk-in was not sent')
    expect(walkIn.email).toBe('terence@coastal.test')
    const sheet = await kevin.as.query(api.clients.get, {
      businessId: s.businessId,
      clientId: walkIn._id,
    })
    expect(sheet?.email).toBe(walkIn.email)

    // Nor can he test a number against the team's: a client he saves with
    // the owner's mobile, or Jo's email, comes back on his copy as it does
    // on the owner's.
    await kevin.as.mutation(api.properties.create, {
      businessId: s.businessId,
      clientName: 'Test',
      phone: '0412 000 111',
      email: 'jo.private@gmail.test',
      addressLine: '1 Test St',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })
    const probe = (dir: FunctionReturnType<typeof api.clients.directory>) =>
      dir.clients.find((c) => c.name === 'Test')
    const probed = probe(await directory(kevin, s.businessId))
    expect(probed?.phone).toBe('0412 000 111')
    expect(probed).toEqual(probe(await directory(s.owner, s.businessId)))
  })
})

describe('the first screen, a page at a time', () => {
  test('pages newest first, without archived or binned clients', async () => {
    const s = await setup()
    await seed(s, [
      { name: 'A' },
      { name: 'B', archived: true },
      { name: 'C' },
      { name: 'D', binned: true },
      { name: 'E' },
      { name: 'F' },
    ])

    const rows = await everyPage(s.owner, s.businessId, 2)
    expect(rows.map((row) => row.client.name)).toEqual(['F', 'E', 'C', 'A'])
  })

  test('shows each card its live sites, and says when there are too many to show', async () => {
    const s = await setup()
    const many = Array.from({ length: 51 }, (_, i) => ({
      addressLine: `${i + 1} Long Street`,
      suburb: 'Morley',
    }))
    await seed(s, [
      {
        name: 'Two sites',
        sites: [
          { addressLine: '1 Kept Road', suburb: 'Bayswater' },
          { addressLine: '2 Binned Road', suburb: 'Bayswater', binned: true },
        ],
      },
      { name: 'Strata', kind: 'business', sites: many },
    ])

    const rows = await everyPage(s.owner, s.businessId, 10)
    const strata = rows.find((row) => row.client.name === 'Strata')!
    expect(strata.properties).toHaveLength(50)
    expect(strata.propertiesCapped).toBe(true)
    const two = rows.find((row) => row.client.name === 'Two sites')!
    expect(two.properties.map((p) => p.addressLine)).toEqual(['1 Kept Road'])
    expect(two.propertiesCapped).toBe(false)
  })

  test('cuts a page down to a sane size whatever is asked', async () => {
    const s = await setup()
    await seed(
      s,
      Array.from({ length: 65 }, (_, i) => ({ name: `Client ${i}` })),
    )
    const p = await s.owner.as.query(api.clients.page, {
      businessId: s.businessId,
      paginationOpts: { numItems: 10_000, cursor: null },
    })
    expect(p.page.length).toBeLessThanOrEqual(60)
    expect(p.isDone).toBe(false)
  })
})

describe('the overview', () => {
  test('counts what the page lists, and offers the filters the page offered', async () => {
    const s = await setup()
    await seed(s, [
      {
        name: 'A',
        tags: ['Real estate'],
        sites: [{ addressLine: '1 A St', suburb: 'Morley' }],
      },
      {
        name: 'B',
        status: 'lead',
        tags: ['real estate', 'Strata'],
        sites: [
          { addressLine: '1 B St', suburb: 'Morley' },
          { addressLine: '2 B St', suburb: 'Morley' },
          { addressLine: '3 B St', suburb: 'Bayswater' },
        ],
      },
      {
        name: 'C',
        status: 'inactive',
        sites: [{ addressLine: '1 C St', suburb: 'Bayswater' }],
      },
      {
        name: 'Archived',
        archived: true,
        tags: ['Gone'],
        sites: [{ addressLine: '1 X St', suburb: 'Kalgoorlie' }],
      },
      {
        name: 'Binned',
        binned: true,
        sites: [{ addressLine: '1 Y St', suburb: 'Broome' }],
      },
    ])

    const overview = await s.owner.as.query(api.clients.overview, {
      businessId: s.businessId,
    })
    expect(overview.total).toBe(3)
    expect(overview.capped).toBe(false)
    expect(overview.statuses).toEqual({ active: 1, lead: 1, inactive: 1 })
    // Each client once per distinct suburb; nothing from archived or binned.
    expect(overview.suburbs).toEqual([
      { suburb: 'Bayswater', count: 2 },
      { suburb: 'Morley', count: 2 },
    ])
    expect(overview.tags.map((t) => [t.tag.toLowerCase(), t.count])).toEqual([
      ['real estate', 2],
      ['strata', 1],
    ])

    // The same choices the page worked out from the whole book before.
    const clients = await s.owner.as.query(api.clients.list, {
      businessId: s.businessId,
    })
    const sites = await s.owner.as.query(api.properties.list, {
      businessId: s.businessId,
    })
    const rows = [...clients].reverse().map((client: Doc<'clients'>) => ({
      client,
      properties: sites.filter((p) => p.clientId === client._id),
    }))
    const before = clientFacets(rows)
    expect(overview.suburbs).toEqual(before.suburbs)
    expect(overview.tags).toEqual(before.tags)
    expect(overview.statuses).toEqual(before.statuses)
  })
})
