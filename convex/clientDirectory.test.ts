/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { clientFacets } from './lib/clientFacets'
import type { FunctionReturnType } from 'convex/server'
import type { Doc, Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * What the Clients page and the booking pickers read instead of every client
 * and every site with its client attached: `clients.directory` (slim, whole),
 * `clients.page` (the first screen, a page at a time) and `clients.overview`
 * (the header and filters, counted on the server).
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
  sites?: Array<{ addressLine: string; suburb: string; binned?: boolean }>
  importedFrom?: Id<'clientImports'>
}

/** Clients inserted in order, so the last is the newest. */
async function seed(s: Setup, clients: Array<ClientSeed>) {
  return s.t.run(async (ctx) => {
    const out: Array<{
      clientId: Id<'clients'>
      siteIds: Array<Id<'properties'>>
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
      out.push({ clientId, siteIds })
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

  test('sends only what the screens use: no email, no head-office address', async () => {
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
    expect(JSON.stringify(dir)).not.toContain('a@first.test')
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
